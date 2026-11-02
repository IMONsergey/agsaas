import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type QueryConfig } from "pg";
import {
  canSendInvoiceEmail,
  canSendInvoiceReminder,
  isCurrentInvoiceSchedule,
  recordInvoiceEmailAccepted,
  recordInvoiceReminderAccepted,
} from "../queries/invoice-delivery";
import { withReplicas } from "../replicas";
import { runtimeSchema } from "../runtime-schema";
import { invoiceStatusEnum } from "../schema";

const invoiceId = "7ec4f751-0f0b-46cb-974c-cd1fb3801160";
const teamId = "e67c3551-a429-423d-afee-2d77b11c4af3";
const acceptedAt = "2026-10-31T12:00:00.000Z";

function queryRecorder() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = new Pool({ host: "127.0.0.1", database: "query_only" });
  const query = async (config: string | QueryConfig, values?: unknown[]) => {
    if (typeof config === "string")
      throw new Error("Expected parameterized SQL");
    queries.push({
      sql: config.text.replace(/\s+/g, " ").trim(),
      params: values ?? config.values ?? [],
    });
    return { rows: [], fields: [], command: "UPDATE", rowCount: 0, oid: 0 };
  };
  pool.query = query as Pool["query"];
  const primary = drizzle(pool, {
    schema: runtimeSchema,
    casing: "snake_case",
  });
  const db = withReplicas(primary, [primary], () => primary);
  return { db, queries };
}

describe("invoice delivery state and SQL contract (no connections)", () => {
  test("first sends, resends and scheduled invoices retain their workflows", () => {
    expect(invoiceStatusEnum.enumValues.filter(canSendInvoiceEmail)).toEqual([
      "draft",
      "overdue",
      "unpaid",
      "scheduled",
    ]);
  });

  test("reminders only target outstanding invoices", () => {
    expect(invoiceStatusEnum.enumValues.filter(canSendInvoiceReminder)).toEqual(
      ["overdue", "unpaid"],
    );
  });

  test("a delayed send belongs only to the matching schedule and scheduled status", () => {
    const expectedScheduledJobId = "invoices:expected-version";
    for (const status of invoiceStatusEnum.enumValues) {
      expect(
        isCurrentInvoiceSchedule(
          { status, scheduledJobId: expectedScheduledJobId },
          expectedScheduledJobId,
        ),
      ).toBe(status === "scheduled");
    }
    for (const scheduledJobId of [null, "", "invoices:newer-version"]) {
      expect(
        isCurrentInvoiceSchedule(
          { status: "scheduled", scheduledJobId },
          expectedScheduledJobId,
        ),
      ).toBe(false);
    }
    expect(
      isCurrentInvoiceSchedule({ status: "scheduled", scheduledJobId: "" }, ""),
    ).toBe(false);
  });

  test("acceptance updates the current status atomically with tenant scope", async () => {
    const { db, queries } = queryRecorder();
    await recordInvoiceEmailAccepted(db, {
      invoiceId,
      teamId,
      acceptedAt,
      recipient: "customer@example.test",
    });
    expect(queries).toHaveLength(1);
    const query = queries[0]!;
    expect(query.sql).toContain(
      'case when "invoices"."status" in (\'draft\', \'scheduled\') then \'unpaid\'::invoice_status else "invoices"."status" end',
    );
    expect(query.sql).toMatch(
      /where \("invoices"\."id" = \$\d+ and "invoices"\."team_id" = \$\d+\)/,
    );
    expect(query.sql).toContain('greatest("invoices"."sent_at",');
    expect(query.sql).toContain('else "invoices"."sent_to" end');
    expect(query.sql).toContain(
      'case when "invoices"."status" = \'scheduled\' then null else "invoices"."scheduled_job_id" end',
    );
    expect(query.sql).not.toContain("customer@example.test");
    expect(query.params).toContain(teamId);
    expect(query.params).toContain(invoiceId);
    expect(query.params).toContain(acceptedAt);
  });

  test("reminder acknowledgement never writes the financial status", async () => {
    const { db, queries } = queryRecorder();
    await recordInvoiceReminderAccepted(db, { invoiceId, teamId, acceptedAt });
    expect(queries).toHaveLength(1);
    const query = queries[0]!;
    expect(query.sql).toContain('greatest("invoices"."reminder_sent_at",');
    expect(query.sql).not.toContain('set "status"');
    expect(query.sql).not.toContain('"status" =');
    expect(query.sql).toMatch(
      /where \("invoices"\."id" = \$\d+ and "invoices"\."team_id" = \$\d+\)/,
    );
    expect(query.params).toContain(teamId);
    expect(query.params).toContain(invoiceId);
    expect(query.params).toContain(acceptedAt);
  });

  test("versioned acceptance conditions both status transition and marker removal on the same current version", async () => {
    const { db, queries } = queryRecorder();
    const expectedScheduledJobId = "invoices:expected-version";
    await recordInvoiceEmailAccepted(db, {
      invoiceId,
      teamId,
      acceptedAt,
      recipient: "customer@example.test",
      expectedScheduledJobId,
    });
    expect(queries).toHaveLength(1);
    const query = queries[0]!;
    expect(query.sql).toMatch(
      /"status" = case when "invoices"\."status" = 'scheduled' and "invoices"\."scheduled_job_id" = \$\d+ then 'unpaid'::invoice_status else "invoices"\."status" end/,
    );
    expect(query.sql).toMatch(
      /"scheduled_job_id" = case when "invoices"\."status" = 'scheduled' and "invoices"\."scheduled_job_id" = \$\d+ then null else "invoices"\."scheduled_job_id" end/,
    );
    expect(
      query.params.filter((value) => value === expectedScheduledJobId),
    ).toHaveLength(2);
    expect(query.sql).not.toContain(expectedScheduledJobId);
    // The audit fact must still be written when an in-flight schedule changed.
    expect(query.sql).toMatch(
      /where \("invoices"\."id" = \$\d+ and "invoices"\."team_id" = \$\d+\) returning/,
    );
    expect(query.sql).toContain('greatest("invoices"."sent_at",');
  });
});
