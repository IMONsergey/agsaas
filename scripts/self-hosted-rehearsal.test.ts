import { describe, expect, test } from "bun:test";
import {
  parseRehearsalArguments,
  REHEARSAL,
  realtimeRoleRestoreSql,
  rehearsalEnvironment,
  upgradeStatements,
  validateArchiveEntries,
  validateRehearsalCompose,
} from "./self-hosted-rehearsal.mts";

const revision = "a".repeat(40);
function environment(): Record<string, string> {
  const password = "1".repeat(64);
  return {
    POSTGRES_PASSWORD: "test-fixture-only",
    DASHBOARD_PASSWORD: "test-fixture-only",
    JWT_SECRET: "test-fixture-only",
    SECRET_KEY_BASE: "test-fixture-only",
    REALTIME_DB_ENC_KEY: "test-fixture-only",
    VAULT_ENC_KEY: "test-fixture-only",
    PG_META_CRYPTO_KEY: "test-fixture-only",
    ANON_KEY: "test-fixture-only",
    SERVICE_ROLE_KEY: "test-fixture-only",
    ANON_KEY_ASYMMETRIC: "test-fixture-only",
    SERVICE_ROLE_KEY_ASYMMETRIC: "test-fixture-only",
    JWT_KEYS: JSON.stringify([{ kty: "EC", d: "test-fixture-only" }]),
    JWT_JWKS: JSON.stringify({ keys: [{ kty: "EC" }] }),
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_only",
    SUPABASE_SECRET_KEY: "sb_secret_test_only",
    AGSAAS_DB_PASSWORD: password,
    COMPOSE_PROJECT_NAME: "agsaas-stage",
    POOLER_TENANT_ID: "agsaas-stage",
    AGSAAS_SOURCE_DIR: "/opt/agsaas/source",
    AGSAAS_RELEASE: revision,
    POSTGRES_DB: "postgres",
    POSTGRES_PORT: "5432",
    AGSAAS_DATABASE_URL: `postgresql://agsaas_app:${password}@db:5432/postgres?sslmode=disable`,
    AGSAAS_WORKER_DATABASE_URL: `postgresql://agsaas_app.agsaas-stage:${password}@supavisor:6543/postgres?sslmode=disable`,
    MIDDAY_ENCRYPTION_KEY: "2".repeat(64),
    INVOICE_JWT_SECRET: "3".repeat(64),
  };
}

function config() {
  const names = [
    "api",
    "api-gw",
    "auth",
    "dashboard",
    "db",
    "functions",
    "imgproxy",
    "mailpit",
    "meta",
    "realtime",
    "redis-cache",
    "redis-queue",
    "rest",
    "storage",
    "studio",
    "supavisor",
    "templates-server",
    "worker",
  ];
  const services: Record<string, Record<string, unknown>> = {};
  for (const name of names) {
    services[name] = {
      networks: { default: null },
      container_name: `${REHEARSAL.project}-${name}`,
    };
  }
  services.realtime!.container_name = `realtime-dev.${REHEARSAL.project}-realtime`;
  for (const name of ["api", "dashboard", "worker"]) {
    services[name]!.image = `agsaas-${name}:rehearsal-${revision}`;
    services[name]!.build = {
      context: REHEARSAL.source,
      args: { GIT_COMMIT_SHA: revision },
    };
  }
  for (const [name, published, target] of [
    ["api", 3403, 8080],
    ["dashboard", 3400, 3000],
    ["api-gw", 3900, 8000],
    ["mailpit", 3925, 8025],
  ] as const) {
    services[name]!.ports = [
      {
        host_ip: "127.0.0.1",
        published: String(published),
        target,
        protocol: "tcp",
      },
    ];
  }
  services.db!.volumes = [
    {
      type: "bind",
      source: `${REHEARSAL.runtime}/volumes/db/data`,
      target: "/var/lib/postgresql/data",
    },
    { type: "volume", source: "db-config", target: "/etc/postgresql-custom" },
  ];
  return {
    name: REHEARSAL.project,
    services,
    networks: {
      default: { name: `${REHEARSAL.project}_default`, internal: true },
    },
    volumes: { "db-config": { name: `${REHEARSAL.project}_db-config` } },
  };
}

