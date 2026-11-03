import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import type { Database } from "../client";
import {
  assertNoPendingProviderCleanup,
  claimResourceCleanups,
  finishResourceCleanup,
  listResourceCleanups,
  openResourceCleanup,
  retainFileCleanup,
  retainResourceCleanup,
} from "../queries/resource-cleanups";
import { withReplicas } from "../replicas";
import { runtimeSchema } from "../runtime-schema";
import { teams } from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

describe.skipIf(!isTestDatabaseAvailable())(
  "durable resource cleanup (PostgreSQL)",
  () => {
    let db: Database;
    beforeAll(() => {
      db = getTestDatabase();
    });
    afterAll(closeDatabase);
    async function fixture(
      work: (teamId: string, userId: string) => Promise<void>,
    ) {
      const teamId = randomUUID(),
        userId = randomUUID();
      try {
        // File erasure now locks the live team before its object scope.
        await db
          .insert(teams)
          .values({ id: teamId, inboxId: teamId, name: "Cleanup fixture" });
        await work(teamId, userId);
      } finally {
        await db.delete(teams).where(eq(teams.id, teamId));
        await db.execute(
          sql`DELETE FROM public.resource_cleanups WHERE team_id = ${teamId}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM public.storage_deletion_tombstones WHERE team_id = ${teamId}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM public.security_audit_events WHERE team_id = ${teamId}::uuid`,
        );
      }
    }
    async function retain(teamId: string, actorUserId: string) {
      return db.transaction((tx) =>
        retainResourceCleanup(tx, {
          version: 1,
          kind: "provider",
          teamId,
          actorUserId,
          targetId: randomUUID(),
          provider: "slack",
          data: {
            accessToken: "retained-secret-fixture",
            externalId: randomUUID(),
          },
        }),
      );
    }
    async function onlyClaim(id: string, teamId: string) {
      return (await claimResourceCleanups(db, 1, teamId)).find(
        (row) => row.id === id,
      )!;
    }
    test("retained secrets roll back with the requesting transaction", async () =>
      fixture(async (teamId, actorUserId) => {
        await expect(
          db.transaction(async (tx) => {
            await retainResourceCleanup(tx, {
              version: 1,
              kind: "provider",
              teamId,
              actorUserId,
              targetId: randomUUID(),
              provider: "slack",
              data: { accessToken: "secret" },
            });
            throw new Error("injected failure");
          }),
        ).rejects.toThrow("injected");
        expect(
          await listResourceCleanups(db, { teamId, actorUserId }),
        ).toHaveLength(0);
      }));
    test("credentials survive source removal, are identity-bound, and never appear in public status", async () =>
      fixture(async (teamId, actorUserId) => {
        const retained = await retain(teamId, actorUserId);
        const claim = await onlyClaim(retained.id, teamId);
        expect(claim).toBeTruthy();
        expect(claim.encryptedPayload).not.toContain("retained-secret-fixture");
        expect(openResourceCleanup(claim).data.accessToken).toBe(
          "retained-secret-fixture",
        );
        expect(() =>
          openResourceCleanup({ ...claim, teamId: randomUUID() }),
        ).toThrow();
        const publicRows = await listResourceCleanups(db, {
          teamId,
          actorUserId,
        });
        expect(JSON.stringify(publicRows)).not.toContain("encryptedPayload");
        expect(JSON.stringify(publicRows)).not.toContain("retained-secret");
        expect(
          await listResourceCleanups(db, {
            teamId: randomUUID(),
            actorUserId: randomUUID(),
          }),
        ).toHaveLength(0);
      }));
    test("a stale worker cannot confirm a newer dispatch, completion erases retained secrets", async () =>
      fixture(async (teamId, actorUserId) => {
        const retained = await retain(teamId, actorUserId);
        const row = await onlyClaim(retained.id, teamId);
        expect(
          await finishResourceCleanup(
            db,
            { ...row, dispatchToken: randomUUID() },
            { status: "completed" },
          ),
        ).toBe(false);
        expect(
          await finishResourceCleanup(db, row, { status: "completed" }),
        ).toBe(true);
        expect(
          await finishResourceCleanup(db, row, { status: "completed" }),
        ).toBe(false);
        const saved = await db.execute<{
          encrypted_payload: string | null;
          status: string;
        }>(
          sql`SELECT encrypted_payload, status FROM public.resource_cleanups WHERE id = ${row.id}::uuid`,
        );
        expect(saved.rows[0]).toEqual({
          encrypted_payload: null,
          status: "completed",
        });
      }));

    test(
      "a lease expiring behind an unchanged row lock cannot complete cleanup or erase retained secrets",
      async () =>
        fixture(async (teamId, actorUserId) => {
          const retained = await retain(teamId, actorUserId);
          const claim = await onlyClaim(retained.id, teamId);
          expect(claim).toBeTruthy();
          const pool = new Pool({
            connectionString: getTestDatabaseUrl(),
            max: 3,
            connectionTimeoutMillis: 3000,
          });
          let holder: PoolClient | undefined;
          let waiter: PoolClient | undefined;
          let finishing:
            | Promise<{ value: boolean } | { error: unknown }>
            | undefined;
          try {
            holder = await pool.connect();
            waiter = await pool.connect();
            for (const client of [holder, waiter])
              await client.query("SET statement_timeout='8s'");
            const holderPid = (
              await holder.query<{ id: number }>(
                "SELECT pg_backend_pid() AS id",
              )
            ).rows[0]!.id;
            const waiterPid = (
              await waiter.query<{ id: number }>(
                "SELECT pg_backend_pid() AS id",
              )
            ).rows[0]!.id;
            const expiry = await pool.query<{ deadline: Date }>(
              "UPDATE public.resource_cleanups SET lease_expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1 RETURNING lease_expires_at AS deadline",
              [claim.id],
            );
            const deadline = expiry.rows[0]!.deadline;
            const before = await pool.query(
              "SELECT status,encrypted_payload,dispatch_token,attempts,lease_expires_at,next_attempt_at,reason,updated_at FROM public.resource_cleanups WHERE id=$1",
              [claim.id],
            );
            await holder.query("BEGIN");
            // This holder never changes the tuple, so PostgreSQL need not
            // re-evaluate the old UPDATE predicate after releasing the lock.
            await holder.query(
              "SELECT id FROM public.resource_cleanups WHERE id=$1 FOR UPDATE",
              [claim.id],
            );
            const primary = drizzle(waiter, {
              schema: runtimeSchema,
              casing: "snake_case",
            });
            const bound = withReplicas(
              primary,
              [primary],
              (replicas) => replicas[0]!,
            );
            finishing = finishResourceCleanup(bound, claim, {
              status: "completed",
            }).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
            const lockDeadline = Date.now() + 3500;
            let blocked = false;
            while (Date.now() < lockDeadline) {
              const barrier = await pool.query<{
                blocked: boolean;
                began_before_expiry: boolean;
              }>(
                "SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked, (SELECT xact_start<$3::timestamptz FROM pg_stat_activity WHERE pid=$2::int) AS began_before_expiry",
                [holderPid, waiterPid, deadline],
              );
              if (barrier.rows[0]?.blocked) {
                expect(barrier.rows[0].began_before_expiry).toBe(true);
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (!blocked)
              throw new Error(
                "Cleanup finalization did not reach its row-lock barrier",
              );
            // Use the database clock for expiry; the test does not depend on
            // the worker host clock or an arbitrary pre-lock delay.
            await pool.query(
              "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)",
              [deadline],
            );
            await holder.query("COMMIT");
            expect(await finishing).toEqual({ value: false });
            const after = await pool.query(
              "SELECT status,encrypted_payload,dispatch_token,attempts,lease_expires_at,next_attempt_at,reason,updated_at FROM public.resource_cleanups WHERE id=$1",
              [claim.id],
            );
            expect(after.rows[0]).toEqual(before.rows[0]);
            expect(after.rows[0]?.status).toBe("processing");
            expect(after.rows[0]?.encrypted_payload).toBe(
              claim.encryptedPayload,
            );
            expect(after.rows[0]?.dispatch_token).toBe(claim.dispatchToken);
            expect(
              (
                await pool.query<{ expired: boolean }>(
                  "SELECT lease_expires_at<=clock_timestamp() AS expired FROM public.resource_cleanups WHERE id=$1",
                  [claim.id],
                )
              ).rows[0]?.expired,
            ).toBe(true);
            expect(
              (
                await pool.query<{ transitions: number }>(
                  "SELECT count(*)::int AS transitions FROM public.security_audit_events WHERE team_id=$1 AND operation='cleanup.transition' AND target_id=$2",
                  [teamId, claim.id],
                )
              ).rows[0]?.transitions,
            ).toBe(0);
          } finally {
            // Unblock the real finisher before releasing either connection;
            // fixture teardown cannot race a still-running cleanup transaction.
            await holder?.query("ROLLBACK").catch(() => {});
            await finishing;
            await waiter?.query("ROLLBACK").catch(() => {});
            holder?.release();
            waiter?.release();
            await pool.end();
          }
        }),
      15000,
    );

    test("an interrupted provider lease becomes unknown and blocks reconnect", async () =>
      fixture(async (teamId, actorUserId) => {
        const retained = await retain(teamId, actorUserId);
        const row = await onlyClaim(retained.id, teamId);
        await db.execute(
          sql`UPDATE public.resource_cleanups SET lease_expires_at = now() - interval '1 second' WHERE id = ${row.id}::uuid`,
        );
        await claimResourceCleanups(db, 1, teamId);
        const status = (
          await listResourceCleanups(db, { teamId, actorUserId })
        )[0]!.status;
        expect(status).toBe("unknown");
        await expect(
          db.transaction((tx) =>
            assertNoPendingProviderCleanup(tx, teamId, "slack"),
          ),
        ).rejects.toThrow("previous provider disconnection");
      }));
    test("file intents enforce canonical tenant scope before any metadata or queue side effect", async () =>
      fixture(async (teamId, actorUserId) => {
        await expect(
          db.transaction((tx) =>
            retainFileCleanup(tx, {
              teamId,
              actorUserId,
              path: `${randomUUID()}/file.pdf`,
            }),
          ),
        ).rejects.toThrow();
        expect(
          await listResourceCleanups(db, { teamId, actorUserId }),
        ).toHaveLength(0);
        const cleanup = await db.transaction((tx) =>
          retainFileCleanup(tx, {
            teamId,
            actorUserId,
            path: `${teamId}/inbox/file.pdf`,
          }),
        );
        expect(cleanup.status).toBe("pending");
        const tombstone = await db.execute(
          sql`SELECT object_hash FROM public.storage_deletion_tombstones WHERE team_id = ${teamId}::uuid`,
        );
        expect(tombstone.rows).toHaveLength(1);
        expect(
          (
            await db.transaction((tx) =>
              retainFileCleanup(tx, {
                teamId,
                actorUserId,
                path: `${teamId}/inbox/file.pdf`,
              }),
            )
          ).id,
        ).toBe(cleanup.id);
      }));
  },
);
