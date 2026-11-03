import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { HostedConsentActor } from "../bank-consent";
import type { Database, TransactionClient } from "../client";
import {
  getBankConnectionCleanup,
  openBankConnectionCleanup,
} from "../queries/bank-connection-cleanups";
import { getBankSyncStatus } from "../queries/bank-sync";
import {
  acceptHostedBankConsent,
  beginHostedBankConsent,
  cancelHostedBankConsent,
  claimHostedBankExchange,
  getHostedBankCleanupBinding,
  getHostedBankConsent,
  hostedBankConsentView,
  openHostedBankConsent,
  reconcileHostedBankConsents,
  retainHostedBankAccess,
  retainHostedBankGrant,
  retainHostedBankLink,
  type HostedBankConsent,
} from "../queries/hosted-bank-consents";
import {
  bankAccounts,
  bankConnections,
  teams,
  users,
  usersOnTeam,
} from "../schema";
import {
  removeTestProfiles,
  seedTestProfiles,
} from "./helpers/profile-fixture";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

// This suite requires the complete foundation plus reviewed migration111000.
// It never installs or replays a migration and never calls a provider.
describe.skipIf(!isTestDatabaseAvailable())(
  "native bank consent SQL lifecycle",
  () => {
    let db: Database;
    let previousKey: string | undefined;
    beforeAll(async () => {
      db = getTestDatabase();
      previousKey = process.env.MIDDAY_ENCRYPTION_KEY;
      process.env.MIDDAY_ENCRYPTION_KEY = "37".repeat(32);
      const ready = await db.execute<{
        ready: boolean;
      }>(sql`SELECT to_regclass('public.hosted_bank_consents') IS NOT NULL
      AND to_regprocedure('private.lock_hosted_bank_consent_session(uuid,uuid,text)') IS NOT NULL AS ready`);
      expect(ready.rows[0]?.ready).toBe(true);
    });
    afterAll(async () => {
      if (previousKey === undefined) delete process.env.MIDDAY_ENCRYPTION_KEY;
      else process.env.MIDDAY_ENCRYPTION_KEY = previousKey;
      await closeDatabase();
    });

    async function fixture(
      work: (actor: HostedConsentActor, coOwner: string) => Promise<void>,
    ) {
      const actor: HostedConsentActor = {
        teamId: randomUUID(),
        userId: randomUUID(),
        sessionId: randomUUID(),
        aal: "aal1",
      };
      const coOwner = randomUUID();
      const ids = [actor.userId, coOwner];
      let bodyFailure: { error: unknown } | undefined;
      try {
        await db.transaction(async (tx) => {
          await tx.insert(teams).values({
            id: actor.teamId,
            inboxId: actor.teamId,
            name: "Consent fixture",
          });
          await seedTestProfiles(
            tx,
            ids.map((id) => ({
              id,
              teamId: actor.teamId,
              fullName: "Consent owner",
              email: `${id}@example.test`,
            })),
          );
          await tx.insert(usersOnTeam).values(
            ids.map((userId) => ({
              userId,
              teamId: actor.teamId,
              role: "owner" as const,
            })),
          );
          await tx.execute(
            sql`INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(${actor.sessionId}::uuid,${actor.userId}::uuid,now(),now())`,
          );
        });
        await work(actor, coOwner);
      } catch (error) {
        bodyFailure = { error };
        throw error;
      } finally {
        try {
          await db.transaction(async (tx) => {
            // Let the actual deletion/revocation triggers run before removing
            // this fixture's retained rows. No production guard is disabled.
            await tx.delete(teams).where(eq(teams.id, actor.teamId));
            await tx.delete(users).where(inArray(users.id, ids));
            await removeTestProfiles(tx, ids);
            const actors = sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            );
            await tx.execute(
              sql`DELETE FROM public.hosted_bank_consents WHERE team_id=${actor.teamId}::uuid`,
            );
            await tx.execute(
              sql`DELETE FROM public.bank_connection_cleanups WHERE team_id=${actor.teamId}::uuid`,
            );
            await tx.execute(
              sql`DELETE FROM public.resource_cleanups WHERE team_id=${actor.teamId}::uuid OR actor_user_id IN (${actors})`,
            );
            await tx.execute(
              sql`DELETE FROM public.security_audit_events WHERE team_id=${actor.teamId}::uuid OR actor_user_id IN (${actors})`,
            );
            await tx.execute(
              sql`DELETE FROM public.storage_deletion_tombstones WHERE team_id=${actor.teamId}::uuid`,
            );
            const retained = await tx.execute<{ remains: boolean }>(sql`SELECT
              EXISTS(SELECT 1 FROM public.hosted_bank_consents WHERE team_id=${actor.teamId}::uuid) OR
              EXISTS(SELECT 1 FROM public.bank_connection_cleanups WHERE team_id=${actor.teamId}::uuid) OR
              EXISTS(SELECT 1 FROM public.resource_cleanups WHERE team_id=${actor.teamId}::uuid OR actor_user_id IN (${actors})) OR
              EXISTS(SELECT 1 FROM public.security_audit_events WHERE team_id=${actor.teamId}::uuid OR actor_user_id IN (${actors})) OR
              EXISTS(SELECT 1 FROM public.storage_deletion_tombstones WHERE team_id=${actor.teamId}::uuid) OR
              EXISTS(SELECT 1 FROM public.bank_connections WHERE team_id=${actor.teamId}::uuid) OR
              EXISTS(SELECT 1 FROM public.bank_accounts WHERE team_id=${actor.teamId}::uuid) OR
              EXISTS(SELECT 1 FROM public.teams WHERE id=${actor.teamId}::uuid) OR
              EXISTS(SELECT 1 FROM public.users WHERE id IN (${actors})) OR
              EXISTS(SELECT 1 FROM auth.users WHERE id IN (${actors})) OR
              EXISTS(SELECT 1 FROM auth.sessions WHERE user_id IN (${actors})) OR
              EXISTS(SELECT 1 FROM auth.mfa_factors WHERE user_id IN (${actors})) AS remains`);
            expect(retained.rows[0]?.remains).toBe(false);
          });
        } catch (error) {
          console.error("Native bank consent fixture cleanup failed", {
            teamId: actor.teamId,
            userIds: ids,
            sessionId: actor.sessionId,
          });
          if (bodyFailure)
            throw new AggregateError(
              [bodyFailure.error, error],
              "Native bank consent fixture body and cleanup both failed",
            );
          throw error;
        }
      }
    }

    type Outcome<T> = { value?: T; error?: unknown };
    const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

    async function waitForBlock(
      waiter: () => number | undefined,
      blocker: number,
    ) {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const pid = waiter();
        if (pid) {
          const result = await db.execute<{ blocked: boolean }>(
            sql`SELECT ${blocker}::integer = ANY(pg_blocking_pids(${pid}::integer)) AS blocked`,
          );
          if (result.rows[0]?.blocked) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        "Expected the competing transaction to wait for the held Auth lock",
      );
    }

    async function acceptanceAfterAuthChange(
      actor: HostedConsentActor,
      id: string,
      hold: (tx: TransactionClient) => Promise<unknown>,
      change: (tx: TransactionClient) => Promise<unknown>,
    ) {
      let pending: Promise<Outcome<HostedBankConsent>> | undefined;
      let waiterPid: number | undefined;
      try {
        await db.transaction(async (holder) => {
          await holder.execute(sql`SET LOCAL statement_timeout='10s'`);
          await hold(holder);
          const holderPid = await holder.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          pending = observe(
            db.transaction(async (waiter) => {
              await waiter.execute(sql`SET LOCAL lock_timeout='10s'`);
              const own = await waiter.execute<{ pid: number }>(
                sql`SELECT pg_backend_pid() AS pid`,
              );
              waiterPid = own.rows[0]?.pid;
              return acceptHostedBankConsent(waiter, actor, id);
            }),
          );
          await waitForBlock(() => waiterPid, holderPid.rows[0]!.pid);
          await change(holder);
        });
      } finally {
        // Release/rollback the holder before awaiting its waiter, including
        // assertion failure, so fixture cleanup cannot race a live transaction.
        if (pending) await pending;
      }
      if (!pending) throw new Error("Competing acceptance was not started");
      return pending;
    }

    const start = (actor: HostedConsentActor, requestId = randomUUID()) =>
      beginHostedBankConsent(db, {
        ...actor,
        requestId,
        environment: "sandbox",
        clientFingerprint: "a".repeat(64),
        country: "US",
      });
    async function linked(actor: HostedConsentActor) {
      const { row } = await start(actor);
      return retainHostedBankLink(db, {
        id: row.id,
        claimToken: row.claimToken!,
        linkToken: `link-sandbox-${row.id}`,
        hostedUrl: `https://secure.plaid.com/hl/${row.id}`,
        expiresAt: row.expiresAt,
      });
    }
    async function exchanging(actor: HostedConsentActor) {
      const row = await linked(actor);
      const claim = await claimHostedBankExchange(db, actor, {
        id: row.id,
        publicToken: `public-sandbox-${row.id}`,
        linkSessionId: randomUUID(),
      });
      expect(claim.claimed).toBe(true);
      return claim.row;
    }
    async function verified(actor: HostedConsentActor) {
      const row = await exchanging(actor);
      const grant = {
        id: row.id,
        claimToken: row.claimToken!,
        accessToken: `access-sandbox-${row.id}`,
        itemId: `item-${row.id}`,
      };
      await retainHostedBankAccess(db, grant);
      return retainHostedBankGrant(db, {
        ...grant,
        institutionId: `institution-${row.id}`,
        institutionName: "Fixture bank",
        accounts: [
          {
            accountId: `account-${row.id}`,
            name: "Checking",
            currency: "USD",
            type: "depository",
            subtype: "checking",
          },
        ],
      });
    }
    const membership = (actor: HostedConsentActor) =>
      and(
        eq(usersOnTeam.teamId, actor.teamId),
        eq(usersOnTeam.userId, actor.userId),
      );

    test("idempotent starts are session-bound, encrypted and owner-only", async () =>
      fixture(async (actor) => {
        const request = randomUUID();
        const first = await start(actor, request);
        const second = await start(actor, request);
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.row.id).toBe(first.row.id);
        expect(first.row.encryptedPayload).not.toContain(actor.userId);
        await expect(
          getHostedBankConsent(
            db,
            { ...actor, sessionId: randomUUID() },
            first.row.id,
          ),
        ).rejects.toThrow();
        await db
          .update(usersOnTeam)
          .set({ role: "member" })
          .where(membership(actor));
        await expect(start(actor)).rejects.toThrow();
        await expect(
          getHostedBankConsent(db, actor, first.row.id),
        ).rejects.toThrow();
      }));
    test("exactly one concurrent exchange claim owns provider IO", async () =>
      fixture(async (actor) => {
        const row = await linked(actor);
        const evidence = {
          id: row.id,
          publicToken: `public-sandbox-${row.id}`,
          linkSessionId: randomUUID(),
        };
        const results = await Promise.all([
          claimHostedBankExchange(db, actor, evidence),
          claimHostedBankExchange(db, actor, evidence),
        ]);
        expect(results.filter((result) => result.claimed)).toHaveLength(1);
        expect(results[0]?.row.claimToken).toBe(results[1]?.row.claimToken);
      }));
    test("accounts, audit and the native sync request commit once without inventing a balance", async () =>
      fixture(async (actor) => {
        const row = await verified(actor);
        const outcomes = await Promise.all([
          acceptHostedBankConsent(db, actor, row.id),
          acceptHostedBankConsent(db, actor, row.id),
        ]);
        expect(outcomes.every((result) => result.status === "completed")).toBe(
          true,
        );
        const connections = await db
          .select()
          .from(bankConnections)
          .where(eq(bankConnections.teamId, actor.teamId));
        const accounts = await db
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.teamId, actor.teamId));
        expect(connections).toHaveLength(1);
        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.balance).toBeNull();
        expect(accounts[0]?.accountId).toBe(`account-${row.id}`);
        const syncScope = { teamId: actor.teamId, connectionId: row.id };
        const syncStatus = await getBankSyncStatus(db, syncScope);
        expect(syncStatus).toMatchObject({ completedGeneration: 0 });
        expect(syncStatus?.requestedGeneration).toBeGreaterThan(0);
        const receipts = await db.execute<{ event_key: string }>(
          sql`SELECT event_key FROM private.bank_sync_webhook_receipts WHERE connection_id=${row.id}::uuid`,
        );
        expect(receipts.rows).toEqual([
          {
            event_key: createHash("sha256")
              .update(`consent:${row.id}`)
              .digest("hex"),
          },
        ]);
        // Connection/account triggers may each advance the pending generation.
        // Replaying accepted consent must preserve it and its single receipt.
        await acceptHostedBankConsent(db, actor, row.id);
        expect(await getBankSyncStatus(db, syncScope)).toEqual(syncStatus);
        expect(
          (
            await db.execute<{ event_key: string }>(
              sql`SELECT event_key FROM private.bank_sync_webhook_receipts WHERE connection_id=${row.id}::uuid`,
            )
          ).rows,
        ).toEqual(receipts.rows);
        const events = await db.execute(
          sql`SELECT id FROM public.security_audit_events WHERE team_id=${actor.teamId}::uuid AND operation='bank.connect'`,
        );
        expect(events.rows).toHaveLength(1);
        expect(openHostedBankConsent(outcomes[0]!)).not.toHaveProperty(
          "accessToken",
        );
        expect(
          JSON.stringify(hostedBankConsentView(outcomes[0]!)),
        ).not.toContain("access-sandbox");
      }));
    test("audit persistence denial rolls back connection, accounts, sync and completion", async () =>
      fixture(async (actor) => {
        const row = await verified(actor);
        let failure: unknown;
        try {
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`REVOKE INSERT ON public.security_audit_events FROM agsaas_app`,
            );
            await tx.execute(sql`SET LOCAL ROLE agsaas_app`);
            await acceptHostedBankConsent(tx, actor, row.id);
            throw new Error("fixture audit fault did not fire");
          });
        } catch (error) {
          failure = error;
        }
        let code: unknown,
          message = "";
        for (
          let depth = 0;
          depth < 8 && failure && typeof failure === "object";
          depth++
        ) {
          if ("code" in failure) {
            code = failure.code;
            message = "message" in failure ? String(failure.message) : "";
            break;
          }
          failure = "cause" in failure ? failure.cause : undefined;
        }
        expect(code).toBe("42501");
        expect(message).toContain("security_audit_events");
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(bankAccounts)
            .where(eq(bankAccounts.teamId, actor.teamId)),
        ).toHaveLength(0);
        expect(
          await getBankSyncStatus(db, {
            teamId: actor.teamId,
            connectionId: row.id,
          }),
        ).toBeNull();
        expect((await getHostedBankConsent(db, actor, row.id)).status).toBe(
          "verified",
        );
      }));
    test("late exchange receipts after session revocation are retained for cancellation", async () =>
      fixture(async (actor) => {
        const row = await exchanging(actor);
        await db.execute(
          sql`DELETE FROM auth.sessions WHERE id=${actor.sessionId}::uuid`,
        );
        const result = await retainHostedBankAccess(db, {
          id: row.id,
          claimToken: row.claimToken!,
          accessToken: `access-sandbox-${row.id}`,
          itemId: `item-${row.id}`,
        });
        expect(result.status).toBe("cleanup_pending");
        expect(result.reason).toBe("scope_revoked");
        const cleanup = await getBankConnectionCleanup(db, result.cleanupId!);
        expect(cleanup).toBeTruthy();
        expect(openBankConnectionCleanup(cleanup!)).toEqual({
          provider: "plaid",
          referenceId: `item-${row.id}`,
          accessToken: `access-sandbox-${row.id}`,
        });
        expect(await getHostedBankCleanupBinding(db, cleanup!)).toEqual({
          environment: "sandbox",
          clientFingerprint: "a".repeat(64),
        });
        await expect(
          acceptHostedBankConsent(db, actor, row.id),
        ).rejects.toThrow();
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(0);
      }));
    test("owner demotion invalidates verified consent before acceptance", async () =>
      fixture(async (actor) => {
        const row = await verified(actor);
        await db
          .update(usersOnTeam)
          .set({ role: "member" })
          .where(membership(actor));
        await expect(
          acceptHostedBankConsent(db, actor, row.id),
        ).rejects.toThrow();
        await reconcileHostedBankConsents(db);
        const stored = await db.execute<{
          status: string;
          cleanup_id: string | null;
        }>(
          sql`SELECT status,cleanup_id FROM public.hosted_bank_consents WHERE id=${row.id}::uuid`,
        );
        expect(stored.rows[0]?.status).toBe("cleanup_pending");
        expect(stored.rows[0]?.cleanup_id).toBeTruthy();
      }));
    test("cancellation during exchange never loses a late revocation credential", async () =>
      fixture(async (actor) => {
        const row = await exchanging(actor);
        expect((await cancelHostedBankConsent(db, actor, row.id)).status).toBe(
          "reconciliation",
        );
        const result = await retainHostedBankAccess(db, {
          id: row.id,
          claimToken: row.claimToken!,
          accessToken: `access-sandbox-${row.id}`,
          itemId: `item-${row.id}`,
        });
        expect(result.status).toBe("cleanup_pending");
        expect(
          (await cancelHostedBankConsent(db, actor, row.id)).cleanupId,
        ).toBe(result.cleanupId);
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(0);
      }));
    test("newly verified MFA blocks a stale aal1 consent and permits the current aal2 session", async () =>
      fixture(async (actor) => {
        const row = await verified(actor);
        await db.execute(
          sql`INSERT INTO auth.mfa_factors(id,user_id,status) VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,'verified')`,
        );
        await expect(
          acceptHostedBankConsent(db, actor, row.id),
        ).rejects.toThrow();
        expect(
          (await acceptHostedBankConsent(db, { ...actor, aal: "aal2" }, row.id))
            .status,
        ).toBe("completed");
      }));
    test("committed session revocation wins an acceptance waiting on the Auth parent lock", async () =>
      fixture(async (actor) => {
        const row = await verified(actor);
        const outcome = await acceptanceAfterAuthChange(
          actor,
          row.id,
          (tx) =>
            tx.execute(
              sql`SELECT id FROM auth.users WHERE id=${actor.userId}::uuid FOR UPDATE`,
            ),
          (tx) =>
            tx.execute(
              sql`SELECT private.revoke_auth_sessions(${actor.userId}::uuid,${actor.sessionId}::uuid,'all')`,
            ),
        );
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toMatchObject({ reason: "session_expired" });
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(0);
        const retained = await db.execute<{ status: string; reason: string }>(
          sql`SELECT status,reason FROM public.hosted_bank_consents WHERE id=${row.id}::uuid`,
        );
        expect(retained.rows[0]).toEqual({
          status: "cleanup_requested",
          reason: "scope_revoked",
        });
      }));
    test("MFA enrollment committed before the Auth parent lock is visible to a waited aal1 acceptance", async () =>
      fixture(async (actor) => {
        const row = await verified(actor);
        const outcome = await acceptanceAfterAuthChange(
          actor,
          row.id,
          (tx) =>
            tx.execute(
              sql`SELECT id FROM auth.users WHERE id=${actor.userId}::uuid FOR UPDATE`,
            ),
          (tx) =>
            tx.execute(
              sql`INSERT INTO auth.mfa_factors(id,user_id,status) VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,'verified')`,
            ),
        );
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toMatchObject({ reason: "session_expired" });
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(0);
        expect(
          (await acceptHostedBankConsent(db, { ...actor, aal: "aal2" }, row.id))
            .status,
        ).toBe("completed");
      }));
    test("verification of an existing MFA factor is fenced even when its user FK does not change", async () =>
      fixture(async (actor) => {
        const factorId = randomUUID();
        await db.execute(
          sql`INSERT INTO auth.mfa_factors(id,user_id,status) VALUES(${factorId}::uuid,${actor.userId}::uuid,'unverified')`,
        );
        const row = await verified(actor);
        const outcome = await acceptanceAfterAuthChange(
          actor,
          row.id,
          (tx) =>
            tx.execute(
              sql`SELECT id FROM auth.mfa_factors WHERE id=${factorId}::uuid FOR UPDATE`,
            ),
          (tx) =>
            tx.execute(
              sql`UPDATE auth.mfa_factors SET status='verified' WHERE id=${factorId}::uuid`,
            ),
        );
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toMatchObject({ reason: "session_expired" });
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(0);
      }));
    test("an accepted transaction holds the Auth parent fence until a new MFA factor can commit", async () =>
      fixture(async (actor) => {
        const row = await verified(actor);
        let pending: Promise<Outcome<unknown>> | undefined;
        let waiterPid: number | undefined;
        try {
          await db.transaction(async (holder) => {
            await holder.execute(sql`SET LOCAL statement_timeout='10s'`);
            expect(
              (await acceptHostedBankConsent(holder, actor, row.id)).status,
            ).toBe("completed");
            const holderPid = await holder.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            pending = observe(
              db.transaction(async (waiter) => {
                await waiter.execute(sql`SET LOCAL lock_timeout='10s'`);
                const own = await waiter.execute<{ pid: number }>(
                  sql`SELECT pg_backend_pid() AS pid`,
                );
                waiterPid = own.rows[0]?.pid;
                return waiter.execute(
                  sql`INSERT INTO auth.mfa_factors(id,user_id,status) VALUES(${randomUUID()}::uuid,${actor.userId}::uuid,'verified')`,
                );
              }),
            );
            await waitForBlock(() => waiterPid, holderPid.rows[0]!.pid);
          });
        } finally {
          if (pending) await pending;
        }
        if (!pending)
          throw new Error("Competing MFA enrollment was not started");
        expect((await pending).error).toBeUndefined();
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(1);
        await expect(start(actor)).rejects.toMatchObject({
          reason: "session_expired",
        });
      }));
    test("an expired unknown creation is reconciliation, never fictitious cancellation", async () =>
      fixture(async (actor) => {
        const { row } = await start(actor);
        await db.execute(
          sql`UPDATE public.hosted_bank_consents SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${row.id}::uuid`,
        );
        await reconcileHostedBankConsents(db);
        const result = await getHostedBankConsent(db, actor, row.id);
        expect(result.status).toBe("reconciliation");
        expect(result.cleanupId).toBeNull();
        await expect(start(actor)).rejects.toThrow();
      }));
    test("SQL expiry wins even when the API clock is behind the database", async () =>
      fixture(async (actor) => {
        const waiting = await linked(actor);
        const checked = await verified(actor);
        await db.execute(sql`UPDATE public.hosted_bank_consents
          SET expires_at=clock_timestamp()-interval '1 second'
          WHERE id IN (${waiting.id}::uuid,${checked.id}::uuid)`);
        const originalNow = Date.now;
        Date.now = () => 0;
        try {
          await expect(
            claimHostedBankExchange(db, actor, {
              id: waiting.id,
              publicToken: `public-sandbox-${waiting.id}`,
              linkSessionId: randomUUID(),
            }),
          ).rejects.toThrow();
          expect(
            (await acceptHostedBankConsent(db, actor, checked.id)).status,
          ).toBe("cleanup_pending");
          const current = await getHostedBankConsent(db, actor, waiting.id);
          expect(hostedBankConsentView(current, true)).not.toHaveProperty(
            "url",
          );
        } finally {
          Date.now = originalNow;
        }
        expect(
          await db
            .select()
            .from(bankConnections)
            .where(eq(bankConnections.teamId, actor.teamId)),
        ).toHaveLength(0);
      }));
    test("a transaction that outlives its session cannot rely on transaction-start now()", async () =>
      fixture(async (actor) => {
        await db.transaction(async (tx) => {
          await tx.execute(sql`UPDATE auth.sessions SET not_after=clock_timestamp()+interval '50 milliseconds'
            WHERE id=${actor.sessionId}::uuid`);
          await tx.execute(sql`SELECT pg_sleep(0.10)`);
          const result = await tx.execute<{
            active: boolean;
          }>(sql`SELECT private.lock_hosted_bank_consent_session(
            ${actor.userId}::uuid,${actor.sessionId}::uuid,${actor.aal}) AS active`);
          expect(result.rows[0]?.active).toBe(false);
        });
      }));
    test("Data API and service roles cannot read retained consent credentials", async () => {
      const privileges = await db.execute<{ allowed: boolean }>(sql`SELECT
      has_table_privilege('anon','public.hosted_bank_consents','SELECT,INSERT,UPDATE,DELETE') OR
      has_table_privilege('authenticated','public.hosted_bank_consents','SELECT,INSERT,UPDATE,DELETE') OR
      has_table_privilege('service_role','public.hosted_bank_consents','SELECT,INSERT,UPDATE,DELETE') AS allowed`);
      expect(privileges.rows[0]?.allowed).toBe(false);
    });
  },
);
