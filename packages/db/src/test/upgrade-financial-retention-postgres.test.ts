import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

const migrationPath = join(
  __dirname,
  "../../self-hosted/upgrades/supabase/migrations/20261101042940_preserve_team_financial_history.sql",
);

// Reconstruct the four exact prior FK definitions inside the rollback-only
// transaction. Do not rewrite or delete existing rows to satisfy NOT NULL.
// Run this rehearsal separately from suites with concurrent committed fixtures.
const restorePriorDefinitionSql = `
  LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.apps, public.bank_accounts, public.invoice_recurring, public.invoices
    IN ACCESS EXCLUSIVE MODE;

  ALTER TABLE public.apps
    DROP CONSTRAINT apps_created_by_fkey,
    ADD CONSTRAINT apps_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;
  ALTER TABLE public.bank_accounts
    DROP CONSTRAINT bank_accounts_created_by_fkey,
    ADD CONSTRAINT bank_accounts_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;
  ALTER TABLE public.invoice_recurring
    DROP CONSTRAINT invoice_recurring_user_id_fkey,
    ADD CONSTRAINT invoice_recurring_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  ALTER TABLE public.invoices
    DROP CONSTRAINT invoices_created_by_fkey,
    ADD CONSTRAINT invoices_created_by_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  ALTER TABLE public.bank_accounts ALTER COLUMN created_by SET NOT NULL;
  ALTER TABLE public.invoice_recurring ALTER COLUMN user_id SET NOT NULL;
`;

const authorDefinitionSql = `
  SELECT t.relname AS table_name, a.attname AS column_name,
         a.attnotnull AS not_null, c.confdeltype AS delete_action,
         pg_catalog.pg_get_constraintdef(c.oid) AS definition
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE n.nspname = 'public' AND c.contype = 'f'
    AND c.conname IN (
      'apps_created_by_fkey', 'bank_accounts_created_by_fkey',
      'invoice_recurring_user_id_fkey', 'invoices_created_by_fkey'
    )
  ORDER BY t.relname
`;

function fixtureIds() {
  return {
    teamId: randomUUID(),
    authorId: randomUUID(),
    survivorId: randomUUID(),
    bankAccountId: randomUUID(),
    transactionId: randomUUID(),
    recurringId: randomUUID(),
    invoiceId: randomUUID(),
    appId: randomUUID(),
  };
}

type Fixture = ReturnType<typeof fixtureIds>;

async function insertPriorSchemaFixture(client: PoolClient, fixture: Fixture) {
  await client.query(
    `INSERT INTO public.teams (id, name, inbox_id)
     VALUES ($1, 'Financial retention upgrade fixture', $2)`,
    [fixture.teamId, fixture.teamId],
  );
  await client.query(
    `INSERT INTO public.users (id, team_id, full_name, email)
     VALUES ($1, $3, 'Deleted fixture author', $4),
            ($2, $3, 'Surviving fixture owner', $5)`,
    [
      fixture.authorId,
      fixture.survivorId,
      fixture.teamId,
      `${fixture.authorId}@example.test`,
      `${fixture.survivorId}@example.test`,
    ],
  );
  await client.query(
    `INSERT INTO public.users_on_team (user_id, team_id, role)
     VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`,
    [fixture.authorId, fixture.survivorId, fixture.teamId],
  );
  await client.query(
    `INSERT INTO public.bank_accounts
       (id, team_id, created_by, account_id, name, currency, balance)
     VALUES ($1, $2, $3, $4, 'Retained upgrade account', 'USD', 1000)`,
    [
      fixture.bankAccountId,
      fixture.teamId,
      fixture.authorId,
      `upgrade-${fixture.bankAccountId}`,
    ],
  );
  await client.query(
    `INSERT INTO public.transactions
       (id, internal_id, team_id, bank_account_id, assigned_id,
        name, date, amount, currency, method, status)
     VALUES ($1, $2, $3, $4, $5, 'Retained upgrade transaction',
             '2026-01-15', -125.50, 'USD', 'payment', 'posted')`,
    [
      fixture.transactionId,
      fixture.transactionId,
      fixture.teamId,
      fixture.bankAccountId,
      fixture.authorId,
    ],
  );
  await client.query(
    `INSERT INTO public.invoice_recurring
       (id, team_id, user_id, frequency, frequency_day, end_type,
        timezone, amount, currency, next_scheduled_at)
     VALUES ($1, $2, $3, 'monthly_date', 15, 'never', 'UTC', 125.50,
             'USD', '2026-02-15T00:00:00Z')`,
    [fixture.recurringId, fixture.teamId, fixture.authorId],
  );
  await client.query(
    `INSERT INTO public.invoices
       (id, team_id, user_id, invoice_recurring_id, recurring_sequence,
        invoice_number, amount, currency, status)
     VALUES ($1, $2, $3, $4, 1, 'UPGRADE-001', 125.50, 'USD', 'paid')`,
    [fixture.invoiceId, fixture.teamId, fixture.authorId, fixture.recurringId],
  );
  await client.query(
    `INSERT INTO public.apps (id, team_id, created_by, app_id, config)
     VALUES ($1, $2, $3, 'xero', '{"fixture":"retained configuration"}'::jsonb)`,
    [fixture.appId, fixture.teamId, fixture.authorId],
  );
}

