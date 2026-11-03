import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { financialRequestHash } from "../financial-job";
import { getExportFileAccessReceipts } from "../queries/export-file-access";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

describe.skipIf(!isTestDatabaseAvailable())(
  "export archive access metadata (isolated PostgreSQL)",
  () => {
    afterAll(closeDatabase);

    test("primary metadata rejects nested archives and malformed source shapes without returning business data", async () => {
      const db = getTestDatabase();
      const rollback = new Error("rollback exact export-access fixture");
      const team = randomUUID();
      const other = randomUUID();
      const cases: Array<{
        name: string;
        rows: unknown;
        safe: boolean;
        kind?: string;
      }> = [
        {
          name: "ordinary",
          rows: [{ attachments: [{ path: [team, "inbox", "ordinary.pdf"] }] }],
          safe: true,
        },
        { name: "empty", rows: [], safe: true },
        {
          name: "null path",
          rows: [{ attachments: [{ path: null }] }],
          safe: true,
        },
        {
          name: "empty path",
          rows: [{ attachments: [{ path: [] }] }],
          safe: true,
        },
        {
          name: "content-addressed archive",
          rows: [
            {
              attachments: [
                {
                  path: [
                    team,
                    "exports",
                    "a".repeat(64),
                    `${"b".repeat(64)}.zip`,
                  ],
                },
              ],
            },
          ],
          safe: false,
        },
        {
          name: "legacy archive",
          rows: [
            {
              attachments: [
                { path: [team, "exports", "team-export-2026-11-03.zip"] },
              ],
            },
          ],
          safe: false,
        },
        {
          name: "foreign source",
          rows: [{ attachments: [{ path: [other, "inbox", "private.pdf"] }] }],
          safe: false,
        },
        {
          name: "encoded source",
          rows: [
            { attachments: [{ path: [team, "%65xports", "private.zip"] }] },
          ],
          safe: false,
        },
        { name: "missing attachments", rows: [{}], safe: false },
        { name: "missing path", rows: [{ attachments: [{}] }], safe: false },
        { name: "non-array rows", rows: {}, safe: false },
        {
          name: "non-array attachments",
          rows: [{ attachments: {} }],
          safe: false,
        },
        {
          name: "non-array path",
          rows: [{ attachments: [{ path: `${team}/exports/private.zip` }] }],
          safe: false,
        },
        { name: "full team", rows: [], kind: "team", safe: false },
      ];
      try {
        // No DDL, fixture-wide cleanup, trigger suppression or committed rows.
        // Every assertion failure rolls this exact fixture back as well.
        // biome-ignore lint/correctness/useHookAtTopLevel: Database routing is not a React hook.
        await db.usePrimaryOnly().transaction(async (tx) => {
          await tx.execute(
            sql`insert into public.teams(id,name) values (${team}::uuid,'export-access-fixture')`,
          );
          const expected = new Map<string, boolean>();
          for (const fixture of cases) {
            const id = randomUUID();
            const op = financialRequestHash([team, fixture.name]);
            const snapshot = {
              version: 1,
              teamId: team,
              kind: fixture.kind ?? "transactions",
              asOf: "2026-11-03T00:00:00.000Z",
              transactionRows: fixture.rows,
              privateBusinessField: "must-never-leave-postgresql",
            };
            const snapshotHash = financialRequestHash(snapshot);
            const archiveHash = financialRequestHash(["archive", fixture.name]);
            const result = {
              operationId: op,
              snapshotId: id,
              snapshotHash,
              archiveHash,
              fullPath: `${team}/exports/${op}/${archiveHash}.zip`,
              status: "complete",
              totalItems: 1,
              missingFiles: 0,
              credentials: "must-never-leave-postgresql",
            };
            await tx.execute(sql`
              insert into public.export_snapshots(id,team_id,operation_key,request_hash,snapshot,snapshot_hash,result)
              values (${id}::uuid,${team}::uuid,${op},${financialRequestHash(fixture.name)},
                ${JSON.stringify(snapshot)}::jsonb,${snapshotHash},${JSON.stringify(result)}::jsonb)
            `);
            expected.set(op, fixture.safe);
          }
          const result = await getExportFileAccessReceipts(tx, {
            teamId: team,
            operationIds: [...expected.keys()],
          });
          expect(result).toHaveLength(cases.length);
          expect(
            new Map(
              result.map((row) => [
                row.operation_key,
                row.transaction_assets_safe,
              ]),
            ),
          ).toEqual(expected);
          expect(JSON.stringify(result)).not.toContain(
            "must-never-leave-postgresql",
          );
          expect(
            result.every(
              (row) => !("snapshot" in row) && !("transactionRows" in row),
            ),
          ).toBe(true);
          expect(
            await getExportFileAccessReceipts(tx, {
              teamId: other,
              operationIds: [...expected.keys()],
            }),
          ).toEqual([]);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const leftover = await db
        .usePrimaryOnly()
        .execute<{ count: number }>(
          sql`select count(*)::integer as count from public.teams where id=${team}::uuid`,
        );
      expect(leftover.rows[0]?.count).toBe(0);
    });
  },
);
