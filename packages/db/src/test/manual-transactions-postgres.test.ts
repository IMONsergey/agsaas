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
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { FinancialOperationConflictError } from "../financial-job";
import { createTransaction, deleteTransactions } from "../queries/transactions";
import {
  bankAccounts,
  financialJobDispatches,
  manualTransactionOperations,
  transactionAttachments,
  transactions,
} from "../schema";
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
  "manual transaction operation identity and atomic handoff (PostgreSQL)",
  () => {
    let db: Database;
    let fixture: TenantIsolationFixture;
    let accountId: string;
    let otherAccountId: string;
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      fixture = await createTenantIsolationFixture(db);
      accountId = randomUUID();
      otherAccountId = randomUUID();
      await db.insert(bankAccounts).values([
        {
          id: accountId,
          teamId: fixture.own.teamId,
          accountId,
          currency: "USD",
          manual: true,
        },
        {
          id: otherAccountId,
          teamId: fixture.other.teamId,
          accountId: otherAccountId,
          currency: "USD",
          manual: true,
        },
      ]);
    });
    afterEach(async () => {
      if (fixture) await removeTenantIsolationFixture(db, fixture);
    });
    afterAll(closeDatabase);
    function input() {
      return {
        operationId: randomUUID(),
        teamId: fixture.own.teamId,
        bankAccountId: accountId,
        assignedId: fixture.own.userId,
        name: "Manual fixture",
        amount: -25.5,
        currency: "USD",
        date: "2026-11-01",
        attachments: [
          {
            name: "receipt.pdf",
            type: "application/pdf",
            size: 100,
            path: [fixture.own.teamId, "receipt.pdf"],
          },
        ],
      };
    }

    test("ten concurrent retries create one transaction, one attachment and exactly two queue intents", async () => {
      const request = input();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          createTransaction(db, {
            ...request,
            operationId:
              index % 2
                ? request.operationId.toUpperCase()
                : request.operationId,
          }),
        ),
      );
      const id = results[0]!.id;
      expect(new Set(results.map((row) => row?.id)).size).toBe(1);
      expect(
        await db
          .select()
          .from(manualTransactionOperations)
          .where(eq(manualTransactionOperations.teamId, request.teamId)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(transactionAttachments)
          .where(eq(transactionAttachments.transactionId, id)),
      ).toHaveLength(1);
      const intents = await db
        .select()
        .from(financialJobDispatches)
        .where(eq(financialJobDispatches.teamId, request.teamId));
      expect(intents).toHaveLength(2);
      expect(
        intents.every(
          (row) =>
            row.status === "pending" && row.payload?.teamId === request.teamId,
        ),
      ).toBe(true);
      expect(intents.map((row) => row.jobName).sort()).toEqual([
        "enrich-transactions",
        "match-transactions-bidirectional",
      ]);
    });

    test("a reused operation ID rejects a different payload without editing the original", async () => {
      const request = input();
      const first = await createTransaction(db, request);
      await expect(
        createTransaction(db, { ...request, amount: -999 }),
      ).rejects.toBeInstanceOf(FinancialOperationConflictError);
      expect(
        (
          await db
            .select()
            .from(transactions)
            .where(eq(transactions.id, first!.id))
        )[0]?.amount,
      ).toBe(-25.5);
    });

    test("a failed outer transaction leaves no financial row, attachment, receipt or queued intent", async () => {
      const request = input();
      await expect(
        db.transaction(async (tx) => {
          await createTransaction(tx, request);
          throw new Error("fixture rollback");
        }),
      ).rejects.toThrow("fixture rollback");
      expect(
        await db
          .select()
          .from(manualTransactionOperations)
          .where(eq(manualTransactionOperations.teamId, request.teamId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(financialJobDispatches)
          .where(eq(financialJobDispatches.teamId, request.teamId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.teamId, request.teamId),
              eq(transactions.name, request.name),
            ),
          ),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(transactionAttachments)
          .where(eq(transactionAttachments.teamId, request.teamId)),
      ).toHaveLength(0);
    });

    test("foreign account/assignee is rejected before writing, while another team may reuse the same operation UUID", async () => {
      const request = input();
      await expect(
        createTransaction(db, { ...request, bankAccountId: otherAccountId }),
      ).rejects.toThrow("Resource not found");
      await expect(
        createTransaction(db, { ...request, assignedId: fixture.other.userId }),
      ).rejects.toThrow("Resource not found");
      const own = await createTransaction(db, request);
      const other = await createTransaction(db, {
        ...request,
        teamId: fixture.other.teamId,
        bankAccountId: otherAccountId,
        assignedId: fixture.other.userId,
        attachments: [],
      });
      expect(other?.id).not.toBe(own?.id);
    });

    test("deleting a manual transaction leaves a receipt tombstone so an old retry cannot recreate it", async () => {
      const request = input();
      const first = await createTransaction(db, request);
      await deleteTransactions(db, {
        teamId: request.teamId,
        ids: [first!.id],
      });
      await expect(createTransaction(db, request)).rejects.toThrow(
        "since been deleted",
      );
      expect(
        (
          await db
            .select()
            .from(manualTransactionOperations)
            .where(eq(manualTransactionOperations.teamId, request.teamId))
        )[0]?.transactionId,
      ).toBeNull();
    });
  },
);
