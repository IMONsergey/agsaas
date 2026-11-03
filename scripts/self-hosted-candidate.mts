import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCleanVendorDocker,
  copyPublicPlatformSnapshot,
  installPublicOtpTemplate,
  parseEnvironment,
  SUPABASE_COMMIT,
  serializeEnvironment,
  validateGeneratedSecrets,
} from "./prepare-self-hosted.mts";
import { provisioningSql, verificationSql } from "./self-hosted-db.mts";
import {
  BASELINE_NAME,
  freshInstallSql,
  migrationChain,
} from "./self-hosted-migration-chain.mts";

/** This profile cannot be redirected to an existing or remote deployment. */
export const CANDIDATE = {
  root: "/opt/agsaas/candidate-20261103",
  source: "/opt/agsaas/candidate-20261103/source",
  runtime: "/opt/agsaas/candidate-20261103/runtime/supabase",
  vendor: "/opt/agsaas/vendor/supabase",
  project: "agsaas-candidate-20261103",
  database: "agsaas-candidate-20261103-db",
  postgresImage: "supabase/postgres:17.6.1.136",
  dashboard: "https://94.249.186.240:8547",
  api: "https://94.249.186.240:8548",
  supabase: "https://94.249.186.240:8549",
  website: "https://94.249.186.240:8550",
} as const;
export const CANDIDATE_BUILDER = "agsaas-candidate-20261103";
const DOCKER = ["--host", "unix:///var/run/docker.sock"];
const LAYERS = [
  "platform.compose.yml",
  "compose.apps.yml",
  "compose.public.yml",
  "compose.candidate.yml",
];
const APPS = ["api", "worker", "dashboard", "website"];
const PLATFORM = [
  "db",
  "auth",
  "rest",
  "realtime",
  "storage",
  "imgproxy",
  "meta",
  "functions",
  "api-gw",
  "supavisor",
  "studio",
  "redis-cache",
  "redis-queue",
];
const ORIGINS = {
  AGSAAS_DASHBOARD_URL: CANDIDATE.dashboard,
  AGSAAS_API_URL: CANDIDATE.api,
  SUPABASE_PUBLIC_URL: CANDIDATE.supabase,
  AGSAAS_WEBSITE_URL: CANDIDATE.website,
};
const PORTS: Record<string, [number, number]> = {
  dashboard: [13500, 3000],
  api: [13503, 8080],
  "api-gw": [14000, 8000],
  website: [13501, 3000],
};
const PROVIDER_PREFIX =
  /^(PLAID_|TELLER_|GOCARDLESS_|ENABLEBANKING_|ENABLE_BANKING_|COMPOSIO_|MISTRAL_|LOGO_DEV_|R2_|COMPANY_ENRICH_|POSTHOG_|NEXT_PUBLIC_POSTHOG_|NEXT_PUBLIC_SENTRY_|GROQ_|AZURE_OPENAI_|OPENROUTER_|PERPLEXITY_|TAVILY_|STRIPE_|POLAR_|RESEND_|GMAIL_|OUTLOOK_|TRIGGER_|PLAIN_|SLACK_|XERO_|QUICKBOOKS_|FORTNOX_|DROPBOX_|OPENAI_|ANTHROPIC_|GOOGLE_GENERATIVE_AI_|GOOGLE_API_|SENTRY_)/;
type Environment = Record<string, string>;
type Manifest = {
  mode: string;
  project: string;
  release: string;
  state: string;
  environmentSha256: string;
  configSha256: Record<string, string>;
  platformImages: Record<string, string>;
  builder: ReturnType<typeof validateCandidateBuilder>;
  [key: string]: unknown;
};
type ComposeService = {
  image: string;
  restart?: string;
  container_name?: string;
  privileged?: boolean;
  network_mode?: string;
  pid?: string;
  ipc?: string;
  userns_mode?: string;
  devices?: unknown[];
  cap_add?: string[];
  networks?: Record<string, unknown>;
  ports?: { host_ip?: string; published?: string | number; target?: number }[];
  volumes?: { type: string; source: string; target: string }[];
  mem_limit?: number;
  cpus?: number;
  pids_limit?: number;
};
type Compose = {
  name: string;
  services: Record<string, ComposeService>;
  networks: Record<
    string,
    { name?: string; internal?: boolean; external?: boolean }
  >;
  volumes?: Record<
    string,
    { name: string; external?: boolean; driver_opts?: unknown }
  >;
};

