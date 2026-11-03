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
import { inArray, sql } from "drizzle-orm";
import type { Database, DatabaseOrTransaction } from "../client";
import { financialRequestHash } from "../financial-job";
import {
  type ExportDataSnapshot,
  getTeamExportHistoryById,
  listTeamExportHistory,
} from "../queries/export-snapshots";
import { withReplicas } from "../replicas";
import { teams } from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "read-only export history on isolated PostgreSQL",
  () => {
    let db: Database;
    let teamIds: string[] = [];
    beforeAll(() => {
      db = getTestDatabase();
    });
    beforeEach(async () => {
      teamIds = [randomUUID(), randomUUID()];
      await db.insert(teams).values(
        teamIds.map((id) => ({
          id,
          name: "Export history fixture",
          inboxId: id,
        })),
      );
    });
    afterEach(async () => {
      if (teamIds.length)
        await db.delete(teams).where(inArray(teams.id, teamIds));
      teamIds = [];
    });
    afterAll(closeDatabase);

    async function seed(
      teamId: string,
      options: {
        kind?: "team" | "transactions";
        createdAt?: string;
        outcome?: "complete" | "partial" | "failed";
        overrides?: Record<string, unknown>;
      } = {},
    ) {
      const id = randomUUID();
      const operationId = financialRequestHash(["history-fixture", teamId, id]);
      const snapshot: ExportDataSnapshot = {
        version: 1,
        teamId,
        kind: options.kind ?? "team",
        asOf: "2026-11-03T12:00:00.000Z",
        consistency: "repeatable-read",
        tables: { fixture: [{ customer_note: "private-snapshot-note" }] },
        transactionRows: [],
        requestedTransactionIds: [],
        omissions: [],
      };
      const snapshotHash = financialRequestHash(snapshot);
      const archiveHash = financialRequestHash(["archive", id]);
      const result = options.outcome
        ? {
            operationId,
            snapshotId: id,
            snapshotHash,
            archiveHash,
            fullPath: `${teamId}/exports/${operationId}/${archiveHash}.zip`,
            status: options.outcome,
            totalItems: 1,
            missingFiles: 0,
            providerSecret: "private-result-secret",
            fileName: "private-arbitrary-filename.zip",
            ...options.overrides,
          }
        : null;
      const at = options.createdAt ?? "2026-11-03T12:00:00.000001Z";
      await db.execute(sql`
        insert into export_snapshots(
          id,team_id,operation_key,request_hash,snapshot,snapshot_hash,result,created_at,updated_at
        ) values(
          ${id}::uuid,${teamId}::uuid,${operationId},${financialRequestHash(["request", id])},
          ${JSON.stringify(snapshot)}::jsonb,${snapshotHash},
          ${result === null ? null : JSON.stringify(result)}::jsonb,
          ${at}::timestamptz,${at}::timestamptz
        )
      `);
      return { id, teamId, operationId, snapshotHash, archiveHash, at };
    }
    async function savedRows(database: DatabaseOrTransaction) {
      const result = await database.execute(sql`
        select to_jsonb(s) as row from export_snapshots s
        where team_id in (${teamIds[0]}::uuid, ${teamIds[1]}::uuid)
        order by id
      `);
      return result.rows;
    }

    test("list/get isolate the current team and full-team kind", async () => {
      const own = await seed(teamIds[0]!, { outcome: "complete" });
      const foreign = await seed(teamIds[1]!, { outcome: "complete" });
      const selection = await seed(teamIds[0]!, {
        kind: "transactions",
        outcome: "complete",
      });
      const page = await listTeamExportHistory(db, { teamId: teamIds[0]! });
      expect(page.teamId).toBe(teamIds[0]);
      expect(page.items.map((row) => row.id)).toEqual([own.id]);
      expect(
        await getTeamExportHistoryById(db, {
          teamId: teamIds[0]!,
          id: foreign.id,
        }),
      ).toEqual({
        teamId: teamIds[0],
        item: null,
      });
      expect(
        (
          await getTeamExportHistoryById(db, {
            teamId: teamIds[0]!,
            id: selection.id,
          })
        ).item,
      ).toBeNull();
      expect(JSON.stringify(page)).not.toContain("private");
      expect(page.items[0]).not.toHaveProperty("snapshot");
      expect(page.items[0]).not.toHaveProperty("result");
      expect(page.items[0]).not.toHaveProperty("transactionRows");
    });

    test("reads primary even when the configured replica refuses history reads", async () => {
      const own = await seed(teamIds[0]!, { outcome: "complete" });
      const primary = db.usePrimaryOnly();
      let replicaReads = 0;
      const replica = new Proxy(primary, {
        get(target, key, receiver) {
          if (key === "execute")
            return () => {
              replicaReads += 1;
              throw new Error("History must not use a replica");
            };
          return Reflect.get(target, key, receiver);
        },
      });
      const routed = withReplicas(
        primary,
        [replica],
        (replicas) => replicas[0]!,
      );
      expect(
        (await listTeamExportHistory(routed, { teamId: teamIds[0]! })).items[0]
          ?.id,
      ).toBe(own.id);
      expect(
        (
          await getTeamExportHistoryById(routed, {
            teamId: teamIds[0]!,
            id: own.id,
          })
        ).item?.id,
      ).toBe(own.id);
      expect(replicaReads).toBe(0);
    });

    test("both endpoints work in an enforced read-only transaction and preserve every saved row", async () => {
      const own = await seed(teamIds[0]!);
      const before = await savedRows(db);
      await db.transaction(async (tx) => {
        await tx.execute(sql`set transaction read only`);
        const page = await listTeamExportHistory(tx, { teamId: teamIds[0]! });
        expect(page.items[0]).toMatchObject({
          id: own.id,
          outcome: "unknown",
          archive: null,
        });
        expect(
          (
            await getTeamExportHistoryById(tx, {
              teamId: teamIds[0]!,
              id: own.id,
            })
          ).item,
        ).toEqual(page.items[0]!);
      });
      expect(await savedRows(db)).toEqual(before);
    });

    test("keyset pagination retains microseconds and ties without gaps or duplicate rows", async () => {
      const rows = [];
      for (const suffix of ["000001", "000002", "000002", "000003"]) {
        rows.push(
          await seed(teamIds[0]!, {
            createdAt: `2026-11-03T12:00:00.${suffix}Z`,
          }),
        );
      }
      const expected = [...rows]
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
        .map((row) => row.id);
      const found: string[] = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (let pageIndex = 0; pageIndex < rows.length; pageIndex++) {
        const page = await listTeamExportHistory(db, {
          teamId: teamIds[0]!,
          limit: 1,
          cursor,
        });
        expect(page.items).toHaveLength(1);
        found.push(page.items[0]!.id);
        if (page.nextCursor) {
          expect(page.nextCursor.createdAt).toMatch(/\.\d{6}Z$/);
          cursor = page.nextCursor;
        } else {
          expect(pageIndex).toBe(rows.length - 1);
        }
      }
      expect(found).toEqual(expected);
      expect(new Set(found).size).toBe(rows.length);
    });

    test("null, invalid, partial and failed receipts keep their distinct durable outcomes", async () => {
      const unknown = await seed(teamIds[0]!);
      const invalid = await seed(teamIds[0]!, {
        outcome: "complete",
        overrides: {
          fullPath: `${teamIds[1]}/exports/${"a".repeat(64)}/${"b".repeat(64)}.zip`,
        },
      });
      const partial = await seed(teamIds[0]!, { outcome: "partial" });
      const failed = await seed(teamIds[0]!, { outcome: "failed" });
      const page = await listTeamExportHistory(db, { teamId: teamIds[0]! });
      const byId = new Map(page.items.map((entry) => [entry.id, entry]));
      expect(byId.get(unknown.id)).toMatchObject({
        outcome: "unknown",
        archive: null,
      });
      expect(byId.get(invalid.id)).toMatchObject({
        outcome: "unverified",
        archive: null,
      });
      expect(byId.get(partial.id)).toMatchObject({
        outcome: "partial",
        missingFiles: 0,
        archive: { sha256: partial.archiveHash },
      });
      expect(byId.get(failed.id)).toMatchObject({
        outcome: "failed",
        archive: { sha256: failed.archiveHash },
      });
      expect(JSON.stringify(page)).not.toContain("private");
    });
  },
);
