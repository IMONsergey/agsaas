import { createHash } from "node:crypto";
import { baselineHistorySql } from "./self-hosted-db.mts";
import { upgradeStatements } from "./self-hosted-rehearsal.mts";

export const BASELINE_NAME = "20261031154237_application_baseline.sql";
export const BASELINE_VERSION = "20261031154237";
export type MigrationHistory = {
  version: string;
  name: string;
  statements: string[];
};
export type Upgrade = MigrationHistory & {
  filename: string;
  sql: string;
  sha256: string;
};

/** One ordered source contract for initial installation and later upgrades. */
export function migrationChain(
  files: { filename: string; sql: string }[],
): Upgrade[] {
  const seen = new Set<string>();
  return [...files]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map(({ filename, sql }) => {
      const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
      if (!match || match[1]! <= BASELINE_VERSION || seen.has(match[1]!)) {
        throw new Error("Invalid, duplicate or pre-baseline migration version");
      }
      seen.add(match[1]!);
      return {
        filename,
        sql,
        version: match[1]!,
        name: match[2]!,
        statements: upgradeStatements(sql),
        sha256: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

export function upgradeHistorySql(migration: Upgrade): string {
  const encoded = migration.statements.map(
    (statement) =>
      `convert_from(decode('${Buffer.from(statement).toString("base64")}','base64'),'UTF8')`,
  );
  return `INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('${migration.version}','${migration.name}',ARRAY[${encoded.join(",")}]);`;
}

export function pendingMigrations(
  history: MigrationHistory[],
  upgrades: Upgrade[],
): Upgrade[] {
  if (
    history[0]?.version !== BASELINE_VERSION ||
    history[0]?.name !== "application_baseline" ||
    new Set(history.map((h) => h.version)).size !== history.length
  ) {
    throw new Error("Unexpected or duplicate baseline migration history");
  }
  for (const entry of history.slice(1)) {
    const source = upgrades.find(
      (upgrade) => upgrade.version === entry.version,
    );
    if (
      !source ||
      entry.name !== source.name ||
      JSON.stringify(entry.statements) !== JSON.stringify(source.statements)
    ) {
      throw new Error(
        "Migration history differs from reviewed immutable source",
      );
    }
  }
  const pending = upgrades.filter(
    (u) => !history.some((h) => h.version === u.version),
  );
  const last = [...history]
    .sort((a, b) => a.version.localeCompare(b.version))
    .at(-1)!.version;
  if (pending.some((u) => u.version <= last))
    throw new Error("Refusing out-of-order migration");
  return pending;
}

/** Caller must execute this complete string in ONE transaction, including
 * rollback verification. A fresh database is never published at baseline only. */
export function freshInstallSql(
  provision: string,
  baseline: string,
  sourceCommit: string,
  upgrades: Upgrade[],
): string {
  return [
    provision,
    baseline,
    baselineHistorySql(baseline, BASELINE_NAME, sourceCommit),
    ...upgrades.map((m) => `${m.sql}\n${upgradeHistorySql(m)}`),
  ].join("\n");
}
