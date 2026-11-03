import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type Approval,
  archiveNames,
  assertKnownFixture,
  type Catalog,
  canonical,
  FIXTURE_KIND,
  FIXTURE_SYSTEM_ID,
  fixtureUrl,
  loadSources,
  queueUnit,
  validateApproval,
  WRITE_ACK,
} from "./synthetic-foundation.mts";

const ROOT = resolve(__dirname, "../../../../..");
const catalogDigest = "a".repeat(64);
const sourceDigest = "b".repeat(64);
const operationId = "c80c5a21-5b7b-4f07-91fe-085c45dd3e0b";
const approval: Approval = {
  kind: FIXTURE_KIND,
  mode: "rehearse",
  operationId,
  database: "midday_test",
  port: 55439,
  systemId: FIXTURE_SYSTEM_ID,
  catalogSha256: catalogDigest,
  sourceSetSha256: sourceDigest,
  acknowledgement: WRITE_ACK,
  preserveOldSchemas: true,
  allowRelocatableExtensions: true,
  acceptSyntheticPlatformOnly: true,
};

function knownCatalog(): Catalog {
  return {
    identity: [
      {
        database: "midday_test",
        role: "postgres",
        version: "160015",
        system_id: FIXTURE_SYSTEM_ID,
      },
    ],
    schemas: ["auth", "private", "public"].map((nspname) => ({ nspname })),
    databases: [{ datname: "midday_test" }, { datname: "postgres" }],
    relations: Array.from({ length: 62 }, (_, index) => ({
      name: `fixture_${index}`,
      schema: "public",
      kind: "r",
    })),
    extensions: [
      {
        extname: "pg_trgm",
        extversion: "1.6",
        extrelocatable: true,
        schema: "public",
      },
      {
        extname: "plpgsql",
        extversion: "1.0",
        extrelocatable: false,
        schema: "pg_catalog",
      },
      {
        extname: "vector",
        extversion: "0.8.7",
        extrelocatable: true,
        schema: "public",
      },
    ],
    availableExtensions: [
      { name: "pgcrypto", default_version: "1.3", installed_version: null },
    ],
    roles: ["agsaas_app", "anon", "authenticated", "service_role"].map(
      (rolname) => ({
        rolname,
        rolcanlogin: rolname === "agsaas_app",
        rolinherit: rolname !== "agsaas_app",
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolreplication: false,
      }),
    ),
    memberships: [],
    publications: [],
    publicationTables: [],
    eventTriggers: [],
    subscriptions: [],
    foreignServers: [],
  };
}

