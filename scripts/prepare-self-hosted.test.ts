import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertCleanVendorDocker,
  assertDigest,
  assertFreshRuntime,
  copyPublicPlatformSnapshot,
  installPublicOtpTemplate,
  type PrepareOptions,
  parseEnvironment,
  parseOptions,
  serializeEnvironment,
  validateGeneratedSecrets,
} from "./prepare-self-hosted.mts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const digest = "a".repeat(64);

function freshOptions(): PrepareOptions {
  const directory = mkdtempSync(
    join(tmpdir(), "agsaas-runtime-preparation-test-"),
  );
  temporaryDirectories.push(directory);
  for (const child of ["vendor", "source", "runtime"]) {
    mkdirSync(join(directory, child));
  }
  return {
    vendor: join(directory, "vendor"),
    source: join(directory, "source"),
    runtime: join(directory, "runtime", "supabase"),
    release: "b".repeat(40),
    redisImage: `redis@sha256:${digest}`,
    mailpitImage: `axllent/mailpit@sha256:${digest}`,
    caddyImage: `caddy@sha256:${digest}`,
  };
}

function gitFixtureCommand(vendor: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-C",
      vendor,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=AGSaaS fixture",
      "-c",
      "user.email=fixture@agsaas.invalid",
      ...args,
    ],
    {
      timeout: 5000,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  if (result.status !== 0)
    throw new Error("Unable to create local Git fixture");
}

function cleanVendorFixture(): string {
  const { vendor } = freshOptions();
  mkdirSync(join(vendor, "docker"));
  writeFileSync(
    join(vendor, "docker", ".gitignore"),
    ".env\nvolumes/db/data/\nvolumes/storage/\n",
  );
  writeFileSync(join(vendor, "docker", "docker-compose.yml"), "services: {}\n");
  gitFixtureCommand(vendor, "init", "--quiet");
  gitFixtureCommand(vendor, "add", "--", "docker");
  gitFixtureCommand(vendor, "commit", "--quiet", "-m", "Private test fixture");
  return vendor;
}

function generatedSecretsFixture(): Record<string, string> {
  return {
    POSTGRES_PASSWORD: "fixture-only-value",
    DASHBOARD_PASSWORD: "fixture-only-value",
    JWT_SECRET: "fixture-only-value",
    SECRET_KEY_BASE: "fixture-only-value",
    REALTIME_DB_ENC_KEY: "fixture-only-value",
    VAULT_ENC_KEY: "fixture-only-value",
    PG_META_CRYPTO_KEY: "fixture-only-value",
    ANON_KEY: "fixture-only-value",
    SERVICE_ROLE_KEY: "fixture-only-value",
    ANON_KEY_ASYMMETRIC: "fixture-only-value",
    SERVICE_ROLE_KEY_ASYMMETRIC: "fixture-only-value",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    JWT_KEYS: JSON.stringify([
      { kty: "EC", d: "private-fixture-value" },
      { kty: "oct", k: "legacy-fixture-value" },
    ]),
    JWT_JWKS: JSON.stringify({
      keys: [{ kty: "EC" }, { kty: "oct", k: "legacy-fixture-value" }],
    }),
  };
}

