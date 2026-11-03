import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { ensureFinancialJobDispatch } from "../queries/financial-job-dispatches";
import {
  cancelInvoiceSchedule,
  deleteInvoiceWithRevision,
  getInvoiceCommandPreview,
  issueInvoice,
  scheduleInvoice,
  updateInvoiceWithIntent,
} from "../queries/invoice-commands";
import { isCurrentInvoiceSchedule } from "../queries/invoice-delivery";
import { updateInvoice } from "../queries/invoices";
import { customers, financialJobDispatches, invoices } from "../schema";
import {
  createTenantIsolationFixture,
  removeTenantIsolationFixture,
  type TenantIsolationFixture,
} from "./helpers/tenant-isolation-fixture";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "manual invoice commands (isolated PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
    });
    afterEach(async () => {
      if (fixture) await removeTenantIsolationFixture(db, fixture);
    });
    afterAll(closeDatabase);
    const scope = () => ({
      id: fixture.own.invoiceId,
      teamId: fixture.own.teamId,
    });
    const later = (hours: number) =>
      new Date(Date.now() + hours * 3600000).toISOString();
    function operationId(value: unknown): string {
      if (!value || typeof value !== "object" || !("operation" in value))
        throw new Error("Missing operation receipt");
      const operation = value.operation;
      if (
        !operation ||
        typeof operation !== "object" ||
        !("id" in operation) ||
        typeof operation.id !== "string"
      )
        throw new Error("Invalid operation receipt");
      return operation.id;
    }
    async function current() {
      return (
        await db
          .select()
          .from(invoices)
          .where(eq(invoices.id, fixture.own.invoiceId))
      )[0]!;
    }
    async function intents() {
      return db
        .select()
        .from(financialJobDispatches)
        .where(eq(financialJobDispatches.teamId, fixture.own.teamId));
    }

    test("concurrent retries issue one immutable document and one generation intent", async () => {
      const request = { ...scope(), deliveryType: "create_and_send" as const };
      const [first, second] = await Promise.all([
        issueInvoice(db, request),
        issueInvoice(db, request),
      ]);
      expect(first?.operation.id).toBe(second?.operation.id);
      expect(first?.documentSnapshot).toEqual(second?.documentSnapshot);
      expect(first?.documentSnapshot?.source).toBe("issued");
      expect((await current()).status).toBe("unpaid");
      const pending = await intents();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe("pending");
      expect(pending[0]?.payload?.invoiceId).toBe(fixture.own.invoiceId);
      expect(
        await db
          .select()
          .from(invoices)
          .where(eq(invoices.teamId, fixture.own.teamId)),
      ).toHaveLength(1);
    });

    test("failure after business write but before outer commit rolls back snapshot, status and intent", async () => {
      await expect(
        db.transaction(async (tx) => {
          await issueInvoice(tx, { ...scope(), deliveryType: "create" });
          throw new Error("fixture crash before commit");
        }),
      ).rejects.toThrow("before commit");
      expect(await current()).toMatchObject({
        status: "draft",
        documentSnapshot: null,
      });
      expect(await intents()).toHaveLength(0);
    });

    test("a conflicting persisted intent fails the business transaction instead of leaving an issued invoice", async () => {
      await ensureFinancialJobDispatch(db, {
        teamId: fixture.own.teamId,
        jobName: "generate-invoice",
        source: `invoice/${fixture.own.invoiceId}/issue/create`,
        payload: {
          teamId: fixture.own.teamId,
          invoiceId: fixture.own.invoiceId,
          deliveryType: "different-fixture",
        },
      });
      await expect(
        issueInvoice(db, { ...scope(), deliveryType: "create" }),
      ).rejects.toThrow("conflict");
      expect(await current()).toMatchObject({
        status: "draft",
        documentSnapshot: null,
      });
      expect(await intents()).toHaveLength(1);
    });

    test("a foreign tenant cannot issue, schedule or cancel the invoice", async () => {
      const foreign = {
        id: fixture.own.invoiceId,
        teamId: fixture.other.teamId,
      };
      expect(
        await issueInvoice(db, { ...foreign, deliveryType: "create" }),
      ).toBeUndefined();
      expect(
        await scheduleInvoice(db, { ...foreign, scheduledAt: later(1) }),
      ).toBeUndefined();
      expect(await cancelInvoiceSchedule(db, foreign)).toBeUndefined();
      expect(await current()).toMatchObject({
        status: "draft",
        documentSnapshot: null,
      });
      expect(await intents()).toHaveLength(0);
    });

    test("two committed reschedules retain SQL intents and only the final marker can send", async () => {
      const [a, b] = await Promise.all([
        scheduleInvoice(db, { ...scope(), scheduledAt: later(1) }),
        scheduleInvoice(db, { ...scope(), scheduledAt: later(2) }),
      ]);
      expect(a?.scheduledJobId).not.toBe(b?.scheduledJobId);
      const final = await current();
      expect(
        [a!, b!].filter((row) =>
          isCurrentInvoiceSchedule(final, row.scheduledJobId!),
        ),
      ).toHaveLength(1);
      expect(
        (await intents()).filter((row) => row.jobName === "generate-invoice"),
      ).toHaveLength(2);
      const retry = await scheduleInvoice(db, {
        ...scope(),
        scheduledAt: final.scheduledAt!,
      });
      expect(retry?.scheduledJobId).toBe(final.scheduledJobId);
      expect(
        (await intents()).filter((row) => row.jobName === "generate-invoice"),
      ).toHaveLength(2);
    });

    test("crash during reschedule preserves the earlier committed generation", async () => {
      const before = await scheduleInvoice(db, {
        ...scope(),
        scheduledAt: later(1),
      });
      await expect(
        db.transaction(async (tx) => {
          await scheduleInvoice(tx, {
            ...scope(),
            scheduledAt: later(2),
            requireScheduled: true,
          });
          throw new Error("fixture schedule rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await current()).scheduledJobId).toBe(before!.scheduledJobId);
      expect(
        (await intents()).filter((row) => row.jobName === "generate-invoice"),
      ).toHaveLength(1);
    });

    test("cancel commits without Redis and invalidates queued work; immediate issue invalidates a later schedule", async () => {
      const first = await scheduleInvoice(db, {
        ...scope(),
        scheduledAt: later(1),
      });
      await cancelInvoiceSchedule(db, scope());
      expect(
        isCurrentInvoiceSchedule(await current(), first!.scheduledJobId!),
      ).toBe(false);
      expect(await current()).toMatchObject({
        status: "draft",
        scheduledJobId: null,
        scheduledAt: null,
      });
      const second = await scheduleInvoice(db, {
        ...scope(),
        scheduledAt: later(2),
      });
      await issueInvoice(db, { ...scope(), deliveryType: "create_and_send" });
      expect(
        isCurrentInvoiceSchedule(await current(), second!.scheduledJobId!),
      ).toBe(false);
      expect(await current()).toMatchObject({
        status: "unpaid",
        scheduledJobId: null,
        scheduledAt: null,
      });
    });

    test("generic unpaid edits cannot bypass durable issuance and concurrent retries share the operation", async () => {
      const request = {
        ...scope(),
        status: "unpaid" as const,
        internalNote: "reviewed",
      };
      const [a, b] = await Promise.all([
        updateInvoiceWithIntent(db, request),
        updateInvoiceWithIntent(db, request),
      ]);
      expect(operationId(a)).toBe(operationId(b));
      expect(await current()).toMatchObject({
        status: "unpaid",
        internalNote: "reviewed",
      });
      expect((await current()).documentSnapshot).not.toBeNull();
      expect(await intents()).toHaveLength(1);
      expect((await intents())[0]!.payload).toMatchObject({
        deliveryType: "create",
        invoiceId: scope().id,
      });
      expect(
        (await intents()).some((row) => row.jobName === "send-invoice-email"),
      ).toBe(false);
      expect(
        await updateInvoiceWithIntent(db, {
          ...request,
          teamId: fixture.other.teamId,
        }),
      ).toBeUndefined();
    });

    test("generic issuance rolls back notes as well as status when its durable intent conflicts", async () => {
      await ensureFinancialJobDispatch(db, {
        teamId: scope().teamId,
        jobName: "generate-invoice",
        source: `invoice/${scope().id}/issue/create`,
        payload: {
          teamId: scope().teamId,
          invoiceId: scope().id,
          deliveryType: "conflicting-fixture",
        },
      });
      await expect(
        updateInvoiceWithIntent(db, {
          ...scope(),
          status: "unpaid",
          internalNote: "must roll back",
        }),
      ).rejects.toThrow("conflict");
      expect(await current()).toMatchObject({
        status: "draft",
        internalNote: null,
        documentSnapshot: null,
      });
      expect(await intents()).toHaveLength(1);
    });

    test("generic schedule updates persist generations and cancellation invalidates them without Redis", async () => {
      await expect(
        updateInvoiceWithIntent(db, {
          ...scope(),
          status: "scheduled",
          internalNote: "invalid",
        }),
      ).rejects.toThrow("scheduledAt");
      expect(await current()).toMatchObject({
        status: "draft",
        internalNote: null,
      });
      const first = await updateInvoiceWithIntent(db, {
        ...scope(),
        status: "scheduled",
        scheduledAt: later(1),
        internalNote: "scheduled",
      });
      const second = await updateInvoiceWithIntent(db, {
        ...scope(),
        scheduledAt: later(2),
      });
      expect(second!.scheduledJobId).not.toBe(first!.scheduledJobId);
      expect(
        isCurrentInvoiceSchedule(await current(), first!.scheduledJobId!),
      ).toBe(false);
      expect(
        (await intents()).filter((row) => row.jobName === "generate-invoice"),
      ).toHaveLength(2);
      await updateInvoiceWithIntent(db, {
        ...scope(),
        scheduledAt: null,
        internalNote: "canceled",
      });
      expect(await current()).toMatchObject({
        status: "draft",
        scheduledAt: null,
        scheduledJobId: null,
        internalNote: "canceled",
      });
      expect(
        isCurrentInvoiceSchedule(await current(), second!.scheduledJobId!),
      ).toBe(false);
    });

    test("manual paid status retains settlement and commits PDF work without inventing an email send", async () => {
      const paidAt = new Date().toISOString();
      const first = await updateInvoiceWithIntent(db, {
        ...scope(),
        userId: fixture.own.userId,
        status: "paid",
        paidAt,
      });
      const retry = await updateInvoiceWithIntent(db, {
        ...scope(),
        userId: fixture.own.userId,
        status: "paid",
        paidAt,
      });
      expect(operationId(first)).toBe(operationId(retry));
      expect((await current()).status).toBe("paid");
      expect(new Date((await current()).paidAt!).toISOString()).toBe(paidAt);
      expect((await current()).documentSnapshot).not.toBeNull();
      expect(await intents()).toHaveLength(1);
      expect((await intents())[0]!.payload).toMatchObject({
        deliveryType: "create",
      });
      await expect(
        updateInvoiceWithIntent(db, { ...scope(), status: "unpaid" }),
      ).rejects.toThrow("finalized");
      expect((await current()).status).toBe("paid");
      expect(await intents()).toHaveLength(1);
    });

    test("an approved command rejects a customer or invoice revision change before any side effect", async () => {
      const preview = (await getInvoiceCommandPreview(db, scope()))!;
      await db
        .update(customers)
        .set({ email: "changed@example.test" })
        .where(eq(customers.id, fixture.own.customerId));
      await expect(
        issueInvoice(db, {
          ...scope(),
          deliveryType: "create_and_send",
          sentTo: preview.recipient,
          expectedRevision: preview.revision,
        }),
      ).rejects.toThrow("changed after preview");
      await expect(
        deleteInvoiceWithRevision(db, {
          ...scope(),
          expectedRevision: preview.revision,
        }),
      ).rejects.toThrow("changed after preview");
      expect((await current()).status).toBe("draft");
      expect(await intents()).toHaveLength(0);
      const latest = (await getInvoiceCommandPreview(db, scope()))!;
      await db
        .update(invoices)
        .set({ amount: 101 })
        .where(eq(invoices.id, scope().id));
      await expect(
        deleteInvoiceWithRevision(db, {
          ...scope(),
          expectedRevision: latest.revision,
        }),
      ).rejects.toThrow("changed after preview");
      expect((await current()).amount).toBe(101);
    });

    test("approved recipient is exact and frozen with all BCC destinations in the SQL intent", async () => {
      await db
        .update(customers)
        .set({ billingEmail: "accounts@example.test, finance@example.test" })
        .where(eq(customers.id, fixture.own.customerId));
      const preview = (await getInvoiceCommandPreview(db, scope()))!;
      await expect(
        issueInvoice(db, {
          ...scope(),
          deliveryType: "create_and_send",
          sentTo: "substituted@example.test",
          expectedRevision: preview.revision,
        }),
      ).rejects.toThrow("reviewed address");
      expect(await intents()).toHaveLength(0);
      await issueInvoice(db, {
        ...scope(),
        deliveryType: "create_and_send",
        sentTo: preview.recipient,
        expectedRevision: preview.revision,
      });
      await db
        .update(customers)
        .set({
          email: "later@example.test",
          billingEmail: "later-bcc@example.test",
        })
        .where(eq(customers.id, fixture.own.customerId));
      expect((await intents())[0]!.payload).toMatchObject({
        approvedRecipients: {
          recipient: preview.recipient,
          bcc: preview.bcc,
          customerName: preview.customerName,
        },
      });
      expect(JSON.stringify((await intents())[0]!.payload)).not.toContain(
        "later@example.test",
      );
      expect(JSON.stringify((await intents())[0]!.payload)).not.toContain(
        "later-bcc@example.test",
      );
    });

    test("outer approval failure rolls back the nested invoice command, and a current deletion preview works", async () => {
      const preview = (await getInvoiceCommandPreview(db, scope()))!;
      await expect(
        db.transaction(async (tx) => {
          await issueInvoice(tx, {
            ...scope(),
            deliveryType: "create_and_send",
            sentTo: preview.recipient,
            expectedRevision: preview.revision,
          });
          throw new Error("approval consume rollback fixture");
        }),
      ).rejects.toThrow("approval consume rollback");
      expect((await current()).status).toBe("draft");
      expect(await intents()).toHaveLength(0);
      expect(
        await getInvoiceCommandPreview(db, {
          id: scope().id,
          teamId: fixture.other.teamId,
        }),
      ).toBeUndefined();
      expect(
        await deleteInvoiceWithRevision(db, {
          ...scope(),
          expectedRevision: preview.revision,
        }),
      ).toEqual({ id: scope().id });
      expect(await current()).toBeUndefined();
    });

    test("a finalized invoice cannot be reopened by stale schedule, cancel or issue commands", async () => {
      await updateInvoice(db, {
        ...scope(),
        status: "paid",
        paidAt: new Date().toISOString(),
      });
      await expect(
        scheduleInvoice(db, { ...scope(), scheduledAt: later(1) }),
      ).rejects.toThrow("Only");
      await expect(cancelInvoiceSchedule(db, scope())).rejects.toThrow("Only");
      await expect(
        issueInvoice(db, { ...scope(), deliveryType: "create_and_send" }),
      ).rejects.toThrow("finalized");
      expect((await current()).status).toBe("paid");
      expect(await intents()).toHaveLength(0);
    });
  },
);
