import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_NAME,
  BASELINE_VERSION,
  freshInstallSql,
  migrationChain,
  pendingMigrations,
} from "./self-hosted-migration-chain.mts";

const first = {
  filename: "20261103060000_first.sql",
  sql: "CREATE TABLE private.chain_test(id int);",
};
const second = {
  filename: "20261103061000_second.sql",
  sql: "INSERT INTO private.chain_test VALUES(1);",
};
const baseline = {
  version: BASELINE_VERSION,
  name: "application_baseline",
  statements: [],
};

describe("immutable ordered migration chain", () => {
  test("sorts a fresh chain and accepts exact installed prefix", () => {
    const chain = migrationChain([second, first]);
    expect(chain.map((m) => m.filename)).toEqual([
      first.filename,
      second.filename,
    ]);
    expect(pendingMigrations([baseline, chain[0]!], chain)).toEqual([
      chain[1]!,
    ]);
  });
  test("rejects duplicate versions and transaction escape before execution", () => {
    expect(() =>
      migrationChain([
        first,
        { ...first, filename: "20261103060000_duplicate.sql" },
      ]),
    ).toThrow("duplicate");
    expect(() =>
      migrationChain([{ ...first, sql: "COMMIT; SELECT 1;" }]),
    ).toThrow();
  });
  test("rejects edited history, unknown history and newly inserted old migrations", () => {
    const chain = migrationChain([first, second]);
    expect(() =>
      pendingMigrations(
        [baseline, { ...chain[0]!, statements: ["SELECT 7"] }],
        chain,
      ),
    ).toThrow("immutable");
    expect(() =>
      pendingMigrations(
        [baseline, { ...chain[0]!, version: "20261103050000" }],
        chain,
      ),
    ).toThrow("immutable");
    expect(() => pendingMigrations([baseline, chain[1]!], chain)).toThrow(
      "out-of-order",
    );
  });
});

describe("reviewed refund, Plaid and Inbox erasure source append (no database)", () => {
  test("the full source chain preserves both earlier upgrades and appends only SQL123 to their installed prefix", () => {
    const root = join(__dirname, "..");
    const directory = join(
      root,
      "packages/db/self-hosted/upgrades/supabase/migrations",
    );
    const chain = migrationChain(
      readdirSync(directory)
        .filter((filename) => filename.endsWith(".sql"))
        .map((filename) => ({
          filename,
          sql: readFileSync(join(directory, filename), "utf8"),
        })),
    );
    expect(chain).toHaveLength(34);
    expect(
      chain.slice(-3).map(({ filename, sha256 }) => ({ filename, sha256 })),
    ).toEqual([
      {
        filename: "20261103110000_invoice_refund_requests.sql",
        sha256:
          "acf11ab88ab8ebb5aa05b90dafd9b22560802aa443bd74e6d03c8dabc2ed0ddb",
      },
      {
        filename: "20261103111000_plaid_hosted_consent.sql",
        sha256:
          "d0c6fc87d32cfec15561f4814475d6db1d6e08fc777fad6f5dc5d18d502a4933",
      },
      {
        filename: "20261103123000_inbox_deletion_receipts.sql",
        sha256:
          "34a73f78d312d6f46e26057ab3c666e9832a6f0096c52b08bdbcd132a42f87b4",
      },
    ]);
    const refund = chain.at(-3)!;
    const plaid = chain.at(-2)!;
    const erasure = chain.at(-1)!;
    const prior = [baseline, ...chain.slice(0, -3)];
    const pending = pendingMigrations(prior, chain);
    expect(pending.map(({ version }) => version)).toEqual([
      "20261103110000",
      "20261103111000",
      "20261103123000",
    ]);
    const afterAppend2 = [...prior, refund, plaid];
    expect(chain.slice(0, -1)).toHaveLength(33);
    expect(pendingMigrations(afterAppend2, chain)).toEqual([erasure]);
    expect(pendingMigrations([...afterAppend2, erasure], chain)).toEqual([]);
    // SQL123 cannot authorize skipping either preceding append2 migration.
    expect(() => pendingMigrations([...prior, plaid], chain)).toThrow(
      "out-of-order",
    );
    expect(() => pendingMigrations([...prior, erasure], chain)).toThrow(
      "out-of-order",
    );
    expect(() => pendingMigrations([...prior, refund, erasure], chain)).toThrow(
      "out-of-order",
    );
    expect(() =>
      pendingMigrations(
        [...prior, { ...refund, statements: ["SELECT 1"] }],
        chain,
      ),
    ).toThrow("immutable");
    expect(() =>
      pendingMigrations(
        [...prior, refund, { ...plaid, statements: ["SELECT 1"] }],
        chain,
      ),
    ).toThrow("immutable");
    expect(() =>
      pendingMigrations(
        [...afterAppend2, { ...erasure, statements: ["SELECT 1"] }],
        chain,
      ),
    ).toThrow("immutable");

    const baselineSql = readFileSync(
      join(root, "packages/db/self-hosted/supabase/migrations", BASELINE_NAME),
      "utf8",
    );
    expect(createHash("sha256").update(baselineSql).digest("hex")).toBe(
      "e999657a93946bc8de87cc3a9321757984cfe2e3b3491fa643be58f10b8b32fd",
    );
    const installation = freshInstallSql(
      "SELECT 1;",
      baselineSql,
      "a".repeat(40),
      chain,
    );
    expect(installation.indexOf(refund.sql)).toBeGreaterThan(
      installation.indexOf(baselineSql),
    );
    expect(installation.indexOf(plaid.sql)).toBeGreaterThan(
      installation.indexOf(refund.sql),
    );
    expect(installation.indexOf(erasure.sql)).toBeGreaterThan(
      installation.indexOf(plaid.sql),
    );
    for (const migration of [refund, plaid, erasure]) {
      expect(installation).toContain(
        `VALUES ('${migration.version}','${migration.name}',ARRAY[`,
      );
    }
  });
});
