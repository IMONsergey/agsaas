import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

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
        await work(teamId, userId);
      } finally {
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