class CandidateError extends Error {}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new CandidateError(message);
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function run(
  executable: string,
  args: string[],
  input?: string,
  timeout = 120_000,
): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    input,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: "/opt/imon-runtime/node/bin:/opt/imon-runtime/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      COMPOSE_PARALLEL_LIMIT: "1",
      DOCKER_BUILDKIT: "1",
    },
  });
  assert(
    result.status === 0,
    `Candidate subprocess failed (${executable}); private output suppressed`,
  );
  return result.stdout.trim();
}
function docker(args: string[], input?: string, timeout?: number) {
  return run("docker", [...DOCKER, ...args], input, timeout);
}
function git(directory: string, ...args: string[]) {
  return run("git", [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    directory,
    ...args,
  ]);
}
function directory(path: string) {
  const stat = lstatSync(path);
  assert(
    stat.isDirectory() &&
      stat.uid === 0 &&
      !(stat.mode & 0o022) &&
      realpathSync(path) === path,
    "Candidate directory is not canonical and deployment-owned",
  );
}
function privateText(path: string) {
  const stat = lstatSync(path);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === 0 &&
      (stat.mode & 0o777) === 0o600 &&
      realpathSync(path) === path,
    "Unsafe candidate private file",
  );
  return readFileSync(path, "utf8");
}
function tracked(relative: string) {
  git(CANDIDATE.source, "ls-files", "--error-unmatch", "--", relative);
  const path = `${CANDIDATE.source}/${relative}`;
  assert(
    realpathSync(path) === path && lstatSync(path).isFile(),
    "Unsafe candidate tracked source",
  );
  return readFileSync(path, "utf8");
}
function sourceRelease() {
  directory(CANDIDATE.root);
  directory(CANDIDATE.source);
  assert(
    !git(CANDIDATE.source, "status", "--porcelain", "--untracked-files=all"),
    "Candidate source must be clean",
  );
  const sha = git(CANDIDATE.source, "rev-parse", "HEAD");
  assert(/^[a-f0-9]{40}$/.test(sha), "Invalid candidate release");
  return sha;
}
function writeJson(path: string, value: unknown, fresh = false) {
  const temporary = `${path}.next-${randomBytes(6).toString("hex")}`;
  if (fresh)
    assert(
      !existsSync(path),
      "Refusing to replace an existing candidate receipt",
    );
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}
function compose(args: string[], timeout = 120_000) {
  return docker(
    [
      "compose",
      "--project-directory",
      CANDIDATE.runtime,
      "--env-file",
      `${CANDIDATE.runtime}/.env`,
      "-p",
      CANDIDATE.project,
      "-f",
      `${CANDIDATE.runtime}/docker-compose.yml`,
      ...LAYERS.flatMap((f) => ["-f", `${CANDIDATE.runtime}/${f}`]),
      ...args,
    ],
    undefined,
    timeout,
  );
}

type BuilderContainer = {
  Id: string;
  Name: string;
  Image: string;
  State: { Running: boolean };
  Config: { Image: string };
  HostConfig: {
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    CpuPeriod: number;
    CpuQuota: number;
    PidsLimit: number;
    NetworkMode: string;
    PortBindings: Record<string, unknown> | null;
  };
  Mounts: { Type: string; Name: string; Destination: string }[];
};

/** Verify the actual daemon-side builder, not the Docker CLI's systemd cgroup.
 * Inspection never starts/creates a builder and never contacts another daemon. */
