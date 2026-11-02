/**
 * Pure PostgreSQL 17 access-control helpers for the isolated restore rehearsal.
 * Nothing in this module connects to a database or chooses a restore target.
 * The caller must independently prove the container, volume and database are
 * the disposable rehearsal before executing the reset SQL as an administrator.
 *
 * This is an access-control comparison, not a schema/data backup verifier. It
 * deliberately omits passwords, connection options, function bodies and role
 * configuration values. Metadata/proofs still belong in private local files.
 *
 * PostgreSQL distinguishes global replacement defaults from schema-local
 * additive defaults. A null object ACL means the hard-wired default, not the
 * current pg_default_acl value. See PostgreSQL 17 pg_default_acl documentation.
 */

export const REHEARSAL_ACL_FORMAT_VERSION = 1;

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
export type RehearsalAclRecord = { key: string; metadata: JsonObject };
export type RehearsalAclSnapshot = {
  formatVersion: typeof REHEARSAL_ACL_FORMAT_VERSION;
  database: string;
  serverMajorVersion: 17;
  objects: RehearsalAclRecord[];
  defaultPrivileges: RehearsalAclRecord[];
  roles: RehearsalAclRecord[];
  memberships: RehearsalAclRecord[];
};

const SECTIONS = [
  "objects",
  "defaultPrivileges",
  "roles",
  "memberships",
] as const;
type Section = (typeof SECTIONS)[number];

/** All fragments passed here are static SQL authored in this module. */
function aclJson(aclExpression: string): string {
  return `COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'grantor', a.grantor_name,
      'grantee', a.grantee_name,
      'privilege', a.privilege_type,
      'grantable', a.is_grantable
    ) ORDER BY a.grantor_name COLLATE "C", a.grantee_name COLLATE "C",
      a.privilege_type COLLATE "C", a.is_grantable)
    FROM (
      SELECT pg_get_userbyid(x.grantor)::text AS grantor_name,
        CASE WHEN x.grantee = 0 THEN 'PUBLIC'
          ELSE pg_get_userbyid(x.grantee)::text END AS grantee_name,
        x.privilege_type, x.is_grantable
      -- PostgreSQL rejects zero-dimensional '{}' ACL arrays. NULL is STRICT
      -- here and yields no privilege rows, which is the intended empty ACL.
      FROM aclexplode(CASE WHEN cardinality(${aclExpression}) > 0
        THEN ${aclExpression} ELSE NULL::aclitem[] END) AS x
    ) AS a
  ), '[]'::jsonb)`;
}

/**
 * Reset ONLY future-object defaults, never the ACL of an existing object.
 * The DO statement is atomic; the final assertion rolls the whole statement
 * back if any supported non-catalog default entry remains.
 *
 * Restoring a dump into an initialized Supabase database without this step can
 * preserve init-script grants on newly recreated objects. pg_restore --clean
 * does not remove every pre-existing ALTER DEFAULT PRIVILEGES entry.
 */
