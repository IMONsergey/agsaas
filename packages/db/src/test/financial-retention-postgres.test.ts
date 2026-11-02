import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { Pool } from "pg";
import type { Database, TransactionClient } from "../client";
import { getAppByAppId, getApps } from "../queries/apps";
import { getBankAccountById, getBankAccounts } from "../queries/bank-accounts";
import {
  getDueInvoiceRecurring,
  getInvoiceRecurringById,
  getInvoiceRecurringList,
} from "../queries/invoice-recurring";
import { getInvoiceById, getInvoices } from "../queries/invoices";
import { leaveTeam } from "../queries/teams";
import { deleteUser } from "../queries/users";
import {
  apiKeys,
  apps,
  bankAccounts,
  customers,
  invoiceRecurring,
  invoices,
  notificationSettings,
  oauthAccessTokens,
  oauthApplications,
  oauthAuthorizationCodes,
  platformIdentities,
  platformLinkTokens,
  providerNotificationBatches,
  teams,
  transactions,
  users,
  usersOnTeam,
} from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

function financialIds(teamId = randomUUID()) {
  return {
    teamId,
    bankAccountId: randomUUID(),
    transactionId: randomUUID(),
    customerId: randomUUID(),
    recurringId: randomUUID(),
    invoiceId: randomUUID(),
    appId: randomUUID(),
  };
}

type FinancialIds = ReturnType<typeof financialIds>;
type Fixture = {
  authorId: string;
  survivorId: string;
  otherUserId: string;
  shared: FinancialIds;
  control: FinancialIds;
  teamIds: string[];
  userIds: string[];
};

