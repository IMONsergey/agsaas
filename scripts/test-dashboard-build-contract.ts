import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const hashedBuildInputs = [
  "GIT_COMMIT_SHA",
  "SENTRY_RELEASE",
  "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
  "DASHBOARD_URL",
  "NEXT_PUBLIC_URL",
] as const;

const publicBuildInput = "NEXT_PUBLIC_API_URL";
const undeclaredInput = "DASHBOARD_BUILD_CONTRACT_UNDECLARED";
export const browserAssetManifest = "src/utils/pdf-public-assets.json";
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
    DASHBOARD_URL: "https://dashboard-contract.invalid",
    NEXT_PUBLIC_URL: "https://dashboard-contract.invalid",
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
  if (!strings(definition?.outputs).includes("public/vendor/pdfjs/**")) {
    throw new BuildContractError(
      "Dashboard build must cache its prepared public/vendor/pdfjs/** assets.",
    );
  }
  // Turbo resolves $TURBO_DEFAULT$ into task.inputs and removes the token from
  // resolvedTaskDefinition.inputs. Inspect real source hashes, not that token.
  const inputs = object(task.inputs);
  if (
    !strings(definition?.inputs).includes(".env") ||
    [
      "package.json",
      "next.config.ts",
      "src/app/[locale]/layout.tsx",
      "scripts/prepare-browser-assets.mjs",
      browserAssetManifest,
    ].some((name) => typeof inputs?.[name] !== "string")
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

export function inspectDashboardAssetPreparation(scripts: unknown) {
  const commands = object(scripts);
  for (const name of ["build", "dev"] as const) {
    const command = commands?.[name];
    if (
      typeof command !== "string" ||
      !command.startsWith("node scripts/prepare-browser-assets.mjs && ") ||
      !command.includes(`next ${name}`)
    ) {
      throw new BuildContractError(
        "Dashboard build/dev must prepare owned PDF.js assets before Next.js.",
      );
    }
  }
}

function digest(path: string): string {
  if (!lstatSync(path).isFile()) {
    throw new BuildContractError("PDF.js assets must be regular files.");
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assetHashes(directory: string, prefix = ""): Map<string, string> {
  if (!lstatSync(directory).isDirectory()) {
    throw new BuildContractError(
      "PDF.js asset directories must not be symlinks.",
    );
  }
  const result = new Map<string, string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, hash] of assetHashes(path, name))
        result.set(child, hash);
    } else {
      result.set(name, digest(path));
    }
  }
  return result;
}

function browserAssetInputs(root: string) {
  const dashboard = join(root, "apps/dashboard");
  const require = createRequire(join(dashboard, "package.json"));
  let pdfPackage: string;
  try {
    // This can differ from the workspace's direct pdfjs-dist dependency.
    const reactPdfRequire = createRequire(require.resolve("react-pdf"));
    pdfPackage = reactPdfRequire.resolve("pdfjs-dist/package.json");
  } catch {
    throw new BuildContractError(
      "React-PDF's installed PDF.js dependency is missing.",
    );
  }
  const version = object(JSON.parse(readFileSync(pdfPackage, "utf8")))?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new BuildContractError("The installed PDF.js version is invalid.");
  }
  const source = dirname(pdfPackage);
  const expected = new Map([
    ["pdf.worker.min.mjs", digest(join(source, "build/pdf.worker.min.mjs"))],
    ["LICENSE", digest(join(source, "LICENSE"))],
  ]);
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    const files = assetHashes(join(source, directory), directory);
    if (!files.size)
      throw new BuildContractError(
        "An installed PDF.js asset directory is empty.",
      );
    for (const [name, hash] of files) expected.set(name, hash);
  }
  const manifest = object(
    JSON.parse(readFileSync(join(dashboard, browserAssetManifest), "utf8")),
  );
  const files = strings(manifest?.files);
  const expectedNames = [...expected.keys()].sort();
  if (
    manifest?.version !== version ||
    files.length !== expectedNames.length ||
    files.some((name, index) => name !== expectedNames[index])
  ) {
    throw new BuildContractError(
      "The reviewed public PDF.js manifest does not match React-PDF's installed dependency.",
    );
  }
  return { dashboard, version, expected };
}

/** Verify every decoder/font/map byte, not only the worker receipt. */
export function verifyPreparedDashboardBrowserAssets(root: string) {
  const { dashboard, version, expected } = browserAssetInputs(root);
  const output = join(dashboard, "public/vendor/pdfjs", version);
  const actual = assetHashes(output);
  const receipt = object(
    JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")),
  );
  if (
    receipt?.kind !== "agsaas-own-pdf-assets-v1" ||
    receipt.version !== version ||
    receipt.workerSha256 !== expected.get("pdf.worker.min.mjs") ||
    receipt.publicBase !== `/vendor/pdfjs/${version}/` ||
    receipt.license !== "LICENSE"
  ) {
    throw new BuildContractError(
      "The prepared PDF.js receipt does not match its installed source.",
    );
  }
  actual.delete("receipt.json");
  if (
    actual.size !== expected.size ||
    [...expected].some(([name, hash]) => actual.get(name) !== hash)
  ) {
    throw new BuildContractError(
      "Prepared PDF.js assets are missing, unexpected or differ from the installed source.",
    );
  }
  return {
    version,
    assetFiles: expected.size,
    workerSha256: expected.get("pdf.worker.min.mjs")!,
  };
}

function prepareDashboardBrowserAssets(root: string) {
  const { dashboard } = browserAssetInputs(root);
  inspectDashboardAssetPreparation(
    object(JSON.parse(readFileSync(join(dashboard, "package.json"), "utf8")))
      ?.scripts,
  );
  const script = join(dashboard, "scripts/prepare-browser-assets.mjs");
  if (!lstatSync(script).isFile())
    throw new BuildContractError("The PDF.js asset preparer is missing.");
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: ["node", script],
      cwd: dashboard,
      env: buildContractEnvironment(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new BuildContractError(
      "The offline PDF.js asset preparer could not be started.",
    );
  }
  if (!result.success) {
    throw new BuildContractError(
      "The offline PDF.js asset preparation failed; no application build was executed.",
    );
  }
  return verifyPreparedDashboardBrowserAssets(root);
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
    DASHBOARD_URL: "https://dashboard-server-changed.invalid",
    NEXT_PUBLIC_URL: "https://dashboard-public-changed.invalid",
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
  return prepareDashboardBrowserAssets(root);
}

if (import.meta.main) {
  try {
    const assets = verifyDashboardBuildContract(
      dirname(dirname(fileURLToPath(import.meta.url))),
    );
    console.log(
      "Dashboard build contract passed: strict environment, source/output/dependency contracts, six cache-invalidating inputs (eight dry runs), and verified offline PDF.js asset preparation; no application build or cache restore was executed.",
    );
    console.log(
      JSON.stringify({ kind: "agsaas-dashboard-asset-contract-v1", ...assets }),
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