export function resetRehearsalDefaultAclSql(): string {
  return `DO $agsaas_rehearsal_default_acl$
DECLARE
  entry record;
  recipient record;
  standard_grant record;
  object_keyword text;
  acl_type "char";
  prefix text;
  recipient_sql text;
BEGIN
  IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Default ACL reset is restricted to the matched PostgreSQL 17 rehearsal';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl AS d
    LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
    WHERE (d.defaclnamespace = 0 OR
      (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'))
      AND d.defaclobjtype NOT IN ('r', 'S', 'f', 'T', 'n')
  ) THEN
    RAISE EXCEPTION 'Unsupported default ACL object type; no reset performed';
  END IF;

  FOR entry IN
    SELECT d.defaclrole, d.defaclnamespace, d.defaclobjtype, d.defaclacl,
      r.rolname AS role_name, n.nspname AS schema_name
    FROM pg_catalog.pg_default_acl AS d
    JOIN pg_catalog.pg_roles AS r ON r.oid = d.defaclrole
    LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
    WHERE d.defaclnamespace = 0 OR
      (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    ORDER BY r.rolname::text COLLATE "C", d.defaclnamespace = 0,
      n.nspname::text COLLATE "C", d.defaclobjtype
  LOOP
    object_keyword := CASE entry.defaclobjtype
      WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
      WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS'
    END;
    -- pg_default_acl uses S for sequences; acldefault uses lowercase s.
    acl_type := CASE WHEN entry.defaclobjtype = 'S' THEN 's'::"char"
      ELSE entry.defaclobjtype END;
    prefix := format('ALTER DEFAULT PRIVILEGES FOR ROLE %I', entry.role_name);
    IF entry.defaclnamespace <> 0 THEN
      prefix := prefix || format(' IN SCHEMA %I', entry.schema_name);
    END IF;

    -- Include owner grants as well: owner defaults may themselves be altered.
    -- CASCADE here affects only the future-object default ACL grant chain.
    FOR recipient IN SELECT DISTINCT x.grantee
      FROM pg_catalog.aclexplode(CASE
        WHEN pg_catalog.cardinality(entry.defaclacl) > 0 THEN entry.defaclacl
        ELSE NULL::pg_catalog.aclitem[] END) AS x
    LOOP
      recipient_sql := CASE WHEN recipient.grantee = 0 THEN 'PUBLIC'
        ELSE format('%I', pg_catalog.pg_get_userbyid(recipient.grantee)) END;
      EXECUTE prefix || ' REVOKE ALL PRIVILEGES ON ' || object_keyword ||
        ' FROM ' || recipient_sql || ' CASCADE';
    END LOOP;

    IF entry.defaclnamespace = 0 THEN
      -- Restore PostgreSQL's complete hard-wired default, including PUBLIC
      -- EXECUTE on functions and PUBLIC USAGE on types. Schema-local entries
      -- are additive and must instead remain empty.
      FOR standard_grant IN
        SELECT * FROM pg_catalog.aclexplode(
          pg_catalog.acldefault(acl_type, entry.defaclrole))
      LOOP
        recipient_sql := CASE WHEN standard_grant.grantee = 0 THEN 'PUBLIC'
          ELSE format('%I', pg_catalog.pg_get_userbyid(standard_grant.grantee)) END;
        EXECUTE prefix || ' GRANT ' || standard_grant.privilege_type ||
          ' ON ' || object_keyword || ' TO ' || recipient_sql ||
          CASE WHEN standard_grant.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
      END LOOP;
    END IF;
  END LOOP;

  -- PostgreSQL removes default-ACL entries when their defaults are restored.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl AS d
    LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
    WHERE d.defaclnamespace = 0 OR
      (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
  ) THEN
    RAISE EXCEPTION 'Default ACL normalization incomplete; reset rolled back';
  END IF;
END
$agsaas_rehearsal_default_acl$;`;
}

/**
 * Session-local SET commands plus one SELECT returning a JSON object. Use a
 * short-lived psql connection with --quiet so command tags do not enter JSON.
 * No data/DDL mutation; works inside the caller's read-only transaction.
 *
 * Name-based identities and exploded/sorted ACLs do not depend on restored
 * catalog OIDs or ACL array ordering. A large object's OID is its persistent
 * dump identity, so it is intentionally retained for that object kind only.
 */
