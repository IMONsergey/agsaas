import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { YAML } from "bun";

// These tests read only checked-in templates. They never load a generated .env,
// contact a service, execute Docker, interpolate credentials, or apply SQL.
// Bun parses YAML merge anchors, but does not implement Compose !reset/!override
// semantics. Check their literal presence and validate the real merge on target.
type Service = {
  image?: string;
  build?: {
    context: string;
    dockerfile: string;
    args: Record<string, string>;
  };
  container_name?: string;
  restart?: string;
  init?: boolean;
  mem_limit?: string;
  cpus?: number;
  pids_limit?: number;
  stop_grace_period?: string;
  privileged?: boolean;
  network_mode?: string;
  pid?: string;
  ports?: string[];
  environment?: Record<string, string>;
  command?: string[];
  entrypoint?: string | string[];
  volumes?: Array<
    | string
    | {
        type: string;
        source: string;
        target: string;
        read_only?: boolean;
        bind?: { create_host_path: boolean };
      }
  >;
  networks?: Record<string, { aliases?: string[] }>;
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period?: string;
  };
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  logging?: {
    driver: string;
    options: Record<string, string>;
  };
};

type Compose = {
  name?: string;
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
};

function read(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

const platformText = read("platform.compose.yml");
const appText = read("compose.apps.yml");
const mailText = read("compose.mail-test.yml");
const platform = YAML.parse(platformText) as Compose;
const apps = YAML.parse(appText) as Compose;
const mail = YAML.parse(mailText) as Compose;

function service(config: Compose, name: string): Service {
  const value = config.services[name];
  if (!value) throw new Error(`Missing declared service: ${name}`);
  return value;
}

function env(config: Compose, name: string): Record<string, string> {
  return service(config, name).environment ?? {};
}

function required(value: string | undefined, name: string) {
  // Compose :? rejects BOTH an unset variable and an empty value.
  expect(value).toMatch(new RegExp(`\\$\\{${name}:\\?[^}]+\\}`));
}

function memoryMiB(config: Compose): number {
  return Object.values(config.services).reduce((total, entry) => {
    if (!entry.mem_limit) return total;
    expect(entry.mem_limit).toMatch(/^\d+m$/);
    return total + Number.parseInt(entry.mem_limit, 10);
  }, 0);
}

const platformServices = [
  "studio",
  "api-gw",
  "auth",
  "rest",
  "realtime",
  "storage",
  "imgproxy",
  "meta",
  "functions",
  "db",
  "supavisor",
];
const appServices = ["api", "worker", "dashboard"];

describe("application image entrypoint permissions", () => {
  test.each(
    appServices,
  )("normalizes the %s script independently of checkout umask", (name) => {
    const dockerfile = read(`../../apps/${name}/Dockerfile`);
    expect(dockerfile).toContain("RUN chmod 0755 /app/entrypoint.sh");
    expect(dockerfile).not.toContain("RUN chmod +x /app/entrypoint.sh");
  });
});

describe("pinned Supabase platform overlay", () => {
  test("preserves the complete matched image/config snapshot", () => {
    expect(platformText).toContain("self-hosted/v0.8.3");
    expect(platformText).toContain("bc27d2661edd09a5d0b8d76ce33da6d4071a756e");
    expect(Object.keys(platform.services).sort()).toEqual(
      [...platformServices].sort(),
    );
    for (const entry of Object.values(platform.services)) {
      for (const untouched of [
        "image",
        "build",
        "command",
        "entrypoint",
        "volumes",
      ]) {
        expect(entry).not.toHaveProperty(untouched);
      }
    }
    expect(platform.name).toBe("agsaas-stage");
  });

  test("replaces gateway ports and resets pooler/database publication", () => {
    expect(service(platform, "api-gw").ports).toEqual([
      "127.0.0.1:3800:8000/tcp",
    ]);
    expect(platformText).toMatch(
      /ports: !override\s+- "127\.0\.0\.1:3800:8000\/tcp"/,
    );
    for (const name of ["db", "supavisor"]) {
      expect(service(platform, name).ports).toEqual([]);
      expect(platformText).toMatch(
        new RegExp(`\\n  ${name}:[\\s\\S]*?\\n    ports: !reset \\[\\]`),
      );
    }
    for (const name of platformServices.filter(
      (name) => !["api-gw", "db", "supavisor"].includes(name),
    )) {
      expect(service(platform, name).ports).toBeUndefined();
    }
  });

  test("removes upstream global-name collisions without breaking Realtime DNS", () => {
    const names = Object.values(platform.services).map(
      (entry) => entry.container_name,
    );
    expect(new Set(names).size).toBe(platformServices.length);
    for (const name of platformServices.filter((name) => name !== "realtime")) {
      expect(service(platform, name).container_name).toMatch(/^agsaas-stage-/);
    }
    const realtime = service(platform, "realtime");
    expect(realtime.container_name).toBe("realtime-dev.agsaas-stage-realtime");
    expect(realtime.networks?.default?.aliases).toEqual([
      "realtime-dev.supabase-realtime",
    ]);
    expect(env(platform, "realtime").REGION).toBe("us-east-1");
  });

  test.each([
    { name: "auth", key: "GOTRUE_JWT_KEYS", variable: "JWT_KEYS" },
    { name: "rest", key: "PGRST_JWT_SECRET", variable: "JWT_JWKS" },
    { name: "realtime", key: "API_JWT_JWKS", variable: "JWT_JWKS" },
    { name: "storage", key: "JWT_JWKS", variable: "JWT_JWKS" },
    { name: "functions", key: "SUPABASE_JWKS", variable: "JWT_JWKS" },
  ])("requires the matched asymmetric configuration: $name", ({
    name,
    key,
    variable,
  }) => {
    required(env(platform, name)[key], variable);
  });

  test("requires generated opaque gateway keys and never auto-confirms missing mail", () => {
    for (const key of [
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SECRET_KEY",
      "ANON_KEY_ASYMMETRIC",
      "SERVICE_ROLE_KEY_ASYMMETRIC",
    ]) {
      required(env(platform, "api-gw")[key], key);
    }
    expect(env(platform, "auth").GOTRUE_MAILER_AUTOCONFIRM).toBe("false");
  });

  test("bounds the real transaction pooler rather than inventing Node pool controls", () => {
    const values = env(platform, "supavisor");
    required(values.POOLER_TENANT_ID, "POOLER_TENANT_ID");
    expect(values.POOLER_DEFAULT_POOL_SIZE).toBe("10");
    expect(values.POOLER_MAX_CLIENT_CONN).toBe("80");
    expect(values.DB_POOL_SIZE).toBe("5");
    expect(service(platform, "db").stop_grace_period).toBe("60s");
  });
});

describe("application deployment wiring", () => {
  test.each(
    appServices,
  )("builds %s from the same full checkout and release", (name) => {
    const entry = service(apps, name);
    required(entry.image, "AGSAAS_RELEASE");
    expect(entry.image).toStartWith(`agsaas-${name}:`);
    required(entry.build?.context, "AGSAAS_SOURCE_DIR");
    expect(entry.build?.dockerfile).toBe(`apps/${name}/Dockerfile`);
    required(entry.build?.args.GIT_COMMIT_SHA, "AGSAAS_RELEASE");
    expect(entry.init).toBe(true);
    expect(entry.cap_drop).toEqual(["ALL"]);
    expect(entry.security_opt).toEqual(["no-new-privileges:true"]);
  });

  test("publishes only dashboard/API loopback ports; workers/Redis stay internal", () => {
    expect(service(apps, "dashboard").ports).toEqual([
      "127.0.0.1:3300:3000/tcp",
    ]);
    expect(service(apps, "api").ports).toEqual(["127.0.0.1:3303:8080/tcp"]);
    for (const name of ["worker", "redis-cache", "redis-queue"]) {
      expect(service(apps, name).ports).toBeUndefined();
    }
  });

  test.each(
    appServices,
  )("retains canonical browser URLs with private server transport: %s", (name) => {
    const values = env(apps, name);
    required(values.SUPABASE_URL, "SUPABASE_PUBLIC_URL");
    expect(values.NEXT_PUBLIC_SUPABASE_URL).toBe(values.SUPABASE_URL);
    expect(values.SUPABASE_INTERNAL_URL).toBe("http://api-gw:8000");
    expect(values.API_INTERNAL_URL).toBe("http://api:8080");
    for (const key of [
      "NEXT_PUBLIC_URL",
      "DASHBOARD_URL",
      "MIDDAY_DASHBOARD_URL",
    ]) {
      required(values[key], "AGSAAS_DASHBOARD_URL");
    }
    for (const key of ["NEXT_PUBLIC_API_URL", "API_URL", "MIDDAY_API_URL"]) {
      required(values[key], "AGSAAS_API_URL");
    }
    required(
      values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "SUPABASE_PUBLISHABLE_KEY",
    );
    required(values.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    for (const key of [
      "MIDDAY_ENCRYPTION_KEY",
      "FILE_KEY_SECRET",
      "INVOICE_JWT_SECRET",
    ]) {
      required(values[key], key);
    }
  });

  test("dashboard build receives public configuration, not provider/server Supabase secrets", () => {
    const args = service(apps, "dashboard").build?.args;
    expect(args).toBeDefined();
    expect(Object.keys(args ?? {}).sort()).toEqual([
      "GIT_COMMIT_SHA",
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_AUTH_COOKIE_NAME",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_URL",
      "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    ]);
    required(args?.NEXT_PUBLIC_SUPABASE_URL, "SUPABASE_PUBLIC_URL");
    required(
      args?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "SUPABASE_PUBLISHABLE_KEY",
    );
    required(args?.NEXT_PUBLIC_URL, "AGSAAS_DASHBOARD_URL");
    required(args?.NEXT_PUBLIC_API_URL, "AGSAAS_API_URL");
    expect(args?.NEXT_PUBLIC_AUTH_COOKIE_NAME).toMatch(
      /^\$\{NEXT_PUBLIC_AUTH_COOKIE_NAME:-\}$/,
    );
    expect(args?.NEXT_PUBLIC_AUTH_COOKIE_NAME).toBe(
      env(apps, "dashboard").NEXT_PUBLIC_AUTH_COOKIE_NAME,
    );
    required(
      args?.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,
      "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    );
    required(
      env(apps, "dashboard").NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,
      "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    );
    expect(env(apps, "dashboard").NEW_USER_SIGNUP_CUTOFF).toMatch(
      /^\$\{NEW_USER_SIGNUP_CUTOFF:-\}$/,
    );
  });

  test("API and worker use separate correct DB contracts and the same authenticated queue", () => {
    const api = env(apps, "api");
    const worker = env(apps, "worker");
    required(api.DATABASE_PRIMARY_URL, "AGSAAS_DATABASE_URL");
    required(worker.DATABASE_PRIMARY_POOLER_URL, "AGSAAS_WORKER_DATABASE_URL");
    expect(api.DATABASE_PRIMARY_POOLER_URL).toBeUndefined();
    expect(worker.DATABASE_PRIMARY_URL).toBeUndefined();
    required(api.SUPABASE_JWT_SECRET, "JWT_SECRET");
    required(api.INTERNAL_API_KEY, "INTERNAL_API_KEY");
    expect(worker.INTERNAL_API_KEY).toBe(api.INTERNAL_API_KEY);
    required(api.REDIS_QUEUE_URL, "REDIS_QUEUE_PASSWORD");
    expect(api.REDIS_QUEUE_URL).toEndWith("@redis-queue:6379/0");
    expect(worker.REDIS_QUEUE_URL).toBe(api.REDIS_QUEUE_URL);
    expect(env(apps, "dashboard").REDIS_QUEUE_URL).toBeUndefined();
    expect(worker.WORKER_ENV).toMatch(/^\$\{AGSAAS_WORKER_ENV:-staging\}$/);
    expect(worker.INSIGHTS_ENABLED).toMatch(/^\$\{INSIGHTS_ENABLED:-false\}$/);
    required(api.ALLOWED_API_ORIGINS, "AGSAAS_DASHBOARD_URL");
  });

  test.each([
    { name: "api", port: 8080, path: "/health/ready", grace: "20s" },
    { name: "worker", port: 8080, path: "/health/ready", grace: "40s" },
    { name: "dashboard", port: 3000, path: "/api/health", grace: "30s" },
  ])("checks bounded real HTTP readiness: $name", ({
    name,
    port,
    path,
    grace,
  }) => {
    const entry = service(apps, name);
    const health = entry.healthcheck;
    expect(health?.test.slice(0, 3)).toEqual(["CMD", "bun", "--eval"]);
    const check = health?.test[3];
    expect(check).toContain(`http://127.0.0.1:${port}${path}`);
    expect(check).toContain("AbortSignal.timeout(5000)");
    expect(check).toContain("r.status !== 200");
    expect(check).toContain("(await r.json()).status !== 'ok'");
    expect(health?.timeout).toBe("8s");
    expect(health?.interval).toBe("15s");
    expect(health?.retries).toBe(5);
    expect(health?.start_period).toBe("60s");
    expect(entry.stop_grace_period).toBe(grace);
  });

  test("waits for core dependency health, not merely container creation", () => {
    expect(service(apps, "api").depends_on).toEqual({
      db: { condition: "service_healthy" },
      "api-gw": { condition: "service_healthy" },
      "redis-cache": { condition: "service_healthy" },
      "redis-queue": { condition: "service_healthy" },
    });
    expect(service(apps, "worker").depends_on?.supavisor?.condition).toBe(
      "service_healthy",
    );
    for (const name of ["worker", "dashboard"]) {
      expect(service(apps, name).depends_on?.api?.condition).toBe(
        "service_healthy",
      );
    }
  });
});

describe("private resource and persistence boundaries", () => {
  test("persistent no-eviction queue Redis is distinct from disposable evicting cache", () => {
    const queue = service(apps, "redis-queue");
    const cache = service(apps, "redis-cache");
    required(queue.image, "AGSAAS_REDIS_IMAGE");
    expect(queue.image).toBe(cache.image);
    for (const [name, password] of [
      ["redis-queue", "REDIS_QUEUE_PASSWORD"],
      ["redis-cache", "REDIS_CACHE_PASSWORD"],
    ] as const) {
      const entry = service(apps, name);
      const command = entry.command ?? [];
      expect(command[0]).toBe("redis-server");
      required(command[command.indexOf("--requirepass") + 1], password);
      required(env(apps, name).REDISCLI_AUTH, password);
      expect(entry.healthcheck?.test).toEqual(["CMD", "redis-cli", "ping"]);
    }
    const queueCommand = queue.command ?? [];
    expect(queueCommand[queueCommand.indexOf("--maxmemory-policy") + 1]).toBe(
      "noeviction",
    );
    expect(queueCommand[queueCommand.indexOf("--appendonly") + 1]).toBe("yes");
    expect(queueCommand[queueCommand.indexOf("--appendfsync") + 1]).toBe(
      "everysec",
    );
    expect(queueCommand[queueCommand.indexOf("--maxmemory") + 1]).toBe("512mb");
    expect(queue.volumes).toEqual(["redis-queue-data:/data"]);
    expect(Object.keys(apps.volumes ?? {})).toEqual(["redis-queue-data"]);
    const cacheCommand = cache.command ?? [];
    expect(cacheCommand[cacheCommand.indexOf("--maxmemory-policy") + 1]).toBe(
      "allkeys-lru",
    );
    expect(cacheCommand[cacheCommand.indexOf("--appendonly") + 1]).toBe("no");
    expect(cacheCommand[cacheCommand.indexOf("--save") + 1]).toBe("");
    expect(cacheCommand[cacheCommand.indexOf("--maxmemory") + 1]).toBe("256mb");
    expect(cache.volumes).toBeUndefined();
    for (const name of appServices) {
      required(env(apps, name).REDIS_URL, "REDIS_CACHE_PASSWORD");
      expect(env(apps, name).REDIS_URL).toEndWith("@redis-cache:6379/0");
    }
  });

  test("bounds memory/process/log growth without claiming a production load guarantee", () => {
    for (const config of [platform, apps]) {
      for (const entry of Object.values(config.services)) {
        expect(entry.restart).toBe("unless-stopped");
        expect(entry.mem_limit).toMatch(/^\d+m$/);
        expect(entry.cpus).toBeGreaterThan(0);
        expect(entry.pids_limit).toBeGreaterThan(0);
        expect(entry.logging).toEqual({
          driver: "json-file",
          options: { "max-size": "10m", "max-file": "3" },
        });
      }
    }
    expect(memoryMiB(platform) + memoryMiB(apps)).toBe(12160);
    expect(memoryMiB(mail)).toBe(384);
  });

  test("does not mount Docker, use host namespaces, or publish privileged ports", () => {
    for (const config of [platform, apps, mail]) {
      for (const entry of Object.values(config.services)) {
        expect(entry.privileged).not.toBe(true);
        expect(entry.network_mode).not.toBe("host");
        expect(entry.pid).not.toBe("host");
        expect(JSON.stringify(entry.volumes ?? [])).not.toContain(
          "docker.sock",
        );
        for (const port of entry.ports ?? []) {
          expect(port).toMatch(/^127\.0\.0\.1:3\d{3}:\d+\/tcp$/);
        }
      }
    }
  });

  test("provides a blank secret inventory rather than reusable example credentials", () => {
    const values = Object.fromEntries(
      read("app.env.example")
        .split(/\r?\n/)
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    for (const name of [
      "AGSAAS_RELEASE",
      "AGSAAS_REDIS_IMAGE",
      "AGSAAS_DATABASE_URL",
      "AGSAAS_WORKER_DATABASE_URL",
      "REDIS_CACHE_PASSWORD",
      "REDIS_QUEUE_PASSWORD",
      "INTERNAL_API_KEY",
      "MIDDAY_ENCRYPTION_KEY",
      "FILE_KEY_SECRET",
      "INVOICE_JWT_SECRET",
      "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    ]) {
      expect(values[name]).toBe("");
    }
    for (const name of [
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SECRET_KEY",
      "JWT_SECRET",
      "JWT_KEYS",
      "JWT_JWKS",
      "NEW_USER_SIGNUP_CUTOFF",
    ]) {
      expect(values[name]).toBeUndefined();
    }
    expect(values.AGSAAS_DASHBOARD_URL).toBe("http://localhost:3300");
    expect(values.AGSAAS_API_URL).toBe("http://localhost:3303");
    expect(values.AGSAAS_WORKER_ENV).toBe("staging");
    expect(values.INSIGHTS_ENABLED).toBe("false");
  });
});

describe("explicit closed-stage email capture overlay", () => {
  test("is opt-in and never configures fake external mail delivery or auto-confirm", () => {
    for (const config of [platform, apps]) {
      expect(config.services.mailpit).toBeUndefined();
      expect(config.services["templates-server"]).toBeUndefined();
    }
    const values = env(mail, "auth");
    expect(values.GOTRUE_SMTP_HOST).toBe("mailpit");
    expect(values.GOTRUE_SMTP_PORT).toBe("1025");
    expect(values.GOTRUE_SMTP_USER).toBe("");
    expect(values.GOTRUE_SMTP_PASS).toBe("");
    expect(values.GOTRUE_SMTP_ADMIN_EMAIL).toBe("no-reply@agsaas.invalid");
    expect(values.GOTRUE_EXTERNAL_EMAIL_ENABLED).toBe("true");
    for (const key of [
      "GOTRUE_MAILER_AUTOCONFIRM",
      "GOTRUE_EXTERNAL_PHONE_ENABLED",
      "GOTRUE_SMS_AUTOCONFIRM",
    ]) {
      expect(values[key]).toBe("false");
    }
  });

  test("serves real OTP HTML to Auth over internal HTTP, not an Auth filesystem path", () => {
    const values = env(mail, "auth");
    for (const kind of ["CONFIRMATION", "MAGIC_LINK"]) {
      expect(values[`GOTRUE_MAILER_TEMPLATES_${kind}`]).toBe(
        "http://templates-server:8080/otp.html",
      );
      expect(values[`GOTRUE_MAILER_SUBJECTS_${kind}`]).toContain(
        "private stage",
      );
    }
    const templateServer = service(mail, "templates-server");
    required(templateServer.image, "AGSAAS_CADDY_IMAGE");
    expect(templateServer.cap_drop).toEqual(["ALL"]);
    expect(templateServer.cap_add).toEqual(["NET_BIND_SERVICE"]);
    expect(templateServer.security_opt).toEqual(["no-new-privileges:true"]);
    expect(templateServer.privileged).not.toBe(true);
    expect(templateServer.command).toEqual([
      "caddy",
      "file-server",
      "-r",
      "/templates",
      "--listen",
      ":8080",
    ]);
    expect(templateServer.ports).toBeUndefined();
    expect(templateServer.volumes).toEqual([
      {
        type: "bind",
        source: "./volumes/templates",
        target: "/templates",
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    expect(templateServer.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "-O",
      "/dev/null",
      "http://127.0.0.1:8080/otp.html",
    ]);
    expect(
      service(mail, "auth").depends_on?.["templates-server"]?.condition,
    ).toBe("service_healthy");
    const html = read("templates/otp.html");
    expect(html).toContain("{{ .Token }}");
    expect(html).not.toContain(".ConfirmationURL");
    expect(html).not.toMatch(/<script\b|https?:\/\//i);
    expect(html).toContain("Private test environment");
  });

  test("pins and bounds Mailpit, exposes only loopback UI, and configures no relay", () => {
    const entry = service(mail, "mailpit");
    expect(entry.image).toBe(
      "axllent/mailpit@sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498",
    );
    expect(entry.ports).toEqual(["127.0.0.1:3825:8025/tcp"]);
    expect(entry.volumes).toBeUndefined();
    expect(entry.mem_limit).toBe("256m");
    const values = env(mail, "mailpit");
    expect(values.MP_MAX_MESSAGES).toBe("1000");
    expect(values.MP_MAX_MESSAGE_SIZE).toBe("1");
    expect(values.MP_DISABLE_VERSION_CHECK).toBe("true");
    expect(values.MP_SMTP_DISABLE_RDNS).toBe("true");
    expect(values.MP_SMTP_RELAY_ALL).toBe("false");
    expect(values.MP_BLOCK_REMOTE_CSS_AND_FONTS).toBe("true");
    expect(values.MP_QUIET).toBe("true");
    expect(
      Object.keys(values).filter((key) => /RELAY|FORWARD|WEBHOOK/.test(key)),
    ).toEqual(["MP_SMTP_RELAY_ALL"]);
  });
});