describe("synthetic foundation guardrails (no database connection)", () => {
  test("accepts only the exact loopback fixture endpoint", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const url = `postgres://test:test@${host}:55439/midday_test`;
      expect(fixtureUrl(url)).toBe(url);
    }
    for (const url of [
      "postgres://test:test@localhost/midday_test",
      "postgres://test:test@localhost:5432/midday_test",
      "postgres://test:test@postgres-test:55439/midday_test",
      "postgres://test:test@localhost.example:55439/midday_test",
      "postgres://test:test@127.0.0.1:55439/postgres",
      "postgres://test:test@127.0.0.1:55439/midday_test?host=example.com",
      "postgres://test:test@127.0.0.1:55439/midday_test#fragment",
    ])
      expect(() => fixtureUrl(url)).toThrow();
  });
  test("canonical hashes ignore object-key order and preserve array order", () => {
    expect(canonical({ b: 2, a: [1, 2] })).toBe(canonical({ a: [1, 2], b: 2 }));
    expect(canonical({ a: [2, 1], b: 2 })).not.toBe(
      canonical({ a: [1, 2], b: 2 }),
    );
    expect(() => canonical(undefined)).toThrow();
  });
  test("requires an actual shared systemd queue unit path", () => {
    expect(
      queueUnit(
        "0::/user.slice/imon-jobs.slice/imon-job@20261103T090422-4c04e606f5.service\n",
      ),
    ).toBe("imon-job@20261103T090422-4c04e606f5.service");
    for (const value of [
      "0::/",
      "0::/user.slice/desktop-commander.service",
      "0::/evil-imon-job@fake.service",
      "0::/imon-job@fake.service.evil",
    ]) {
      expect(() => queueUnit(value)).toThrow();
    }
  });
  test("a rehearsal approval cannot commit, change port, system or fingerprints", () => {
    expect(
      validateApproval(approval, "rehearse", catalogDigest, sourceDigest),
    ).toEqual(approval);
    expect(() =>
      validateApproval(approval, "commit", catalogDigest, sourceDigest),
    ).toThrow();
    for (const delta of [
      { database: "postgres" },
      { port: 5432 },
      { systemId: "another-cluster" },
      { catalogSha256: "c".repeat(64) },
      { sourceSetSha256: "d".repeat(64) },
      { preserveOldSchemas: false },
      { allowRelocatableExtensions: false },
      { acceptSyntheticPlatformOnly: false },
      { acknowledgement: "yes" },
    ])
      expect(() =>
        validateApproval(
          { ...approval, ...delta },
          "rehearse",
          catalogDigest,
          sourceDigest,
        ),
      ).toThrow();
    expect(() =>
      validateApproval(approval, "rehearse", "c".repeat(64), sourceDigest),
    ).toThrow();
    expect(() =>
      validateApproval(approval, "rehearse", catalogDigest, "d".repeat(64)),
    ).toThrow();
  });
  test("archive identities are distinct bounded SQL identifiers from UUIDv4 only", () => {
    const names = Object.values(archiveNames(operationId));
    expect(new Set(names).size).toBe(3);
    for (const name of names) {
      expect(name).toMatch(
        /^agsaas_fixture_[a-f0-9]{32}_(public|private|auth)$/,
      );
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    }
    for (const value of [
      "",
      operationId.toUpperCase(),
      "a".repeat(200),
      'x";DROP SCHEMA public;--',
      operationId.replace("-4f07-", "-1f07-"),
    ]) {
      expect(() => archiveNames(value)).toThrow();
    }
  });
  test("rejects another database cluster, version, real platform or role boundary", () => {
    expect(() => assertKnownFixture(knownCatalog())).not.toThrow();
    for (const mutate of [
      (c: Catalog) => {
        c.identity![0]!.system_id = "different";
      },
      (c: Catalog) => {
        c.identity![0]!.version = "170006";
      },
      (c: Catalog) => {
        c.identity![0]!.role = "agsaas_app";
      },
      (c: Catalog) => {
        c.schemas!.push({ nspname: "supabase_migrations" });
      },
      (c: Catalog) => {
        c.relations!.push({ schema: "auth", name: "users", kind: "r" });
      },
      (c: Catalog) => {
        c.extensions![0]!.extrelocatable = false;
      },
      (c: Catalog) => {
        c.extensions![2]!.extversion = "0.8.8";
      },
      (c: Catalog) => {
        c.roles![0]!.rolbypassrls = true;
      },
      (c: Catalog) => {
        c.roles![1]!.rolcanlogin = true;
      },
      (c: Catalog) => {
        c.publications!.push({ pubname: "supabase_realtime" });
      },
    ]) {
      const catalog = knownCatalog();
      mutate(catalog);
      expect(() => assertKnownFixture(catalog)).toThrow();
    }
  });
  test("the complete merged baseline and all 34 upgrades match reviewed immutable bytes", () => {
    const sources = loadSources(ROOT);
    expect(sources.files).toHaveLength(35);
    expect(sources.receipts).toHaveLength(36); // explicitly synthetic platform + real application SQL
    expect(sources.files[0]?.sha256).toBe(
      "e999657a93946bc8de87cc3a9321757984cfe2e3b3491fa643be58f10b8b32fd",
    );
    expect(
      sources.files
        .at(-1)
        ?.path.endsWith("20261103123000_inbox_deletion_receipts.sql"),
    ).toBe(true);
    expect(sources.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  test("modified or additional SQL cannot silently join the reviewed chain", () => {
    const temp = mkdtempSync(join(tmpdir(), "agsaas-foundation-source-"));
    try {
      const sources = loadSources(ROOT);
      for (const file of sources.files) {
        mkdirSync(dirname(join(temp, file.path)), { recursive: true });
        copyFileSync(join(ROOT, file.path), join(temp, file.path));
      }
      expect(loadSources(temp).sha256).toBe(sources.sha256);
      const changed = join(temp, sources.files[1]!.path);
      const original = readFileSync(changed, "utf8");
      writeFileSync(changed, `${original}\n-- changed after review\n`);
      expect(() => loadSources(temp)).toThrow("immutable SQL bytes differ");
      writeFileSync(changed, original);
      const extra = join(dirname(changed), "20261103112000_unreviewed.sql");
      writeFileSync(extra, "SELECT 1;");
      expect(() => loadSources(temp)).toThrow("additional or reordered");
      rmSync(extra);
      rmSync(changed);
      expect(() => loadSources(temp)).toThrow("Missing");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