export function rehearsalAclMetadataSql(): string {
  const schemaAcl = aclJson("COALESCE(n.nspacl, acldefault('n', n.nspowner))");
  const relationAcl = aclJson(
    "COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::\"char\" ELSE 'r'::\"char\" END, c.relowner))",
  );
  const columnAcl = aclJson("COALESCE(a.attacl, '{}'::aclitem[])");
  const functionAcl = aclJson(
    "COALESCE(p.proacl, acldefault('f', p.proowner))",
  );
  const typeAcl = aclJson("COALESCE(t.typacl, acldefault('T', t.typowner))");
  const defaultAcl = aclJson("d.defaclacl");
  const databaseAcl = aclJson("COALESCE(d.datacl, acldefault('d', d.datdba))");
  const languageAcl = aclJson(
    "COALESCE(l.lanacl, acldefault('l', l.lanowner))",
  );
  const wrapperAcl = aclJson("COALESCE(f.fdwacl, acldefault('F', f.fdwowner))");
  const serverAcl = aclJson("COALESCE(s.srvacl, acldefault('S', s.srvowner))");
  const largeObjectAcl = aclJson(
    "COALESCE(l.lomacl, acldefault('L', l.lomowner))",
  );

  return `SET search_path TO pg_catalog;
SET TIME ZONE 'UTC';
WITH namespaces AS (
  SELECT * FROM pg_namespace
  WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
), objects AS (
  SELECT jsonb_build_array('schema', n.nspname)::text AS key,
    jsonb_build_object('owner', pg_get_userbyid(n.nspowner), 'acl', ${schemaAcl}) AS metadata
  FROM namespaces AS n
  UNION ALL
  SELECT jsonb_build_array('relation', n.nspname, c.relname, c.relkind)::text,
    jsonb_build_object('owner', pg_get_userbyid(c.relowner), 'acl', ${relationAcl},
      'rowSecurity', c.relrowsecurity, 'forceRowSecurity', c.relforcerowsecurity,
      'securityOptions', COALESCE((SELECT jsonb_agg(v ORDER BY v COLLATE "C")
        FROM unnest(c.reloptions) AS v
        WHERE v LIKE 'security_invoker=%' OR v LIKE 'security_barrier=%'), '[]'::jsonb))
  FROM pg_class AS c JOIN namespaces AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT jsonb_build_array('column', n.nspname, c.relname, a.attname)::text,
    jsonb_build_object('acl', ${columnAcl})
  FROM pg_attribute AS a JOIN pg_class AS c ON c.oid = a.attrelid
    JOIN namespaces AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT jsonb_build_array('function', n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid), p.prokind)::text,
    jsonb_build_object('owner', pg_get_userbyid(p.proowner), 'acl', ${functionAcl},
      'securityDefiner', p.prosecdef, 'leakproof', p.proleakproof,
      'settingsSha256', encode(sha256(convert_to(COALESCE((
        SELECT jsonb_agg(v ORDER BY v COLLATE "C")::text FROM unnest(p.proconfig) AS v
      ), '[]'), 'UTF8')), 'hex'))
  FROM pg_proc AS p JOIN namespaces AS n ON n.oid = p.pronamespace
  UNION ALL
  SELECT jsonb_build_array('type', n.nspname, t.typname)::text,
    jsonb_build_object('owner', pg_get_userbyid(t.typowner), 'acl', ${typeAcl})
  FROM pg_type AS t JOIN namespaces AS n ON n.oid = t.typnamespace
  UNION ALL
  SELECT jsonb_build_array('policy', n.nspname, c.relname, p.polname)::text,
    jsonb_build_object('command', p.polcmd, 'permissive', p.polpermissive,
      'roles', COALESCE((SELECT jsonb_agg(role_name ORDER BY role_name COLLATE "C")
        FROM (SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC'
          ELSE pg_get_userbyid(role_oid)::text END AS role_name
          FROM unnest(p.polroles) AS role_oid) AS policy_roles), '[]'::jsonb),
      'usingExpression', pg_get_expr(p.polqual, p.polrelid, false),
      'checkExpression', pg_get_expr(p.polwithcheck, p.polrelid, false))
  FROM pg_policy AS p JOIN pg_class AS c ON c.oid = p.polrelid
    JOIN namespaces AS n ON n.oid = c.relnamespace
  UNION ALL
  SELECT jsonb_build_array('database', d.datname)::text,
    jsonb_build_object('owner', pg_get_userbyid(d.datdba), 'acl', ${databaseAcl})
  FROM pg_database AS d WHERE d.datname = current_database()
  UNION ALL
  SELECT jsonb_build_array('language', l.lanname)::text,
    jsonb_build_object('owner', pg_get_userbyid(l.lanowner), 'acl', ${languageAcl},
      'trusted', l.lanpltrusted)
  FROM pg_language AS l
  UNION ALL
  SELECT jsonb_build_array('foreignDataWrapper', f.fdwname)::text,
    jsonb_build_object('owner', pg_get_userbyid(f.fdwowner), 'acl', ${wrapperAcl})
  FROM pg_foreign_data_wrapper AS f
  UNION ALL
  SELECT jsonb_build_array('foreignServer', s.srvname)::text,
    jsonb_build_object('owner', pg_get_userbyid(s.srvowner), 'acl', ${serverAcl})
  FROM pg_foreign_server AS s
  UNION ALL
  SELECT jsonb_build_array('largeObject', l.oid::text)::text,
    jsonb_build_object('owner', pg_get_userbyid(l.lomowner), 'acl', ${largeObjectAcl})
  FROM pg_largeobject_metadata AS l
), default_privileges AS (
  SELECT jsonb_build_array('default', r.rolname, n.nspname, d.defaclobjtype)::text AS key,
    jsonb_build_object('acl', ${defaultAcl}) AS metadata
  FROM pg_default_acl AS d JOIN pg_roles AS r ON r.oid = d.defaclrole
    LEFT JOIN pg_namespace AS n ON n.oid = d.defaclnamespace
  WHERE d.defaclnamespace = 0 OR
    (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
), roles AS (
  SELECT jsonb_build_array('role', r.rolname)::text AS key,
    jsonb_build_object('superuser', r.rolsuper, 'inherit', r.rolinherit,
      'createRole', r.rolcreaterole, 'createDb', r.rolcreatedb, 'login', r.rolcanlogin,
      'replication', r.rolreplication, 'bypassRls', r.rolbypassrls,
      'connectionLimit', r.rolconnlimit, 'validUntil', r.rolvaliduntil::text) AS metadata
  FROM pg_roles AS r
), memberships AS (
  SELECT jsonb_build_array('membership', pg_get_userbyid(m.roleid),
    pg_get_userbyid(m.member), pg_get_userbyid(m.grantor))::text AS key,
    jsonb_build_object('admin', m.admin_option, 'inherit', m.inherit_option,
      'set', m.set_option) AS metadata
  FROM pg_auth_members AS m
)
SELECT jsonb_build_object(
  'formatVersion', ${REHEARSAL_ACL_FORMAT_VERSION},
  'database', current_database(),
  'serverMajorVersion', current_setting('server_version_num')::integer / 10000,
  'objects', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'metadata', metadata)
    ORDER BY key COLLATE "C") FROM objects), '[]'::jsonb),
  'defaultPrivileges', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'metadata', metadata)
    ORDER BY key COLLATE "C") FROM default_privileges), '[]'::jsonb),
  'roles', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'metadata', metadata)
    ORDER BY key COLLATE "C") FROM roles), '[]'::jsonb),
  'memberships', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'metadata', metadata)
    ORDER BY key COLLATE "C") FROM memberships), '[]'::jsonb)
);`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32)
    throw new Error("Invalid ACL proof: metadata nesting is excessive");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i))
        throw new Error("Invalid ACL proof: sparse metadata array");
      items.push(canonicalJson(value[i], depth + 1));
    }
    return `[${items.join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`,
      )
      .join(",")}}`;
  }
  throw new Error("Invalid ACL proof: metadata is not finite JSON");
}

export function validateRehearsalAclSnapshot(
  value: unknown,
): asserts value is RehearsalAclSnapshot {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "formatVersion",
      "database",
      "serverMajorVersion",
      ...SECTIONS,
    ]) ||
    value.formatVersion !== REHEARSAL_ACL_FORMAT_VERSION ||
    typeof value.database !== "string" ||
    !value.database ||
    value.serverMajorVersion !== 17
  ) {
    throw new Error("Invalid ACL proof: unsupported snapshot header");
  }
  for (const section of SECTIONS) {
    const records = value[section];
    if (
      !Array.isArray(records) ||
      ((section === "objects" || section === "roles") && records.length === 0)
    ) {
      throw new Error(`Invalid ACL proof: missing ${section}`);
    }
    const keys = new Set<string>();
    for (const record of records) {
      if (
        !isObject(record) ||
        !exactKeys(record, ["key", "metadata"]) ||
        typeof record.key !== "string" ||
        !record.key ||
        !isObject(record.metadata)
      ) {
        throw new Error(`Invalid ACL proof: malformed ${section} entry`);
      }
      if (keys.has(record.key))
        throw new Error(`Invalid ACL proof: duplicate ${section} identity`);
      keys.add(record.key);
      canonicalJson(record.metadata);
    }
  }
}

export type RehearsalAclDifference = {
  section: Section | "header";
  key: string;
  change: "added" | "removed" | "changed";
};

/** Detailed identities are for private diagnostics; metadata values are omitted. */
export function compareRehearsalAclSnapshots(
  expected: unknown,
  actual: unknown,
): RehearsalAclDifference[] {
  validateRehearsalAclSnapshot(expected);
  validateRehearsalAclSnapshot(actual);
  const differences: RehearsalAclDifference[] = [];
  if (expected.database !== actual.database) {
    differences.push({ section: "header", key: "database", change: "changed" });
  }
  for (const section of SECTIONS) {
    const before = new Map(
      expected[section].map((record) => [
        record.key,
        canonicalJson(record.metadata),
      ]),
    );
    const after = new Map(
      actual[section].map((record) => [
        record.key,
        canonicalJson(record.metadata),
      ]),
    );
    for (const key of [
      ...new Set([...before.keys(), ...after.keys()]),
    ].sort()) {
      if (!before.has(key)) differences.push({ section, key, change: "added" });
      else if (!after.has(key))
        differences.push({ section, key, change: "removed" });
      else if (before.get(key) !== after.get(key))
        differences.push({ section, key, change: "changed" });
    }
  }
  return differences;
}

export function assertRehearsalAclMatches(
  expected: unknown,
  actual: unknown,
): void {
  const differences = compareRehearsalAclSnapshots(expected, actual);
  if (differences.length) {
    const sections = [
      ...new Set(differences.map((difference) => difference.section)),
    ].join(", ");
    throw new Error(
      `Restored ACL/RLS proof differs: ${differences.length} entries in ${sections}`,
    );
  }
}

const NET_SOURCE_SETTINGS_SHA256 =
  "d0f36062e7c48e2f29c7c58511e3af43eb81d0cf54a91ecfe89af8a22c934f37";
const EMPTY_SETTINGS_SHA256 =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const netFunctionMetadata: JsonObject = {
  owner: "supabase_admin",
  leakproof: false,
  securityDefiner: false,
  acl: [
    {
      grantee: "PUBLIC",
      grantor: "supabase_admin",
      grantable: false,
      privilege: "EXECUTE",
    },
    {
      grantee: "supabase_admin",
      grantor: "supabase_admin",
      grantable: false,
      privilege: "EXECUTE",
    },
  ],
};
const extensionSchemaOwnerAcl: JsonValue[] = [
  {
    grantee: "supabase_admin",
    grantor: "supabase_admin",
    grantable: false,
    privilege: "CREATE",
  },
  {
    grantee: "supabase_admin",
    grantor: "supabase_admin",
    grantable: false,
    privilege: "USAGE",
  },
];
const extensionSchemaSourceAcl: JsonValue[] = [
  {
    grantee: "anon",
    grantor: "supabase_admin",
    grantable: false,
    privilege: "USAGE",
  },
  {
    grantee: "authenticated",
    grantor: "supabase_admin",
    grantable: false,
    privilege: "USAGE",
  },
  {
    grantee: "postgres",
    grantor: "supabase_admin",
    grantable: true,
    privilege: "USAGE",
  },
  {
    grantee: "service_role",
    grantor: "supabase_admin",
    grantable: false,
    privilege: "USAGE",
  },
  ...extensionSchemaOwnerAcl,
];

const MATCHED_EXTENSION_REPAIRS: ReadonlyArray<{
  key: string;
  source: JsonObject;
  restored: JsonObject;
  sql: string;
}> = [
  {
    key: '["function", "net", "http_get", "url text, params jsonb, headers jsonb, timeout_milliseconds integer", "f"]',
    source: {
      ...netFunctionMetadata,
      settingsSha256: NET_SOURCE_SETTINGS_SHA256,
    },
    restored: { ...netFunctionMetadata, settingsSha256: EMPTY_SETTINGS_SHA256 },
    sql: "ALTER FUNCTION net.http_get(pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.int4) SET search_path = net;",
  },
  {
    key: '["function", "net", "http_post", "url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer", "f"]',
    source: {
      ...netFunctionMetadata,
      settingsSha256: NET_SOURCE_SETTINGS_SHA256,
    },
    restored: { ...netFunctionMetadata, settingsSha256: EMPTY_SETTINGS_SHA256 },
    sql: "ALTER FUNCTION net.http_post(pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.int4) SET search_path = net;",
  },
  {
    key: '["schema", "graphql"]',
    source: { owner: "supabase_admin", acl: extensionSchemaSourceAcl },
    restored: { owner: "supabase_admin", acl: extensionSchemaOwnerAcl },
    sql: "GRANT USAGE ON SCHEMA graphql TO anon, authenticated, service_role;\nGRANT USAGE ON SCHEMA graphql TO postgres WITH GRANT OPTION;",
  },
  {
    key: '["schema", "graphql_public"]',
    source: { owner: "supabase_admin", acl: extensionSchemaSourceAcl },
    restored: { owner: "supabase_admin", acl: extensionSchemaOwnerAcl },
    sql: "GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;\nGRANT USAGE ON SCHEMA graphql_public TO postgres WITH GRANT OPTION;",
  },
];

/**
 * Bounded repair for four observed extension-installation defaults in this
 * exact matched Supabase image. This is NOT a general ACL/settings reconciler.
 *
 * Both sides of every difference must match the audited literal metadata.
 * A complete simulated snapshot must then equal the source before any SQL is
 * returned. SQL is entirely static, never interpolated from proof content.
 * The caller must execute it atomically as supabase_admin on the verified
 * clone, re-read all metadata, and prove equality before finalizing restore.
 */
export function matchedExtensionRestoreSql(
  expected: unknown,
  actual: unknown,
): string {
  const differences = compareRehearsalAclSnapshots(expected, actual);
  if (!differences.length) return "";
  // compareRehearsalAclSnapshots validated both, but TypeScript cannot carry
  // its assertion across the call boundary.
  validateRehearsalAclSnapshot(expected);
  validateRehearsalAclSnapshot(actual);
  const expectedObjects = new Map(
    expected.objects.map((record) => [record.key, record]),
  );
  const actualObjects = new Map(
    actual.objects.map((record) => [record.key, record]),
  );
  const allowed = new Map(
    MATCHED_EXTENSION_REPAIRS.map((repair) => [repair.key, repair]),
  );
  const selected = new Set<string>();
  for (const difference of differences) {
    const repair = allowed.get(difference.key);
    if (
      difference.section !== "objects" ||
      difference.change !== "changed" ||
      !repair ||
      canonicalJson(expectedObjects.get(difference.key)?.metadata) !==
        canonicalJson(repair.source) ||
      canonicalJson(actualObjects.get(difference.key)?.metadata) !==
        canonicalJson(repair.restored)
    ) {
      throw new Error(
        "Extension restore repair refused: differences are outside the four matched installation defaults",
      );
    }
    selected.add(repair.key);
  }
  const simulated: RehearsalAclSnapshot = {
    ...actual,
    objects: actual.objects.map((record) =>
      selected.has(record.key)
        ? { key: record.key, metadata: allowed.get(record.key)!.source }
        : record,
    ),
  };
  assertRehearsalAclMatches(expected, simulated);
  return [
    "DO $agsaas_matched_extension_role$ BEGIN IF current_user <> 'supabase_admin' THEN RAISE EXCEPTION 'Matched extension repair requires the verified clone administrator'; END IF; END $agsaas_matched_extension_role$;",
    ...MATCHED_EXTENSION_REPAIRS.filter((repair) =>
      selected.has(repair.key),
    ).map((repair) => repair.sql),
  ].join("\n");
}
