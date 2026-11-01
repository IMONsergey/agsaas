import { describe, expect, test } from "bun:test";
import {
  assertRehearsalAclMatches,
  compareRehearsalAclSnapshots,
  matchedExtensionRestoreSql,
  type RehearsalAclSnapshot,
  rehearsalAclMetadataSql,
  resetRehearsalDefaultAclSql,
  validateRehearsalAclSnapshot,
} from "./rehearsal-acl.mts";

function fixture(): RehearsalAclSnapshot {
  return {
    formatVersion: 1,
    database: "postgres",
    serverMajorVersion: 17,
    objects: [
      { key: '["schema", "public"]', metadata: { owner: "postgres", acl: [] } },
      {
        key: '["relation", "public", "users", "r"]',
        metadata: {
          owner: "postgres",
          rowSecurity: true,
          forceRowSecurity: false,
          acl: [
            {
              grantor: "postgres",
              grantee: "authenticated",
              privilege: "SELECT",
              grantable: false,
            },
          ],
        },
      },
    ],
    defaultPrivileges: [
      { key: '["default", "postgres", "public", "r"]', metadata: { acl: [] } },
    ],
    roles: [
      {
        key: '["role", "agsaas_app"]',
        metadata: { login: true, superuser: false, bypassRls: false },
      },
    ],
    memberships: [],
  };
}

describe("isolated restore default ACL SQL (pure, no server)", () => {
  test("resets schema additions and restores global hard-wired defaults atomically", () => {
    const sql = resetRehearsalDefaultAclSql();
    expect(sql).toStartWith("DO $agsaas_rehearsal_default_acl$");
    expect(sql).toContain("pg_catalog.acldefault(acl_type, entry.defaclrole)");
    expect(sql).toContain("IF entry.defaclnamespace = 0 THEN");
    expect(sql).toContain("WHEN 'f' THEN 'FUNCTIONS'");
    expect(sql).toContain("WHEN 'T' THEN 'TYPES'");
    expect(sql).toContain("WHEN 'n' THEN 'SCHEMAS'");
    expect(sql).toContain("WHEN entry.defaclobjtype = 'S' THEN 's'::\"char\"");
    expect(sql).toContain("WITH GRANT OPTION");
    expect(sql).toContain(
      "Default ACL normalization incomplete; reset rolled back",
    );
  });

  test("quotes role/schema identifiers and treats PUBLIC as a pseudo-role", () => {
    const sql = resetRehearsalDefaultAclSql();
    expect(sql).toContain(
      "format('ALTER DEFAULT PRIVILEGES FOR ROLE %I', entry.role_name)",
    );
    expect(sql).toContain("format(' IN SCHEMA %I', entry.schema_name)");
    expect(sql).toContain("WHEN recipient.grantee = 0 THEN 'PUBLIC'");
    expect(sql).toContain(
      "format('%I', pg_catalog.pg_get_userbyid(recipient.grantee))",
    );
  });

  test("empty default ACLs are not passed to aclexplode as zero-dimensional arrays", () => {
    const sql = resetRehearsalDefaultAclSql();
    expect(sql).toContain(
      "WHEN pg_catalog.cardinality(entry.defaclacl) > 0 THEN entry.defaclacl",
    );
    expect(sql).toContain("ELSE NULL::pg_catalog.aclitem[] END");
  });

  test("never rewrites catalogs, existing objects, passwords, roles or data", () => {
    const sql = resetRehearsalDefaultAclSql();
    expect(sql).not.toMatch(/\b(?:DELETE|INSERT|UPDATE|TRUNCATE|DROP)\b/i);
    expect(sql).not.toContain("ALTER TABLE");
    expect(sql).not.toContain("ALTER ROLE");
    expect(sql).not.toContain("pg_authid");
    expect(sql).not.toContain("rolpassword");
    expect(sql).toContain("NOT BETWEEN 170000 AND 179999");
    expect(sql).toContain(
      "Unsupported default ACL object type; no reset performed",
    );
  });
});

