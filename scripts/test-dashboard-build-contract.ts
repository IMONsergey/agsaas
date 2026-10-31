import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const hashedBuildInputs = [
  "GIT_COMMIT_SHA",
  "SENTRY_RELEASE",
  "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
] as const;

const publicBuildInput = "NEXT_PUBLIC_API_URL";
const undeclaredInput = "DASHBOARD_BUILD_CONTRACT_UNDECLARED";
type BuildInput = (typeof hashedBuildInputs)[number] | typeof publicBuildInput;
type Environment = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;

export class BuildContractError extends Error {}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function variableNames(value: unknown): Set<string> {
  return new Set(strings(value).map((entry) => entry.split("=", 1)[0]!));
}

/** Do not inherit credentials, proxy settings, preloads, or Turbo overrides. */
export function buildContractEnvironment(source: Environment): Environment {
  const env: Environment = {
    CI: "true",
    NODE_ENV: "production",
    TURBO_TELEMETRY_DISABLED: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    GIT_COMMIT_SHA: "dashboard-contract-baseline",
    SENTRY_RELEASE: "dashboard-contract-baseline",
    // Synthetic input for a dry run only. No application is built with this key.
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    NEXT_PUBLIC_API_URL: "https://dashboard-contract.invalid",
    [undeclaredInput]: "must-not-reach-the-build",
  };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** Inspect names and task hashes only; never include a dry-run payload in errors. */
export function inspectDashboardBuildReport(raw: string): { hash: string } {
  let report: JsonObject | undefined;
  try {
    report = object(JSON.parse(raw));
  } catch {
    throw new BuildContractError(
      "Turbo did not return a valid dry-run report.",
    );
  }
  const tasks = report?.tasks;
  const task = Array.isArray(tasks)
    ? tasks
        .map(object)
        .find((item) => item?.taskId === "@midday/dashboard#build")
    : undefined;
  if (!task || report?.envMode !== "strict" || task.envMode !== "strict") {
    throw new BuildContractError(
      "Dashboard build must exist and use strict environment mode.",
    );
  }
  if (task.framework !== "nextjs") {
    throw new BuildContractError(
      "Dashboard must retain Next.js framework environment inference.",
    );
  }
  const definition = object(task.resolvedTaskDefinition);
  if (!strings(definition?.outputs).includes(".next/**")) {
    throw new BuildContractError(
      "Dashboard build must retain its .next output cache contract.",
    );
  }
  // Turbo resolves $TURBO_DEFAULT$ into task.inputs and removes the token from
  // resolvedTaskDefinition.inputs. Inspect real source hashes, not that token.
  const inputs = object(task.inputs);
  if (
    !strings(definition?.inputs).includes(".env") ||
    ["package.json", "next.config.ts", "src/app/[locale]/layout.tsx"].some(
      (name) => typeof inputs?.[name] !== "string",
    )
  ) {
    throw new BuildContractError(
      "Dashboard build must retain its default source inputs.",
    );
  }
  if (!strings(definition?.dependsOn).includes("^build")) {
    throw new BuildContractError(
      "Dashboard build must retain its workspace build dependencies.",
    );
  }
  const variables = object(task.environmentVariables);
  const configured = variableNames(variables?.configured);
  const inferred = variableNames(variables?.inferred);
  const passthrough = variableNames(variables?.passthrough);
  const globalVariables = object(
    object(report?.globalCacheInputs)?.environmentVariables,
  );
  for (const name of hashedBuildInputs) {
    if (!configured.has(name)) {
      throw new BuildContractError(
        `${name} must be a hashed build input, not only passthrough.`,
      );
    }
  }
  if (!configured.has(publicBuildInput) && !inferred.has(publicBuildInput)) {
    throw new BuildContractError(
      `${publicBuildInput} must be forwarded and hashed.`,
    );
  }
  if (
    [
      configured,
      inferred,
      passthrough,
      variableNames(globalVariables?.configured),
      variableNames(globalVariables?.inferred),
      variableNames(globalVariables?.passthrough),
    ].some((names) => names.has(undeclaredInput))
  ) {
    throw new BuildContractError(
      "An undeclared environment variable reached the dashboard build.",
    );
  }
  if (typeof task.hash !== "string" || !/^[a-f\d]{16,}$/i.test(task.hash)) {
    throw new BuildContractError(
      "Turbo did not provide a valid dashboard build hash.",
    );
  }
  return { hash: task.hash };
}

export function assertBuildInputChangesHash(
  name: BuildInput,
  baseline: string,
  changed: string,
) {
  if (baseline === changed) {
    throw new BuildContractError(
      `${name} changed without invalidating the dashboard build cache.`,
    );
  }
}

function installedTurboBinary(root: string): string {
  // Resolve an already-installed binary directly. The JS launcher may download a
  // missing optional dependency, which is not appropriate for an offline check.
  const require = createRequire(`${root}/package.json`);
  let turboRequire: NodeJS.Require;
  try {
    turboRequire = createRequire(require.resolve("turbo/package.json"));
  } catch {
    throw new BuildContractError(
      "Install the pinned workspace dependencies before this check.",
    );
  }
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "64" : process.arch;
  const extension = process.platform === "win32" ? ".exe" : "";
  for (const prefix of ["@turbo/", "turbo-"]) {
    try {
      return turboRequire.resolve(
        `${prefix}${platform}-${arch}/bin/turbo${extension}`,
      );
    } catch {
      // Support both names used by the pinned Turbo release's native packages.
    }
  }
  throw new BuildContractError(
    "The installed Turbo binary for this platform is missing; no download was attempted.",
  );
}

export function verifyDashboardBuildContract(root: string) {
  const binary = installedTurboBinary(root);
  const baselineEnv = buildContractEnvironment(process.env);
  const run = (env: Environment) => {
    let result: ReturnType<typeof Bun.spawnSync>;
    try {
      result = Bun.spawnSync({
        cmd: [
          binary,
          "run",
          "build",
          "--filter=@midday/dashboard",
          "--only",
          "--dry=json",
          "--no-daemon",
          "--cache=local:rw",
        ],
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      throw new BuildContractError(
        "The offline Turbo dry run could not be started.",
      );
    }
    if (!result.success || !result.stdout) {
      // Turbo diagnostics can contain environment values. Do not forward them.
      throw new BuildContractError(
        "The offline Turbo dry run failed; no build was executed.",
      );
    }
    return inspectDashboardBuildReport(result.stdout.toString()).hash;
  };
  const baseline = run(baselineEnv);
  const variants: Record<BuildInput, string> = {
    GIT_COMMIT_SHA: "dashboard-contract-changed",
    SENTRY_RELEASE: "dashboard-contract-changed",
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    NEXT_PUBLIC_API_URL: "https://dashboard-contract-changed.invalid",
  };
  for (const name of [...hashedBuildInputs, publicBuildInput] as const) {
    assertBuildInputChangesHash(
      name,
      baseline,
      run({ ...baselineEnv, [name]: variants[name] }),
    );
  }
  if (run(baselineEnv) !== baseline) {
    throw new BuildContractError(
      "The baseline build hash changed during verification; retry with a stable working tree.",
    );
  }
}

if (import.meta.main) {
  try {
    verifyDashboardBuildContract(
      dirname(dirname(fileURLToPath(import.meta.url))),
    );
    console.log(
      "Dashboard build contract passed: strict environment, source/output/dependency contracts, and four cache-invalidating inputs (six dry runs, no application build).",
    );
  } catch (error) {
    console.error(
      error instanceof BuildContractError
        ? error.message
        : "Dashboard build contract verification failed.",
    );
    process.exitCode = 1;
  }
}