async function insertFinancialRows(
  tx: TransactionClient,
  ids: FinancialIds,
  authorId: string,
) {
  await tx.insert(customers).values({
    id: ids.customerId,
    teamId: ids.teamId,
    name: "Retention customer",
    email: `${ids.customerId}@example.test`,
  });
  await tx.insert(bankAccounts).values({
    id: ids.bankAccountId,
    teamId: ids.teamId,
    createdBy: authorId,
    name: "Retention bank account",
    accountId: `retention-${ids.bankAccountId}`,
    balance: 1234.56,
    currency: "USD",
    enabled: true,
    manual: true,
    type: "depository",
  });
  await tx.insert(transactions).values({
    id: ids.transactionId,
    internalId: ids.transactionId,
    teamId: ids.teamId,
    bankAccountId: ids.bankAccountId,
    assignedId: authorId,
    name: "Retained transaction",
    date: "2026-01-15",
    amount: -125.5,
    currency: "USD",
    method: "payment",
    status: "posted",
    internal: false,
  });
  await tx.insert(invoiceRecurring).values({
    id: ids.recurringId,
    teamId: ids.teamId,
    userId: authorId,
    customerId: ids.customerId,
    customerName: "Retention customer",
    frequency: "monthly_date",
    frequencyDay: 15,
    endType: "never",
    status: "active",
    invoicesGenerated: 2,
    nextScheduledAt: "2001-01-15T09:00:00.000Z",
    timezone: "UTC",
    dueDateOffset: 30,
    amount: 125.5,
    currency: "USD",
    lineItems: [{ name: "Retained service", quantity: 1, price: 125.5 }],
    template: { currency: "USD", timezone: "UTC" },
  });
  await tx.insert(invoices).values({
    id: ids.invoiceId,
    teamId: ids.teamId,
    userId: authorId,
    customerId: ids.customerId,
    customerName: "Retention customer",
    invoiceRecurringId: ids.recurringId,
    recurringSequence: 2,
    invoiceNumber: `RET-${ids.invoiceId}`,
    amount: 125.5,
    currency: "USD",
    lineItems: [{ name: "Retained service", quantity: 1, price: 125.5 }],
    template: { currency: "USD", timezone: "UTC" },
    token: `retention-invoice-${ids.invoiceId}`,
    status: "paid",
    issueDate: "2026-01-15T00:00:00.000Z",
    dueDate: "2026-02-15T00:00:00.000Z",
    paidAt: "2026-01-20T00:00:00.000Z",
  });
  await tx.insert(apps).values({
    id: ids.appId,
    teamId: ids.teamId,
    createdBy: authorId,
    appId: "xero",
    config: {
      provider: "xero",
      accessToken: `fake-access-${ids.appId}`,
      refreshToken: `fake-refresh-${ids.appId}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      tenantId: ids.teamId,
      scope: ["accounting.transactions"],
    },
    settings: [{ id: "enabled", value: true }],
  });
}

async function financialSnapshot(db: Database, ids: FinancialIds) {
  const [bankAccount, transaction, recurring, invoice, app, customer] =
    await Promise.all([
      db.query.bankAccounts.findFirst({
        where: eq(bankAccounts.id, ids.bankAccountId),
      }),
      db.query.transactions.findFirst({
        where: eq(transactions.id, ids.transactionId),
      }),
      db.query.invoiceRecurring.findFirst({
        where: eq(invoiceRecurring.id, ids.recurringId),
      }),
      db.query.invoices.findFirst({ where: eq(invoices.id, ids.invoiceId) }),
      db.query.apps.findFirst({ where: eq(apps.id, ids.appId) }),
      db.query.customers.findFirst({ where: eq(customers.id, ids.customerId) }),
    ]);

  if (
    !bankAccount ||
    !transaction ||
    !recurring ||
    !invoice ||
    !app ||
    !customer
  ) {
    throw new Error("A retained financial fixture row is missing");
  }
  return { bankAccount, transaction, recurring, invoice, app, customer };
}

type FinancialSnapshot = Awaited<ReturnType<typeof financialSnapshot>>;

function expectOnlyAuthorReferencesRemoved(
  after: FinancialSnapshot,
  before: FinancialSnapshot,
) {
  expect(after).toEqual({
    bankAccount: { ...before.bankAccount, createdBy: null },
    // Assignment already uses SET NULL; the underlying ledger row must survive.
    transaction: { ...before.transaction, assignedId: null },
    recurring: { ...before.recurring, userId: null },
    invoice: { ...before.invoice, userId: null },
    app: { ...before.app, createdBy: null },
    customer: before.customer,
  });
}

// Real PostgreSQL, real deleteUser/query functions, and a separate connection
// for the public.users side of Auth's cascade. This does not test managed Auth
// HTTP, Auth schema grants, browser RLS, or external-provider revocation.
// Fixtures must commit so the separate connection can see them. Cleanup is
// limited to these UUIDs: no TRUNCATE or global DELETE. The shared guard only
// permits an explicitly configured local/disposable midday_test database.
// Run separately from legacy calculation suites that truncate shared tables.
describe.skipIf(!isTestDatabaseAvailable())(
  "financial retention on account deletion (PostgreSQL)",
  () => {
    let db: Database;
    let authPool: Pool;

    beforeAll(() => {
      db = getTestDatabase();
      authPool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
      });
    });
    afterAll(async () => {
      await Promise.all([closeDatabase(), authPool.end()]);
    });

    async function withFixture(run: (fixture: Fixture) => Promise<void>) {
      const fixture: Fixture = {
        authorId: randomUUID(),
        survivorId: randomUUID(),
        otherUserId: randomUUID(),
        shared: financialIds(),
        control: financialIds(),
        teamIds: [],
        userIds: [],
      };
      fixture.teamIds.push(fixture.shared.teamId, fixture.control.teamId);
      fixture.userIds.push(
        fixture.authorId,
        fixture.survivorId,
        fixture.otherUserId,
      );

      try {
        await db.transaction(async (tx) => {
          await tx.insert(teams).values(
            fixture.teamIds.map((id) => ({
              id,
              name: "Financial retention fixture",
              inboxId: id,
              baseCurrency: "USD",
              email: `${id}@example.test`,
            })),
          );
          await tx.insert(users).values(
            fixture.userIds.map((id) => ({
              id,
              fullName: "Retention fixture user",
              email: `${id}@example.test`,
              teamId:
                id === fixture.otherUserId
                  ? fixture.control.teamId
                  : fixture.shared.teamId,
            })),
          );
          await tx.insert(usersOnTeam).values([
            {
              userId: fixture.authorId,
              teamId: fixture.shared.teamId,
              role: "owner",
            },
            {
              userId: fixture.survivorId,
              teamId: fixture.shared.teamId,
              role: "owner",
            },
            {
              userId: fixture.otherUserId,
              teamId: fixture.control.teamId,
              role: "owner",
            },
          ]);
          await insertFinancialRows(tx, fixture.shared, fixture.authorId);
          await insertFinancialRows(tx, fixture.control, fixture.otherUserId);
        });
        await run(fixture);
      } finally {
        await db.delete(teams).where(inArray(teams.id, fixture.teamIds));
        await db.delete(users).where(inArray(users.id, fixture.userIds));
      }
    }

    async function profile(userId: string) {
      return db.query.users.findFirst({ where: eq(users.id, userId) });
    }

    async function cascadeProfile(userId: string) {
      const client = await authPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '2000ms'");
        await client.query("DELETE FROM public.users WHERE id = $1", [userId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    async function expectSurvivingOwner(fixture: Fixture) {
      expect(
        await db.query.teams.findFirst({
          where: eq(teams.id, fixture.shared.teamId),
        }),
      ).toBeDefined();
      const members = await db
        .select({ userId: usersOnTeam.userId, role: usersOnTeam.role })
        .from(usersOnTeam)
        .where(eq(usersOnTeam.teamId, fixture.shared.teamId));
      expect(members).toEqual([{ userId: fixture.survivorId, role: "owner" }]);
      expect((await profile(fixture.survivorId))?.teamId).toBe(
        fixture.shared.teamId,
      );
    }

    test("all four author FKs set null while company ownership still cascades", async () => {
      const authorKeys = await db.execute(sql`
        SELECT c.conname, c.confdeltype
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND c.contype = 'f'
          AND c.confrelid = 'public.users'::regclass
          AND c.conname IN (
            'apps_created_by_fkey', 'bank_accounts_created_by_fkey',
            'invoice_recurring_user_id_fkey', 'invoices_created_by_fkey'
          )
        ORDER BY c.conname
      `);
      expect(authorKeys.rows).toEqual([
        { conname: "apps_created_by_fkey", confdeltype: "n" },
        { conname: "bank_accounts_created_by_fkey", confdeltype: "n" },
        { conname: "invoice_recurring_user_id_fkey", confdeltype: "n" },
        { conname: "invoices_created_by_fkey", confdeltype: "n" },
      ]);

      const nullableAuthors = await db.execute(sql`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND (table_name, column_name) IN (
          ('bank_accounts', 'created_by'), ('invoice_recurring', 'user_id')
        )
        ORDER BY table_name
      `);
      expect(nullableAuthors.rows).toEqual([
        {
          table_name: "bank_accounts",
          column_name: "created_by",
          is_nullable: "YES",
        },
        {
          table_name: "invoice_recurring",
          column_name: "user_id",
          is_nullable: "YES",
        },
      ]);

      const teamKeys = await db.execute(sql`
        SELECT c.conname, c.confdeltype
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND c.contype = 'f'
          AND c.confrelid = 'public.teams'::regclass
          AND c.conname IN (
            'integrations_team_id_fkey', 'public_bank_accounts_team_id_fkey',
            'invoice_recurring_team_id_fkey', 'invoices_team_id_fkey'
          )
        ORDER BY c.conname
      `);
      expect(teamKeys.rows).toEqual([
        { conname: "integrations_team_id_fkey", confdeltype: "c" },
        { conname: "invoice_recurring_team_id_fkey", confdeltype: "c" },
        { conname: "invoices_team_id_fkey", confdeltype: "c" },
        { conname: "public_bank_accounts_team_id_fkey", confdeltype: "c" },
      ]);
    });

    test("deleteUser retains shared-team financial rows and clears only the deleted author", async () => {
      await withFixture(async (fixture) => {
        const before = await financialSnapshot(db, fixture.shared);
        const controlBefore = await financialSnapshot(db, fixture.control);
        let authCalls = 0;

        const result = await deleteUser(db, fixture.authorId, async () => {
          authCalls++;
          expect(
            (await profile(fixture.authorId))?.deletionStartedAt,
          ).toBeTruthy();
          await cascadeProfile(fixture.authorId);
        });

        expect(result).toEqual({ id: fixture.authorId });
        expect(authCalls).toBe(1);
        expect(await profile(fixture.authorId)).toBeUndefined();
        await expectSurvivingOwner(fixture);
        expectOnlyAuthorReferencesRemoved(
          await financialSnapshot(db, fixture.shared),
          before,
        );
        expect(await financialSnapshot(db, fixture.control)).toEqual(
          controlBefore,
        );
      });
    });

    test("a former member with no memberships cannot cascade their old team's financial history", async () => {
      await withFixture(async (fixture) => {
        const before = await financialSnapshot(db, fixture.shared);
        await leaveTeam(db, {
          teamId: fixture.shared.teamId,
          userId: fixture.authorId,
        });
        expect((await profile(fixture.authorId))?.teamId).toBeNull();
        expect(
          await db.$count(
            usersOnTeam,
            eq(usersOnTeam.userId, fixture.authorId),
          ),
        ).toBe(0);
        expect(await financialSnapshot(db, fixture.shared)).toEqual(before);

        await deleteUser(db, fixture.authorId, () =>
          cascadeProfile(fixture.authorId),
        );

        expect(await profile(fixture.authorId)).toBeUndefined();
        await expectSurvivingOwner(fixture);
        expectOnlyAuthorReferencesRemoved(
          await financialSnapshot(db, fixture.shared),
          before,
        );
      });
    });

    test("deleting a user with a solo and a shared team deletes only the solo team's financial rows", async () => {
      await withFixture(async (fixture) => {
        const solo = financialIds();
        fixture.teamIds.push(solo.teamId);
        await db.transaction(async (tx) => {
          await tx.insert(teams).values({
            id: solo.teamId,
            name: "Solo retention fixture",
            inboxId: solo.teamId,
          });
          await tx.insert(usersOnTeam).values({
            userId: fixture.authorId,
            teamId: solo.teamId,
            role: "owner",
          });
          await insertFinancialRows(tx, solo, fixture.authorId);
        });
        const before = await financialSnapshot(db, fixture.shared);
        const controlBefore = await financialSnapshot(db, fixture.control);

        await deleteUser(db, fixture.authorId, () =>
          cascadeProfile(fixture.authorId),
        );

        expect(await db.$count(teams, eq(teams.id, solo.teamId))).toBe(0);
        for (const table of [
          bankAccounts,
          transactions,
          invoiceRecurring,
          invoices,
          apps,
          customers,
        ]) {
          expect(await db.$count(table, eq(table.teamId, solo.teamId))).toBe(0);
        }
        await expectSurvivingOwner(fixture);
        expectOnlyAuthorReferencesRemoved(
          await financialSnapshot(db, fixture.shared),
          before,
        );
        expect(await financialSnapshot(db, fixture.control)).toEqual(
          controlBefore,
        );
      });
    });

    test("Auth rejection retains financial data and a retry-only marker until the retry cascades", async () => {
      await withFixture(async (fixture) => {
        const before = await financialSnapshot(db, fixture.shared);
        await expect(
          deleteUser(db, fixture.authorId, async () => {
            throw new Error("Fixture Auth rejection");
          }),
        ).rejects.toThrow("Fixture Auth rejection");

        const pending = await profile(fixture.authorId);
        expect(pending?.teamId).toBeNull();
        expect(pending?.deletionStartedAt).toBeTruthy();
        await expectSurvivingOwner(fixture);
        expect(await financialSnapshot(db, fixture.shared)).toEqual(before);

        await deleteUser(db, fixture.authorId, async () => {
          expect((await profile(fixture.authorId))?.deletionStartedAt).toBe(
            pending?.deletionStartedAt,
          );
          await cascadeProfile(fixture.authorId);
        });

        expect(await profile(fixture.authorId)).toBeUndefined();
        expectOnlyAuthorReferencesRemoved(
          await financialSnapshot(db, fixture.shared),
          before,
        );
      });
    });

    test("direct profile deletion retains finance but cascades personal credentials and membership", async () => {
      await withFixture(async (fixture) => {
        const applicationId = randomUUID();
        await db.transaction(async (tx) => {
          // A surviving owner owns the client definition. Deleting its creator
          // would exercise the separate OAuth-application retention policy.
          await tx.insert(oauthApplications).values({
            id: applicationId,
            teamId: fixture.shared.teamId,
            createdBy: fixture.survivorId,
            name: "Retention credentials fixture",
            slug: `retention-${applicationId}`,
            clientId: `retention-client-${applicationId}`,
            redirectUris: ["https://example.test/callback"],
            scopes: ["invoices.read"],
          });
          for (const userId of [fixture.authorId, fixture.survivorId]) {
            const identityId = randomUUID();
            await tx.insert(apiKeys).values({
              userId,
              teamId: fixture.shared.teamId,
              name: "Retention fixture key",
              keyEncrypted: `fake-encrypted-${userId}`,
              keyHash: `fake-hash-${userId}`,
            });
            await tx.insert(oauthAuthorizationCodes).values({
              applicationId,
              userId,
              teamId: fixture.shared.teamId,
              code: `fake-code-${userId}`,
              scopes: ["invoices.read"],
              redirectUri: "https://example.test/callback",
              expiresAt: "2099-01-01T00:00:00.000Z",
            });
            await tx.insert(oauthAccessTokens).values({
              applicationId,
              userId,
              teamId: fixture.shared.teamId,
              token: `fake-token-${userId}`,
              refreshToken: `fake-refresh-${userId}`,
              scopes: ["invoices.read"],
              expiresAt: "2099-01-01T00:00:00.000Z",
            });
            await tx.insert(platformIdentities).values({
              id: identityId,
              provider: "telegram",
              userId,
              teamId: fixture.shared.teamId,
              externalUserId: `fake-external-${userId}`,
              externalChannelId: `fake-chat-${userId}`,
            });
            await tx.insert(platformLinkTokens).values({
              provider: "telegram",
              userId,
              teamId: fixture.shared.teamId,
              code: `fake-link-${userId}`,
              expiresAt: "2099-01-01T00:00:00.000Z",
            });
            await tx.insert(providerNotificationBatches).values({
              batchKey: `retention-${userId}`,
              platformIdentityId: identityId,
              teamId: fixture.shared.teamId,
              userId,
              provider: "telegram",
              eventFamily: "invoice_paid",
              payload: { entries: [{ invoiceId: fixture.shared.invoiceId }] },
              windowEndsAt: "2099-01-01T00:00:00.000Z",
            });
            await tx.insert(notificationSettings).values({
              userId,
              teamId: fixture.shared.teamId,
              notificationType: "invoice_paid",
              channel: "in_app",
              enabled: true,
            });
          }
        });
        const before = await financialSnapshot(db, fixture.shared);

        // No deleteUser preparation: preservation must be enforced by the
        // database FK boundary, not just a current-membership update loop.
        await cascadeProfile(fixture.authorId);

        expect(await profile(fixture.authorId)).toBeUndefined();
        await expectSurvivingOwner(fixture);
        expectOnlyAuthorReferencesRemoved(
          await financialSnapshot(db, fixture.shared),
          before,
        );
        for (const table of [
          apiKeys,
          oauthAuthorizationCodes,
          oauthAccessTokens,
          platformIdentities,
          platformLinkTokens,
          providerNotificationBatches,
          notificationSettings,
        ]) {
          const remaining = await db
            .select({ userId: table.userId })
            .from(table)
            .where(eq(table.teamId, fixture.shared.teamId));
          expect(remaining).toEqual([{ userId: fixture.survivorId }]);
        }
        expect(
          await db.$count(
            oauthApplications,
            eq(oauthApplications.id, applicationId),
          ),
        ).toBe(1);
      });
    });

    test("normal query functions still return null-author financial records and active recurring schedules", async () => {
      await withFixture(async (fixture) => {
        await deleteUser(db, fixture.authorId, () =>
          cascadeProfile(fixture.authorId),
        );
        const { shared, control } = fixture;

        const invoice = await getInvoiceById(db, {
          id: shared.invoiceId,
          teamId: shared.teamId,
        });
        expect(invoice).toMatchObject({
          id: shared.invoiceId,
          teamId: shared.teamId,
          amount: 125.5,
          invoiceRecurringId: shared.recurringId,
          recurringSequence: 2,
        });
        expect(invoice?.user).toBeNull();
        expect(invoice?.customer?.id).toBe(shared.customerId);
        expect(
          (await getInvoices(db, { teamId: shared.teamId })).data.map(
            (row) => row.id,
          ),
        ).toEqual([shared.invoiceId]);

        expect(
          await getInvoiceRecurringById(db, {
            id: shared.recurringId,
            teamId: shared.teamId,
          }),
        ).toMatchObject({
          id: shared.recurringId,
          userId: null,
          status: "active",
        });
        expect(
          (
            await getInvoiceRecurringList(db, { teamId: shared.teamId })
          ).data.map((row) => row.id),
        ).toEqual([shared.recurringId]);
        const due = await getDueInvoiceRecurring(db, { limit: 1000 });
        expect(
          due.data.find((row) => row.id === shared.recurringId),
        ).toMatchObject({
          userId: null,
          teamId: shared.teamId,
        });

        expect(
          await getBankAccountById(db, {
            id: shared.bankAccountId,
            teamId: shared.teamId,
          }),
        ).toMatchObject({
          id: shared.bankAccountId,
          createdBy: null,
          balance: 1234.56,
        });
        expect(
          (await getBankAccounts(db, { teamId: shared.teamId })).map(
            (row) => row.id,
          ),
        ).toEqual([shared.bankAccountId]);
        expect(
          await getAppByAppId(db, { appId: "xero", teamId: shared.teamId }),
        ).toMatchObject({ id: shared.appId, createdBy: null });
        expect(
          (await getApps(db, shared.teamId)).map((row) => row.app_id),
        ).toEqual(["xero"]);

        // Null attribution must not broaden access to another tenant.
        expect(
          await getInvoiceById(db, {
            id: shared.invoiceId,
            teamId: control.teamId,
          }),
        ).toBeNull();
        expect(
          await getInvoiceRecurringById(db, {
            id: shared.recurringId,
            teamId: control.teamId,
          }),
        ).toBeNull();
        expect(
          await getBankAccountById(db, {
            id: shared.bankAccountId,
            teamId: control.teamId,
          }),
        ).toBeUndefined();
        expect(
          await getAppByAppId(db, { appId: "xero", teamId: control.teamId }),
        ).toMatchObject({ id: control.appId, createdBy: fixture.otherUserId });
      });
    });
  },
);