describe("private runtime configuration", () => {
  test("reads plain assignments and quoted paths without evaluating anything", () => {
    expect(
      parseEnvironment('# Comment\nHOST=db\nEMPTY=\nPATH="/auth/v1/verify"\n'),
    ).toEqual({ HOST: "db", EMPTY: "", PATH: "/auth/v1/verify" });
    expect(parseEnvironment("COMMAND=$(do-not-execute)\n").COMMAND).toBe(
      "$(do-not-execute)",
    );
  });

  test("round trips asymmetric key JSON and base64 padding", () => {
    const values = {
      JWT_KEYS: '[{"kty":"EC","d":"private-test-value"}]',
      JWT_JWKS: '{"keys":[{"kty":"EC","x":"public-test-value"}]}',
      KEY: "a-test-value==",
      SENDER: "AGSaaS private test mail",
    };
    expect(parseEnvironment(serializeEnvironment(values))).toEqual(values);
  });

  test("rejects duplicate keys, shell syntax and interpolation on output", () => {
    expect(() => parseEnvironment("A=one\nA=two")).toThrow("Duplicate");
    expect(() => parseEnvironment("export A=one")).toThrow("Unsupported");
    for (const value of [`\${OTHER_SECRET}`, "x\nINJECTED=y", " x ", "x\0y"]) {
      expect(() => serializeEnvironment({ SECRET: value })).toThrow("SECRET");
    }
  });

  test("requires a digest for the expected repository, never latest or a lookalike", () => {
    expect(() => assertDigest(`redis@sha256:${digest}`, "redis")).not.toThrow();
    for (const image of [
      "redis:latest",
      `evil/redis@sha256:${digest}`,
      "redis@sha256:abc",
    ]) {
      expect(() => assertDigest(image, "redis")).toThrow("resolved redis");
    }
  });

  test("accepts only an absent, isolated runtime directory", () => {
    const options = freshOptions();
    expect(() => assertFreshRuntime(options)).not.toThrow();
    mkdirSync(options.runtime);
    expect(() => assertFreshRuntime(options)).toThrow("refusing to overwrite");
  });

  test("refuses broad destinations, relative paths and source-tree runtimes", () => {
    const options = freshOptions();
    for (const runtime of [
      "/",
      "runtime/supabase",
      `${options.source}/runtime/supabase`,
    ]) {
      expect(() => assertFreshRuntime({ ...options, runtime })).toThrow();
    }
    expect(() => assertFreshRuntime({ ...options, release: "main" })).toThrow(
      "commit SHA",
    );
  });

  test("refuses a symlinked runtime parent", () => {
    const options = freshOptions();
    const alias = join(options.source, "alias");
    symlinkSync(join(options.vendor, "..", "runtime"), alias);
    expect(() =>
      assertFreshRuntime({ ...options, runtime: `${alias}/supabase` }),
    ).toThrow();
  });

  test("parses complete options and refuses ambiguous arguments", () => {
    const options = freshOptions();
    const args = [
      "--vendor",
      options.vendor,
      "--runtime",
      options.runtime,
      "--source",
      options.source,
      "--release",
      options.release,
      "--redis-image",
      options.redisImage,
      "--mailpit-image",
      options.mailpitImage,
      "--caddy-image",
      options.caddyImage,
    ];
    expect(parseOptions(args)).toEqual(options);
    expect(() => parseOptions([...args, "--runtime", options.runtime])).toThrow(
      "duplicate",
    );
    expect(() => parseOptions(args.slice(0, -2))).toThrow("Provide");
    expect(() => parseOptions(["--unknown", "x"])).toThrow("unsupported");
  });

  test("secret validation reports names, not supplied secret values", () => {
    expect(() =>
      validateGeneratedSecrets({ POSTGRES_PASSWORD: "your-private-value" }),
    ).toThrow("Generated configuration is missing POSTGRES_PASSWORD");
    try {
      validateGeneratedSecrets({ POSTGRES_PASSWORD: "your-private-value" });
    } catch (error) {
      expect(String(error)).not.toContain("your-private-value");
    }
  });
});

describe("fresh Supabase Docker source", () => {
  test("accepts a clean tracked Docker tree without inspecting unrelated files", () => {
    const vendor = cleanVendorFixture();
    writeFileSync(join(vendor, "unrelated-local-note"), "outside Docker tree");
    expect(() => assertCleanVendorDocker(vendor)).not.toThrow();
  });

  test.each([
    { kind: "ignored credentials", file: ".env" },
    { kind: "ignored database contents", file: "volumes/db/data/PG_VERSION" },
    { kind: "ignored object storage", file: "volumes/storage/object-fixture" },
    { kind: "untracked files", file: "untracked-fixture.txt" },
    { kind: "modified tracked files", file: "docker-compose.yml" },
  ])("rejects $kind before copying a supposedly fresh snapshot", ({ file }) => {
    const vendor = cleanVendorFixture();
    const target = join(vendor, "docker", file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "SYNTHETIC_PRIVATE_VALUE");
    expect(() => assertCleanVendorDocker(vendor)).toThrow(
      "Supabase Docker source must not contain modified, untracked, or ignored content",
    );
    try {
      assertCleanVendorDocker(vendor);
    } catch (error) {
      expect(String(error)).not.toContain(vendor);
      expect(String(error)).not.toContain(file);
      expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    }
  });
});