describe("dedicated matched-stack rehearsal guardrails", () => {
  test("retargets only the rehearsal, preserving cryptographic material in memory", () => {
    const original = environment();
    const next = rehearsalEnvironment(original, revision);
    expect(next.COMPOSE_PROJECT_NAME).toBe(REHEARSAL.project);
    expect(next.AGSAAS_SOURCE_DIR).toBe(REHEARSAL.source);
    expect(next.SUPABASE_PUBLIC_URL).toBe("http://127.0.0.1:3900");
    expect(next.AGSAAS_WORKER_DATABASE_URL).toContain(
      `agsaas_app.${REHEARSAL.project}:`,
    );
    expect(next.MIDDAY_ENCRYPTION_KEY).toBe(original.MIDDAY_ENCRYPTION_KEY);
    expect(next.JWT_KEYS).toBe(original.JWT_KEYS);
    expect(next.INVOICE_JWT_SECRET).toBe(original.INVOICE_JWT_SECRET);
    expect(original.COMPOSE_PROJECT_NAME).toBe("agsaas-stage");
    expect(next.ENABLE_EMAIL_AUTOCONFIRM).toBe("false");
    expect(next.SMTP_HOST).toBe("mailpit");
    expect(next.OPENAI_API_KEY).toBe("");
  });

  test("rejects a different original project or a short release", () => {
    expect(() =>
      rehearsalEnvironment(
        { ...environment(), COMPOSE_PROJECT_NAME: "production" },
        revision,
      ),
    ).toThrow();
    expect(() => rehearsalEnvironment(environment(), "HEAD")).toThrow();
  });

  test("validates all merged services, mounts, namespaces and loopback ports", () => {
    expect(validateRehearsalCompose(config(), revision)).toHaveLength(18);
  });

  test.each([
    [
      "old global container name",
      (value: ReturnType<typeof config>) => {
        value.services.db!.container_name = "agsaas-stage-db";
      },
    ],
    [
      "live data bind mount",
      (value: ReturnType<typeof config>) => {
        value.services.db!.volumes = [
          {
            type: "bind",
            source: "/opt/agsaas/runtime/supabase/volumes/db/data",
            target: "/var/lib/postgresql/data",
          },
        ];
      },
    ],
    [
      "path traversal",
      (value: ReturnType<typeof config>) => {
        value.services.db!.volumes = [
          {
            type: "bind",
            source: `${REHEARSAL.runtime}/../../outside`,
            target: "/data",
          },
        ];
      },
    ],
    [
      "Docker socket",
      (value: ReturnType<typeof config>) => {
        value.services.db!.volumes = [
          {
            type: "bind",
            source: `${REHEARSAL.runtime}/socket`,
            target: "/var/run/docker.sock",
          },
        ];
      },
    ],
    [
      "external volume",
      (value: ReturnType<typeof config>) => {
        value.volumes["db-config"].name = "agsaas-stage_db-config";
      },
    ],
    [
      "network escape",
      (value: ReturnType<typeof config>) => {
        value.services.api!.networks = { default: null, egress: null };
      },
    ],
    [
      "noninternal network",
      (value: ReturnType<typeof config>) => {
        value.networks.default.internal = false;
      },
    ],
    [
      "public binding",
      (value: ReturnType<typeof config>) => {
        value.services.api!.ports = [
          {
            host_ip: "0.0.0.0",
            published: "3403",
            target: 8080,
            protocol: "tcp",
          },
        ];
      },
    ],
    [
      "extra DB port",
      (value: ReturnType<typeof config>) => {
        value.services.db!.ports = [
          {
            host_ip: "127.0.0.1",
            published: "5432",
            target: 5432,
            protocol: "tcp",
          },
        ];
      },
    ],
    [
      "active image overwrite",
      (value: ReturnType<typeof config>) => {
        value.services.api!.image = `agsaas-api:${revision}`;
      },
    ],
    [
      "active source build",
      (value: ReturnType<typeof config>) => {
        value.services.api!.build = { context: "/opt/agsaas/source" };
      },
    ],
    [
      "host namespace",
      (value: ReturnType<typeof config>) => {
        value.services.worker!.network_mode = "host";
      },
    ],
    [
      "privileged container",
      (value: ReturnType<typeof config>) => {
        value.services.worker!.privileged = true;
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const value = config();
    mutate(value);
    expect(() => validateRehearsalCompose(value, revision)).toThrow();
  });

  test("parses procedural bodies but rejects top-level transaction overrides", () => {
    expect(
      upgradeStatements(
        "-- approved\nDO $$ BEGIN PERFORM 1; END $$;\nALTER TABLE public.users ADD COLUMN example text; ",
      ),
    ).toHaveLength(2);
    for (const sql of [
      "BEGIN; SELECT 1; COMMIT;",
      "ROLLBACK;",
      "/* comment */ END;",
      "START TRANSACTION;",
      "ABORT;",
      "PREPARE TRANSACTION 'escaped';",
      "SAVEPOINT nested;",
      "RELEASE nested;",
      "SET TRANSACTION READ WRITE;",
      "-- only a comment",
    ]) {
      expect(() => upgradeStatements(sql)).toThrow();
    }
  });

  test("rejects stale image tags, build stamps and aliased volume drivers", () => {
    const image = config();
    image.services.api!.image = `agsaas-api:rehearsal-${"b".repeat(40)}`;
    expect(() => validateRehearsalCompose(image, revision)).toThrow();
    const stamp = config();
    stamp.services.api!.build = {
      context: REHEARSAL.source,
      args: { GIT_COMMIT_SHA: "b".repeat(40) },
    };
    expect(() => validateRehearsalCompose(stamp, revision)).toThrow();
    const alias = config();
    Object.assign(alias.volumes["db-config"], {
      driver_opts: {
        type: "none",
        o: "bind",
        device: "/opt/agsaas/runtime/supabase/volumes/db/data",
      },
    });
    expect(() => validateRehearsalCompose(alias, revision)).toThrow();
  });

  test("does not accept arbitrary server target paths or cleanup commands", () => {
    expect(parseRehearsalArguments(["config"])).toBe("config");
    for (const args of [
      ["restore", "/opt/agsaas/runtime/supabase"],
      ["reset"],
      ["down"],
      [],
    ]) {
      expect(() => parseRehearsalArguments(args)).toThrow();
    }
  });

  test("restores only the observed non-login Realtime role, without arbitrary privilege inheritance", () => {
    const role = {
      login: false,
      superuser: false,
      createDb: false,
      createRole: false,
      inherit: false,
      bypassRls: false,
      replication: false,
      connectionLimit: -1,
      validUntil: null,
      config: ["search_path=public, extensions, realtime"],
      memberships: [
        { role: "anon", admin: false },
        { role: "authenticated", admin: false },
        { role: "service_role", admin: false },
      ],
    };
    expect(realtimeRoleRestoreSql(role)).toContain("NOLOGIN NOSUPERUSER");
    for (const key of [
      "login",
      "superuser",
      "createDb",
      "createRole",
      "inherit",
      "bypassRls",
      "replication",
    ]) {
      expect(() => realtimeRoleRestoreSql({ ...role, [key]: true })).toThrow();
    }
    expect(() =>
      realtimeRoleRestoreSql({
        ...role,
        memberships: [{ role: "supabase_admin", admin: false }],
      }),
    ).toThrow();
  });

  test("accepts only regular database config archive members and a saved root key", () => {
    const names = "./\n./pgsodium_root.key";
    const details =
      "drwx------ 0/0 0 2026-11-01 00:00 ./\n-rw------- 0/0 64 2026-11-01 00:00 ./pgsodium_root.key";
    expect(() => validateArchiveEntries(names, details)).not.toThrow();
    for (const invalid of [
      "../../stage/key",
      "/etc/key",
      "./key with spaces",
      "./sub/../pgsodium_root.key",
    ]) {
      expect(() => validateArchiveEntries(`./\n${invalid}`, details)).toThrow();
    }
    expect(() =>
      validateArchiveEntries(
        names,
        details.replace("-rw-------", "lrwxrwxrwx"),
      ),
    ).toThrow();
    expect(() =>
      validateArchiveEntries(
        names,
        details.replace("-rw-------", "drwx------"),
      ),
    ).toThrow();
    expect(() =>
      validateArchiveEntries("./", "drwx------ 0/0 0 2026-11-01 00:00 ./"),
    ).toThrow();
  });
});
