import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { isTestDatabaseAvailable } from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

const migration = readFileSync(
  join(
    __dirname,
    "../../self-hosted/upgrades/supabase/migrations/20261103102000_native_bank_sync.sql",
  ),
  "utf8",
);
const txData = (id: string, amount = 12) => ({
  id,
  amount,
  currency: "USD",
  date: "2026-11-03",
  name: "Synthetic provider purchase",
  method: "card_purchase",
  status: "posted",
  balance: 100,
  category: null,
  description: "Fixture only",
  counterparty_name: null,
  merchant_name: null,
});
const balance = {
  amount: 100,
  currency: "USD",
  available_balance: null,
  credit_limit: null,
};

describe.skipIf(!isTestDatabaseAvailable())(
  "native banking leases and ingestion (real PostgreSQL)",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 3,
        connectionTimeoutMillis: 2000,
      });
    });
    afterAll(async () => {
      await pool?.end();
    });
    async function fixture(client: PoolClient, replayMigration = true) {
      await client.query("BEGIN");
      if (replayMigration) await client.query(migration);
      const team = randomUUID(),
        other = randomUUID(),
        connection = randomUUID(),
        account = randomUUID();
      await client.query(
        "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'Bank fixture'),($2::uuid,$2::text,'Other fixture')",
        [team, other],
      );
      await client.query(
        "INSERT INTO public.bank_connections(id,team_id,institution_id,name,provider,status,access_token,reference_id) VALUES($1::uuid,$2::uuid,$1::text,'Synthetic bank','plaid','connected','fixture-not-a-provider-secret','fixture-reference')",
        [connection, team],
      );
      await client.query(
        "INSERT INTO public.bank_accounts(id,team_id,bank_connection_id,account_id,name,currency,type,manual) VALUES($1,$2,$3,'fixture-account','Synthetic account','USD','depository',false)",
        [account, team, connection],
      );
      return { team, other, connection, account };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function claim(c: PoolClient, f: Fixture) {
      return (
        await c.query("SELECT private.claim_bank_sync($1,$2) result", [
          f.connection,
          f.team,
        ])
      ).rows[0].result;
    }
    async function finish(
      c: PoolClient,
      f: Fixture,
      lease: { leaseToken: string; revision: string },
      rows: unknown[] = [txData("fixture-transaction")],
    ) {
      return (
        await c.query(
          "SELECT private.finish_bank_sync_account($1,$2,$3,$4,$5,$6) accepted",
          [
            f.connection,
            f.team,
            lease.leaseToken,
            lease.revision,
            balance,
            JSON.stringify(rows),
          ],
        )
      ).rows[0].accepted;
    }
    async function run(
      body: (client: PoolClient, f: Fixture) => Promise<void>,
    ) {
      const client = await pool.connect();
      try {
        const f = await fixture(client);
        await body(client, f);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    async function rejected(
      client: PoolClient,
      sql: string,
      values: unknown[] = [],
    ) {
      await client.query("SAVEPOINT expected_denial");
      try {
        await expect(client.query(sql, values)).rejects.toThrow();
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT expected_denial");
      }
    }
    test("connection/account writes persist intent without Redis; event replay coalesces and wrong team cannot claim", async () =>
      run(async (c, f) => {
        // Account triggers use wall time, while the scheduler uses transaction
        // time. Verify the trigger intent before representing an already-due
        // item inside this rollback-only fixture transaction. Only this case's
        // row is advanced; unrelated queue entries and the production SQL stay
        // untouched. The oldest due time also makes the bounded list stable.
        expect(
          (
            await c.query(
              "SELECT requested_generation>completed_generation pending, next_attempt_at<=clock_timestamp() due, lease_token IS NULL unclaimed FROM private.bank_sync_operations WHERE connection_id=$1 AND team_id=$2",
              [f.connection, f.team],
            )
          ).rows,
        ).toEqual([{ pending: true, due: true, unclaimed: true }]);
        expect(
          (
            await c.query(
              "UPDATE private.bank_sync_operations SET next_attempt_at='-infinity'::timestamptz WHERE connection_id=$1 AND team_id=$2",
              [f.connection, f.team],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await c.query("SELECT * FROM private.list_due_bank_sync(20)")
          ).rows.some((r) => r.connection_id === f.connection),
        ).toBe(true);
        const event = "a".repeat(64);
        await c.query("SELECT private.request_bank_sync($1,$2,true,$3)", [
          f.connection,
          f.team,
          event,
        ]);
        const before = (
          await c.query(
            "SELECT requested_generation FROM private.bank_sync_operations WHERE connection_id=$1",
            [f.connection],
          )
        ).rows[0];
        await c.query("SELECT private.request_bank_sync($1,$2,true,$3)", [
          f.connection,
          f.team,
          event,
        ]);
        expect(
          (
            await c.query(
              "SELECT requested_generation FROM private.bank_sync_operations WHERE connection_id=$1",
              [f.connection],
            )
          ).rows[0],
        ).toEqual(before);
        expect(
          (
            await c.query("SELECT private.request_bank_sync($1,$2) result", [
              f.connection,
              f.other,
            ])
          ).rows[0].result,
        ).toBe(false);
        expect(
          (
            await c.query("SELECT private.claim_bank_sync($1,$2) result", [
              f.connection,
              f.other,
            ])
          ).rows[0].result.state,
        ).toBe("canceled");
      }));
    test("only one live lease; expired/replayed result cannot write, replacement commits once", async () =>
      run(async (c, f) => {
        const first = await claim(c, f);
        expect(first.state).toBe("claimed");
        expect(first.latest).toBe(false);
        expect((await claim(c, f)).state).toBe("busy");
        await c.query(
          "UPDATE private.bank_sync_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE connection_id=$1",
          [f.connection],
        );
        expect(await finish(c, f, first)).toBe(false);
        const second = await claim(c, f);
        expect(second.leaseToken).not.toBe(first.leaseToken);
        expect(await finish(c, f, first)).toBe(false);
        expect(await finish(c, f, second)).toBe(true);
        expect(await finish(c, f, second)).toBe(false);
        expect(
          (
            await c.query(
              "SELECT count(*)::int n FROM public.transactions WHERE team_id=$1",
              [f.team],
            )
          ).rows[0].n,
        ).toBe(1);
      }));
    test("credential rotation and account disabling fence in-flight results", async () =>
      run(async (c, f) => {
        const old = await claim(c, f);
        await c.query(
          "UPDATE public.bank_connections SET access_token='rotated-fixture-not-a-provider-secret',reference_id='rotated-fixture-reference' WHERE id=$1",
          [f.connection],
        );
        expect(await finish(c, f, old)).toBe(false);
        const fresh = await claim(c, f);
        expect(fresh.revision).not.toBe(old.revision);
        expect(fresh.connection.referenceId).toBe("rotated-fixture-reference");
        await c.query(
          "UPDATE public.bank_accounts SET enabled=false WHERE id=$1",
          [f.account],
        );
        expect(await finish(c, f, fresh)).toBe(false);
        expect((await claim(c, f)).state).toBe("idle");
        expect(
          (
            await c.query(
              "SELECT status FROM public.bank_connections WHERE id=$1",
              [f.connection],
            )
          ).rows[0].status,
        ).toBe("connected");
      }));
    test("account identity changes invalidate claims; a deleted team cannot be resurrected", async () =>
      run(async (c, f) => {
        const old = await claim(c, f);
        await c.query(
          "UPDATE public.bank_accounts SET account_id='another-verified-fixture-account' WHERE id=$1",
          [f.account],
        );
        expect(await finish(c, f, old)).toBe(false);
        const fresh = await claim(c, f);
        await c.query("DELETE FROM public.teams WHERE id=$1", [f.team]);
        expect(await finish(c, f, fresh)).toBe(false);
        expect(
          (
            await c.query(
              "SELECT count(*)::int n FROM private.bank_sync_operations WHERE connection_id=$1",
              [f.connection],
            )
          ).rows[0].n,
        ).toBe(0);
      }));
    test("provider changes update financial fields while keeping manual enrichment and resetting stale exported status", async () =>
      run(async (c, f) => {
        const first = await claim(c, f);
        expect(
          await finish(c, f, first, [
            { ...txData("same-provider-id"), status: "pending" },
          ]),
        ).toBe(true);
        await c.query(
          "UPDATE public.transactions SET name='User name',note='User note',description='User description',enrichment_completed=true,status='exported',base_amount=12,base_currency='USD' WHERE team_id=$1",
          [f.team],
        );
        await c.query("SELECT private.request_bank_sync($1,$2,true)", [
          f.connection,
          f.team,
        ]);
        const next = await claim(c, f);
        expect(await finish(c, f, next, [txData("same-provider-id", 20)])).toBe(
          true,
        );
        const rows = (
          await c.query(
            "SELECT name,note,description,enrichment_completed,status,amount::text,base_amount FROM public.transactions WHERE team_id=$1",
            [f.team],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          name: "User name",
          note: "User note",
          description: "User description",
          enrichment_completed: true,
          status: "posted",
          amount: "20.00",
          base_amount: null,
        });
      }));
    test("cross-account duplicate provider identity rejects the entire batch and balance update", async () =>
      run(async (c, f) => {
        const otherAccount = randomUUID();
        await c.query(
          "INSERT INTO public.bank_accounts(id,team_id,account_id,name,manual) VALUES($1,$2,'manual-fixture','Manual',true)",
          [otherAccount, f.team],
        );
        await c.query(
          "INSERT INTO public.transactions(team_id,bank_account_id,internal_id,date,name,method,amount,currency) VALUES($1,$2,$3,'2026-11-03','Existing','other',1,'USD')",
          [f.team, otherAccount, `${f.team}_collision`],
        );
        const lease = await claim(c, f);
        await rejected(
          c,
          "SELECT private.finish_bank_sync_account($1,$2,$3,$4,$5,$6)",
          [
            f.connection,
            f.team,
            lease.leaseToken,
            lease.revision,
            balance,
            JSON.stringify([txData("new-row"), txData("collision")]),
          ],
        );
        expect(
          (
            await c.query(
              "SELECT count(*)::int n FROM public.transactions WHERE team_id=$1",
              [f.team],
            )
          ).rows[0].n,
        ).toBe(1);
        expect(
          (
            await c.query(
              "SELECT balance::text FROM public.bank_accounts WHERE id=$1",
              [f.account],
            )
          ).rows[0].balance,
        ).toBe("0.00");
      }));
    test("new request during an active claim survives completion; missing config remains pending", async () =>
      run(async (c, f) => {
        const lease = await claim(c, f);
        await c.query("SELECT private.request_bank_sync($1,$2)", [
          f.connection,
          f.team,
        ]);
        expect(await finish(c, f, lease)).toBe(true);
        const pending = (
          await c.query(
            "SELECT requested_generation>completed_generation pending FROM private.bank_sync_operations WHERE connection_id=$1",
            [f.connection],
          )
        ).rows[0];
        expect(pending.pending).toBe(true);
        const next = await claim(c, f);
        await c.query(
          "SELECT private.defer_bank_sync($1,$2,$3,$4,'configuration_unavailable')",
          [f.connection, f.team, next.leaseToken, next.revision],
        );
        expect(
          (
            await c.query(
              "SELECT requested_generation>completed_generation pending,last_error,lease_token FROM private.bank_sync_operations WHERE connection_id=$1",
              [f.connection],
            )
          ).rows[0],
        ).toMatchObject({
          pending: true,
          last_error: "configuration_unavailable",
          lease_token: null,
        });
      }));
    test("malformed provider data cannot partially commit and migration replay does not reset identity", async () =>
      run(async (c, f) => {
        const lease = await claim(c, f);
        await rejected(
          c,
          "SELECT private.finish_bank_sync_account($1,$2,$3,$4,$5,$6)",
          [
            f.connection,
            f.team,
            lease.leaseToken,
            lease.revision,
            balance,
            JSON.stringify([txData("valid"), { id: "invalid" }]),
          ],
        );
        expect(
          (
            await c.query(
              "SELECT count(*)::int n FROM public.transactions WHERE team_id=$1",
              [f.team],
            )
          ).rows[0].n,
        ).toBe(0);
        await c.query(migration);
        expect(
          (
            await c.query(
              "SELECT revision::text FROM private.bank_sync_operations WHERE connection_id=$1",
              [f.connection],
            )
          ).rows[0].revision,
        ).toBe(lease.revision);
      }));
    test("concurrent SQL claimers share one lease and a new request survives a committing result", async () => {
      const first = await pool.connect(),
        second = await pool.connect();
      let f: Fixture | undefined;
      try {
        // The shared foundation already installed this SQL. Commit only this
        // case's own rows; migration replay belongs to rollback-only cases.
        f = await fixture(first, false);
        // Only this case commits its synthetic rows so a genuinely separate
        // connection can race. The isolated catalog is already approved by the gate.
        await first.query("COMMIT");
        await first.query("SET statement_timeout='5s'");
        await second.query("SET statement_timeout='5s'");
        const [left, right] = await Promise.all([
          claim(first, f),
          claim(second, f),
        ]);
        expect([left.state, right.state].sort()).toEqual(["busy", "claimed"]);
        const lease = left.state === "claimed" ? left : right;
        await first.query("BEGIN");
        expect(await finish(first, f, lease)).toBe(true);
        const requested = second.query(
          "SELECT private.request_bank_sync($1,$2) accepted",
          [f.connection, f.team],
        );
        await first.query("COMMIT");
        expect((await requested).rows[0].accepted).toBe(true);
        expect(
          (
            await first.query(
              "SELECT requested_generation>completed_generation pending FROM private.bank_sync_operations WHERE connection_id=$1",
              [f.connection],
            )
          ).rows[0].pending,
        ).toBe(true);
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        if (f)
          await first.query(
            "DELETE FROM public.teams WHERE id=ANY($1::uuid[])",
            [[f.team, f.other]],
          );
        await first.query("RESET statement_timeout");
        await second.query("RESET statement_timeout");
        first.release();
        second.release();
      }
    });
    test("browser roles cannot read credentials, request service work or manufacture provider account references", async () =>
      run(async (c, f) => {
        await c.query("SAVEPOINT browser_role");
        await c.query("SET LOCAL ROLE authenticated");
        await expect(
          c.query("SELECT * FROM private.bank_sync_operations"),
        ).rejects.toThrow();
        await c.query("ROLLBACK TO SAVEPOINT browser_role");
        await c.query("SET LOCAL ROLE authenticated");
        await expect(
          c.query("SELECT private.claim_bank_sync($1,$2)", [
            f.connection,
            f.team,
          ]),
        ).rejects.toThrow();
        await c.query("ROLLBACK TO SAVEPOINT browser_role");
        await c.query("SET LOCAL ROLE authenticated");
        await expect(
          c.query(
            "UPDATE public.bank_accounts SET account_id='foreign' WHERE id=$1",
            [f.account],
          ),
        ).rejects.toThrow();
        await c.query("ROLLBACK TO SAVEPOINT browser_role");
      }));
  },
);
