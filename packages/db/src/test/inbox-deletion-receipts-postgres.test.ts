import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import type { Database } from "../client";
import {
  type CreateInboxParams,
  createInbox,
  deleteInbox,
  deleteInboxMany,
  getInbox,
  getInboxById,
  updateInbox,
  updateInboxWithProcessedData,
} from "../queries/inbox";
import {
  getInboxDeletionDigestPlan,
  InboxReceiptDeletedError,
  inboxDeletionIdentity,
  retainInboxDeletionDigest,
} from "../queries/inbox-deletion-receipts";
import { getInboxReceiptByReferenceId } from "../queries/inbox-receipts";
import { claimResourceCleanups } from "../queries/resource-cleanups";
import { withReplicas } from "../replicas";
import { runtimeSchema } from "../runtime-schema";
import { teams } from "../schema";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";
import { getTestDatabaseUrl } from "./helpers/test-database-config";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function state(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? state(error.cause) : undefined;
}
async function rejectsState(work: Promise<unknown>, allowed: string[]) {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  const code = state(caught);
  if (code === undefined) {
    throw new Error(
      "Expected the operation to fail with a PostgreSQL SQLSTATE",
      {
        cause: caught,
      },
    );
  }
  expect(allowed).toContain(code);
}
function connection(client: PoolClient) {
  return drizzle(client, {
    schema: runtimeSchema,
    casing: "snake_case",
  });
}
function bound(pool: Pool) {
  const primary = drizzle(pool, {
    schema: runtimeSchema,
    casing: "snake_case",
  });
  return withReplicas(primary, [primary], (replicas) => replicas[0]!);
}