// This executes the actual upgrade SQL, not a textual imitation of the new
// schema. Every DDL/data change rolls back, including rejected migrations.
// It only uses the guarded midday_test URL; never a server, deployed DB,
// managed Auth schema, provider, or baseline migration history table.
describe.skipIf(!isTestDatabaseAvailable())(
  "financial retention incremental upgrade (PostgreSQL rollback rehearsal)",
  () => {
    let pool: Pool;
    let migrationSql: string;

    beforeAll(() => {
      migrationSql = readFileSync(migrationPath, "utf8");
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
      });
    });
    afterAll(async () => {
      await pool.end();
    });

    async function withPriorSchemaFixture(
      run: (client: PoolClient, fixture: Fixture) => Promise<void>,
    ) {
      const client = await pool.connect();
      const fixture = fixtureIds();
      try {
        const originalDefinition = await client.query(authorDefinitionSql);
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL lock_timeout = '2000ms'");
          await client.query("SET LOCAL statement_timeout = '20000ms'");
          await client.query(restorePriorDefinitionSql);
          await insertPriorSchemaFixture(client, fixture);
          await run(client, fixture);
        } finally {
          await client.query("ROLLBACK");
          expect((await client.query(authorDefinitionSql)).rows).toEqual(
            originalDefinition.rows,
          );
          const remainingFixture = await client.query(
            `SELECT
               (SELECT count(*)::integer FROM public.teams WHERE id = $1) AS teams,
               (SELECT count(*)::integer FROM public.users WHERE id IN ($2, $3)) AS users,
               (SELECT count(*)::integer FROM public.bank_accounts WHERE id = $4) AS accounts,
               (SELECT count(*)::integer FROM public.transactions WHERE id = $5) AS transactions,
               (SELECT count(*)::integer FROM public.invoice_recurring WHERE id = $6) AS recurring,
               (SELECT count(*)::integer FROM public.invoices WHERE id = $7) AS invoices,
               (SELECT count(*)::integer FROM public.apps WHERE id = $8) AS apps`,
            [
              fixture.teamId,
              fixture.authorId,
              fixture.survivorId,
              fixture.bankAccountId,
              fixture.transactionId,
              fixture.recurringId,
              fixture.invoiceId,
              fixture.appId,
            ],
          );
          expect(remainingFixture.rows).toEqual([
            {
              teams: 0,
              users: 0,
              accounts: 0,
              transactions: 0,
              recurring: 0,
              invoices: 0,
              apps: 0,
            },
          ]);
        }
      } finally {
        client.release();
      }
    }

    test("actual migration upgrades existing rows, and user deletion retains all four records", async () => {
      await withPriorSchemaFixture(async (client, fixture) => {
        const prior = await client.query(authorDefinitionSql);
        expect(prior.rows.map(({ definition: _, ...row }) => row)).toEqual([
          {
            table_name: "apps",
            column_name: "created_by",
            not_null: false,
            delete_action: "c",
          },
          {
            table_name: "bank_accounts",
            column_name: "created_by",
            not_null: true,
            delete_action: "c",
          },
          {
            table_name: "invoice_recurring",
            column_name: "user_id",
            not_null: true,
            delete_action: "c",
          },
          {
            table_name: "invoices",
            column_name: "user_id",
            not_null: false,
            delete_action: "c",
          },
        ]);

        await client.query(migrationSql);

        const upgraded = await client.query(authorDefinitionSql);
        expect(upgraded.rows).toHaveLength(4);
        for (const row of upgraded.rows) {
          expect(row.delete_action).toBe("n");
          expect(row.not_null).toBe(false);
        }
        await client.query("DELETE FROM public.users WHERE id = $1", [
          fixture.authorId,
        ]);

        const retainedReferences = [
          {
            table: "bank_accounts",
            column: "created_by",
            id: fixture.bankAccountId,
          },
          {
            table: "invoice_recurring",
            column: "user_id",
            id: fixture.recurringId,
          },
          { table: "invoices", column: "user_id", id: fixture.invoiceId },
          { table: "apps", column: "created_by", id: fixture.appId },
        ] as const;
        for (const reference of retainedReferences) {
          // Identifiers are fixed test constants; row IDs remain parameters.
          const retained = await client.query(
            `SELECT id, team_id, ${reference.column} AS author
             FROM public.${reference.table} WHERE id = $1`,
            [reference.id],
          );
          expect(retained.rows).toEqual([
            { id: reference.id, team_id: fixture.teamId, author: null },
          ]);
        }
        const transaction = await client.query(
          `SELECT id, bank_account_id, amount::float8 AS amount, assigned_id
           FROM public.transactions WHERE id = $1`,
          [fixture.transactionId],
        );
        expect(transaction.rows).toEqual([
          {
            id: fixture.transactionId,
            bank_account_id: fixture.bankAccountId,
            amount: -125.5,
            assigned_id: null,
          },
        ]);
        const invoice = await client.query(
          `SELECT invoice_recurring_id, amount::float8 AS amount, recurring_sequence
           FROM public.invoices WHERE id = $1`,
          [fixture.invoiceId],
        );
        expect(invoice.rows).toEqual([
          {
            invoice_recurring_id: fixture.recurringId,
            amount: 125.5,
            recurring_sequence: 1,
          },
        ]);
        const memberships = await client.query(
          "SELECT user_id FROM public.users_on_team WHERE team_id = $1",
          [fixture.teamId],
        );
        expect(memberships.rows).toEqual([{ user_id: fixture.survivorId }]);
      });
    });

    test("unexpected prior FK is rejected and both schema and fixtures roll back", async () => {
      await withPriorSchemaFixture(async (client) => {
        await client.query(`
          ALTER TABLE public.bank_accounts
            DROP CONSTRAINT bank_accounts_created_by_fkey,
            ADD CONSTRAINT bank_accounts_created_by_fkey
              FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT
        `);

        await expect(client.query(migrationSql)).rejects.toMatchObject({
          message:
            "Unexpected author FK definition: bank_accounts.bank_accounts_created_by_fkey",
        });
      });
    });
  },
);