describe("public upstream snapshot permissions", () => {
  test.each([
    { label: "normal source modes", restrictiveSource: false },
    {
      label: "a clean Git clone with 0600/0700 source modes",
      restrictiveSource: true,
    },
  ])("normalizes public files from Git metadata with $label", ({
    restrictiveSource,
  }) => {
    const vendor = cleanVendorFixture();
    const runtime = join(vendor, "..", "runtime", "supabase");
    const docker = join(vendor, "docker");
    const directories = [
      "",
      "volumes",
      "volumes/db",
      "volumes/pooler",
      "volumes/api",
      "volumes/api/envoy",
    ];
    for (const directory of directories) {
      const target = join(docker, directory);
      mkdirSync(target, { recursive: true });
      chmodSync(target, 0o755);
    }
    const files = [
      { path: "volumes/db/roles.sql", mode: 0o644 },
      { path: "volumes/db/realtime.sql", mode: 0o644 },
      { path: "volumes/db/_supabase.sql", mode: 0o644 },
      { path: "volumes/pooler/pooler.exs", mode: 0o644 },
      { path: "volumes/api/envoy/docker-entrypoint.sh", mode: 0o755 },
    ];
    for (const file of files) {
      writeFileSync(join(docker, file.path), "public fixture\n");
      chmodSync(join(docker, file.path), file.mode);
    }
    gitFixtureCommand(vendor, "add", "--", "docker");
    gitFixtureCommand(
      vendor,
      "commit",
      "--quiet",
      "-m",
      "Public asset fixture",
    );
    if (restrictiveSource) {
      for (const directory of directories) {
        chmodSync(join(docker, directory), 0o700);
      }
      for (const file of files) {
        chmodSync(join(docker, file.path), file.mode === 0o755 ? 0o700 : 0o600);
      }
    }
    // Git tracks executable bits, not group/other readability: this is still clean.
    expect(() => assertCleanVendorDocker(vendor)).not.toThrow();
    const originalMask = process.umask(0o077);
    try {
      copyPublicPlatformSnapshot(vendor, runtime);
      expect(process.umask()).toBe(0o077);
      for (const directory of directories) {
        expect(statSync(join(runtime, directory)).mode & 0o777).toBe(
          directory ? 0o755 : 0o750,
        );
      }
      for (const file of files) {
        expect(statSync(join(runtime, file.path)).mode & 0o777).toBe(file.mode);
        expect(readFileSync(join(runtime, file.path), "utf8")).toBe(
          "public fixture\n",
        );
        expect(statSync(join(docker, file.path)).mode & 0o777).toBe(
          restrictiveSource ? (file.mode === 0o755 ? 0o700 : 0o600) : file.mode,
        );
      }
      // Subsequent generated private files must not inherit the temporary 0022.
      writeFileSync(join(runtime, ".env"), "FIXTURE_ONLY=value\n");
      expect(statSync(join(runtime, ".env")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(originalMask);
    }
  });

  test("restores the original private mask if copying fails", () => {
    const vendor = cleanVendorFixture();
    const runtime = join(vendor, "..", "runtime", "supabase");
    mkdirSync(runtime);
    const privateFile = join(runtime, ".env");
    writeFileSync(privateFile, "EXISTING_PRIVATE_FIXTURE=value\n", {
      mode: 0o600,
    });
    const originalMask = process.umask(0o077);
    try {
      expect(() => copyPublicPlatformSnapshot(vendor, runtime)).toThrow();
      expect(process.umask()).toBe(0o077);
      expect(statSync(privateFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(privateFile, "utf8")).toBe(
        "EXISTING_PRIVATE_FIXTURE=value\n",
      );
    } finally {
      process.umask(originalMask);
    }
  });

  test("copies only index-listed public files, not ignored private files", () => {
    const vendor = cleanVendorFixture();
    const runtime = join(vendor, "..", "runtime", "supabase");
    const privateFile = join(vendor, "docker", ".env");
    writeFileSync(privateFile, "SYNTHETIC_PRIVATE_FIXTURE=value\n", {
      mode: 0o600,
    });
    // The full preparer rejects this source earlier. The copy helper additionally
    // cannot copy untracked secret contents even when called independently.
    expect(() => assertCleanVendorDocker(vendor)).toThrow();
    copyPublicPlatformSnapshot(vendor, runtime);
    expect(existsSync(join(runtime, ".env"))).toBe(false);
    expect(statSync(privateFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(privateFile, "utf8")).toBe(
      "SYNTHETIC_PRIVATE_FIXTURE=value\n",
    );
  });

  test("rejects tracked symlinks before creating a runtime", () => {
    const vendor = cleanVendorFixture();
    const runtime = join(vendor, "..", "runtime", "supabase");
    symlinkSync("docker-compose.yml", join(vendor, "docker", "public-link"));
    gitFixtureCommand(vendor, "add", "--", "docker");
    gitFixtureCommand(
      vendor,
      "commit",
      "--quiet",
      "-m",
      "Unsupported symlink fixture",
    );
    expect(() => copyPublicPlatformSnapshot(vendor, runtime)).toThrow(
      "Unsupported entry in the public Supabase Docker snapshot",
    );
    expect(existsSync(runtime)).toBe(false);
  });
});

describe("public OTP template permissions", () => {
  test("makes only template assets readable across UIDs under a private umask", () => {
    const { source, runtime } = freshOptions();
    const sourceTemplates = join(source, "deploy", "self-hosted", "templates");
    mkdirSync(sourceTemplates, { recursive: true });
    const templateHtml = "<p>{{ .Token }}</p>\n";
    writeFileSync(join(sourceTemplates, "otp.html"), templateHtml, {
      mode: 0o600,
    });
    mkdirSync(runtime);
    writeFileSync(join(runtime, ".env"), "FIXTURE_ONLY=value\n", {
      mode: 0o600,
    });
    const previousMask = process.umask(0o077);
    try {
      installPublicOtpTemplate(source, runtime);
      const targetDirectory = join(runtime, "volumes", "templates");
      expect(statSync(targetDirectory).mode & 0o777).toBe(0o755);
      expect(statSync(join(targetDirectory, "otp.html")).mode & 0o777).toBe(
        0o644,
      );
      expect(readFileSync(join(targetDirectory, "otp.html"), "utf8")).toBe(
        templateHtml,
      );
      expect(statSync(join(runtime, ".env")).mode & 0o777).toBe(0o600);
      expect(process.umask()).toBe(0o077);
    } finally {
      process.umask(previousMask);
    }
  });

  test("does not overwrite an existing template", () => {
    const { source, runtime } = freshOptions();
    const sourceTemplates = join(source, "deploy", "self-hosted", "templates");
    mkdirSync(sourceTemplates, { recursive: true });
    writeFileSync(join(sourceTemplates, "otp.html"), "new fixture");
    const targetDirectory = join(runtime, "volumes", "templates");
    mkdirSync(targetDirectory, { recursive: true });
    const target = join(targetDirectory, "otp.html");
    writeFileSync(target, "existing fixture", { mode: 0o600 });
    expect(() => installPublicOtpTemplate(source, runtime)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("existing fixture");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("generated key JSON redaction", () => {
  test("accepts the upstream array/object shape including the legacy HS256 key", () => {
    expect(() =>
      validateGeneratedSecrets(generatedSecretsFixture()),
    ).not.toThrow();
  });

  test.each([
    { name: "JWT_KEYS", value: "PRIVATEVALUE" },
    { name: "JWT_KEYS", value: '[{"kty":"EC","d":"PRIVATEVALUE"},BROKEN]' },
    { name: "JWT_JWKS", value: "PRIVATEVALUE" },
    {
      name: "JWT_JWKS",
      value: '{"keys":[{"kty":"oct","k":"PRIVATEVALUE"},BROKEN]}',
    },
  ])("redacts malformed $name, including private value fragments", ({
    name,
    value,
  }) => {
    let failure: unknown;
    try {
      validateGeneratedSecrets({ ...generatedSecretsFixture(), [name]: value });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toBe(`Invalid generated ${name} configuration`);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain("PRIVATE");
    expect(error.stack).not.toContain("PRIVATE");
  });

  test.each([
    { name: "JWT_KEYS", value: "null" },
    { name: "JWT_KEYS", value: "{}" },
    { name: "JWT_KEYS", value: "[null]" },
    { name: "JWT_KEYS", value: "[]" },
    { name: "JWT_KEYS", value: '[{"kty":"EC","d":false}]' },
    { name: "JWT_KEYS", value: '[{"kty":"EC","d":""}]' },
    { name: "JWT_JWKS", value: "null" },
    { name: "JWT_JWKS", value: "[]" },
    { name: "JWT_JWKS", value: "{}" },
    { name: "JWT_JWKS", value: '{"keys":null}' },
    { name: "JWT_JWKS", value: '{"keys":{}}' },
    { name: "JWT_JWKS", value: '{"keys":[null]}' },
    { name: "JWT_JWKS", value: '{"keys":[]}' },
    {
      name: "JWT_JWKS",
      value: '{"keys":[{"kty":"EC","d":"private-fixture-value"}]}',
    },
  ])("rejects invalid $name shapes with a field-only error", ({
    name,
    value,
  }) => {
    expect(() =>
      validateGeneratedSecrets({ ...generatedSecretsFixture(), [name]: value }),
    ).toThrow(`Invalid generated ${name} configuration`);
  });
});
