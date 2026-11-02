import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { InvoiceFinancialStateError } from "@midday/invoice/calculate";
import type { EditorDoc } from "@midday/invoice/types";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  draftInvoice,
  getInvoiceById,
  getInvoiceDocumentById,
  getPublishedInvoiceById,
  prepareInvoiceDocument,
  updateInvoice,
} from "../queries/invoices";
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
  "invoice numbers and immutable documents (real PostgreSQL)",
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

    function input(
      overrides: Partial<Parameters<typeof draftInvoice>[1]> = {},
    ) {
      const own = fixture.own;
      return {
        id: own.invoiceId,
        teamId: own.teamId,
        userId: own.userId,
        customerId: own.customerId,
        invoiceNumber: "DOCUMENT-100",
        token: "fixture-public-token",
        issueDate: "2026-11-01T00:00:00.000Z",
        dueDate: "2026-12-01T00:00:00.000Z",
        template: { currency: "USD", paymentEnabled: true },
        lineItems: [{ name: "Design", unit: "hour", price: 100, quantity: 2 }],
        ...overrides,
      };
    }

    test("draft previews do not publish; issue captures the document and live payment state remains current", async () => {
      const draft = input();
      const originalNote: EditorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "original printable note" }],
          },
        ],
      };
      const workingNote: EditorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "working note" }],
          },
        ],
      };
      // Match the actual JSONB editor shape produced by API input parsing.
      const writeNote = (note: EditorDoc) =>
        db.execute(sql`UPDATE public.invoices
          SET note_details = ${JSON.stringify(note)}::jsonb
          WHERE id = ${draft.id} AND team_id = ${draft.teamId}`);
      await draftInvoice(db, draft);
      await writeNote(originalNote);
      expect(
        (await getInvoiceDocumentById(db, draft))?.documentSnapshot,
      ).toBeNull();
      expect(await getPublishedInvoiceById(db, draft)).toBeNull();
      await updateInvoice(db, {
        id: draft.id,
        teamId: draft.teamId,
        status: "unpaid",
        internalNote: "operator-only",
      });
      const issued = await getInvoiceDocumentById(db, draft);
      expect(issued?.documentSnapshot?.source).toBe("issued");
      await draftInvoice(db, {
        ...draft,
        dueDate: "2027-01-01T00:00:00.000Z",
      });
      await writeNote(workingNote);
      expect((await getInvoiceById(db, draft))?.noteDetails).toEqual(
        workingNote,
      );
      const document = await getInvoiceDocumentById(db, draft);
      expect(document?.noteDetails).toEqual(originalNote);
      expect(new Date(document!.dueDate!).toISOString()).toBe(draft.dueDate);
      await updateInvoice(db, {
        id: draft.id,
        teamId: draft.teamId,
        status: "paid",
        paidAt: "2026-11-05T12:00:00.000Z",
      });
      const published = await getPublishedInvoiceById(db, draft);
      expect(published?.status).toBe("paid");
      expect(new Date(published!.paidAt!).toISOString()).toBe(
        "2026-11-05T12:00:00.000Z",
      );
      for (const key of [
        "internalNote",
        "paymentIntentId",
        "user",
        "scheduledJobId",
        "documentSnapshot",
        "sentTo",
      ])
        expect(published).not.toHaveProperty(key);
    });

    test("issued identity and amount edits require a corrected invoice, but the original snapshot survives", async () => {
      const draft = input();
      await draftInvoice(db, draft);
      await updateInvoice(db, {
        id: draft.id,
        teamId: draft.teamId,
        status: "unpaid",
      });
      const before = await getInvoiceDocumentById(db, draft);
      for (const change of [
        { invoiceNumber: "REPLACED-999" },
        { customerName: "Other buyer" },
        { customerDetails: "Different legal details" },
        { fromDetails: "Different seller" },
        {
          lineItems: [
            {
              name: "Different service",
              unit: "hour",
              price: 100,
              quantity: 2,
            },
          ],
        },
        {
          lineItems: [
            { name: "Design", unit: "hour", price: 200, quantity: 2 },
          ],
        },
      ])
        await expect(draftInvoice(db, { ...draft, ...change })).rejects.toThrow(
          InvoiceFinancialStateError,
        );
      expect(
        (await getInvoiceDocumentById(db, draft))?.documentSnapshot,
      ).toEqual(before?.documentSnapshot);
      expect(
        await getInvoiceDocumentById(db, {
          id: draft.id,
          teamId: fixture.other.teamId,
        }),
      ).toBeNull();
    });

    test("publishing preparation freezes a recurring draft, but a stale schedule cannot freeze it", async () => {
      const draft = input();
      await draftInvoice(db, draft);
      await updateInvoice(db, {
        id: draft.id,
        teamId: draft.teamId,
        status: "scheduled",
        scheduledJobId: "schedule-current",
      });
      expect(
        await prepareInvoiceDocument(db, {
          ...draft,
          expectedScheduledJobId: "schedule-old",
        }),
      ).toBeNull();
      expect((await getInvoiceById(db, draft))?.documentSnapshot).toBeNull();
      expect(
        (
          await prepareInvoiceDocument(db, {
            ...draft,
            expectedScheduledJobId: "schedule-current",
          })
        )?.documentSnapshot?.source,
      ).toBe("generation");
      expect(await getPublishedInvoiceById(db, draft)).toBeNull();
      await expect(
        draftInvoice(db, {
          ...draft,
          amount: 500,
          lineItems: [{ name: "Changed", price: 500, quantity: 1 }],
        }),
      ).rejects.toThrow(InvoiceFinancialStateError);
    });

    test("a concurrent financial edit waits for snapshot capture and cannot reprice the published PDF", async () => {
      const draft = input();
      await draftInvoice(db, draft);
      const ready = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const holder = db.transaction(async (tx) => {
        await prepareInvoiceDocument(tx, draft);
        const result = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        ready.resolve(result.rows[0]!.pid);
        await release.promise;
      });
      let pending: Promise<unknown> | undefined;
      try {
        const pid = await Promise.race([
          ready.promise,
          holder.then(() => {
            throw new Error(
              "Snapshot holder exited before lock was established",
            );
          }),
        ]);
        pending = draftInvoice(db, {
          ...draft,
          lineItems: [
            { name: "Design", unit: "hour", price: 999, quantity: 1 },
          ],
        }).then(
          () => "unexpected save",
          (error) => error,
        );
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          const check = await db.execute<{ blocked: boolean }>(
            sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`,
          );
          blocked = check.rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        release.resolve();
        await holder;
        expect(await pending).toBeInstanceOf(InvoiceFinancialStateError);
        expect((await getInvoiceDocumentById(db, draft))?.amount).toBe(200);
      } finally {
        release.resolve();
        await holder.catch(() => undefined);
        await pending;
      }
    });
  },
);
