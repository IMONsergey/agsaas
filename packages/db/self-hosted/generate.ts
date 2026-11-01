import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema";

const directory = __dirname;

type SnapshotColumn = {
  name: string;
  type: string;
  notNull?: boolean;
  default?: unknown;
  generated?: { as: string; type: "stored" | "virtual" };
};

type SnapshotForeignKey = {
  name: string;
  tableFrom: string;
  tableTo: string;
  schemaTo?: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
  onUpdate?: string;
};

type SnapshotTable = {
  name: string;
  schema: string;
  columns: Record<string, SnapshotColumn>;
  foreignKeys: Record<string, SnapshotForeignKey>;
  policies: Record<string, unknown>;
  isRLSEnabled: boolean;
  uniqueConstraints?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordOf<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is Record<string, T> {
  return isRecord(value) && Object.values(value).every(predicate);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isColumn(value: unknown): value is SnapshotColumn {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    (value.notNull === undefined || typeof value.notNull === "boolean") &&
    (value.generated === undefined ||
      (isRecord(value.generated) &&
        typeof value.generated.as === "string" &&
        (value.generated.type === "stored" ||
          value.generated.type === "virtual")))
  );
}

function isForeignKey(value: unknown): value is SnapshotForeignKey {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.tableFrom === "string" &&
    typeof value.tableTo === "string" &&
    isStringArray(value.columnsFrom) &&
    isStringArray(value.columnsTo) &&
    (value.schemaTo === undefined || typeof value.schemaTo === "string") &&
    (value.onDelete === undefined || typeof value.onDelete === "string") &&
    (value.onUpdate === undefined || typeof value.onUpdate === "string")
  );
}

function isTable(value: unknown): value is SnapshotTable {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.schema === "string" &&
    isRecordOf(value.columns, isColumn) &&
    isRecordOf(value.foreignKeys, isForeignKey) &&
    isRecord(value.policies) &&
    typeof value.isRLSEnabled === "boolean" &&
    (value.uniqueConstraints === undefined || isRecord(value.uniqueConstraints))
  );
}

/** Validate the metadata we edit; preserve all other Drizzle data verbatim. */
export function readSnapshotMetadata(value: unknown) {
  if (
    !isRecord(value) ||
    !isRecordOf(value.tables, isTable) ||
    !isRecord(value.enums) ||
    !isRecord(value.views) ||
    !isRecord(value.roles)
  ) {
    throw new Error("Unsupported Drizzle snapshot metadata");
  }
  return {
    tables: value.tables,
    enums: value.enums,
    views: value.views,
    roles: value.roles,
  };
}

/** The application owns public tables, never Supabase's auth/storage schemas. */
const applicationSchema = Object.fromEntries(
  Object.entries(schema).filter(([, value]) => {
    if (!is(value, PgTable)) return true;
    const table = getTableConfig(value);
    return table.schema === undefined || table.schema === "public";
  }),
);

export function createApplicationSnapshot() {
  const raw = generateDrizzleJson(
    applicationSchema,
    undefined,
    ["public"],
    "snake_case",
  );
  // drizzle-kit's declarations rely on a particular Zod major. Treat its
  // boundary as unknown and validate accessed fields instead of casting it or
  // weakening this package's strict compiler configuration.
  const snapshot = { raw, ...readSnapshotMetadata(raw) };

  for (const [key, table] of Object.entries(snapshot.tables)) {
    if (!key.startsWith("public.") || table.name.includes(".")) {
      throw new Error(`Refusing to generate a managed or dotted table: ${key}`);
    }

    // Imported historical policies are incomplete (several omit USING), so
    // they are not a safe fresh-install policy source. Browser read policies
    // are explicitly installed in after.sql after the membership helper.
    table.policies = {
      agsaas_backend: {
        name: "agsaas_backend",
        as: "PERMISSIVE",
        for: "ALL",
        to: ["agsaas_app"],
        using: "true",
        withCheck: "true",
      },
    };
    table.isRLSEnabled = true;
  }

  const users = snapshot.tables["public.users"];
  const teams = snapshot.tables["public.teams"];
  const invites = snapshot.tables["public.user_invites"];
  const documents = snapshot.tables["public.documents"];
  const profileForeignKey = users?.foreignKeys.users_id_fkey;
  const inboxId = teams?.columns.inbox_id;
  const inviteCode = invites?.columns.code;
  const documentFts = documents?.columns.fts;
  if (
    !profileForeignKey ||
    !inboxId ||
    !inviteCode ||
    !documentFts?.generated
  ) {
    throw new Error(
      "The baseline's managed-auth/default/FTS contracts changed",
    );
  }

  // These corrections are deliberately fresh-baseline-only. Legacy test
  // fixtures do not create real Auth identities; never use drizzle-kit push
  // against a self-hosted installation to undo these production contracts.
  profileForeignKey.schemaTo = "auth";
  profileForeignKey.tableTo = "users";
  inboxId.default = "public.generate_inbox(10)";
  inviteCode.default = "public.nanoid(24)";
  documentFts.generated.as =
    "to_tsvector('english'::regconfig, COALESCE(title, '') || ' ' || COALESCE(body, ''))";

  return snapshot;
}

