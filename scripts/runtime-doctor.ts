import { parseRedisQueueUrl } from "../packages/job-client/src/redis-url";

export type Service = "api" | "worker" | "dashboard";
type Environment = Record<string, string | undefined>;
export type Finding = {
  severity: "error" | "warning";
  variable: string;
  message: string;
};

const required: Record<Service, string[]> = {
  api: [
    "DATABASE_PRIMARY_URL",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "REDIS_URL",
    "REDIS_QUEUE_URL",
  ],
  worker: [
    "INTERNAL_API_KEY",
    "SUPABASE_SECRET_KEY",
    "REDIS_URL",
    "REDIS_QUEUE_URL",
  ],
  dashboard: [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_URL",
  ],
};

function isPlaceholder(value: string) {
  return /^(?:your[-_ ]|replace[-_ ]|changeme$|secret$|TODO$|\$\{)/i.test(
    value,
  );
}

/** Offline configuration check. Never returns environment values or contacts a service. */
export function inspectEnvironment(service: Service, env: Environment) {
  const findings: Finding[] = [];
  const add = (
    severity: Finding["severity"],
    variable: string,
    message: string,
  ) => findings.push({ severity, variable, message });
  const requireVariable = (name: string) => {
    const value = env[name];
    if (!value?.trim()) {
      add("error", name, "Required configuration is missing.");
    } else if (isPlaceholder(value.trim())) {
      add("error", name, "Replace the template placeholder before starting.");
    }
  };
  const checkUrl = (name: string, protocols: string[], publicUrl = false) => {
    if (!env[name]?.trim()) return;
    try {
      const value = env[name]!;
      const url = new URL(value);
      if (
        value !== value.trim() ||
        Array.from(value).some(
          (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
        ) ||
        !protocols.includes(url.protocol) ||
        !url.hostname ||
        url.hash ||
        (name === "SUPABASE_INTERNAL_URL" && url.search)
      ) {
        throw new Error("invalid URL");
      }
      if (protocols.includes("https:") && (url.username || url.password)) {
        add("error", name, "HTTP endpoints must not embed credentials.");
      }
      if (
        publicUrl &&
        env.NODE_ENV === "production" &&
        url.protocol !== "https:"
      ) {
        add(
          "warning",
          name,
          "Use HTTPS before exposing this endpoint outside a local test.",
        );
      }
    } catch {
      add("error", name, "Invalid URL or unsupported protocol.");
    }
  };

  for (const name of required[service]) requireVariable(name);
  checkUrl("SUPABASE_INTERNAL_URL", ["http:", "https:"]);
  const workerDatabaseVariable =
    env.DATABASE_PRIMARY_POOLER_URL !== undefined
      ? "DATABASE_PRIMARY_POOLER_URL"
      : "DATABASE_PRIMARY_URL";
  if (service === "worker") {
    requireVariable(workerDatabaseVariable);
    if (env.SUPABASE_URL) requireVariable("SUPABASE_URL");
    else requireVariable("NEXT_PUBLIC_SUPABASE_URL");
  }

  if (service === "api" || service === "worker") {
    checkUrl(
      service === "api" ? "DATABASE_PRIMARY_URL" : workerDatabaseVariable,
      ["postgres:", "postgresql:"],
    );
    checkUrl("SUPABASE_URL", ["http:", "https:"]);
    if (service === "worker" && !env.SUPABASE_URL) {
      checkUrl("NEXT_PUBLIC_SUPABASE_URL", ["http:", "https:"]);
    }
    for (const name of ["REDIS_URL", "REDIS_QUEUE_URL"]) {
      if (!env[name]?.trim()) continue;
      try {
        parseRedisQueueUrl(env[name]);
      } catch {
        add(
          "error",
          name,
          "Use a valid redis:// or rediss:// URL with a numeric database and no query/fragment.",
        );
      }
    }
    if (
      env.PORT &&
      (!/^\d+$/.test(env.PORT) || +env.PORT < 1 || +env.PORT > 65535)
    ) {
      add("error", "PORT", "Port must be an integer between 1 and 65535.");
    }
  }

  if (service === "worker") {
    if (Boolean(env.BOARD_USERNAME) !== Boolean(env.BOARD_PASSWORD)) {
      add(
        "warning",
        "BOARD_USERNAME / BOARD_PASSWORD",
        "Both values are required; administration remains disabled with only one.",
      );
    }
    if (env.API_INTERNAL_URL) {
      checkUrl("API_INTERNAL_URL", ["http:", "https:"]);
    } else if (env.NEXT_PUBLIC_API_URL) {
      checkUrl("NEXT_PUBLIC_API_URL", ["http:", "https:"]);
    } else {
      add(
        "warning",
        "API_INTERNAL_URL",
        "Set the API endpoint for service-to-service jobs; the existing fallback is localhost:3003.",
      );
    }
  }
  if (service === "api") {
    if (!env.ALLOWED_API_ORIGINS?.trim()) {
      add(
        "warning",
        "ALLOWED_API_ORIGINS",
        "Set the dashboard origin to enable cross-origin browser requests.",
      );
    } else {
      for (const value of env.ALLOWED_API_ORIGINS.split(",")) {
        try {
          const url = new URL(value);
          if (!/^https?:$/.test(url.protocol) || value !== url.origin)
            throw new Error();
        } catch {
          add(
            "error",
            "ALLOWED_API_ORIGINS",
            "Use comma-separated HTTP(S) origins without spaces, paths or trailing slashes.",
          );
          break;
        }
      }
    }
  }
  if (service === "dashboard") {
    for (const name of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_URL",
    ]) {
      checkUrl(name, ["http:", "https:"], true);
    }
    const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (
      publishableKey &&
      (publishableKey.startsWith("sb_secret_") ||
        publishableKey === env.SUPABASE_SECRET_KEY)
    ) {
      add(
        "error",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "A server-side secret must never be included in a public build variable.",
      );
    }
    const actionsKey = env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
    if (actionsKey) {
      const decoded = Buffer.from(actionsKey, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== actionsKey) {
        add(
          "error",
          "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
          "Use canonical base64 encoding of 32 random bytes, shared by all replicas of one build.",
        );
      }
    } else if (env.NODE_ENV === "production") {
      add(
        "warning",
        "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
        "Set a stable build-time key before using multiple replicas or independent builds.",
      );
    }
  }
  return {
    service,
    ok: !findings.some((item) => item.severity === "error"),
    findings,
  };
}

if (import.meta.main) {
  const service = Bun.argv[2];
  if (
    !service ||
    !["api", "worker", "dashboard"].includes(service) ||
    Bun.argv.length !== 3
  ) {
    console.error(
      "Usage: bun --env-file=<service-env> scripts/runtime-doctor.ts <api|worker|dashboard>",
    );
    process.exitCode = 2;
  } else {
    const result = inspectEnvironment(service as Service, process.env);
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Offline configuration only; credentials, schema, migrations and provider connectivity are not verified.",
    );
    process.exitCode = result.ok ? 0 : 1;
  }
}
