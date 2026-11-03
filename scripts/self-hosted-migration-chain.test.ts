import { describe, expect, test } from "bun:test";
import {
  BASELINE_VERSION,
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