export function getApplicationTableNames(): string[] {
  return Object.values(createApplicationSnapshot().tables)
    .map((table) => table.name)
    .sort();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function freshDatabaseGuard(tableNames: string[]): string {
  const names = tableNames.map((name) => `'${name}'`).join(", ");
  return `DO $fresh_install$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY (ARRAY[${names}]::text[])
  ) THEN
    RAISE EXCEPTION 'AGSaaS fresh bootstrap refuses existing application tables; use reviewed incremental migrations';
  END IF;
END;
$fresh_install$;`;
}

/** Offline generation only: no credentials, DB connections, or remote calls. */
export async function generateBootstrapSql(
  snapshot = createApplicationSnapshot(),
): Promise<string> {
  const tableNames = Object.values(snapshot.tables)
    .map((table) => table.name)
    .sort();
  const empty = generateDrizzleJson({}, undefined, ["public"], "snake_case");
  const ddl = await generateMigration(empty, snapshot.raw);
  const tablePrivileges = tableNames
    .map((name) => {
      const table = `public.${quoteIdentifier(name)}`;
      return [
        `REVOKE ALL ON TABLE ${table} FROM PUBLIC, anon, authenticated, service_role, agsaas_app;`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO agsaas_app, service_role;`,
      ].join("\n");
    })
    .join("\n");

  return `${[
    "-- Generated by packages/db/self-hosted/generate.ts. Do not hand-edit.",
    "-- Reconstructed fresh-install baseline; NOT the missing upstream bootstrap.",
    "-- Apply atomically with the Supabase migration runner or psql --single-transaction --set ON_ERROR_STOP=1.",
    freshDatabaseGuard(tableNames),
    readFileSync(join(directory, "before.sql"), "utf8").trim(),
    ddl.join("\n"),
    tablePrivileges,
    readFileSync(join(directory, "functions.sql"), "utf8").trim(),
    readFileSync(join(directory, "after.sql"), "utf8").trim(),
    "NOTIFY pgrst, 'reload schema';",
  ].join("\n\n")}\n`;
}

export function getBaselinePath(): string {
  const migrations = join(directory, "supabase", "migrations");
  const names = readdirSync(migrations).filter((name) =>
    /^\d{14}_application_baseline\.sql$/.test(name),
  );
  if (names.length !== 1 || !names[0]) {
    throw new Error("Expected one CLI-created application_baseline migration");
  }
  return join(migrations, names[0]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sql = await generateBootstrapSql();
  if (args.length === 0) {
    process.stdout.write(sql);
  } else if (args.length === 1 && args[0] === "--check") {
    if (readFileSync(getBaselinePath(), "utf8") !== sql) {
      throw new Error("Fresh baseline SQL is stale; regenerate and review it");
    }
    console.log(
      "Fresh baseline matches the application schema and SQL sources",
    );
  } else {
    throw new Error("Usage: bun packages/db/self-hosted/generate.ts [--check]");
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Baseline generation failed",
    );
    process.exitCode = 1;
  });
}