export function validateCandidateBuilder(
  description: string,
  info: BuilderContainer,
) {
  const names = [...description.matchAll(/^Name:\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const endpoints = [...description.matchAll(/^Endpoint:\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const drivers = [...description.matchAll(/^Driver:\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const node = `${CANDIDATE_BUILDER}0`;
  assert(
    names.length === 2 &&
      names[0] === CANDIDATE_BUILDER &&
      names[1] === node &&
      drivers.length === 1 &&
      drivers[0] === "docker-container" &&
      endpoints.length === 1 &&
      endpoints[0] === "unix:///var/run/docker.sock",
    "Candidate requires its single local docker-container builder",
  );
  const limits = info.HostConfig;
  const cpus =
    limits.NanoCpus > 0
      ? limits.NanoCpus / 1_000_000_000
      : limits.CpuQuota / limits.CpuPeriod;
  assert(
    info.Name === `/buildx_buildkit_${node}` &&
      /^[a-f0-9]{64}$/.test(info.Id) &&
      info.State.Running &&
      /^moby\/buildkit@sha256:[a-f0-9]{64}$/.test(info.Config.Image) &&
      /^sha256:[a-f0-9]{64}$/.test(info.Image),
    "Candidate builder identity/image is not pinned and running",
  );
  assert(
    Number.isFinite(limits.Memory) &&
      limits.Memory > 0 &&
      limits.Memory <= 3 * 1024 ** 3 &&
      limits.MemorySwap === limits.Memory &&
      (limits.NanoCpus > 0 || (limits.CpuPeriod > 0 && limits.CpuQuota > 0)) &&
      Number.isFinite(cpus) &&
      cpus > 0 &&
      cpus <= 2 &&
      Number.isInteger(limits.PidsLimit) &&
      limits.PidsLimit > 0 &&
      limits.PidsLimit <= 256,
    "Candidate builder lacks actual memory/swap/CPU/PID bounds",
  );
  assert(
    ["bridge", "default"].includes(limits.NetworkMode) &&
      !Object.keys(limits.PortBindings ?? {}).length &&
      info.Mounts.length === 1 &&
      info.Mounts[0]?.Type === "volume" &&
      info.Mounts[0]?.Name === `buildx_buildkit_${node}_state` &&
      info.Mounts[0]?.Destination === "/var/lib/buildkit",
    "Candidate builder must use only its own state volume and ordinary bridge",
  );
  return {
    name: CANDIDATE_BUILDER,
    containerId: info.Id,
    imageId: info.Image,
    image: info.Config.Image,
    memoryBytes: limits.Memory,
    swapTotalBytes: limits.MemorySwap,
    cpus,
    pids: limits.PidsLimit,
  };
}
function boundedBuilder(
  expected?: ReturnType<typeof validateCandidateBuilder>,
) {
  const description = docker([
    "buildx",
    "inspect",
    CANDIDATE_BUILDER,
    "--timeout",
    "10s",
  ]);
  const info = JSON.parse(
    docker(["container", "inspect", `buildx_buildkit_${CANDIDATE_BUILDER}0`]),
  )[0] as BuilderContainer;
  const receipt = validateCandidateBuilder(description, info);
  if (expected)
    assert(
      JSON.stringify(receipt) === JSON.stringify(expected),
      "Candidate builder changed since preparation",
    );
  return receipt;
}

export function validateCandidateQuarantine(
  receipt: unknown,
  operation: string | undefined,
  parentPid: number,
  builder?: { containerId: string; imageId: string; image: string },
) {
  assert(
    receipt && typeof receipt === "object",
    "Shared candidate quarantine is missing",
  );
  const record = receipt as Record<string, unknown>;
  assert(
    record.protocol === 1 &&
      record.project === CANDIDATE.project &&
      typeof operation === "string" &&
      /^[a-f0-9]{32}$/.test(operation) &&
      record.operationId === operation &&
      record.adapterPid === parentPid &&
      parentPid > 1,
    "Candidate build requires its live parent adapter and shared heavy-slot quarantine",
  );
  if (builder) {
    const recorded = record.builder as Record<string, unknown> | undefined;
    assert(
      recorded &&
        recorded.containerId === builder.containerId &&
        recorded.imageId === builder.imageId &&
        recorded.image === builder.image,
      "Quarantine does not cover this exact candidate builder",
    );
  }
}
function requireCandidateQuarantine(builder?: {
  containerId: string;
  imageId: string;
  image: string;
}) {
  const path = "/var/lib/imon-heavy-slot/quarantine.json";
  const stat = lstatSync(path);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === 0 &&
      !(stat.mode & 0o022) &&
      stat.size <= 65536 &&
      realpathSync(path) === path,
    "Unsafe shared candidate quarantine",
  );
  validateCandidateQuarantine(
    JSON.parse(readFileSync(path, "utf8")),
    process.env.AGSAAS_HEAVY_SLOT_OPERATION,
    process.ppid,
    builder,
  );
}

export function validateCandidateProviderEnvironment(env: Environment) {
  assert(
    !Object.entries(env).some(
      ([key, value]) => PROVIDER_PREFIX.test(key) && value.trim(),
    ),
    "Candidate cannot contain external provider credentials",
  );
}

export function validateCandidateEnvironment(env: Environment) {
  assert(
    env.COMPOSE_PROJECT_NAME === CANDIDATE.project &&
      env.AGSAAS_SOURCE_DIR === CANDIDATE.source &&
      /^[a-f0-9]{40}$/.test(env.AGSAAS_RELEASE ?? ""),
    "Candidate environment identity mismatch",
  );
  for (const [name, value] of Object.entries(ORIGINS))
    assert(env[name] === value, "Candidate origin mismatch");
  assert(
    env.SITE_URL === CANDIDATE.dashboard &&
      env.API_EXTERNAL_URL === `${CANDIDATE.supabase}/auth/v1`,
    "Candidate Auth origin mismatch",
  );
  assert(
    env.DISABLE_SIGNUP === "true" &&
      env.AUTH_ENABLED_PROVIDERS === "password" &&
      env.ENABLE_EMAIL_AUTOCONFIRM === "false" &&
      env.AUTH_PASSWORD_RECOVERY_ENABLED === "false",
    "Candidate Auth policy mismatch",
  );
  assert(
    env.NEXT_PUBLIC_AUTH_COOKIE_NAME === "agsaas-candidate-20261103-auth",
    "Candidate requires its distinct stable cookie namespace",
  );
  assert(
    env.INSIGHTS_ENABLED === "false" &&
      env.AGSAAS_BILLING_ENABLED === "false" &&
      env.AGSAAS_SITE_INDEXABLE === "false" &&
      env.FUNCTIONS_VERIFY_JWT === "true",
    "Candidate optional feature policy mismatch",
  );
  validateCandidateProviderEnvironment(env);
  assert(
    ![
      "SMTP_HOST",
      "SMTP_USER",
      "SMTP_PASS",
      "SMTP_ADMIN_EMAIL",
      "SMTP_SENDER_NAME",
    ].some((key) => env[key]?.trim()),
    "Candidate must not claim an email transport",
  );
  const password = env.AGSAAS_DB_PASSWORD;
  assert(
    password && /^[a-f0-9]{64}$/.test(password),
    "Invalid candidate backend credential",
  );
  assert(
    env.POOLER_TENANT_ID === CANDIDATE.project &&
      env.AGSAAS_DATABASE_URL ===
        `postgresql://agsaas_app:${password}@db:5432/postgres?sslmode=disable` &&
      env.AGSAAS_WORKER_DATABASE_URL ===
        `postgresql://agsaas_app.${CANDIDATE.project}:${password}@supavisor:6543/postgres?sslmode=disable`,
    "Candidate backend scope mismatch",
  );
  validateGeneratedSecrets(env);
  return password;
}

export function validateCandidateCompose(value: unknown) {
  const config = value as Compose;
  assert(
    config?.name === CANDIDATE.project,
    "Candidate Compose identity mismatch",
  );
  assert(
    config.networks &&
      Object.keys(config.networks).length === 1 &&
      config.networks.default?.name === `${CANDIDATE.project}_default` &&
      config.networks.default.internal === true &&
      !config.networks.default.external,
    "Candidate requires its own isolated network",
  );
  assert(
    JSON.stringify(Object.keys(config.services).sort()) ===
      JSON.stringify([...PLATFORM, ...APPS].sort()),
    "Candidate service set changed",
  );
  for (const [name, service] of Object.entries(config.services)) {
    assert(
      service.restart === "no",
      "Synthetic candidate must not automatically restart after a host reboot",
    );
    assert(
      !service.privileged &&
        !service.network_mode &&
        Object.keys(service.networks ?? {}).every((n) => n === "default"),
      "Candidate service escapes its isolated network",
    );
    assert(
      ![service.pid, service.ipc, service.userns_mode].includes("host") &&
        !service.devices?.length &&
        !service.cap_add?.length,
      "Candidate service exposes host capabilities",
    );
    assert(
      !service.container_name ||
        service.container_name.includes(CANDIDATE.project),
      "Candidate container aliases another project",
    );
    assert(
      Number(service.mem_limit) > 0 &&
        Number(service.mem_limit) <= 3 * 1024 ** 3 &&
        Number(service.cpus) > 0 &&
        Number(service.cpus) <= 2 &&
        Number(service.pids_limit) > 0 &&
        Number(service.pids_limit) <= 512,
      "Candidate resource bound missing or exceeded",
    );
    const ports = service.ports ?? [],
      expected = PORTS[name];
    assert(
      expected
        ? ports.length === 1 &&
            ports[0]?.host_ip === "127.0.0.1" &&
            Number(ports[0]?.published) === expected[0] &&
            ports[0]?.target === expected[1]
        : ports.length === 0,
      "Candidate port exposure differs from its loopback profile",
    );
    for (const mount of service.volumes ?? []) {
      assert(
        mount.target !== "/var/run/docker.sock",
        "Candidate must not mount the Docker socket",
      );
      if (mount.type === "bind")
        assert(
          mount.source.startsWith(`${CANDIDATE.runtime}/`) &&
            resolve(mount.source) === mount.source,
          "Candidate mount points outside fresh runtime",
        );
      else
        assert(
          mount.type === "volume" &&
            !!config.volumes?.[mount.source] &&
            config.volumes[mount.source]!.name.startsWith(
              `${CANDIDATE.project}_`,
            ) &&
            !config.volumes[mount.source]!.external &&
            !config.volumes[mount.source]!.driver_opts,
          "Candidate volume is not independently owned",
        );
    }
  }
  return config;
}

function imageId(image: string) {
  return JSON.parse(
    docker(["image", "inspect", "--format", "{{json .Id}}", image]),
  ) as string;
}
function manifestPath() {
  return `${CANDIDATE.runtime}/candidate-manifest.json`;
}
function guard() {
  const release = sourceRelease();
  directory(CANDIDATE.runtime);
  const raw = privateText(`${CANDIDATE.runtime}/.env`),
    env = parseEnvironment(raw),
    password = validateCandidateEnvironment(env);
  const manifest = JSON.parse(privateText(manifestPath())) as Manifest;
  assert(
    manifest.mode === "isolated-synthetic" &&
      manifest.project === CANDIDATE.project &&
      manifest.release === release &&
      env.AGSAAS_RELEASE === release &&
      manifest.environmentSha256 === digest(raw),
    "Candidate manifest/source/config drift",
  );
  for (const [file, expected] of Object.entries(manifest.configSha256))
    assert(
      digest(readFileSync(`${CANDIDATE.runtime}/${file}`, "utf8")) === expected,
      "Candidate deployment layer changed",
    );
  const config = validateCandidateCompose(
    JSON.parse(compose(["config", "--format", "json"])),
  );
  for (const service of PLATFORM)
    assert(
      imageId(config.services[service]!.image) ===
        manifest.platformImages[service],
      "Installed platform image changed",
    );
  return { release, env, password, manifest, config };
}

export function prepareCandidate(release: string, redisImage: string) {
  assert(
    process.geteuid?.() === 0,
    "Candidate preparation requires its deployment owner",
  );
  assert(
    sourceRelease() === release &&
      /^redis@sha256:[a-f0-9]{64}$/.test(redisImage),
    "Explicit exact source and installed Redis digest required",
  );
  directory(CANDIDATE.vendor);
  directory(`${CANDIDATE.root}/runtime`);
  assert(
    !existsSync(CANDIDATE.runtime),
    "Candidate runtime already exists; no overwrite or key rotation is allowed",
  );
  assert(
    git(CANDIDATE.vendor, "rev-parse", "HEAD") === SUPABASE_COMMIT,
    "Pinned public platform source mismatch",
  );
  assertCleanVendorDocker(CANDIDATE.vendor);
  imageId(redisImage);
  // Fail before fresh keys/runtime/database creation if the builder is unbounded.
  const builder = boundedBuilder();
  assert(
    !docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${CANDIDATE.project}`,
    ]),
    "Candidate containers already exist",
  );
  assert(
    !docker([
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${CANDIDATE.project}`,
    ]),
    "Candidate volumes already exist",
  );
  assert(
    !docker([
      "network",
      "ls",
      "-q",
      "--filter",
      `name=^${CANDIDATE.project}_default$`,
    ]),
    "Candidate network already exists",
  );
  const listeners = run("ss", ["-H", "-ltn"]);
  for (const [hostPort] of Object.values(PORTS))
    assert(
      !new RegExp(`:${hostPort}\\s`).test(listeners),
      "A candidate loopback port is occupied",
    );
  const previousMask = process.umask(0o077);
  try {
    copyPublicPlatformSnapshot(CANDIDATE.vendor, CANDIDATE.runtime);
    copyFileSync(
      `${CANDIDATE.runtime}/.env.example`,
      `${CANDIDATE.runtime}/.env`,
      constants.COPYFILE_EXCL,
    );
    chmodSync(`${CANDIDATE.runtime}/.env`, 0o600);
    for (const generator of ["generate-keys.sh", "add-new-auth-keys.sh"]) {
      const result = spawnSync("sh", [`utils/${generator}`, "--update-env"], {
        cwd: CANDIDATE.runtime,
        timeout: 30_000,
        stdio: "ignore",
      });
      assert(
        result.status === 0,
        "Candidate key generation failed; private runtime retained",
      );
    }
    const env = parseEnvironment(privateText(`${CANDIDATE.runtime}/.env`));
    validateGeneratedSecrets(env);
    const password = randomBytes(32).toString("hex");
    Object.assign(env, ORIGINS, {
      COMPOSE_PROJECT_NAME: CANDIDATE.project,
      COMPOSE_FILE: ["docker-compose.yml", ...LAYERS].join(":"),
      AGSAAS_SOURCE_DIR: CANDIDATE.source,
      AGSAAS_RELEASE: release,
      SITE_URL: CANDIDATE.dashboard,
      API_EXTERNAL_URL: `${CANDIDATE.supabase}/auth/v1`,
      API_GW_HTTP_PORT: "127.0.0.1:14000",
      ADDITIONAL_REDIRECT_URLS: `${CANDIDATE.dashboard}/api/auth/callback`,
      POOLER_TENANT_ID: CANDIDATE.project,
      STORAGE_TENANT_ID: CANDIDATE.project,
      GLOBAL_S3_BUCKET: CANDIDATE.project,
      DASHBOARD_USERNAME: "agsaas-candidate-admin",
      STUDIO_DEFAULT_PROJECT: "AGSaaS isolated synthetic acceptance",
      DISABLE_SIGNUP: "true",
      ENABLE_EMAIL_SIGNUP: "true",
      ENABLE_EMAIL_AUTOCONFIRM: "false",
      ENABLE_PHONE_SIGNUP: "false",
      ENABLE_PHONE_AUTOCONFIRM: "false",
      ENABLE_ANONYMOUS_USERS: "false",
      AUTH_ENABLED_PROVIDERS: "password",
      AUTH_PASSWORD_RECOVERY_ENABLED: "false",
      NEXT_PUBLIC_AUTH_COOKIE_NAME: "agsaas-candidate-20261103-auth",
      SMTP_HOST: "",
      SMTP_PORT: "25",
      SMTP_USER: "",
      SMTP_PASS: "",
      SMTP_ADMIN_EMAIL: "",
      SMTP_SENDER_NAME: "",
      AGSAAS_DATABASE_URL: `postgresql://agsaas_app:${password}@db:5432/postgres?sslmode=disable`,
      AGSAAS_DB_PASSWORD: password,
      AGSAAS_WORKER_DATABASE_URL: `postgresql://agsaas_app.${CANDIDATE.project}:${password}@supavisor:6543/postgres?sslmode=disable`,
      AGSAAS_REDIS_IMAGE: redisImage,
      AGSAAS_WORKER_ENV: "staging",
      AGSAAS_SITE_INDEXABLE: "false",
      AGSAAS_BILLING_ENABLED: "false",
      INSIGHTS_ENABLED: "false",
      FUNCTIONS_VERIFY_JWT: "true",
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
      REGION: "local",
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      APP_NAME: "AGSaaS",
      NEW_USER_SIGNUP_CUTOFF: "",
    });
    for (const key of Object.keys(env))
      if (PROVIDER_PREFIX.test(key)) env[key] = "";
    for (const key of [
      "REDIS_CACHE_PASSWORD",
      "REDIS_QUEUE_PASSWORD",
      "INTERNAL_API_KEY",
      "FILE_KEY_SECRET",
      "INVOICE_JWT_SECRET",
      "MIDDAY_ENCRYPTION_KEY",
      "AGSAAS_SUPPORT_INGEST_KEY",
      "WEBHOOK_SECRET_KEY",
    ])
      env[key] = randomBytes(32).toString("hex");
    validateCandidateEnvironment(env);
    const raw = serializeEnvironment(env);
    writeFileSync(`${CANDIDATE.runtime}/.env`, raw, { mode: 0o600 });
    if (existsSync(`${CANDIDATE.runtime}/.env.old`))
      chmodSync(`${CANDIDATE.runtime}/.env.old`, 0o600);
    for (const layer of LAYERS)
      writeFileSync(
        `${CANDIDATE.runtime}/${layer}`,
        tracked(`deploy/self-hosted/${layer}`),
        { mode: 0o644, flag: "wx" },
      );
    installPublicOtpTemplate(CANDIDATE.source, CANDIDATE.runtime);
    const config = validateCandidateCompose(
      JSON.parse(compose(["config", "--format", "json"])),
    );
    const manifest: Manifest = {
      mode: "isolated-synthetic",
      project: CANDIDATE.project,
      release,
      state: "prepared",
      builder,
      builderMayBeActive: false,
      createdAt: new Date().toISOString(),
      supabaseCommit: SUPABASE_COMMIT,
      environmentSha256: digest(raw),
      configSha256: Object.fromEntries(
        ["docker-compose.yml", ...LAYERS].map((file) => [
          file,
          digest(readFileSync(`${CANDIDATE.runtime}/${file}`, "utf8")),
        ]),
      ),
      platformImages: Object.fromEntries(
        PLATFORM.map((service) => [
          service,
          imageId(config.services[service]!.image),
        ]),
      ),
      productionStateCopied: false,
      externalProvidersEnabled: false,
      publicSignupEnabled: false,
      ingressInstalled: false,
    };
    writeJson(manifestPath(), manifest, true);
    return {
      project: CANDIDATE.project,
      release,
      state: "prepared",
      origins: ORIGINS,
      loopbackPorts: PORTS,
      productionStateCopied: false,
    };
  } finally {
    process.umask(previousMask);
  }
}

function psql(input: string, atomic = false) {
  return docker(
    [
      "exec",
      "-i",
      "--user",
      "postgres",
      "--env",
      "PGCONNECT_TIMEOUT=5",
      "--env",
      "PGOPTIONS=-c statement_timeout=60000 -c lock_timeout=5000 -c transaction_timeout=120000 -c idle_in_transaction_session_timeout=120000",
      CANDIDATE.database,
      "psql",
      "-h",
      "/var/run/postgresql",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=sqlstate",
      "-v",
      "SHOW_CONTEXT=never",
      "-f",
      "-",
      ...(atomic ? ["--single-transaction"] : []),
    ],
    input,
    180_000,
  );
}
function databaseGuard(expectedImage: string) {
  const database = JSON.parse(docker(["inspect", CANDIDATE.database]))[0];
  assert(
    database.Name === `/${CANDIDATE.database}` &&
      database.Image === expectedImage &&
      database.State?.Running &&
      database.State.Health?.Status === "healthy",
    "Candidate database identity/health mismatch",
  );
  assert(
    database.Config?.Labels?.["com.docker.compose.project"] ===
      CANDIDATE.project &&
      database.Config.Labels["com.docker.compose.project.working_dir"] ===
        CANDIDATE.runtime,
    "Candidate database labels mismatch",
  );
  const data = database.Mounts.filter(
    (mount: { Destination: string }) =>
      mount.Destination === "/var/lib/postgresql/data",
  );
  assert(
    data.length === 1 &&
      data[0].Type === "bind" &&
      data[0].Source === `${CANDIDATE.runtime}/volumes/db/data`,
    "Candidate database data mount mismatch",
  );
}
function noApplications() {
  for (const service of APPS)
    assert(
      !docker([
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${CANDIDATE.project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]),
      "Stop candidate application writers first",
    );
}

async function seed(env: Environment) {
  const file = `${CANDIDATE.root}/synthetic-browser-credentials.json`;
  assert(
    !existsSync(file),
    "Synthetic credentials already exist; refusing duplicate account creation",
  );
  assert(
    psql("SELECT count(*) FROM auth.users;") === "0",
    "Only an empty candidate may receive the initial browser fixture",
  );
  const fixtures = ["owner", "other"].map((label) => ({
    label,
    email: `agsaas-candidate-${label}@example.test`,
    password: randomBytes(32).toString("base64url"),
    userId: null as string | null,
  }));
  const receipt = {
    project: CANDIDATE.project,
    release: env.AGSAAS_RELEASE,
    dashboard: CANDIDATE.dashboard,
    confirmedBySyntheticAdministrator: true,
    externalEmailDeliveryVerified: false,
    fixtures,
  };
  writeJson(file, receipt, true);
  for (const fixture of fixtures) {
    const response = await fetch("http://127.0.0.1:14000/auth/v1/admin/users", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SECRET_KEY!,
        Authorization: `Bearer ${env.SERVICE_ROLE_KEY_ASYMMETRIC}`,
      },
      body: JSON.stringify({
        email: fixture.email,
        password: fixture.password,
        email_confirm: true,
        user_metadata: { full_name: `AGSaaS synthetic ${fixture.label}` },
      }),
    });
    assert(
      response.ok,
      "Synthetic GoTrue account creation failed; inspect the private fixture receipt before retrying",
    );
    const created = (await response.json()) as {
      id?: string;
      email?: string;
      email_confirmed_at?: string;
    };
    assert(
      created.email === fixture.email &&
        /^[a-f0-9-]{36}$/i.test(created.id ?? "") &&
        !!created.email_confirmed_at,
      "Unexpected synthetic Auth receipt",
    );
    fixture.userId = created.id!;
    writeJson(file, receipt);
  }
  return {
    seeded: fixtures.length,
    credentialFile: file,
    externalEmailDeliveryVerified: false,
    accountsHaveNoSeededBusinessData: true,
  };
}

async function installCandidateIngress(state: ReturnType<typeof guard>) {
  assert(
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    "Trusted ingress checks cannot disable TLS verification",
  );
  assert(
    state.manifest.state === "running",
    "Start the healthy complete candidate before adding its ingress",
  );
  const ids = docker([
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${CANDIDATE.project}`,
  ])
    .split(/\s+/)
    .filter(Boolean);
  assert(ids.length === 17, "Every candidate service must run before ingress");
  const services = JSON.parse(docker(["inspect", ...ids]));
  assert(
    services.every(
      (item: { State: { Running: boolean; Health?: { Status: string } } }) =>
        item.State.Running &&
        (!item.State.Health || item.State.Health.Status === "healthy"),
    ),
    "Candidate service is not healthy",
  );
  const target = "/etc/nginx/conf.d/agsaas-candidate-20261103.conf";
  directory("/etc/nginx/conf.d");
  const content = tracked("deploy/self-hosted/nginx.candidate.conf");
  const created = !existsSync(target);
  if (created) writeFileSync(target, content, { flag: "wx", mode: 0o644 });
  else {
    const info = lstatSync(target);
    assert(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === 0 &&
        !(info.mode & 0o022) &&
        digest(readFileSync(target, "utf8")) === digest(content),
      "Existing candidate ingress differs; no overwrite is automatic",
    );
  }
  try {
    run("nginx", ["-t"]);
    run("systemctl", ["reload", "nginx"]);
    const endpoints = [
      `${CANDIDATE.dashboard}/login`,
      `${CANDIDATE.api}/health/ready`,
      `${CANDIDATE.supabase}/auth/v1/health`,
      `${CANDIDATE.website}/api/health/`,
    ];
    const checks = [];
    for (const url of endpoints) {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { apikey: state.env.SUPABASE_PUBLISHABLE_KEY! },
      });
      assert(
        response.status === 200 &&
          response.headers.get("x-robots-tag")?.includes("noindex"),
        "Candidate HTTPS readiness or noindex verification failed",
      );
      await response.body?.cancel();
      checks.push({
        url,
        status: response.status,
        trustedTls: true,
        noindex: true,
      });
    }
    const asset = await fetch(
      `${CANDIDATE.supabase}/storage/v1/object/public/avatars/nonexistent-header-probe.png`,
      { redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    assert(
      asset.headers.get("x-content-type-options") === "nosniff" &&
        asset.headers.get("content-security-policy")?.includes("sandbox"),
      "Candidate public image response protections are missing",
    );
    await asset.body?.cancel();
    state.manifest.ingressInstalled = true;
    const receipt = {
      project: CANDIDATE.project,
      release: state.release,
      configSha256: digest(content),
      ports: [8547, 8548, 8549, 8550],
      checks,
      imageHeaderVerified: true,
      externalBrowserVerified: false,
      vpn443Changed: false,
    };
    writeJson(`${CANDIDATE.root}/ingress-receipt.json`, receipt);
    writeJson(manifestPath(), state.manifest);
    return receipt;
  } catch (error) {
    if (created) {
      assert(
        digest(readFileSync(target, "utf8")) === digest(content),
        "Candidate ingress changed during rollback; coordinate operator recovery",
      );
      unlinkSync(target);
      run("nginx", ["-t"]);
      run("systemctl", ["reload", "nginx"]);
    }
    throw error;
  }
}

export async function runCandidate(
  action: string,
  release?: string,
  redisImage?: string,
) {
  assert(
    process.geteuid?.() === 0,
    "Candidate operations require the deployment owner",
  );
  if (action === "launch") {
    requireCandidateQuarantine();
    assert(
      release && redisImage,
      "Launch requires exact release and installed Redis digest",
    );
    const steps: unknown[] = [
      await runCandidate("prepare", release, redisImage),
    ];
    for (const step of ["platform", "bootstrap", "build", "start", "seed"])
      steps.push(await runCandidate(step));
    return {
      project: CANDIDATE.project,
      release,
      steps,
      ingressInstalled: false,
      productionStateCopied: false,
    };
  }
  if (action === "prepare") {
    assert(
      release && redisImage,
      "Prepare requires exact release and Redis digest",
    );
    return prepareCandidate(release, redisImage);
  }
  assert(!release && !redisImage, "Only prepare accepts release/image options");
  const state = guard();
  if (action === "config")
    return {
      project: CANDIDATE.project,
      release: state.release,
      state: state.manifest.state,
      isolatedNetwork: true,
      productionStateCopied: false,
      loopbackPorts: PORTS,
    };
  if (action === "platform") {
    assert(
      ["prepared", "platform"].includes(state.manifest.state),
      "Platform initialization is only for a fresh candidate",
    );
    noApplications();
    compose(
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        "180",
        ...PLATFORM,
      ],
      300_000,
    );
    databaseGuard(state.manifest.platformImages.db!);
    state.manifest.state = "platform";
  } else if (action === "bootstrap") {
    assert(
      state.manifest.state === "platform",
      "Candidate platform must finish its own real migrations first",
    );
    noApplications();
    databaseGuard(state.manifest.platformImages.db!);
    assert(
      psql(
        "SELECT (NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agsaas_app') AND NOT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public') AND NOT EXISTS(SELECT 1 FROM auth.users) AND NOT EXISTS(SELECT 1 FROM storage.objects))::text;",
      ) === "true",
      "Bootstrap requires empty fresh Auth, Storage and application state",
    );
    compose(
      [
        "stop",
        "--timeout",
        "30",
        "auth",
        "rest",
        "storage",
        "realtime",
        "functions",
        "api-gw",
      ],
      240_000,
    );
    const baseline = tracked(
      `packages/db/self-hosted/supabase/migrations/${BASELINE_NAME}`,
    );
    const folder = "packages/db/self-hosted/upgrades/supabase/migrations";
    const upgrades = migrationChain(
      readdirSync(`${CANDIDATE.source}/${folder}`)
        .filter((name) => name.endsWith(".sql"))
        .map((filename) => ({
          filename,
          sql: tracked(`${folder}/${filename}`),
        })),
    );
    const provision = provisioningSql(state.password),
      installation = freshInstallSql(
        provision,
        baseline,
        state.release,
        upgrades,
      );
    psql(
      verificationSql(
        `${provision}\n${baseline}`,
        tracked("packages/db/self-hosted/verify.sql"),
      ),
    );
    psql(`BEGIN;\n${installation}\nROLLBACK;`);
    psql(installation, true);
    state.manifest.state = "bootstrapped";
    state.manifest.baselineSha256 = digest(baseline);
    state.manifest.migrations = upgrades.map((m) => ({
      filename: m.filename,
      sha256: m.sha256,
    }));
    writeJson(manifestPath(), state.manifest);
    compose(
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        "180",
        ...PLATFORM,
      ],
      300_000,
    );
  } else if (action === "build") {
    requireCandidateQuarantine(state.manifest.builder);
    noApplications();
    assert(
      state.manifest.state === "bootstrapped",
      "Candidate database must be bootstrapped before building",
    );
    assert(
      state.manifest.builderMayBeActive === false,
      "Previous builder work has not been confirmed stopped",
    );
    boundedBuilder(state.manifest.builder);
    // The root adapter reads this receipt even if this CLI is killed. It stops
    // the exact recorded builder before giving back the shared heavy slot.
    state.manifest.builderMayBeActive = true;
    writeJson(manifestPath(), state.manifest);
    for (const service of APPS) {
      boundedBuilder(state.manifest.builder);
      compose(["build", "--builder", CANDIDATE_BUILDER, service], 1_800_000);
    }
  } else if (action === "start") {
    assert(
      state.manifest.state === "bootstrapped" ||
        state.manifest.state === "running",
      "Apply the full candidate migration chain before publication",
    );
    for (const service of APPS) {
      const info = JSON.parse(
        docker(["image", "inspect", state.config.services[service]!.image]),
      )[0];
      assert(
        info.Config.Labels?.["org.opencontainers.image.revision"] ===
          state.release &&
          info.Config.Labels?.["org.opencontainers.image.source"] ===
            "https://github.com/IMONsergey/agsaas",
        "Candidate application image provenance mismatch",
      );
    }
    compose(
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        "180",
      ],
      300_000,
    );
    state.manifest.state = "running";
  } else if (action === "seed") {
    assert(
      state.manifest.state === "running",
      "Start the complete isolated candidate before seeding",
    );
    databaseGuard(state.manifest.platformImages.db!);
    return seed(state.env);
  } else if (action === "ingress") {
    return installCandidateIngress(state);
  } else if (action === "stop") {
    compose(["stop", "--timeout", "60"], 360_000);
    return {
      project: CANDIDATE.project,
      release: state.release,
      stopped: true,
      volumesRetained: true,
    };
  } else if (action === "status") {
    const ids = docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${CANDIDATE.project}`,
    ])
      .split(/\s+/)
      .filter(Boolean);
    const containers = ids.length
      ? JSON.parse(docker(["inspect", ...ids])).map(
          (item: {
            Id: string;
            Image: string;
            Config: { Labels: Record<string, string> };
            State: { Running: boolean; Health?: { Status: string } };
          }) => ({
            id: item.Id,
            image: item.Image,
            service: item.Config.Labels["com.docker.compose.service"],
            running: item.State.Running,
            health: item.State.Health?.Status ?? "none",
          }),
        )
      : [];
    return {
      project: CANDIDATE.project,
      release: state.release,
      state: state.manifest.state,
      containers,
      productionStateCopied: false,
      externalProvidersEnabled: false,
    };
  } else
    throw new CandidateError(
      "Use launch, prepare, config, platform, bootstrap, build, start, seed, ingress, status or stop",
    );
  writeJson(manifestPath(), state.manifest);
  return {
    project: CANDIDATE.project,
    release: state.release,
    action,
    state: state.manifest.state,
    productionStateCopied: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    assert(
      realpathSync(fileURLToPath(import.meta.url)) ===
        `${CANDIDATE.source}/scripts/self-hosted-candidate.mts`,
      "Execute the candidate helper from its own clean release checkout",
    );
    assert(
      process.argv.length === 3 || process.argv.length === 5,
      "Usage: node scripts/self-hosted-candidate.mts ACTION [EXACT_SHA REDIS_DIGEST]",
    );
    console.log(
      JSON.stringify(
        await runCandidate(process.argv[2]!, process.argv[3], process.argv[4]),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof CandidateError
        ? error.message
        : "Candidate operation failed; private details suppressed",
    );
    process.exitCode = 1;
  }
}
