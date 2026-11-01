import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SUPABASE_RELEASE = "self-hosted/v0.8.3";
export const SUPABASE_COMMIT = "bc27d2661edd09a5d0b8d76ce33da6d4071a756e";

export type PrepareOptions = {
  vendor: string;
  runtime: string;
  source: string;
  release: string;
  redisImage: string;
  mailpitImage: string;
  caddyImage: string;
};

/** Only simple dotenv assignments are supported; never evaluate an env file. */
export function parseEnvironment(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("Unsupported environment file syntax");
    const name = match[1]!;
    if (Object.hasOwn(values, name)) {
      throw new Error(`Duplicate environment variable: ${name}`);
    }
    let value = match[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

export function serializeEnvironment(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([name, value]) => {
      if (
        !/^[A-Z][A-Z0-9_]*$/.test(name) ||
        /[\r\n\0$]/.test(value) ||
        value !== value.trim()
      ) {
        throw new Error(`Unsupported environment value for ${name}`);
      }
      return `${name}=${value}`;
    })
    .join("\n")}\n`;
}

export function assertDigest(image: string, repository: string): void {
  if (!new RegExp(`^${repository}@sha256:[a-f0-9]{64}$`).test(image)) {
    throw new Error(`A resolved ${repository} image digest is required`);
  }
}

export function assertFreshRuntime(options: PrepareOptions): void {
  for (const name of ["vendor", "runtime", "source"] as const) {
    if (
      !isAbsolute(options[name]) ||
      options[name] !== resolve(options[name])
    ) {
      throw new Error(`${name} must be a normalized absolute path`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(options.release)) {
    throw new Error("A full application commit SHA is required");
  }
  assertDigest(options.redisImage, "redis");
  assertDigest(options.mailpitImage, "axllent/mailpit");
  assertDigest(options.caddyImage, "caddy");
  if (
    !options.runtime.endsWith("/runtime/supabase") ||
    options.runtime.startsWith(`${options.vendor}/`) ||
    options.runtime.startsWith(`${options.source}/`)
  ) {
    throw new Error(
      "Use a separate deployment directory ending in /runtime/supabase",
    );
  }
  if (existsSync(options.runtime)) {
    throw new Error(
      "Runtime already exists; refusing to overwrite data or rotate keys",
    );
  }
  const parent = dirname(options.runtime);
  if (!existsSync(parent) || realpathSync(parent) !== parent) {
    throw new Error(
      "Runtime parent must already exist and must not be a symlink",
    );
  }
  for (const directory of [options.vendor, options.source]) {
    if (
      !lstatSync(directory).isDirectory() ||
      realpathSync(directory) !== directory
    ) {
      throw new Error(
        "Source directories must be real directories, not symlinks",
      );
    }
  }
}

function gitValue(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("Unable to verify source revision");
  return result.stdout.trim();
}

export function assertCleanVendorDocker(vendor: string): void {
  // cpSync includes ignored files too. A previously started upstream checkout
  // can contain .env, object files, or an entire database while Git looks clean.
  if (
    gitValue(
      vendor,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored",
      "--",
      "docker",
    )
  ) {
    // Never include Git output: filenames themselves can contain sensitive data.
    throw new Error(
      "Supabase Docker source must not contain modified, untracked, or ignored content",
    );
  }
}

function runKeyGenerator(runtime: string, script: string): void {
  // Upstream generators print private keys. Never forward either output stream.
  const result = spawnSync("sh", [script, "--update-env"], {
    cwd: runtime,
    timeout: 30_000,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(
      `Key generation failed: ${script}; runtime was retained for inspection`,
    );
  }
}

function parseGeneratedKeyJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Native JSON errors may quote the input, which can contain private keys.
    // Do not retain a cause or forward the original error to the CLI/logger.
    throw new Error(`Invalid generated ${name} configuration`);
  }
}

function isKeyObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateGeneratedSecrets(values: Record<string, string>): void {
  const expected = [
    "POSTGRES_PASSWORD",
    "DASHBOARD_PASSWORD",
    "JWT_SECRET",
    "SECRET_KEY_BASE",
    "REALTIME_DB_ENC_KEY",
    "VAULT_ENC_KEY",
    "PG_META_CRYPTO_KEY",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "ANON_KEY_ASYMMETRIC",
    "SERVICE_ROLE_KEY_ASYMMETRIC",
    "JWT_KEYS",
    "JWT_JWKS",
  ];
  for (const name of expected) {
    if (!values[name] || /your-|insecure|supabaserealtime/.test(values[name])) {
      throw new Error(`Generated configuration is missing ${name}`);
    }
  }
  if (!/^sb_publishable_/.test(values.SUPABASE_PUBLISHABLE_KEY ?? "")) {
    throw new Error("A generated publishable key is required");
  }
  if (!/^sb_secret_/.test(values.SUPABASE_SECRET_KEY ?? "")) {
    throw new Error("A generated server secret key is required");
  }
  const signing = parseGeneratedKeyJson(values.JWT_KEYS!, "JWT_KEYS");
  if (
    !Array.isArray(signing) ||
    !signing.every(isKeyObject) ||
    !signing.some(
      (key) =>
        key.kty === "EC" && typeof key.d === "string" && key.d.length > 0,
    )
  ) {
    throw new Error("Invalid generated JWT_KEYS configuration");
  }
  const verification = parseGeneratedKeyJson(values.JWT_JWKS!, "JWT_JWKS");
  if (
    !isKeyObject(verification) ||
    !Array.isArray(verification.keys) ||
    !verification.keys.every(isKeyObject) ||
    !verification.keys.some((key) => key.kty === "EC") ||
    verification.keys.some((key) => Object.hasOwn(key, "d"))
  ) {
    throw new Error("Invalid generated JWT_JWKS configuration");
  }
}

export function installPublicOtpTemplate(
  source: string,
  runtime: string,
): void {
  const templateDirectory = join(runtime, "volumes", "templates");
  const templateFile = join(templateDirectory, "otp.html");
  mkdirSync(templateDirectory, { recursive: true });
  copyFileSync(
    join(source, "deploy", "self-hosted", "templates", "otp.html"),
    templateFile,
    constants.COPYFILE_EXCL,
  );
  // These are public template assets, not rendered OTP mail or credentials.
  // The restricted Caddy container may have a different UID and has no DAC bypass.
  // Explicit chmod is needed because preparation uses a private 0077 umask.
  chmodSync(templateDirectory, 0o755);
  chmodSync(templateFile, 0o644);
}

export function copyPublicPlatformSnapshot(
  vendor: string,
  runtime: string,
): void {
  // Called only after validating the pinned, clean source tree (including ignored
  // content). These upstream SQL/config/scripts are public, not generated secrets.
  // A clone created under 0077 can itself have 0600/0700 modes even when Git is
  // clean. Filesystem modes are therefore NOT the source of truth for this copy.
  const records = gitValue(vendor, "ls-files", "--stage", "-z", "--", "docker")
    .split("\0")
    .filter(Boolean);
  if (records.length === 0) {
    throw new Error("The public Supabase Docker snapshot is empty");
  }
  const files = records.map((record) => {
    const match = /^(100644|100755) [a-f0-9]+ 0\tdocker\/(.+)$/s.exec(record);
    if (
      !match ||
      match[2]!
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    ) {
      // The reviewed snapshot has only regular files: never dereference a
      // symlink/submodule or broaden modes based on arbitrary filesystem entries.
      throw new Error(
        "Unsupported entry in the public Supabase Docker snapshot",
      );
    }
    return { path: match[2]!, mode: match[1] === "100755" ? 0o755 : 0o644 };
  });
  const previousMask = process.umask(0o022);
  try {
    // Atomically reserve a new target; never merge into an existing runtime.
    mkdirSync(runtime, { mode: 0o750 });
    chmodSync(runtime, 0o750);
    for (const file of files) {
      const destination = join(runtime, file.path);
      // New public directories are 0755 regardless of the clone's 0700 modes.
      mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      copyFileSync(
        join(vendor, "docker", file.path),
        destination,
        constants.COPYFILE_EXCL,
      );
      // Normalize ONLY tracked public files; private .env/keys are created later.
      chmodSync(destination, file.mode);
    }
  } finally {
    // In preparation the caller's mask is 0077: restore before generating keys.
    process.umask(previousMask);
  }
}

export function prepareFreshRuntime(options: PrepareOptions) {
  assertFreshRuntime(options);
  if (gitValue(options.vendor, "rev-parse", "HEAD") !== SUPABASE_COMMIT) {
    throw new Error("Supabase source does not match the reviewed release");
  }
  assertCleanVendorDocker(options.vendor);
  if (gitValue(options.source, "rev-parse", "HEAD") !== options.release) {
    throw new Error("Application source revision does not match the release");
  }

  const previousMask = process.umask(0o077);
  try {
    copyPublicPlatformSnapshot(options.vendor, options.runtime);
    copyFileSync(
      join(options.runtime, ".env.example"),
      join(options.runtime, ".env"),
    );
    chmodSync(join(options.runtime, ".env"), 0o600);
    runKeyGenerator(options.runtime, "utils/generate-keys.sh");
    runKeyGenerator(options.runtime, "utils/add-new-auth-keys.sh");
    const values = parseEnvironment(
      readFileSync(join(options.runtime, ".env"), "utf8"),
    );
    validateGeneratedSecrets(values);

    const appPassword = randomBytes(32).toString("hex");
    Object.assign(values, {
      COMPOSE_FILE:
        "docker-compose.yml:platform.compose.yml:compose.mail-test.yml:compose.apps.yml",
      COMPOSE_PROJECT_NAME: "agsaas-stage",
      SUPABASE_PUBLIC_URL: "http://localhost:3800",
      API_EXTERNAL_URL: "http://localhost:3800/auth/v1",
      SITE_URL: "http://localhost:3300",
      ADDITIONAL_REDIRECT_URLS:
        "http://localhost:3300/api/auth/callback,http://localhost:3300/api/auth/password-recovery",
      API_GW_HTTP_PORT: "127.0.0.1:3800",
      DASHBOARD_USERNAME: "agsaas-admin",
      STUDIO_DEFAULT_ORGANIZATION: "AGSaaS",
      STUDIO_DEFAULT_PROJECT: "AGSaaS private staging",
      POOLER_TENANT_ID: "agsaas-stage",
      POOLER_DEFAULT_POOL_SIZE: "10",
      POOLER_MAX_CLIENT_CONN: "80",
      POOLER_DB_POOL_SIZE: "5",
      OPENAI_API_KEY: "",
      ENABLE_EMAIL_SIGNUP: "true",
      ENABLE_EMAIL_AUTOCONFIRM: "false",
      ENABLE_PHONE_SIGNUP: "false",
      ENABLE_PHONE_AUTOCONFIRM: "false",
      ENABLE_ANONYMOUS_USERS: "false",
      SMTP_HOST: "mailpit",
      SMTP_PORT: "1025",
      SMTP_USER: "",
      SMTP_PASS: "",
      SMTP_ADMIN_EMAIL: "no-reply@agsaas.localhost",
      SMTP_SENDER_NAME: "AGSaaS private test mail",
      GLOBAL_S3_BUCKET: "agsaas-stage",
      STORAGE_TENANT_ID: "agsaas-stage",
      REGION: "local",
      FUNCTIONS_VERIFY_JWT: "true",
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
      AGSAAS_SOURCE_DIR: options.source,
      AGSAAS_RELEASE: options.release,
      AGSAAS_DB_PASSWORD: appPassword,
      AGSAAS_DATABASE_URL: `postgresql://agsaas_app:${appPassword}@db:5432/postgres?sslmode=disable`,
      AGSAAS_WORKER_DATABASE_URL: `postgresql://agsaas_app.agsaas-stage:${appPassword}@supavisor:6543/postgres?sslmode=disable`,
      AGSAAS_REDIS_IMAGE: options.redisImage,
      AGSAAS_MAILPIT_IMAGE: options.mailpitImage,
      AGSAAS_CADDY_IMAGE: options.caddyImage,
      AGSAAS_DASHBOARD_URL: "http://localhost:3300",
      AGSAAS_API_URL: "http://localhost:3303",
      AGSAAS_WORKER_ENV: "staging",
      INSIGHTS_ENABLED: "false",
      NEW_USER_SIGNUP_CUTOFF: "",
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });
    for (const name of [
      "REDIS_CACHE_PASSWORD",
      "REDIS_QUEUE_PASSWORD",
      "INTERNAL_API_KEY",
      "FILE_KEY_SECRET",
      "INVOICE_JWT_SECRET",
      "MIDDAY_ENCRYPTION_KEY",
    ]) {
      values[name] = randomBytes(32).toString("hex");
    }
    writeFileSync(join(options.runtime, ".env"), serializeEnvironment(values), {
      mode: 0o600,
    });
    // Upstream uses .env.old during generation; retain it privately, never print it.
    if (existsSync(join(options.runtime, ".env.old"))) {
      chmodSync(join(options.runtime, ".env.old"), 0o600);
    }
    writeFileSync(
      join(options.runtime, ".supabase-version"),
      `ref=${SUPABASE_RELEASE}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    const manifest = {
      mode: "private-staging",
      createdAt: new Date().toISOString(),
      supabaseRelease: SUPABASE_RELEASE,
      supabaseCommit: SUPABASE_COMMIT,
      applicationCommit: options.release,
      redisImage: options.redisImage,
      mailpitImage: options.mailpitImage,
      caddyImage: options.caddyImage,
      publicAccessEnabled: false,
      externalEmailDeliveryEnabled: false,
    };
    writeFileSync(
      join(options.runtime, "deployment-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    installPublicOtpTemplate(options.source, options.runtime);
    return manifest;
  } finally {
    process.umask(previousMask);
  }
}

export function parseOptions(args: string[]): PrepareOptions {
  const names = {
    "--vendor": "vendor",
    "--runtime": "runtime",
    "--source": "source",
    "--release": "release",
    "--redis-image": "redisImage",
    "--mailpit-image": "mailpitImage",
    "--caddy-image": "caddyImage",
  } as const;
  const parsed: Partial<PrepareOptions> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as keyof typeof names;
    const key = names[flag];
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--") || parsed[key]) {
      throw new Error("Missing, duplicate, or unsupported deployment option");
    }
    parsed[key] = value;
  }
  if (Object.values(names).some((key) => !parsed[key])) {
    throw new Error(
      "Provide vendor, runtime, source, release and three resolved image digests",
    );
  }
  return parsed as PrepareOptions;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes("--help")) {
    console.log(
      "Prepare a NEW private AGSaaS runtime; never overwrites or starts services.",
    );
    console.log(
      "Options: --vendor --runtime --source --release --redis-image --mailpit-image --caddy-image",
    );
  } else {
    try {
      console.log(
        JSON.stringify(
          prepareFreshRuntime(parseOptions(process.argv.slice(2))),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Runtime preparation failed",
      );
      process.exitCode = 1;
    }
  }
}
