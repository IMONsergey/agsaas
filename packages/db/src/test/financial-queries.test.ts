import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type QueryConfig } from "pg";
import { getCustomerById, getCustomers } from "../queries/customers";
import { getTaxSummary } from "../queries/reports";
import { withReplicas } from "../replicas";
import { runtimeSchema } from "../runtime-schema";

const teamId = "e9d116ce-0523-42d3-978f-ddf0f1b24452";
const customerId = "ec5e2c2e-852c-4441-ab72-bd69c1db06a9";

/** Real Drizzle compilation, with only this never-connected pg pool replaced. */
function queryRecorder() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = new Pool({ host: "127.0.0.1", database: "query_only" });
  const query = async (config: string | QueryConfig, values?: unknown[]) => {
    if (typeof config === "string") {
      throw new Error("Expected Drizzle's parameterized query configuration");
    }
    queries.push({
      sql: config.text.replace(/\s+/g, " ").trim(),
      params: values ?? config.values ?? [],
    });
    return { rows: [], fields: [], command: "SELECT", rowCount: 0, oid: 0 };
  };
  // pg also exposes callback/stream overloads; Drizzle uses this promise form.
  pool.query = query as Pool["query"];
  const primary = drizzle(pool, {
    schema: runtimeSchema,
    casing: "snake_case",
  });
  const db = withReplicas(primary, [primary], () => primary);
  return { db, queries };
}

describe("financial queries (real SQL generation, no connections)", () => {
  test("numeric-prefix customer search is parameterized instead of ignored", async () => {
    const { db, queries } = queryRecorder();
    await getCustomers(db, { teamId, q: "7701 Example" });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toContain("7701 Example");
    expect(queries[0]?.sql).toContain('"customers"."vat_number" ILIKE');
    expect(queries[0]?.sql).not.toContain("7701 Example");
  });

  test("customer list aggregates independent collections before joining", async () => {
    const { db, queries } = queryRecorder();
    await getCustomers(db, { teamId });
    const query = queries[0]!;
    expect(query.sql).toContain('"customer_invoice_totals"');
    expect(query.sql).toContain('"customer_project_totals"');
    expect(query.sql).toContain('"customer_tag_totals"');
    expect(query.sql).not.toContain('left join "invoices" on');
    expect(query.sql).not.toContain('left join "tracker_projects" on');
    expect(
      query.params.filter((value) => value === teamId).length,
    ).toBeGreaterThan(3);
  });

  test("detail counts do not join invoices to projects or tags", async () => {
    const { db, queries } = queryRecorder();
    await getCustomerById(db, { id: customerId, teamId });
    expect(queries[0]?.sql).not.toContain('left join "invoices" on');
    expect(queries[0]?.sql).not.toContain('left join "tracker_projects" on');
    expect(queries[0]?.params).toContain(customerId);
    expect(queries[0]?.params).toContain(teamId);
  });

  for (const column of ["total_revenue", "outstanding"]) {
    for (const direction of ["asc", "desc"]) {
      test(`${column} ${direction} places incomplete totals last`, async () => {
        const { db, queries } = queryRecorder();
        await getCustomers(db, { teamId, sort: [column, direction] });
        expect(queries[0]?.sql).toContain(`${direction} nulls last`);
        expect(queries[0]?.sql).toContain('"customers"."id" asc');
      });
    }
  }

  test("fixed tax including zero takes precedence over percentage fallback", async () => {
    const { db, queries } = queryRecorder();
    await getTaxSummary(db, {
      teamId,
      type: "paid",
      from: "2026-01-01",
      to: "2026-01-31",
      currency: "RUB",
    });
    expect(queries).toHaveLength(1);
    const sql = queries[0]!.sql;
    expect(sql).toMatch(/WHEN "transactions"\."tax_amount" IS NOT NULL THEN/);
    expect(sql).toContain('ABS("transactions"."tax_amount")');
    expect(sql).toContain('NULLIF(ABS("transactions"."amount"), 0)');
    expect(sql).not.toMatch(/WHEN "transactions"\."tax_amount" > 0/);
    expect(queries[0]?.params).toContain("RUB");
  });
});
