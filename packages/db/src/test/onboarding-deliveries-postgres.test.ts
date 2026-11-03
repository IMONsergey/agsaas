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
    "../../self-hosted/upgrades/supabase/migrations/20261103103000_onboarding_deliveries.sql",
  ),
  "utf8",
);
describe.skipIf(!isTestDatabaseAvailable())(
  "native onboarding delivery fence (real PostgreSQL)",
  () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 1,
        connectionTimeoutMillis: 2000,
      });
    });
    afterAll(async () => {
      await pool?.end();
    });
    async function fixture(c: PoolClient) {
      await c.query("BEGIN");
      await c.query(`CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text);
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`);
      await c.query(migration);
      const user = randomUUID(),
        team = randomUUID(),
        email = `${user}@example.test`;
      await c.query(
        "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
        [user, email],
      );
      await c.query(
        "INSERT INTO public.users(id,email,full_name,created_at) VALUES($1,'untrusted-profile@example.test','Synthetic recipient',now()) ON CONFLICT(id) DO UPDATE SET full_name='Synthetic recipient',email=excluded.email",
        [user],
      );
      await c.query(
        "INSERT INTO public.teams(id,inbox_id,name) VALUES($1::uuid,$1::text,'Onboarding fixture')",
        [team],
      );
      await c.query(
        "INSERT INTO public.users_on_team(user_id,team_id,role) VALUES($1,$2,'owner')",
        [user, team],
      );
      await c.query("UPDATE public.users SET team_id=$2 WHERE id=$1", [
        user,
        team,
      ]);
      const rows = (
        await c.query(
          "SELECT id,kind FROM private.onboarding_deliveries WHERE user_id=$1",
          [user],
        )
      ).rows;
      const welcome = rows.find((row) => row.kind === "welcome")?.id as string;
      const activation = rows.find((row) => row.kind === "activation")
        ?.id as string;
      expect(welcome).toBeString();
      expect(activation).toBeString();
      await c.query(
        "UPDATE private.onboarding_deliveries SET due_at=now()-interval '1 minute',next_attempt_at=now()-interval '1 minute' WHERE user_id=$1",
        [user],
      );
      return { user, team, email, welcome, activation };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function run(body: (c: PoolClient, f: Fixture) => Promise<void>) {
      const c = await pool.connect();
      try {
        await body(c, await fixture(c));
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }
    async function get(c: PoolClient, f: Fixture, id = f.welcome) {
      return (
        await c.query("SELECT private.get_onboarding_delivery($1,$2) result", [
          id,
          f.user,
        ])
      ).rows[0].result;
    }
    async function prepare(c: PoolClient, f: Fixture, id = f.welcome) {
      const row = await get(c, f, id);
      const body = JSON.stringify({
        from: "Fixture <sender@example.test>",
        to: [row.context.recipient],
        subject: "Synthetic only",
        html: "<p>Fixture only</p>",
      });
      expect(
        (
          await c.query(
            "SELECT private.prepare_onboarding_delivery($1,$2,$3,$4) result",
            [id, f.user, row.context.hash, body],
          )
        ).rows[0].result,
      ).toBe(true);
      return body;
    }
    async function claim(c: PoolClient, f: Fixture, id = f.welcome) {
      return (
        await c.query(
          "SELECT private.claim_onboarding_delivery($1,$2) result",
          [id, f.user],
        )
      ).rows[0].result;
    }
    async function outcome(
      c: PoolClient,
      f: Fixture,
      token: string,
      kind: string,
      code: string | null = null,
      message: string | null = null,
    ) {
      return (
        await c.query(
          "SELECT private.record_onboarding_outcome($1,$2,$3,$4,$5,$6) result",
          [f.welcome, f.user, token, kind, code, message],
        )
      ).rows[0].result;
    }
    test("registration is transactional and idempotent; a lost trigger is reconciled without replaying old users", async () =>
      run(async (c, f) => {
        await c.query(
          "SELECT private.enqueue_onboarding($1),private.enqueue_onboarding($1)",
          [f.user],
        );
        expect(
          (
            await c.query(
              "SELECT count(*)::int n FROM private.onboarding_deliveries WHERE user_id=$1",
              [f.user],
            )
          ).rows[0].n,
        ).toBe(2);
        const old = randomUUID(),
          lost = randomUUID();
        await c.query(
          "ALTER TABLE public.users DISABLE TRIGGER agsaas_onboarding_profile_created",
        );
        await c.query(
          "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'old-fixture@example.test',now()),($2,'lost-fixture@example.test',now())",
          [old, lost],
        );
        await c.query(
          "INSERT INTO public.users(id,created_at) VALUES($1,now()-interval '1 year'),($2,now()) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at",
          [old, lost],
        );
        await c.query(
          "ALTER TABLE public.users ENABLE TRIGGER agsaas_onboarding_profile_created",
        );
        await c.query("SELECT * FROM private.list_due_onboarding(10)");
        expect(
          (
            await c.query(
              "SELECT count(*)::int n FROM private.onboarding_deliveries WHERE user_id=$1",
              [old],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await c.query(
              "SELECT count(*)::int n FROM private.onboarding_deliveries WHERE user_id=$1",
              [lost],
            )
          ).rows[0].n,
        ).toBe(2);
      }));
    test("recipient comes from verified Auth, never editable profile; duplicate claim/receipt cannot send twice", async () =>
      run(async (c, f) => {
        expect((await get(c, f)).context.recipient).toBe(f.email);
        await prepare(c, f);
        const first = await claim(c, f);
        expect(first.state).toBe("claimed");
        expect((await claim(c, f)).state).toBe("busy");
        expect(
          await outcome(
            c,
            f,
            first.leaseToken,
            "accepted",
            null,
            "synthetic-provider-receipt",
          ),
        ).toBe("accepted");
        expect(
          await outcome(
            c,
            f,
            first.leaseToken,
            "accepted",
            null,
            "synthetic-provider-receipt",
          ),
        ).toBe("accepted");
        expect((await claim(c, f)).state).toBe("accepted");
        expect((await get(c, f)).envelope).toBeNull();
        expect((await get(c, f)).recipient).toBeNull();
      }));
    test("email change before send discards the stale envelope and requires fresh preparation", async () =>
      run(async (c, f) => {
        await prepare(c, f);
        await c.query(
          "UPDATE auth.users SET email='new-verified@example.test' WHERE id=$1",
          [f.user],
        );
        expect((await claim(c, f)).state).toBe("unprepared");
        expect((await get(c, f)).envelope).toBeNull();
        await prepare(c, f);
        expect((await claim(c, f)).recipient).toBe("new-verified@example.test");
      }));
    test("late opt-out, deletion or ban prevents a prepared message from being claimed", async () =>
      run(async (c, f) => {
        await prepare(c, f);
        await c.query(
          "INSERT INTO public.notification_settings(user_id,team_id,notification_type,channel,enabled) VALUES($1,$2,'onboarding_welcome','email',false)",
          [f.user, f.team],
        );
        expect((await claim(c, f)).state).toBe("canceled");
        await c.query(
          "DELETE FROM public.notification_settings WHERE user_id=$1",
          [f.user],
        );
        await c.query(
          "UPDATE private.onboarding_deliveries SET status='pending',next_attempt_at=now() WHERE id=$1",
          [f.welcome],
        );
        await prepare(c, f);
        await c.query(
          "UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1",
          [f.user],
        );
        expect((await claim(c, f)).state).toBe("canceled");
        await c.query(
          "UPDATE auth.users SET banned_until=NULL,deleted_at=now() WHERE id=$1",
          [f.user],
        );
        expect((await get(c, f)).context.eligible).toBe(false);
        await c.query("UPDATE auth.users SET deleted_at=NULL WHERE id=$1", [
          f.user,
        ]);
        await c.query(
          "UPDATE public.users SET deletion_started_at=now() WHERE id=$1",
          [f.user],
        );
        expect((await get(c, f)).context.eligible).toBe(false);
      }));
    test("lost sending lease is uncertain, never reissued; its late confirmed receipt can still settle it", async () =>
      run(async (c, f) => {
        await prepare(c, f);
        const first = await claim(c, f);
        await c.query(
          "UPDATE private.onboarding_deliveries SET lease_until=now()-interval '1 minute' WHERE id=$1",
          [f.welcome],
        );
        expect((await claim(c, f)).state).toBe("reconciliation");
        expect((await claim(c, f)).state).toBe("reconciliation");
        expect(
          await outcome(
            c,
            f,
            first.leaseToken,
            "accepted",
            null,
            "late-synthetic-receipt",
          ),
        ).toBe("accepted");
      }));
    test("uncertain outcome requires review; only a definite rate-limit rejection is retryable", async () =>
      run(async (c, f) => {
        const envelope = await prepare(c, f);
        const first = await claim(c, f);
        expect(
          await outcome(c, f, first.leaseToken, "retry", "provider_rate_limit"),
        ).toBe("pending");
        await c.query(
          "UPDATE private.onboarding_deliveries SET next_attempt_at=now() WHERE id=$1",
          [f.welcome],
        );
        const second = await claim(c, f);
        expect(second.envelope).toBe(envelope);
        expect(second.leaseToken).not.toBe(first.leaseToken);
        expect(
          await outcome(c, f, second.leaseToken, "retry", "provider_uncertain"),
        ).toBe("reconciliation");
        expect((await claim(c, f)).state).toBe("reconciliation");
      }));
    test("configuration absence does not consume a send attempt or mark acceptance", async () =>
      run(async (c, f) => {
        await c.query(
          "SELECT private.defer_onboarding_delivery($1,$2,'configuration_unavailable')",
          [f.welcome, f.user],
        );
        expect(
          (
            await c.query(
              "SELECT status,attempts,first_attempt_at,provider_message_id,last_error FROM private.onboarding_deliveries WHERE id=$1",
              [f.welcome],
            )
          ).rows[0],
        ).toEqual({
          status: "pending",
          attempts: 0,
          first_attempt_at: null,
          provider_message_id: null,
          last_error: "configuration_unavailable",
        });
      }));
    test("activation requires saved opt-in and current membership, and stops once a bank is connected", async () =>
      run(async (c, f) => {
        expect((await get(c, f, f.activation)).context.eligible).toBe(false);
        await c.query(
          "INSERT INTO public.notification_settings(user_id,team_id,notification_type,channel,enabled) VALUES($1,$2,'onboarding_tips','email',true)",
          [f.user, f.team],
        );
        expect((await get(c, f, f.activation)).context.eligible).toBe(true);
        await prepare(c, f, f.activation);
        await c.query(
          "DELETE FROM public.users_on_team WHERE user_id=$1 AND team_id=$2",
          [f.user, f.team],
        );
        expect((await claim(c, f, f.activation)).state).toBe("canceled");
        await c.query(
          "INSERT INTO public.users_on_team(user_id,team_id,role) VALUES($1,$2,'owner')",
          [f.user, f.team],
        );
        await c.query(
          "INSERT INTO public.bank_connections(team_id,institution_id,name,provider,status) VALUES($1,'onboarding-fixture','Synthetic bank','plaid','connected')",
          [f.team],
        );
        expect((await get(c, f, f.activation)).context.reason).toBe(
          "activation_not_needed",
        );
      }));
    test("tampered envelope, wrong subject or old token cannot authorize a send", async () =>
      run(async (c, f) => {
        await prepare(c, f);
        expect(
          (
            await c.query(
              "SELECT private.get_onboarding_delivery($1,$2) result",
              [f.welcome, randomUUID()],
            )
          ).rows[0].result,
        ).toBeNull();
        await c.query(
          "UPDATE private.onboarding_deliveries SET envelope=envelope||' ' WHERE id=$1",
          [f.welcome],
        );
        expect((await claim(c, f)).state).toBe("reconciliation");
        expect(
          await outcome(
            c,
            f,
            randomUUID(),
            "accepted",
            null,
            "forged-fixture-receipt",
          ),
        ).toBe("reconciliation");
      }));
    test("browser roles cannot read recipient/envelope or invoke service send claims", async () =>
      run(async (c, f) => {
        await c.query("SAVEPOINT browser_role");
        await c.query("SET LOCAL ROLE authenticated");
        await expect(
          c.query("SELECT * FROM private.onboarding_deliveries"),
        ).rejects.toThrow();
        await c.query("ROLLBACK TO SAVEPOINT browser_role");
        await c.query("SET LOCAL ROLE authenticated");
        await expect(
          c.query("SELECT private.claim_onboarding_delivery($1,$2)", [
            f.welcome,
            f.user,
          ]),
        ).rejects.toThrow();
        await c.query("ROLLBACK TO SAVEPOINT browser_role");
      }));
  },
);
