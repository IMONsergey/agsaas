import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { upsertApiKey } from "../queries/api-keys";
import {
  getCustomerForEnrichment,
  updateCustomerEnrichment,
} from "../queries/customer-enrichment";
import { upsertCustomer } from "../queries/customers";
import {
  createDocumentTagAssignment,
  upsertDocumentTagAssignments,
} from "../queries/document-tag-assignments";
import { draftInvoice } from "../queries/invoices";
import {
  bulkCreateTrackerEntries,
  getCurrentTimer,
  getTimerStatus,
  startTimer,
  stopTimer,
  upsertTrackerEntries,
} from "../queries/tracker-entries";
import {
  getTrackerProjectById,
  upsertTrackerProject,
} from "../queries/tracker-projects";
import {
  type Attachment,
  createAttachments,
  deleteAttachment,
} from "../queries/transaction-attachments";
import {
  createTransactionTag,
  deleteTransactionTag,
} from "../queries/transaction-tags";
import {
  accountingSyncRecords,
  activities,
  apiKeys,
  customers,
  customerTags,
  documentTagAssignments,
  inbox,
  invoices,
  trackerEntries,
  trackerProjects,
  transactionAttachments,
  transactionMatchSuggestions,
  transactions,
  transactionTags,
} from "../schema";
import { TenantResourceNotFoundError } from "../utils/tenant-ownership";
import {
  createTenantIsolationFixture,
  removeTenantIsolationFixture,
  type TenantFixtureIds,
  type TenantIsolationFixture,
} from "./helpers/tenant-isolation-fixture";
import { setupTenantIsolationQueryFunctions } from "./helpers/tenant-isolation-functions";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const manualCustomerDetails = {
  addressLine1: "100 Demo Street",
  city: "New York",
  state: "NY",
  country: "United States",
  countryCode: "US",
  zip: "10001",
  vatNumber: "MANUAL-VAT",
};

const providerEnrichment = {
  description: "Verified provider profile",
  industry: "Software",
  addressLine1: "200 Provider Street",
  city: "Toronto",
  state: "ON",
  country: "Canada",
  zipCode: "M5V 2T6",
  vatNumber: "PROVIDER-VAT",
};

function invoiceInput(
  tenant: TenantFixtureIds,
  overrides: Partial<Parameters<typeof draftInvoice>[1]> = {},
): Parameters<typeof draftInvoice>[1] {
  return {
    id: tenant.invoiceId,
    teamId: tenant.teamId,
    userId: tenant.userId,
    customerId: tenant.customerId,
    templateId: tenant.templateId,
    template: { currency: "USD" },
    invoiceNumber: "UPDATED-001",
    dueDate: "2026-02-01T00:00:00.000Z",
    issueDate: "2026-01-01T00:00:00.000Z",
    amount: 200,
    token: "fixture-new-invoice-token",
    ...overrides,
  };
}

function trackerInput(tenant: TenantFixtureIds) {
  return {
    start: "2026-01-01T10:00:00.000Z",
    stop: "2026-01-01T12:00:00.000Z",
    dates: ["2026-01-01"],
    projectId: tenant.projectId,
    assignedId: tenant.userId,
    duration: 7200,
  };
}

function attachmentInput(
  tenant: TenantFixtureIds,
  transactionId = tenant.transactionId,
): Attachment {
  return {
    transactionId,
    name: "fixture.pdf",
    type: "application/pdf",
    size: 123,
    path: [tenant.teamId, "fixtures", `${randomUUID()}.pdf`],
  };
}

async function runningTimerFromYesterday(
  db: Database,
  tenant: TenantFixtureIds,
) {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(12, 0, 0, 0);
  const id = randomUUID();
  await db.insert(trackerEntries).values({
    id,
    teamId: tenant.teamId,
    projectId: tenant.projectId,
    assignedId: tenant.userId,
    start: start.toISOString(),
    date: start.toISOString().slice(0, 10),
    stop: null,
    duration: null,
  });
  return { id, start: start.toISOString() };
}

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow(TenantResourceNotFoundError);
}

