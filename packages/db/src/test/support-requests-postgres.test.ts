import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  SupportRequestError,
  submitSupportRequest,
} from "../queries/support-requests";
import {
  closeDatabase,
  getTestDatabase,
  isTestDatabaseAvailable,
} from "./helpers/test-database";

const available = isTestDatabaseAvailable();
describe.skipIf(!available)(
  "own durable support queue (isolated PostgreSQL)",
  () => {
    let db: Database;
    const scope = "test:" + crypto.randomUUID();
    const ids: string[] = [];
    function input() {
      const id = crypto.randomUUID();
      ids.push(id);
      return {
        id,
        source: "website" as const,
        scopeKey: scope,
        email: "test@example.invalid",
        fullName: "Synthetic Test",
        subject: "Synthetic only",
        priority: "normal" as const,
        product: "General",
        message: "No email is sent.",
      };
    }
    beforeAll(async () => {
      db = getTestDatabase();
      const migration = await readFile(
        join(
          __dirname,
          "../../self-hosted/upgrades/supabase/migrations/20261103070000_support_requests.sql",
        ),
        "utf8",
      );
      await db.execute(sql.raw(migration));
    });
    afterAll(async () => {
      for (const id of ids)
        await db.execute(
          sql`DELETE FROM public.support_requests WHERE id=${id}::uuid`,
        );
      await closeDatabase();
    });
    test("concurrent retries commit one receipt and one record", async () => {
      const item = input();
      const receipts = await Promise.all(
        Array.from({ length: 4 }, () => submitSupportRequest(db, item)),
      );
      expect(receipts.every((r) => r.id === item.id && r.accepted)).toBe(true);
      const rows = await db.execute(
        sql`SELECT count(*)::int AS count FROM public.support_requests WHERE id=${item.id}::uuid`,
      );
      expect(rows.rows[0]?.count).toBe(1);
    });
    test("reused reference cannot change content or sender", async () => {
      const item = input();
      await submitSupportRequest(db, item);
      await expect(
        submitSupportRequest(db, { ...item, message: "Different" }),
      ).rejects.toBeInstanceOf(SupportRequestError);
      await expect(
        submitSupportRequest(db, { ...item, scopeKey: "foreign" }),
      ).rejects.toBeInstanceOf(SupportRequestError);
      const rows = await db.execute(
        sql`SELECT message FROM public.support_requests WHERE id=${item.id}::uuid`,
      );
      expect(rows.rows[0]?.message).toBe(item.message);
    });
    test("only one concurrent request may claim the last hourly slot", async () => {
      const limitedScope = "test:" + crypto.randomUUID();
      for (let i = 0; i < 9; i++)
        await submitSupportRequest(db, { ...input(), scopeKey: limitedScope });
      const result = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          submitSupportRequest(db, { ...input(), scopeKey: limitedScope }),
        ),
      );
      expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    });
    test("confirmed retry succeeds after sender admission budget is exhausted", async () => {
      const retryScope = "test:" + crypto.randomUUID();
      const first = { ...input(), scopeKey: retryScope };
      await submitSupportRequest(db, first);
      for (let i = 0; i < 9; i++)
        await submitSupportRequest(db, { ...input(), scopeKey: retryScope });
      expect((await submitSupportRequest(db, first)).id).toBe(first.id);
    });
  },
);