function extensionFixture(restored: boolean): RehearsalAclSnapshot {
  const result = fixture();
  const ownerAcl = [
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
  for (const [name, args] of [
    [
      "http_get",
      "url text, params jsonb, headers jsonb, timeout_milliseconds integer",
    ],
    [
      "http_post",
      "url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer",
    ],
  ]) {
    result.objects.push({
      key: `["function", "net", "${name}", "${args}", "f"]`,
      metadata: {
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
        settingsSha256: restored
          ? "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
          : "d0f36062e7c48e2f29c7c58511e3af43eb81d0cf54a91ecfe89af8a22c934f37",
      },
    });
  }
  for (const name of ["graphql", "graphql_public"]) {
    result.objects.push({
      key: `["schema", "${name}"]`,
      metadata: {
        owner: "supabase_admin",
        acl: restored
          ? structuredClone(ownerAcl)
          : [
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
              ...structuredClone(ownerAcl),
            ],
      },
    });
  }
  return result;
}

describe("matched extension installation repair", () => {
  test("returns only fixed function settings and exact missing schema grants after full simulation", () => {
    const expected = extensionFixture(false);
    const actual = extensionFixture(true);
    const untouched = structuredClone(actual);
    const sql = matchedExtensionRestoreSql(expected, actual);
    expect(sql).toContain("current_user <> 'supabase_admin'");
    expect(sql).toContain(
      "ALTER FUNCTION net.http_get(pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.int4) SET search_path = net;",
    );
    expect(sql).toContain(
      "ALTER FUNCTION net.http_post(pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.int4) SET search_path = net;",
    );
    expect(sql).toContain(
      "GRANT USAGE ON SCHEMA graphql TO anon, authenticated, service_role;",
    );
    expect(sql).toContain(
      "GRANT USAGE ON SCHEMA graphql_public TO postgres WITH GRANT OPTION;",
    );
    expect(sql.match(/ALTER FUNCTION /g)).toHaveLength(2);
    expect(sql.match(/GRANT USAGE ON SCHEMA /g)).toHaveLength(4);
    expect(sql).not.toMatch(
      /\b(?:DROP|DELETE|INSERT|UPDATE|TRUNCATE|REVOKE|CASCADE)\b/,
    );
    expect(actual).toEqual(untouched);
  });

  test("a fully matched proof is an explicit no-op", () => {
    expect(
      matchedExtensionRestoreSql(
        extensionFixture(false),
        extensionFixture(false),
      ),
    ).toBe("");
  });

  test("repairs an exact known subset without changing the other matched objects", () => {
    const expected = extensionFixture(false);
    const actual = extensionFixture(false);
    actual.objects[2]!.metadata = extensionFixture(true).objects[2]!.metadata;
    const sql = matchedExtensionRestoreSql(expected, actual);
    expect(sql).toContain("ALTER FUNCTION net.http_get");
    expect(sql).not.toContain("ALTER FUNCTION net.http_post");
    expect(sql).not.toContain("GRANT USAGE");
  });

  test.each([
    "owner",
    "securityDefiner",
    "leakproof",
    "settingsSha256",
  ])("refuses an unexpected function %s on either side", (field) => {
    for (const side of ["source", "target"]) {
      const expected = extensionFixture(false);
      const actual = extensionFixture(true);
      const metadata = (side === "source" ? expected : actual).objects[2]!
        .metadata;
      metadata[field] =
        field === "owner"
          ? "postgres"
          : field === "settingsSha256"
            ? "a".repeat(64)
            : true;
      expect(() => matchedExtensionRestoreSql(expected, actual)).toThrow();
    }
  });

  test("refuses unexpected schema grants, grantors, grant options and owners", () => {
    for (const field of [
      "grantor",
      "grantable",
      "privilege",
      "grantee",
      "owner",
    ]) {
      const expected = extensionFixture(false);
      const actual = extensionFixture(true);
      const metadata = actual.objects[4]!.metadata;
      if (field === "owner") metadata.owner = "postgres";
      else
        (metadata.acl as Array<Record<string, unknown>>)[0]![field] =
          field === "grantable" ? true : "unexpected";
      expect(() => matchedExtensionRestoreSql(expected, actual)).toThrow();
    }
  });

  test("cannot mask unrelated ACL/RLS, role, default or membership drift", () => {
    for (const section of [
      "objects",
      "roles",
      "defaultPrivileges",
      "memberships",
    ] as const) {
      const actual = extensionFixture(true);
      if (section === "memberships")
        actual.memberships.push({ key: "unexpected", metadata: {} });
      else actual[section][0]!.metadata.unexpected = true;
      expect(() =>
        matchedExtensionRestoreSql(extensionFixture(false), actual),
      ).toThrow();
    }
  });

  test("rejects removed objects, altered signatures and arbitrary SQL-looking identities", () => {
    const missing = extensionFixture(true);
    missing.objects.splice(2, 1);
    expect(() =>
      matchedExtensionRestoreSql(extensionFixture(false), missing),
    ).toThrow();
    const renamed = extensionFixture(true);
    renamed.objects[2]!.key =
      '["function", "net", "http_get", "url text", "f"]';
    expect(() =>
      matchedExtensionRestoreSql(extensionFixture(false), renamed),
    ).toThrow();
    const injected = extensionFixture(true);
    injected.objects[4]!.key = '["schema", "graphql; DROP TABLE public.users"]';
    expect(() =>
      matchedExtensionRestoreSql(extensionFixture(false), injected),
    ).toThrow();
  });

  test("validates snapshots before even returning a no-op", () => {
    expect(() => matchedExtensionRestoreSql({}, {})).toThrow();
    expect(() =>
      matchedExtensionRestoreSql(
        { ...fixture(), serverMajorVersion: 18 },
        fixture(),
      ),
    ).toThrow();
  });
});

describe("canonical access-control metadata SQL", () => {
  test("captures every requested ACL/RLS boundary with stable name-based identity", () => {
    const sql = rehearsalAclMetadataSql();
    for (const category of [
      "schema",
      "relation",
      "column",
      "function",
      "type",
      "policy",
      "database",
      "language",
      "foreignDataWrapper",
      "foreignServer",
      "largeObject",
    ]) {
      expect(sql).toContain(`jsonb_build_array('${category}'`);
    }
    expect(sql).toContain("c.relrowsecurity");
    expect(sql).toContain("c.relforcerowsecurity");
    expect(sql).toContain("p.polpermissive");
    expect(sql).toContain("pg_get_expr(p.polqual, p.polrelid, false)");
    expect(sql).toContain("pg_get_expr(p.polwithcheck, p.polrelid, false)");
    expect(sql).toContain("p.prosecdef");
    expect(sql).toContain("p.proleakproof");
    expect(sql).toContain("security_invoker=%");
    expect(sql).toContain("m.inherit_option");
    expect(sql).toContain("m.set_option");
    expect(sql).toContain("r.rolbypassrls");
  });

  test("normalizes null ACLs, PUBLIC, sequence type codes and deterministic ordering", () => {
    const sql = rehearsalAclMetadataSql();
    expect(sql).toContain("COALESCE(p.proacl, acldefault('f', p.proowner))");
    expect(sql).toContain("COALESCE(t.typacl, acldefault('T', t.typowner))");
    expect(sql).toContain("COALESCE(a.attacl, '{}'::aclitem[])");
    expect(sql).toContain("CASE WHEN c.relkind = 'S' THEN 's'::\"char\"");
    expect(sql).toContain("CASE WHEN x.grantee = 0 THEN 'PUBLIC'");
    expect(sql).toContain('ORDER BY key COLLATE "C"');
    expect(sql).toContain("SET search_path TO pg_catalog;");
    expect(sql).toContain("SET TIME ZONE 'UTC';");
    expect(sql).toContain(
      "nspname !~ '^pg_' AND nspname <> 'information_schema'",
    );
  });

  test("does not extract secrets, function bodies, foreign endpoints or row data", () => {
    const sql = rehearsalAclMetadataSql();
    for (const forbidden of [
      "pg_authid",
      "rolpassword",
      "rolconfig",
      "pg_db_role_setting",
      "srvoptions",
      "umoptions",
      "pg_get_functiondef",
      "prosrc",
      "FROM public.users",
      "FROM auth.users",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).toContain("'settingsSha256', encode(sha256(");
    expect(sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i,
    );
  });

  test("empty column, explicit object and default ACL arrays explode as an empty set", () => {
    const sql = rehearsalAclMetadataSql();
    expect(sql).toContain(
      "cardinality(COALESCE(a.attacl, '{}'::aclitem[])) > 0",
    );
    expect(sql).toContain("cardinality(d.defaclacl) > 0");
    expect(sql).toContain(
      "cardinality(COALESCE(p.proacl, acldefault('f', p.proowner))) > 0",
    );
    expect(sql.match(/ELSE NULL::aclitem\[\] END\) AS x/g)).toHaveLength(11);
  });
});

describe("strict restore ACL/RLS comparison", () => {
  test("accepts only semantically equal records despite JSON key or record order", () => {
    const expected = fixture();
    const actual = fixture();
    actual.objects.reverse();
    actual.roles[0]!.metadata = {
      bypassRls: false,
      superuser: false,
      login: true,
    };
    expect(compareRehearsalAclSnapshots(expected, actual)).toEqual([]);
    expect(() => assertRehearsalAclMatches(expected, actual)).not.toThrow();
  });

  test("finds unexpected browser grants introduced by fresh Supabase defaults", () => {
    const actual = fixture();
    (actual.objects[1]!.metadata.acl as unknown[]).push({
      grantor: "postgres",
      grantee: "anon",
      privilege: "UPDATE",
      grantable: true,
    });
    expect(compareRehearsalAclSnapshots(fixture(), actual)).toEqual([
      { section: "objects", key: actual.objects[1]!.key, change: "changed" },
    ]);
    expect(() => assertRehearsalAclMatches(fixture(), actual)).toThrow(
      "Restored ACL/RLS proof differs",
    );
  });

  test.each([
    "rowSecurity",
    "forceRowSecurity",
  ])("detects %s changes", (field) => {
    const actual = fixture();
    actual.objects[1]!.metadata[field] = !actual.objects[1]!.metadata[field];
    expect(() => assertRehearsalAclMatches(fixture(), actual)).toThrow();
  });

  test("detects privilege loss as well as privilege escalation", () => {
    const actual = fixture();
    actual.objects[1]!.metadata.acl = [];
    expect(() => assertRehearsalAclMatches(fixture(), actual)).toThrow();
    actual.roles[0]!.metadata.bypassRls = true;
    expect(compareRehearsalAclSnapshots(fixture(), actual)).toHaveLength(2);
  });

  test("detects missing or unexpected objects, defaults and memberships", () => {
    const actual = fixture();
    actual.objects.pop();
    actual.defaultPrivileges = [];
    actual.memberships.push({
      key: '["membership", "service_role", "anon", "postgres"]',
      metadata: { admin: false, inherit: true, set: true },
    });
    expect(
      compareRehearsalAclSnapshots(fixture(), actual).map((d) => [
        d.section,
        d.change,
      ]),
    ).toEqual([
      ["objects", "removed"],
      ["defaultPrivileges", "removed"],
      ["memberships", "added"],
    ]);
  });

  test("compares database identity and rejects a different proof format or PostgreSQL major", () => {
    const actual = fixture();
    actual.database = "other";
    expect(compareRehearsalAclSnapshots(fixture(), actual)).toEqual([
      { section: "header", key: "database", change: "changed" },
    ]);
    expect(() =>
      validateRehearsalAclSnapshot({ ...fixture(), formatVersion: 2 }),
    ).toThrow();
    expect(() =>
      validateRehearsalAclSnapshot({ ...fixture(), serverMajorVersion: 18 }),
    ).toThrow();
  });

  test("rejects duplicate, missing, empty and unexpected proof fields", () => {
    const duplicate = fixture();
    duplicate.objects.push(duplicate.objects[0]!);
    for (const invalid of [
      null,
      {},
      [],
      { ...fixture(), objects: [] },
      { ...fixture(), roles: [] },
      { ...fixture(), memberships: null },
      { ...fixture(), extra: true },
      duplicate,
    ]) {
      expect(() => validateRehearsalAclSnapshot(invalid)).toThrow();
    }
  });

  test("rejects non-JSON, nonfinite, sparse and excessively nested metadata", () => {
    const cycle: Record<string, unknown> = {};
    cycle.next = cycle;
    for (const invalid of [
      undefined,
      Number.NaN,
      Infinity,
      new Date(),
      () => true,
      1n,
      Array(1),
      cycle,
    ]) {
      const actual = fixture();
      (actual.objects[0]!.metadata as Record<string, unknown>).invalid =
        invalid;
      expect(() => validateRehearsalAclSnapshot(actual)).toThrow();
    }
  });

  test("failure messages never echo metadata values", () => {
    const actual = fixture();
    actual.objects[0]!.metadata.arbitrary =
      "private-fixture-value-not-for-logs";
    try {
      assertRehearsalAclMatches(fixture(), actual);
      throw new Error("comparison unexpectedly succeeded");
    } catch (error) {
      expect(String(error)).toContain("Restored ACL/RLS proof differs");
      expect(String(error)).not.toContain("private-fixture-value-not-for-logs");
    }
  });
});