// Real PostgreSQL and real query functions; no mocked query execution. The
// privileged test connection intentionally bypasses RLS. Real auth/RLS is not
// validated: the shared test setup supplies synthetic auth functions.
// Run separately from suites that TRUNCATE tables or install module mocks.
describe.skipIf(!isTestDatabaseAvailable())(
  "tenant isolation (PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture | undefined;
    let previousInvoiceSecret: string | undefined;

    beforeAll(async () => {
      previousInvoiceSecret = process.env.INVOICE_JWT_SECRET;
      process.env.INVOICE_JWT_SECRET = "local-tenant-isolation-fixture-secret";
      db = getTestDatabase();
      await setupTenantIsolationQueryFunctions(db);
    });

    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
    });

    afterEach(async () => {
      if (fixture) {
        await removeTenantIsolationFixture(db, fixture);
        fixture = undefined;
      }
    });

    afterAll(async () => {
      try {
        await closeDatabase();
      } finally {
        if (previousInvoiceSecret === undefined) {
          delete process.env.INVOICE_JWT_SECRET;
        } else {
          process.env.INVOICE_JWT_SECRET = previousInvoiceSecret;
        }
      }
    });

    test("invoice upsert cannot transfer another team's invoice", async () => {
      const { own, other } = fixture!;
      const before = await db.query.invoices.findFirst({
        where: eq(invoices.id, other.invoiceId),
      });

      await expectNotFound(
        draftInvoice(db, invoiceInput(own, { id: other.invoiceId })),
      );

      expect(
        await db.query.invoices.findFirst({
          where: eq(invoices.id, other.invoiceId),
        }),
      ).toEqual(before);
    });

    test("invoice drafts create and update within their own team", async () => {
      const { own } = fixture!;
      const id = randomUUID();
      const created = await draftInvoice(db, invoiceInput(own, { id }));
      expect(created).toMatchObject({
        id,
        teamId: own.teamId,
        customerId: own.customerId,
        templateId: own.templateId,
        amount: 200,
      });

      const updated = await draftInvoice(
        db,
        invoiceInput(own, { id, amount: 300 }),
      );
      expect(updated).toMatchObject({ id, teamId: own.teamId, amount: 300 });
      expect(await db.$count(invoices, eq(invoices.teamId, own.teamId))).toBe(
        2,
      );
    });

    test("invoice rejects foreign and missing customers before inserting", async () => {
      const { own, other } = fixture!;
      const otherCustomer = await db.query.customers.findFirst({
        where: eq(customers.id, other.customerId),
      });
      for (const customerId of [other.customerId, randomUUID()]) {
        const id = randomUUID();
        await expectNotFound(
          draftInvoice(db, invoiceInput(own, { id, customerId })),
        );
        expect(await db.$count(invoices, eq(invoices.id, id))).toBe(0);
      }
      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, other.customerId),
        }),
      ).toEqual(otherCustomer);
    });

    test("invoice rejects a foreign template without changing an existing draft", async () => {
      const { own, other } = fixture!;
      const before = await db.query.invoices.findFirst({
        where: eq(invoices.id, own.invoiceId),
      });
      await expectNotFound(
        draftInvoice(db, invoiceInput(own, { templateId: other.templateId })),
      );
      expect(
        await db.query.invoices.findFirst({
          where: eq(invoices.id, own.invoiceId),
        }),
      ).toEqual(before);
    });

    test("API key update cannot change another team's name or scopes", async () => {
      const { own, other } = fixture!;
      const before = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, other.apiKeyId),
      });
      for (const id of [other.apiKeyId, randomUUID()]) {
        await expectNotFound(
          upsertApiKey(db, {
            id,
            teamId: own.teamId,
            userId: own.userId,
            name: "Unexpected change",
            scopes: ["customers.write"],
          }),
        );
      }
      expect(
        await db.query.apiKeys.findFirst({
          where: eq(apiKeys.id, other.apiKeyId),
        }),
      ).toEqual(before);
    });

    test("API key update retains the allowed team operation and cache invalidation hash", async () => {
      const { own } = fixture!;
      const result = await upsertApiKey(db, {
        id: own.apiKeyId,
        teamId: own.teamId,
        userId: own.userId,
        name: "Updated own key",
        scopes: ["customers.read", "customers.write"],
      });
      expect(result).toEqual({ key: null, keyHash: own.apiKeyId });
      expect(
        await db.query.apiKeys.findFirst({
          where: eq(apiKeys.id, own.apiKeyId),
        }),
      ).toMatchObject({
        teamId: own.teamId,
        name: "Updated own key",
        scopes: ["customers.read", "customers.write"],
      });
    });

    test("customer upsert cannot alter another customer or remove their tags", async () => {
      const { own, other } = fixture!;
      const before = await db.query.customers.findFirst({
        where: eq(customers.id, other.customerId),
      });
      const tagsBefore = await db
        .select()
        .from(customerTags)
        .where(eq(customerTags.customerId, other.customerId));

      await expectNotFound(
        upsertCustomer(db, {
          id: other.customerId,
          teamId: own.teamId,
          userId: own.userId,
          name: "Unexpected change",
          email: "unexpected@example.test",
          // Omitted tags used to delete all tags on the foreign customer.
        }),
      );

      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, other.customerId),
        }),
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(customerTags)
          .where(eq(customerTags.customerId, other.customerId)),
      ).toEqual(tagsBefore);
    });

    test("customers still create and update with their own tags", async () => {
      const { own } = fixture!;
      const created = await upsertCustomer(db, {
        teamId: own.teamId,
        userId: own.userId,
        name: "New own customer",
        email: "new@example.test",
        tags: [{ id: own.tagId, name: "Fixture tag" }],
      });
      expect(created).toMatchObject({
        name: "New own customer",
        teamId: own.teamId,
      });
      expect(created?.tags).toEqual([{ id: own.tagId, name: "Fixture tag" }]);

      const updated = await upsertCustomer(db, {
        id: created!.id,
        teamId: own.teamId,
        name: "Updated own customer",
        email: "updated@example.test",
        tags: [],
      });
      expect(updated).toMatchObject({
        id: created!.id,
        teamId: own.teamId,
        name: "Updated own customer",
        tags: [],
      });
    });

    test("empty customer enrichment preserves the manually saved address", async () => {
      const { own } = fixture!;
      await upsertCustomer(db, {
        id: own.customerId,
        teamId: own.teamId,
        name: "Manual customer",
        email: "manual@example.test",
        ...manualCustomerDetails,
      });
      await db
        .update(customers)
        .set({ description: "Existing profile" })
        .where(eq(customers.id, own.customerId));

      // Missing provider configuration/no match produces these null fields.
      await updateCustomerEnrichment(db, {
        customerId: own.customerId,
        teamId: own.teamId,
        data: {
          description: null,
          addressLine1: null,
          city: null,
          state: null,
          country: null,
          zipCode: null,
          vatNumber: null,
        },
      });

      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, own.customerId),
        }),
      ).toMatchObject({
        ...manualCustomerDetails,
        description: "Existing profile",
        enrichmentStatus: "completed",
      });
    });

    test("customer enrichment preserves manual edits made after the worker read", async () => {
      const { own } = fixture!;
      const snapshot = await getCustomerForEnrichment(db, {
        customerId: own.customerId,
        teamId: own.teamId,
      });
      expect(snapshot).toMatchObject({
        addressLine1: null,
        city: null,
        state: null,
        country: null,
        vatNumber: null,
      });

      // The provider request is in flight while the owner saves an address.
      await upsertCustomer(db, {
        id: own.customerId,
        teamId: own.teamId,
        name: "Manual customer",
        email: "manual@example.test",
        ...manualCustomerDetails,
      });
      await updateCustomerEnrichment(db, {
        customerId: own.customerId,
        teamId: own.teamId,
        data: providerEnrichment,
      });

      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, own.customerId),
        }),
      ).toMatchObject({
        ...manualCustomerDetails,
        description: providerEnrichment.description,
        industry: providerEnrichment.industry,
        enrichmentStatus: "completed",
      });
    });

    for (const empty of [null, "", "   "]) {
      test(`customer enrichment fills ${JSON.stringify(empty)} address fields and maps the provider ZIP`, async () => {
        const { own } = fixture!;
        await db
          .update(customers)
          .set({
            addressLine1: empty,
            city: empty,
            state: empty,
            country: empty,
            zip: empty,
            vatNumber: empty,
          })
          .where(eq(customers.id, own.customerId));

        await updateCustomerEnrichment(db, {
          customerId: own.customerId,
          teamId: own.teamId,
          data: providerEnrichment,
        });

        expect(
          await db.query.customers.findFirst({
            where: eq(customers.id, own.customerId),
          }),
        ).toMatchObject({
          addressLine1: providerEnrichment.addressLine1,
          city: providerEnrichment.city,
          state: providerEnrichment.state,
          country: providerEnrichment.country,
          zip: providerEnrichment.zipCode,
          vatNumber: providerEnrichment.vatNumber,
          description: providerEnrichment.description,
          industry: providerEnrichment.industry,
          enrichmentStatus: "completed",
        });
      });
    }

    test("customer enrichment rechecks manual fields after waiting for a row lock", async () => {
      const { own } = fixture!;
      const enrichment: {
        pending?: Promise<{ error: unknown }>;
        result?: { error: unknown };
      } = {};
      try {
        await db.transaction(async (tx) => {
          const owner = await tx.execute(sql`select pg_backend_pid() as pid`);
          const ownerPid = Number(owner.rows[0]?.pid);
          await tx
            .update(customers)
            .set(manualCustomerDetails)
            .where(eq(customers.id, own.customerId));

          // A second connection sees the old NULL address until this commits.
          enrichment.pending = updateCustomerEnrichment(db, {
            customerId: own.customerId,
            teamId: own.teamId,
            data: providerEnrichment,
          }).then(
            () => ({ error: null }),
            (error: unknown) => ({ error }),
          );

          const deadline = Date.now() + 2_000;
          let waiting = false;
          while (Date.now() < deadline) {
            const locks = await db.execute(sql`
              select exists (
                select 1 from pg_stat_activity
                where ${ownerPid} = any(pg_blocking_pids(pid))
              ) as waiting
            `);
            if (locks.rows[0]?.waiting === true) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          // Commit the owner's edit before the enrichment UPDATE can resume.
        });
      } finally {
        // Always release the lock before draining the concurrent query.
        enrichment.result = await enrichment.pending;
      }
      if (enrichment.result && enrichment.result.error !== null) {
        throw enrichment.result.error;
      }

      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, own.customerId),
        }),
      ).toMatchObject({
        ...manualCustomerDetails,
        description: providerEnrichment.description,
        enrichmentStatus: "completed",
      });
    });

    test("customer enrichment ignores row fields outside its explicit mapping", async () => {
      const { own, other } = fixture!;
      const before = await db.query.customers.findFirst({
        where: eq(customers.id, own.customerId),
      });
      // Structural typing does not strip extra runtime provider properties.
      const data = {
        description: providerEnrichment.description,
        teamId: other.teamId,
        name: "Unexpected provider name",
        email: "unexpected@example.test",
        countryCode: "CA",
        addressLine2: "Unexpected suite",
        zip: "UNMAPPED-ZIP",
        note: "Unexpected note",
      };
      await updateCustomerEnrichment(db, {
        customerId: own.customerId,
        teamId: own.teamId,
        data,
      });

      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, own.customerId),
        }),
      ).toMatchObject({
        id: own.customerId,
        teamId: own.teamId,
        name: before!.name,
        email: before!.email,
        countryCode: before!.countryCode,
        addressLine2: before!.addressLine2,
        zip: before!.zip,
        note: before!.note,
        description: providerEnrichment.description,
        enrichmentStatus: "completed",
      });
    });

    test("customer enrichment cannot write another team's customer", async () => {
      const { own, other } = fixture!;
      const before = await db.query.customers.findFirst({
        where: eq(customers.id, other.customerId),
      });

      await updateCustomerEnrichment(db, {
        customerId: other.customerId,
        teamId: own.teamId,
        data: providerEnrichment,
      });

      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, other.customerId),
        }),
      ).toEqual(before);
    });

    test("customer rejects foreign tags before changing the customer", async () => {
      const { own, other } = fixture!;
      const before = await db.query.customers.findFirst({
        where: eq(customers.id, own.customerId),
      });
      await expectNotFound(
        upsertCustomer(db, {
          id: own.customerId,
          teamId: own.teamId,
          name: "Unexpected change",
          email: "unexpected@example.test",
          tags: [
            { id: own.tagId, name: "Own" },
            { id: other.tagId, name: "Foreign" },
          ],
        }),
      );
      expect(
        await db.query.customers.findFirst({
          where: eq(customers.id, own.customerId),
        }),
      ).toEqual(before);
      expect(
        await db.$count(
          customerTags,
          eq(customerTags.customerId, own.customerId),
        ),
      ).toBe(1);
    });

    test("customer and activity writes roll back when tag insertion fails", async () => {
      const { own } = fixture!;
      await expect(
        upsertCustomer(db, {
          teamId: own.teamId,
          userId: own.userId,
          name: "Must roll back",
          email: "rollback@example.test",
          tags: [
            { id: own.tagId, name: "Duplicate" },
            { id: own.tagId, name: "Duplicate" },
          ],
        }),
      ).rejects.toThrow();
      expect(await db.$count(customers, eq(customers.teamId, own.teamId))).toBe(
        1,
      );
      expect(
        await db.$count(activities, eq(activities.teamId, own.teamId)),
      ).toBe(0);
    });

    test("tracker entry upsert cannot update another team's entry", async () => {
      const { own, other } = fixture!;
      const before = await db.query.trackerEntries.findFirst({
        where: eq(trackerEntries.id, other.entryId),
      });
      await expectNotFound(
        upsertTrackerEntries(db, {
          ...trackerInput(own),
          id: other.entryId,
          teamId: own.teamId,
        }),
      );
      expect(
        await db.query.trackerEntries.findFirst({
          where: eq(trackerEntries.id, other.entryId),
        }),
      ).toEqual(before);
    });

    test("tracker entry updates return only the own project and customer", async () => {
      const { own } = fixture!;
      const result = await upsertTrackerEntries(db, {
        ...trackerInput(own),
        id: own.entryId,
        teamId: own.teamId,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: own.entryId,
        duration: 7200,
        teamId: own.teamId,
      });
      expect(result[0]?.trackerProject).toMatchObject({
        id: own.projectId,
        teamId: own.teamId,
        customer: { id: own.customerId },
      });
    });

    test("tracker entry rejects a foreign project or assignee before inserting", async () => {
      const { own, other } = fixture!;
      for (const override of [
        { projectId: other.projectId },
        { projectId: randomUUID() },
        { assignedId: other.userId },
      ]) {
        await expectNotFound(
          upsertTrackerEntries(db, {
            ...trackerInput(own),
            ...override,
            teamId: own.teamId,
          }),
        );
      }
      expect(
        await db.$count(trackerEntries, eq(trackerEntries.teamId, own.teamId)),
      ).toBe(1);
      expect(
        await db.$count(activities, eq(activities.teamId, own.teamId)),
      ).toBe(0);
    });

    test("tracker bulk insert validates the whole batch and allows valid batches", async () => {
      const { own, other } = fixture!;
      await expectNotFound(
        bulkCreateTrackerEntries(db, {
          teamId: own.teamId,
          entries: [
            trackerInput(own),
            { ...trackerInput(own), projectId: other.projectId },
          ],
        }),
      );
      expect(
        await db.$count(trackerEntries, eq(trackerEntries.teamId, own.teamId)),
      ).toBe(1);

      const created = await bulkCreateTrackerEntries(db, {
        teamId: own.teamId,
        entries: [
          { ...trackerInput(own), dates: ["2026-01-02", "2026-01-03"] },
        ],
      });
      expect(created).toHaveLength(2);
      expect(
        created.every(
          (entry) =>
            entry.teamId === own.teamId &&
            entry.trackerProject?.customer?.id === own.customerId,
        ),
      ).toBe(true);
    });

    test("invalid timer links do not stop the current timer; own timer creation works", async () => {
      const { own, other } = fixture!;
      const currentId = randomUUID();
      const now = new Date().toISOString();
      await db.insert(trackerEntries).values({
        id: currentId,
        teamId: own.teamId,
        projectId: own.projectId,
        assignedId: own.userId,
        start: now,
        date: now.slice(0, 10),
        stop: null,
        duration: null,
      });

      await expectNotFound(
        startTimer(db, {
          teamId: own.teamId,
          projectId: other.projectId,
          assignedId: own.userId,
        }),
      );
      expect(
        await db.query.trackerEntries.findFirst({
          where: eq(trackerEntries.id, currentId),
        }),
      ).toMatchObject({ stop: null, duration: null });

      const timer = await startTimer(db, {
        teamId: own.teamId,
        projectId: own.projectId,
        assignedId: own.userId,
      });
      expect(timer).toMatchObject({
        teamId: own.teamId,
        stop: null,
        project: { id: own.projectId, customer: { id: own.customerId } },
      });
      expect(
        (
          await db.query.trackerEntries.findFirst({
            where: eq(trackerEntries.id, currentId),
          })
        )?.stop,
      ).not.toBeNull();
    });

    test("running timer survives midnight and remains scoped to its team and assignee", async () => {
      const { own, other } = fixture!;
      const overnight = await runningTimerFromYesterday(db, own);
      await runningTimerFromYesterday(db, other);

      expect(
        await getCurrentTimer(db, {
          teamId: own.teamId,
          assignedId: own.userId,
        }),
      ).toMatchObject({ id: overnight.id, stop: null });
      const status = await getTimerStatus(db, {
        teamId: own.teamId,
        assignedId: own.userId,
      });
      expect(status.isRunning).toBe(true);
      expect(status.currentEntry?.id).toBe(overnight.id);
      expect(status.elapsedTime).toBeGreaterThan(60);
      expect(
        await getCurrentTimer(db, {
          teamId: own.teamId,
          assignedId: other.userId,
        }),
      ).toBeNull();
      expect(
        await getCurrentTimer(db, {
          teamId: other.teamId,
          assignedId: own.userId,
        }),
      ).toBeNull();
    });

    test("stop without an entry ID closes yesterday's timer and preserves the other team", async () => {
      const { own, other } = fixture!;
      const overnight = await runningTimerFromYesterday(db, own);
      const foreign = await runningTimerFromYesterday(db, other);
      const stop = new Date().toISOString();
      const expectedDuration = Math.floor(
        (Date.parse(stop) - Date.parse(overnight.start)) / 1000,
      );

      const result = await stopTimer(db, {
        teamId: own.teamId,
        assignedId: own.userId,
        stop,
      });
      expect(result).toMatchObject({
        id: overnight.id,
        duration: expectedDuration,
      });
      const saved = await db.query.trackerEntries.findFirst({
        where: eq(trackerEntries.id, overnight.id),
      });
      expect(Date.parse(saved!.stop!)).toBe(Date.parse(stop));
      expect(saved?.duration).toBe(expectedDuration);
      expect(
        await getCurrentTimer(db, {
          teamId: own.teamId,
          assignedId: own.userId,
        }),
      ).toBeNull();
      expect(
        await db.query.trackerEntries.findFirst({
          where: eq(trackerEntries.id, foreign.id),
        }),
      ).toMatchObject({ stop: null, duration: null });
    });

    test("starting a timer closes yesterday's own timer only, after validating links", async () => {
      const { own, other } = fixture!;
      const overnight = await runningTimerFromYesterday(db, own);
      const foreign = await runningTimerFromYesterday(db, other);

      await expectNotFound(
        startTimer(db, {
          teamId: own.teamId,
          projectId: other.projectId,
          assignedId: own.userId,
        }),
      );
      expect(
        await db.query.trackerEntries.findFirst({
          where: eq(trackerEntries.id, overnight.id),
        }),
      ).toMatchObject({ stop: null, duration: null });

      const next = await startTimer(db, {
        teamId: own.teamId,
        projectId: own.projectId,
        assignedId: own.userId,
      });
      expect(next?.id).not.toBe(overnight.id);
      const previous = await db.query.trackerEntries.findFirst({
        where: eq(trackerEntries.id, overnight.id),
      });
      expect(previous?.stop).not.toBeNull();
      expect(previous?.duration).toBeGreaterThan(60);
      expect(
        await getCurrentTimer(db, {
          teamId: own.teamId,
          assignedId: own.userId,
        }),
      ).toMatchObject({ id: next!.id, stop: null });
      expect(
        await db.query.trackerEntries.findFirst({
          where: eq(trackerEntries.id, foreign.id),
        }),
      ).toMatchObject({ stop: null, duration: null });
    });

    test("project rejects foreign customer and tags without modifying its row", async () => {
      const { own, other } = fixture!;
      const before = await db.query.trackerProjects.findFirst({
        where: eq(trackerProjects.id, own.projectId),
      });
      for (const override of [
        { customerId: other.customerId },
        { tags: [{ id: other.tagId, value: "Foreign" }] },
      ]) {
        await expectNotFound(
          upsertTrackerProject(db, {
            id: own.projectId,
            teamId: own.teamId,
            name: "Unexpected change",
            ...override,
          }),
        );
      }
      expect(
        await db.query.trackerProjects.findFirst({
          where: eq(trackerProjects.id, own.projectId),
        }),
      ).toEqual(before);
    });

    test("project conflict cannot update another team's row", async () => {
      const { own, other } = fixture!;
      const before = await db.query.trackerProjects.findFirst({
        where: eq(trackerProjects.id, other.projectId),
      });
      await expectNotFound(
        upsertTrackerProject(db, {
          id: other.projectId,
          teamId: own.teamId,
          name: "Unexpected change",
          customerId: own.customerId,
        }),
      );
      expect(
        await db.query.trackerProjects.findFirst({
          where: eq(trackerProjects.id, other.projectId),
        }),
      ).toEqual(before);
    });

    test("project creates and updates with its own customer and tags", async () => {
      const { own } = fixture!;
      const created = await upsertTrackerProject(db, {
        teamId: own.teamId,
        userId: own.userId,
        name: "New own project",
        customerId: own.customerId,
        tags: [{ id: own.tagId, value: "Fixture tag" }],
      });
      expect(created).toMatchObject({
        teamId: own.teamId,
        name: "New own project",
        customer: { id: own.customerId },
        tags: [{ id: own.tagId, name: "Fixture tag" }],
      });
      const updated = await upsertTrackerProject(db, {
        id: created!.id,
        teamId: own.teamId,
        name: "Updated own project",
        tags: [],
      });
      expect(updated).toMatchObject({
        id: created!.id,
        teamId: own.teamId,
        name: "Updated own project",
        tags: [],
      });
    });

    test("project read does not expose a customer behind a legacy cross-team link", async () => {
      const { own, other } = fixture!;
      await db
        .update(trackerProjects)
        .set({ customerId: other.customerId })
        .where(eq(trackerProjects.id, own.projectId));

      const project = await getTrackerProjectById(db, {
        id: own.projectId,
        teamId: own.teamId,
      });

      expect(project).toMatchObject({ id: own.projectId, teamId: own.teamId });
      expect(project?.customer).toBeNull();
    });

    test("attachment batch rejects a foreign transaction without partial writes or export resets", async () => {
      const { own, other } = fixture!;
      await db.insert(accountingSyncRecords).values({
        teamId: own.teamId,
        transactionId: own.transactionId,
        provider: "xero",
        providerTenantId: "fixture-provider",
      });
      await expectNotFound(
        createAttachments(db, {
          teamId: own.teamId,
          userId: own.userId,
          attachments: [
            attachmentInput(own),
            attachmentInput(own, other.transactionId),
          ],
        }),
      );
      expect(
        await db.$count(
          transactionAttachments,
          eq(transactionAttachments.teamId, own.teamId),
        ),
      ).toBe(0);
      expect(
        await db.$count(
          accountingSyncRecords,
          eq(accountingSyncRecords.teamId, own.teamId),
        ),
      ).toBe(1);
      expect(
        await db.$count(activities, eq(activities.teamId, own.teamId)),
      ).toBe(0);
    });

    test("own attachments create and delete with matching and export side effects", async () => {
      const { own } = fixture!;
      const created = await createAttachments(db, {
        teamId: own.teamId,
        userId: own.userId,
        attachments: [attachmentInput(own), attachmentInput(own)],
      });
      expect(created).toHaveLength(2);
      const attachment = created[0]!;
      const inboxId = randomUUID();
      await db.insert(inbox).values({
        id: inboxId,
        teamId: own.teamId,
        transactionId: own.transactionId,
        attachmentId: attachment.id,
        status: "done",
      });
      await db.insert(transactionMatchSuggestions).values({
        teamId: own.teamId,
        inboxId,
        transactionId: own.transactionId,
        confidenceScore: 1,
        matchType: "auto_matched",
        status: "confirmed",
      });
      await db.insert(accountingSyncRecords).values({
        teamId: own.teamId,
        transactionId: own.transactionId,
        provider: "xero",
        providerTenantId: "fixture-provider",
      });

      await deleteAttachment(db, { id: attachment.id, teamId: own.teamId });

      expect(
        await db.$count(
          transactionAttachments,
          eq(transactionAttachments.teamId, own.teamId),
        ),
      ).toBe(1);
      expect(
        await db.query.transactions.findFirst({
          where: eq(transactions.id, own.transactionId),
        }),
      ).toMatchObject({ taxRate: null, taxType: null });
      expect(
        await db.query.inbox.findFirst({ where: eq(inbox.id, inboxId) }),
      ).toMatchObject({
        attachmentId: null,
        transactionId: null,
        status: "pending",
      });
      expect(
        await db.query.transactionMatchSuggestions.findFirst({
          where: eq(transactionMatchSuggestions.inboxId, inboxId),
        }),
      ).toMatchObject({ status: "unmatched" });
      expect(
        await db.$count(
          accountingSyncRecords,
          eq(accountingSyncRecords.teamId, own.teamId),
        ),
      ).toBe(0);
    });

    test("deleting a legacy cross-team attachment does not clear foreign tax or inbox links", async () => {
      const { own, other } = fixture!;
      const attachmentId = randomUUID();
      const inboxId = randomUUID();
      // Seed a pre-existing invalid link directly, bypassing the now-protected create query.
      await db.insert(transactionAttachments).values({
        id: attachmentId,
        teamId: own.teamId,
        transactionId: other.transactionId,
        path: [own.teamId, "legacy.pdf"],
      });
      await db.insert(inbox).values({
        id: inboxId,
        teamId: other.teamId,
        transactionId: other.transactionId,
        status: "done",
      });
      await db.insert(accountingSyncRecords).values({
        teamId: other.teamId,
        transactionId: other.transactionId,
        provider: "xero",
        providerTenantId: "fixture-provider",
      });
      const transactionBefore = await db.query.transactions.findFirst({
        where: eq(transactions.id, other.transactionId),
      });
      const inboxBefore = await db.query.inbox.findFirst({
        where: eq(inbox.id, inboxId),
      });

      await deleteAttachment(db, { id: attachmentId, teamId: own.teamId });

      expect(
        await db.query.transactions.findFirst({
          where: eq(transactions.id, other.transactionId),
        }),
      ).toEqual(transactionBefore);
      expect(
        await db.query.inbox.findFirst({ where: eq(inbox.id, inboxId) }),
      ).toEqual(inboxBefore);
      expect(
        await db.$count(
          accountingSyncRecords,
          eq(accountingSyncRecords.teamId, other.teamId),
        ),
      ).toBe(1);
      expect(
        await db.$count(
          transactionAttachments,
          eq(transactionAttachments.id, attachmentId),
        ),
      ).toBe(0);
    });

    test("attachment deletion cannot remove a foreign attachment", async () => {
      const { own, other } = fixture!;
      const [attachment] = await createAttachments(db, {
        teamId: other.teamId,
        attachments: [attachmentInput(other)],
      });
      await expectNotFound(
        deleteAttachment(db, { id: attachment!.id, teamId: own.teamId }),
      );
      expect(
        await db.query.transactionAttachments.findFirst({
          where: eq(transactionAttachments.id, attachment!.id),
        }),
      ).toEqual(attachment);
    });

    test("document assignments reject foreign documents and document tags", async () => {
      const { own, other } = fixture!;
      for (const [documentId, tagId] of [
        [other.documentId, own.documentTagId],
        [own.documentId, other.documentTagId],
      ]) {
        await expectNotFound(
          createDocumentTagAssignment(db, {
            teamId: own.teamId,
            documentId: documentId!,
            tagId: tagId!,
          }),
        );
      }
      expect(
        await db.$count(
          documentTagAssignments,
          eq(documentTagAssignments.teamId, own.teamId),
        ),
      ).toBe(0);
      expect(
        await db.$count(
          documentTagAssignments,
          eq(documentTagAssignments.teamId, other.teamId),
        ),
      ).toBe(0);
    });

    test("document assignment batch validates every team before any insertion", async () => {
      const { own, other } = fixture!;
      await expectNotFound(
        upsertDocumentTagAssignments(db, [
          {
            teamId: own.teamId,
            documentId: own.documentId,
            tagId: own.documentTagId,
          },
          {
            teamId: other.teamId,
            documentId: other.documentId,
            tagId: own.documentTagId,
          },
        ]),
      );
      expect(
        await db.$count(
          documentTagAssignments,
          eq(documentTagAssignments.teamId, own.teamId),
        ),
      ).toBe(0);
      expect(
        await db.$count(
          documentTagAssignments,
          eq(documentTagAssignments.teamId, other.teamId),
        ),
      ).toBe(0);
    });

    test("document assignments retain valid create and idempotent multi-team batch behavior", async () => {
      const { own, other } = fixture!;
      const ownAssignment = {
        teamId: own.teamId,
        documentId: own.documentId,
        tagId: own.documentTagId,
      };
      expect(await createDocumentTagAssignment(db, ownAssignment)).toEqual(
        ownAssignment,
      );
      const otherAssignment = {
        teamId: other.teamId,
        documentId: other.documentId,
        tagId: other.documentTagId,
      };
      expect(
        await upsertDocumentTagAssignments(db, [
          ownAssignment,
          otherAssignment,
        ]),
      ).toEqual([otherAssignment]);
      expect(
        await upsertDocumentTagAssignments(db, [
          ownAssignment,
          otherAssignment,
        ]),
      ).toEqual([]);
    });

    test("transaction tags reject foreign transactions and tags without writing links", async () => {
      const { own, other } = fixture!;
      const foreignTransaction = await db.query.transactions.findFirst({
        where: eq(transactions.id, other.transactionId),
      });
      for (const override of [
        { transactionId: other.transactionId },
        { tagId: other.tagId },
      ]) {
        await expectNotFound(
          createTransactionTag(db, {
            teamId: own.teamId,
            transactionId: own.transactionId,
            tagId: own.tagId,
            ...override,
          }),
        );
      }
      expect(
        await db.$count(
          transactionTags,
          eq(transactionTags.teamId, own.teamId),
        ),
      ).toBe(0);
      expect(
        await db.query.transactions.findFirst({
          where: eq(transactions.id, other.transactionId),
        }),
      ).toEqual(foreignTransaction);
    });

    test("transaction tags create in their team and retain scoped deletion", async () => {
      const { own, other } = fixture!;
      const input = {
        teamId: own.teamId,
        transactionId: own.transactionId,
        tagId: own.tagId,
      };
      expect(await createTransactionTag(db, input)).toMatchObject([input]);
      await deleteTransactionTag(db, { ...input, teamId: other.teamId });
      expect(
        await db.$count(
          transactionTags,
          and(
            eq(transactionTags.teamId, own.teamId),
            eq(transactionTags.transactionId, own.transactionId),
          ),
        ),
      ).toBe(1);
      await deleteTransactionTag(db, input);
      expect(
        await db.$count(
          transactionTags,
          eq(transactionTags.teamId, own.teamId),
        ),
      ).toBe(0);
    });
  },
);