describe.skipIf(!isTestDatabaseAvailable())(
  "Inbox erasure receipts (real PostgreSQL)",
  () => {
    let db: Database;
    let pool: Pool;
    beforeAll(async () => {
      db = getTestDatabase();
      pool = new Pool({
        connectionString: getTestDatabaseUrl(),
        max: 4,
        connectionTimeoutMillis: 3000,
      });
      const ready = await pool.query(
        "SELECT to_regclass('private.inbox_deletion_receipts') AS receipt",
      );
      if (!ready.rows[0]?.receipt)
        throw new Error(
          "Apply reviewed 20261103123000 to the isolated synthetic fixture before this suite",
        );
      if (!process.env.MIDDAY_ENCRYPTION_KEY)
        throw new Error(
          "The isolated cleanup fixture requires MIDDAY_ENCRYPTION_KEY",
        );
    });
    afterAll(async () => {
      await pool?.end();
      await closeDatabase();
    });

    async function fixture(work: (teamId: string) => Promise<void>) {
      const teamId = randomUUID();
      try {
        await db.insert(teams).values({
          id: teamId,
          inboxId: teamId,
          name: "Inbox erasure fixture",
        });
        await work(teamId);
      } finally {
        await pool.query(
          "DELETE FROM storage.objects WHERE bucket_id='vault' AND name LIKE $1",
          [teamId + "/%"],
        );
        await db.delete(teams).where(eq(teams.id, teamId));
        await pool.query(
          "DELETE FROM private.inbox_deletion_receipts WHERE team_id=$1",
          [teamId],
        );
        await pool.query(
          "DELETE FROM public.storage_deletion_tombstones WHERE team_id=$1",
          [teamId],
        );
        await pool.query(
          "DELETE FROM public.resource_cleanups WHERE team_id=$1",
          [teamId],
        );
      }
    }
    async function receipt(teamId: string, canonical = true) {
      const originalName = "Private-vendor-name-" + randomUUID() + ".pdf";
      const message = randomUUID();
      const referenceId = canonical
        ? "receipt_" + digest(message)
        : message + "_" + originalName;
      const filePath = canonical
        ? [teamId, "inbox", "uploads", referenceId + ".bin"]
        : [teamId, "inbox", originalName];
      const meta = {
        source: "postmark",
        sourceVersion: "postmark-inbound-v1",
        messageId: message,
        attachmentIndex: 0,
        attachmentContentId: "",
        originalFileName: originalName,
        contentSha256: digest("original"),
      };
      const params: CreateInboxParams = {
        teamId,
        referenceId,
        filePath,
        fileName: originalName,
        displayName: "Sensitive subject",
        senderEmail: "private-sender@example.test",
        contentType: "application/pdf",
        size: 8,
        meta: canonical ? meta : undefined,
        status: "new",
      };
      const row = await createInbox(db, params);
      if (!row) throw new Error("Fixture receipt was not retained");
      return {
        row,
        params,
        meta,
        expectedProof: { contentType: params.contentType, meta },
      };
    }
    async function clients(
      work: (
        a: PoolClient,
        b: PoolClient,
        identities: { aPid: number; bPid: number },
      ) => Promise<void>,
    ) {
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        for (const client of [a, b])
          await client.query("SET statement_timeout='8s'");
        await work(a, b, { aPid: await pid(a), bPid: await pid(b) });
      } finally {
        await a.query("ROLLBACK").catch(() => {});
        await b.query("ROLLBACK").catch(() => {});
        a.release();
        b.release();
      }
    }
    async function blockedBy(waiter: number, holder: number) {
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        const result = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",
          [holder, waiter],
        );
        if (result.rows[0]?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        "Expected deterministic row/advisory lock barrier was not reached",
      );
    }
    async function pid(client: PoolClient) {
      return (
        await client.query<{ id: number }>("SELECT pg_backend_pid() AS id")
      ).rows[0]!.id;
    }
    async function lockScope(client: PoolClient, params: CreateInboxParams) {
      const identity = inboxDeletionIdentity(params);
      await client.query(
        "SELECT private.lock_inbox_deletion_scope($1,$2,$3,false,false)",
        [params.teamId, identity.referenceHash, identity.objectHash],
      );
    }
    async function putStorage(client: PoolClient, params: CreateInboxParams) {
      return client.query(
        "INSERT INTO storage.objects(id,bucket_id,name,metadata,version) VALUES($1,'vault',$2,$3::jsonb,'fixture-version')",
        [
          randomUUID(),
          params.filePath.join("/"),
          JSON.stringify({ mimetype: params.contentType, size: params.size }),
        ],
      );
    }

    test("physical deletion retains only digests, drops active read models and preserves exact original evidence", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId);
        await pool.query(
          "INSERT INTO public.documents(id,team_id,name,path_tokens,title,body) VALUES($1,$2,$3,$4,'Sensitive title','Sensitive OCR')",
          [
            randomUUID(),
            teamId,
            f.params.filePath.join("/"),
            f.params.filePath,
          ],
        );
        const erased = await deleteInbox(db, { id: f.row.id, teamId });
        expect(erased.cleanupPending).toBe(true);
        expect(
          (
            await pool.query("SELECT id FROM public.inbox WHERE team_id=$1", [
              teamId,
            ])
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await pool.query(
              "SELECT id FROM public.documents WHERE team_id=$1",
              [teamId],
            )
          ).rows,
        ).toHaveLength(0);
        expect(await getInboxById(db, { id: f.row.id, teamId })).toBeNull();
        expect((await getInbox(db, { teamId })).data).toHaveLength(0);
        // Monthly admitted usage is intentionally retained, but the tombstone adds no item.
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM public.team_quota_usage WHERE team_id=$1 AND kind='inbox'",
              [teamId],
            )
          ).rows[0]?.count,
        ).toBe(1);
        const stored = (
          await pool.query(
            "SELECT * FROM private.inbox_deletion_receipts WHERE team_id=$1",
            [teamId],
          )
        ).rows[0]!;
        for (const erasedValue of [
          f.params.referenceId!,
          f.params.fileName,
          f.params.filePath.join("/"),
          "Sensitive subject",
          "private-sender@example.test",
          "Sensitive OCR",
        ]) {
          expect(JSON.stringify(stored)).not.toContain(erasedValue);
        }
        expect(stored.content_sha256).toBe(digest("original"));
        const found = await getInboxReceiptByReferenceId(db, {
          teamId,
          referenceId: f.params.referenceId!,
          expectedProof: f.expectedProof,
        });
        expect(found?.status).toBe("deleted");
        expect(
          found && "deletionProof" in found ? found.deletionProof : null,
        ).toEqual({
          contentSha256: digest("original"),
          contentTypeMatches: true,
          metadataMatches: true,
          metadataRetained: true,
          unavailable: false,
        });
        expect(
          await getInboxReceiptByReferenceId(db, {
            teamId: randomUUID(),
            referenceId: f.params.referenceId!,
            expectedProof: f.expectedProof,
          }),
        ).toBeUndefined();
        for (const expectedProof of [
          { ...f.expectedProof, contentType: "application/octet-stream" },
          {
            ...f.expectedProof,
            meta: { ...f.meta, originalFileName: "changed.pdf" },
          },
          {
            ...f.expectedProof,
            meta: { ...f.meta, contentSha256: digest("changed!") },
          },
        ]) {
          const changed = await getInboxReceiptByReferenceId(db, {
            teamId,
            referenceId: f.params.referenceId!,
            expectedProof,
          });
          expect(
            changed &&
              "deletionProof" in changed &&
              changed.deletionProof.contentTypeMatches === true &&
              changed.deletionProof.metadataMatches === true,
          ).toBe(false);
        }
      }));

    test("PATCH-compatible deletion returns a command, while direct soft deletion is rejected", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId);
        await rejectsState(
          pool.query("UPDATE public.inbox SET status='deleted' WHERE id=$1", [
            f.row.id,
          ]),
          ["23514"],
        );
        const result = await updateInbox(db, {
          id: f.row.id,
          teamId,
          status: "deleted",
        });
        expect(result).toEqual({
          id: f.row.id,
          deleted: true,
          status: "deleted",
          cleanupPending: true,
          cleanupId: expect.any(String),
        });
        expect(JSON.stringify(result)).not.toContain("filePath");
        expect(
          (
            await pool.query("SELECT id FROM public.inbox WHERE id=$1", [
              f.row.id,
            ])
          ).rows,
        ).toHaveLength(0);
      }));

    test("new reference/path resurrection and late OCR output are refused, including direct SQL", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId);
        await deleteInbox(db, { id: f.row.id, teamId });
        await expect(createInbox(db, f.params)).rejects.toBeInstanceOf(
          InboxReceiptDeletedError,
        );
        await expect(
          createInbox(db, {
            ...f.params,
            referenceId: "other-" + randomUUID(),
          }),
        ).rejects.toBeInstanceOf(InboxReceiptDeletedError);
        await rejectsState(
          pool.query(
            "INSERT INTO public.inbox(id,team_id,reference_id,file_path,file_name,size,content_type) VALUES($1,$2,$3,$4,$5,8,'application/pdf')",
            [
              randomUUID(),
              teamId,
              f.params.referenceId,
              [teamId, "inbox", "different.pdf"],
              "late.pdf",
            ],
          ),
          ["23514"],
        );
        expect(
          await updateInboxWithProcessedData(db, {
            id: f.row.id,
            displayName: "Late private OCR",
            amount: 999,
            status: "analyzing",
          }),
        ).toBeUndefined();
        const projected = await pool.query(
          "INSERT INTO public.documents(id,team_id,name,path_tokens,title,body) VALUES($1,$2,$3,$4,'Late PII','Late OCR') RETURNING id",
          [
            randomUUID(),
            teamId,
            f.params.filePath.join("/"),
            f.params.filePath,
          ],
        );
        expect(projected.rows).toHaveLength(0);
        expect(
          (
            await pool.query("SELECT id FROM public.inbox WHERE team_id=$1", [
              teamId,
            ])
          ).rows,
        ).toHaveLength(0);
      }));

    test("source identity/evidence is immutable and unprivileged actors cannot inject private or foreign-team markers", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId);
        for (const [query, values] of [
          [
            "UPDATE public.inbox SET reference_id=$2 WHERE id=$1",
            [f.row.id, "different"],
          ],
          [
            "UPDATE public.inbox SET content_type=$2 WHERE id=$1",
            [f.row.id, "image/png"],
          ],
          [
            "UPDATE public.inbox SET meta=$2::jsonb WHERE id=$1",
            [
              f.row.id,
              JSON.stringify({ ...f.meta, contentSha256: digest("changed!") }),
            ],
          ],
        ] as const)
          await rejectsState(pool.query(query, [...values]), ["23514"]);
        await deleteInbox(db, { id: f.row.id, teamId });
        await rejectsState(
          pool.query(
            "UPDATE private.inbox_deletion_receipts SET content_sha256=$2 WHERE team_id=$1",
            [teamId, digest("changed!")],
          ),
          ["23514"],
        );
        await clients(async (a) => {
          await a.query("BEGIN");
          await a.query("SET LOCAL ROLE agsaas_app");
          expect(
            (
              await a.query(
                "SELECT reference_hash FROM private.inbox_deletion_receipts WHERE team_id=$1",
                [teamId],
              )
            ).rows,
          ).toHaveLength(1);
          await rejectsState(
            a.query(
              "INSERT INTO private.inbox_deletion_receipts(team_id,reference_hash,inbox_id) VALUES($1,$2,$3)",
              [teamId, digest("forged"), randomUUID()],
            ),
            ["42501"],
          );
          await a.query("ROLLBACK");
          await a.query("BEGIN");
          await a.query("SET LOCAL ROLE authenticated");
          await rejectsState(
            a.query(
              "INSERT INTO public.storage_deletion_tombstones(team_id,object_hash) VALUES($1,$2)",
              [teamId, digest("forged")],
            ),
            ["42501"],
          );
          await a.query("ROLLBACK");
        });
        await expect(
          createInbox(db, {
            ...f.params,
            referenceId: randomUUID(),
            filePath: [randomUUID(), "inbox", "foreign.pdf"],
          }),
        ).rejects.toThrow();
        await rejectsState(
          pool.query(
            "INSERT INTO public.inbox(id,team_id,reference_id,file_path,file_name) VALUES($1,$2,$3,$4,'foreign')",
            [
              randomUUID(),
              teamId,
              randomUUID(),
              [randomUUID(), "inbox", "foreign.pdf"],
            ],
          ),
          ["23514"],
        );
      }));

    test("batch erasure preserves each source identity while sharing one object cleanup", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId, false);
        const second = await createInbox(db, {
          ...f.params,
          referenceId: "same-object-" + randomUUID(),
        });
        expect(second).toBeTruthy();
        const erased = await deleteInboxMany(db, {
          ids: [second!.id, f.row.id],
          teamId,
        });
        expect(erased).toHaveLength(2);
        expect(erased[0]?.cleanupId).toBe(erased[1]?.cleanupId);
        expect(
          (
            await pool.query(
              "SELECT reference_hash FROM private.inbox_deletion_receipts WHERE team_id=$1",
              [teamId],
            )
          ).rows,
        ).toHaveLength(2);
        expect(
          (
            await pool.query("SELECT id FROM public.inbox WHERE team_id=$1", [
              teamId,
            ])
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM public.team_quota_usage WHERE team_id=$1 AND kind='inbox'",
              [teamId],
            )
          ).rows[0]?.count,
        ).toBe(2);
      }));

    test("baseline non-file rows remain updatable and erasable without inventing byte evidence", async () =>
      fixture(async (teamId) => {
        const id = randomUUID(),
          referenceId = "legacy-empty-" + randomUUID();
        await pool.query(
          "INSERT INTO public.inbox(id,team_id,reference_id,file_name) VALUES($1,$2,$3,'legacy')",
          [id, teamId, referenceId],
        );
        await pool.query(
          "UPDATE public.inbox SET display_name='Legacy update' WHERE id=$1",
          [id],
        );
        const result = await deleteInbox(db, { id, teamId });
        expect(result.cleanupPending).toBe(false);
        const found = await getInboxReceiptByReferenceId(db, {
          teamId,
          referenceId,
        });
        expect(found?.status).toBe("deleted");
        expect(
          found && "deletionProof" in found
            ? found.deletionProof.contentSha256
            : "missing",
        ).toBeNull();
      }));

    test("legacy proof is lease-scoped, exact-size and write-once; failures stay explicitly unknown", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId, false);
        const erased = await deleteInbox(db, { id: f.row.id, teamId });
        const claim = (await claimResourceCleanups(db, 1, teamId)).find(
          (item) => item.id === erased.cleanupId,
        )!;
        expect(claim).toBeTruthy();
        expect(await getInboxDeletionDigestPlan(db, claim)).toEqual({
          pending: 1,
          maximumBytes: 8,
        });
        expect(
          await retainInboxDeletionDigest(
            db,
            { ...claim, dispatchToken: randomUUID() },
            { sha256: digest("original"), size: 8 },
          ),
        ).toBe(false);
        await retainInboxDeletionDigest(db, claim, {
          sha256: digest("short"),
          size: 5,
        });
        let proof = (
          await pool.query(
            "SELECT content_sha256,digest_failure FROM private.inbox_deletion_receipts WHERE team_id=$1",
            [teamId],
          )
        ).rows[0]!;
        expect(proof).toEqual({
          content_sha256: null,
          digest_failure: "size_unverifiable",
        });
        await retainInboxDeletionDigest(db, claim, {
          failure: "download_unavailable",
        });
        proof = (
          await pool.query(
            "SELECT content_sha256,digest_failure FROM private.inbox_deletion_receipts WHERE team_id=$1",
            [teamId],
          )
        ).rows[0]!;
        expect(proof).toEqual({
          content_sha256: null,
          digest_failure: "download_unavailable",
        });
        await retainInboxDeletionDigest(db, claim, {
          sha256: digest("original"),
          size: 8,
        });
        await retainInboxDeletionDigest(db, claim, {
          sha256: digest("changed!"),
          size: 8,
        });
        proof = (
          await pool.query(
            "SELECT content_sha256,digest_failure FROM private.inbox_deletion_receipts WHERE team_id=$1",
            [teamId],
          )
        ).rows[0]!;
        expect(proof).toEqual({
          content_sha256: digest("original"),
          digest_failure: null,
        });
        expect(await getInboxDeletionDigestPlan(db, claim)).toEqual({
          pending: 0,
          maximumBytes: 0,
        });
      }));

    test(
      "a lease that expires while waiting for an unchanged cleanup tuple cannot retain proof",
      async () =>
        fixture(async (teamId) => {
          const f = await receipt(teamId, false);
          const erased = await deleteInbox(db, { id: f.row.id, teamId });
          const claim = (await claimResourceCleanups(db, 1, teamId)).find(
            (item) => item.id === erased.cleanupId,
          )!;
          await clients(async (a, b, identities) => {
            const expiry = await pool.query<{ deadline: Date }>(
              "UPDATE public.resource_cleanups SET lease_expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1 RETURNING lease_expires_at AS deadline",
              [claim.id],
            );
            await a.query("BEGIN");
            await a.query(
              "SELECT id FROM public.resource_cleanups WHERE id=$1 FOR UPDATE",
              [claim.id],
            );
            const pending = connection(b)
              .transaction((tx) =>
                retainInboxDeletionDigest(tx, claim, {
                  sha256: digest("original"),
                  size: 8,
                }),
              )
              .catch((error: unknown) => error);
            await blockedBy(identities.bPid, identities.aPid);
            await pool.query(
              "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)",
              [expiry.rows[0]!.deadline],
            );
            await a.query("COMMIT");
            expect(await pending).toBe(false);
            expect(
              (
                await pool.query(
                  "SELECT content_sha256 FROM private.inbox_deletion_receipts WHERE team_id=$1",
                  [teamId],
                )
              ).rows[0]?.content_sha256,
            ).toBeNull();
          });
        }),
      15000,
    );

    test("a Storage insertion already holding the object scope finishes before actual deleteInbox erases its projection", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId);
        await clients(async (a, b, identities) => {
          await a.query("BEGIN");
          await putStorage(a, f.params);
          const pending = connection(b)
            .transaction((tx) => deleteInbox(tx, { id: f.row.id, teamId }))
            .catch((error: unknown) => error);
          await blockedBy(identities.bPid, identities.aPid);
          await a.query("COMMIT");
          const result = await pending;
          expect(result).toMatchObject({ id: f.row.id, cleanupPending: true });
        });
        expect(
          (
            await pool.query("SELECT id FROM public.inbox WHERE team_id=$1", [
              teamId,
            ])
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await pool.query(
              "SELECT id FROM public.documents WHERE team_id=$1",
              [teamId],
            )
          ).rows,
        ).toHaveLength(0);
      }));

    test("deletion first fences concurrent registration, Storage upload and stale direct writes", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId);
        // createInbox owns its commit-before-refusal boundary. Use a real Pool
        // while keeping the waiter's one backend observable for the lock barrier.
        const a = await pool.connect();
        const registrationPool = new Pool({
          connectionString: getTestDatabaseUrl(),
          max: 1,
          idleTimeoutMillis: 0,
          connectionTimeoutMillis: 3000,
        });
        try {
          const b = await registrationPool.connect();
          let released = false;
          try {
            for (const client of [a, b])
              await client.query("SET statement_timeout='8s'");
            const identities = { aPid: await pid(a), bPid: await pid(b) };
            await a.query("BEGIN");
            await lockScope(a, f.params);
            await a.query("DELETE FROM public.inbox WHERE id=$1", [f.row.id]);
            await rejectsState(putStorage(b, f.params), ["40001", "55P03"]);
            await rejectsState(
              b.query(
                "INSERT INTO public.inbox(id,team_id,reference_id,file_path,file_name) VALUES($1,$2,$3,$4,'late')",
                [randomUUID(), teamId, f.params.referenceId, f.params.filePath],
              ),
              ["40001", "55P03"],
            );
            b.release();
            released = true;
            const pending = createInbox(
              bound(registrationPool),
              f.params,
            ).catch((error: unknown) => error);
            await blockedBy(identities.bPid, identities.aPid);
            await a.query("COMMIT");
            expect(await pending).toBeInstanceOf(InboxReceiptDeletedError);
            const retainedCleanup = await registrationPool.query<{
              retained: boolean;
            }>(
              "SELECT encrypted_payload IS NOT NULL AS retained FROM public.resource_cleanups WHERE team_id=$1 AND kind='storage-object' AND target_id=$2",
              [teamId, inboxDeletionIdentity(f.params).objectHash],
            );
            expect(retainedCleanup.rows).toEqual([{ retained: true }]);
            const after = await registrationPool.connect();
            try {
              expect(await pid(after)).toBe(identities.bPid);
              await rejectsState(putStorage(after, f.params), ["23514"]);
            } finally {
              after.release();
            }
          } finally {
            if (!released) b.release();
          }
        } finally {
          await a.query("ROLLBACK").catch(() => {});
          a.release();
          await registrationPool.end();
        }
        expect(
          (
            await pool.query("SELECT id FROM public.inbox WHERE team_id=$1", [
              teamId,
            ])
          ).rows,
        ).toHaveLength(0);
      }));

    for (const storageFirst of [true, false]) {
      test(
        "team cascade and Storage writer serialize without accepting a late object, storageFirst=" +
          storageFirst,
        async () =>
          fixture(async (teamId) => {
            const f = await receipt(teamId);
            await clients(async (a, b, identities) => {
              await a.query("BEGIN");
              if (storageFirst) {
                await putStorage(a, f.params);
                const pending = b
                  .query("DELETE FROM public.teams WHERE id=$1", [teamId])
                  .catch((error: unknown) => error);
                await blockedBy(identities.bPid, identities.aPid);
                await a.query("COMMIT");
                expect(await pending).toMatchObject({ rowCount: 1 });
              } else {
                await a.query("DELETE FROM public.teams WHERE id=$1", [teamId]);
                await rejectsState(putStorage(b, f.params), ["55P03", "40001"]);
                await a.query("COMMIT");
              }
              await rejectsState(putStorage(b, f.params), ["23514"]);
            });
            expect(
              (
                await pool.query(
                  "SELECT reference_hash FROM private.inbox_deletion_receipts WHERE team_id=$1",
                  [teamId],
                )
              ).rows,
            ).toHaveLength(1);
          }),
      );
    }

    test("old transaction snapshots fail closed instead of bypassing a committed erasure", async () =>
      fixture(async (teamId) => {
        const f = await receipt(teamId);
        await clients(async (a) => {
          await a.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await a.query("SELECT id FROM public.inbox WHERE id=$1", [f.row.id]);
          await deleteInbox(db, { id: f.row.id, teamId });
          await rejectsState(
            a.query(
              "INSERT INTO public.inbox(id,team_id,reference_id,file_path,file_name) VALUES($1,$2,$3,$4,'late')",
              [randomUUID(), teamId, f.params.referenceId, f.params.filePath],
            ),
            ["40001"],
          );
          await a.query("ROLLBACK");
        });
      }));
  },
);
