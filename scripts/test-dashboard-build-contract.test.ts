import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBuildInputChangesHash,
  browserAssetManifest,
  buildContractEnvironment,
  hashedBuildInputs,
  inspectDashboardAssetPreparation,
  inspectDashboardBuildReport,
  publicBuildInputs,
  verifyPreparedDashboardBrowserAssets,
} from "./test-dashboard-build-contract";

function fixture() {
  return {
    envMode: "strict",
    tasks: [
      {
        taskId: "@midday/dashboard#build",
        envMode: "strict",
        framework: "nextjs",
        hash: "0123456789abcdef",
        inputs: {
          "package.json": "hash",
          "next.config.ts": "hash",
          "src/app/[locale]/layout.tsx": "hash",
          "scripts/prepare-browser-assets.mjs": "hash",
          "scripts/verify-release-source.mjs": "hash",
          "src/app/[locale]/(public)/source/page.tsx": "hash",
          [browserAssetManifest]: "hash",
        },
        resolvedTaskDefinition: {
          outputs: [".next/**", "!.next/cache/**", "public/vendor/pdfjs/**"],
          inputs: [".env"],
          dependsOn: ["^build"],
        },
        environmentVariables: {
          configured: hashedBuildInputs.map((name) => `${name}=hash`),
          inferred: publicBuildInputs.map((name) => `${name}=hash`),
          passthrough: [] as string[],
        },
      },
    ],
  };
}

describe("dashboard build contract report", () => {
  test("accepts strict Next.js build with hashed inputs and intact cache outputs", () => {
    expect(inspectDashboardBuildReport(JSON.stringify(fixture()))).toEqual({
      hash: "0123456789abcdef",
    });
  });
  test.each(hashedBuildInputs)("rejects passthrough-only %s", (name) => {
    const report = fixture();
    const variables = report.tasks[0]!.environmentVariables;
    variables.configured = variables.configured.filter(
      (entry) => !entry.startsWith(`${name}=`),
    );
    variables.passthrough.push(`${name}=do-not-print`);
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      `${name} must be a hashed build input`,
    );
  });
  test("rejects caching only Next output while generated PDF assets are omitted", () => {
    const report = fixture();
    report.tasks[0]!.resolvedTaskDefinition.outputs = [
      ".next/**",
      "!.next/cache/**",
    ];
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "public/vendor/pdfjs/**",
    );
  });
  test.each([
    "scripts/prepare-browser-assets.mjs",
    "scripts/verify-release-source.mjs",
    "src/app/[locale]/(public)/source/page.tsx",
    browserAssetManifest,
  ])("requires the browser asset source input %s to be hashed", (name) => {
    const report = fixture();
    const inputs: Record<string, string> = report.tasks[0]!.inputs;
    delete inputs[name];
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "default source inputs",
    );
  });
  test.each([
    "outputs",
    "inputs",
    "dependsOn",
  ] as const)("rejects lost %s from a non-inheriting task override", (field) => {
    const report = fixture();
    report.tasks[0]!.resolvedTaskDefinition[field] = [];
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow();
  });
  test.each([
    "loose",
    "",
    "unexpected",
  ])("rejects environment mode %s", (mode) => {
    const report = fixture();
    report.tasks[0]!.envMode = mode;
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "strict environment mode",
    );
  });
  test.each(
    publicBuildInputs,
  )("rejects missing or passthrough-only public input %s", (name) => {
    const report = fixture();
    const variables = report.tasks[0]!.environmentVariables;
    variables.inferred = variables.inferred.filter(
      (entry) => !entry.startsWith(`${name}=`),
    );
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      name,
    );
    variables.passthrough.push(`${name}=do-not-print`);
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      name,
    );
  });
  test.each([
    "configured",
    "inferred",
    "passthrough",
  ] as const)("rejects undeclared input in %s", (group) => {
    const report = fixture();
    report.tasks[0]!.environmentVariables[group].push(
      "DASHBOARD_BUILD_CONTRACT_UNDECLARED=do-not-print",
    );
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "undeclared environment variable",
    );
  });
  test("global passthrough cannot leak an undeclared input into a strict task", () => {
    const report = {
      ...fixture(),
      globalCacheInputs: {
        environmentVariables: {
          passthrough: ["DASHBOARD_BUILD_CONTRACT_UNDECLARED=do-not-print"],
        },
      },
    };
    expect(() => inspectDashboardBuildReport(JSON.stringify(report))).toThrow(
      "undeclared environment variable",
    );
  });
  test.each([
    "secret-must-not-appear",
    JSON.stringify({ tasks: [{ secret: "secret-must-not-appear" }] }),
    "null",
  ])("malformed reports do not leak payloads", (raw) => {
    try {
      inspectDashboardBuildReport(raw);
      throw new Error("Unexpected successful inspection");
    } catch (error) {
      expect(String(error)).not.toContain("secret-must-not-appear");
      expect(String(error)).not.toContain("Unexpected successful inspection");
    }
  });
  test("a build input must invalidate the task hash", () => {
    expect(() =>
      assertBuildInputChangesHash("SENTRY_RELEASE", "a", "a"),
    ).toThrow("invalidating");
    expect(() =>
      assertBuildInputChangesHash("SENTRY_RELEASE", "a", "b"),
    ).not.toThrow();
  });
  test("sterile subprocess environment does not forward credentials or execution overrides", () => {
    const env = buildContractEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp",
      SUPABASE_SECRET_KEY: "secret-must-not-appear",
      SENTRY_AUTH_TOKEN: "secret-must-not-appear",
      NODE_OPTIONS: "--require=untrusted",
      BUN_OPTIONS: "untrusted",
      TURBO_BINARY_PATH: "/untrusted",
      HTTPS_PROXY: "secret-must-not-appear",
      GIT_COMMIT_SHA: "secret-must-not-appear",
      DASHBOARD_URL: "secret-must-not-appear",
      NEXT_PUBLIC_URL: "secret-must-not-appear",
      NEXT_PUBLIC_API_URL: "secret-must-not-appear",
      NEXT_PUBLIC_RELEASE_SHA: "secret-must-not-appear",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp");
    expect(JSON.stringify(env)).not.toContain("secret-must-not-appear");
    for (const name of [
      "SUPABASE_SECRET_KEY",
      "SENTRY_AUTH_TOKEN",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "TURBO_BINARY_PATH",
      "HTTPS_PROXY",
    ]) {
      expect(env[name]).toBeUndefined();
    }
  });
});

describe("dashboard release source image guard", () => {
  const exact = "a".repeat(40);
  const run = (git: string | undefined, published: string | undefined) =>
    Bun.spawnSync({
      cmd: [
        "node",
        fileURLToPath(
          new URL(
            "../apps/dashboard/scripts/verify-release-source.mjs",
            import.meta.url,
          ),
        ),
      ],
      env: {
        PATH: process.env.PATH ?? "",
        GIT_COMMIT_SHA: git,
        NEXT_PUBLIC_RELEASE_SHA: published,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024,
    });

  test("accepts the exact matching release without exposing its environment", () => {
    const result = run(exact, exact);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test.each([
    { name: "missing both revisions", git: undefined, published: undefined },
    { name: "missing public revision", git: exact, published: undefined },
    { name: "missing build revision", git: undefined, published: exact },
    { name: "mismatched revision", git: exact, published: "b".repeat(40) },
    { name: "short revision", git: "a".repeat(39), published: "a".repeat(39) },
    {
      name: "non-hex revision",
      git: "z".repeat(40),
      published: "z".repeat(40),
    },
    {
      name: "uppercase revision",
      git: "A".repeat(40),
      published: "A".repeat(40),
    },
  ])("rejects $name before building an image", ({ git, published }) => {
    const result = run(git, published);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Exact matching release SHA required\n",
    );
  });
});

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("dashboard Docker installer release wiring", () => {
  const exact = "a".repeat(40);
  const root = fileURLToPath(new URL("../", import.meta.url));

  function run(git: string, published: string | undefined) {
    const directory = mkdtempSync(join(tmpdir(), "agsaas-docker-release-"));
    temporaryRoots.push(directory);
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const stamp = join(directory, "git-sha.txt");
    const capture = join(directory, "build-env.json");
    writeFileSync(stamp, git);
    // Execute the Docker RUN's release setup and real verifier, stopping at a
    // local build boundary. No Docker daemon, dependency install or Next build.
    writeFileSync(
      join(bin, "bunx"),
      [
        "#!/usr/bin/env node",
        'const { writeFileSync } = require("node:fs");',
        'const expected = ["turbo", "run", "build", "--filter=@midday/dashboard", "--only"];',
        'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) throw new Error("Unexpected build invocation");',
        "writeFileSync(process.env.AGSAAS_DOCKER_BUILD_CAPTURE, JSON.stringify({",
        "  git: process.env.GIT_COMMIT_SHA,",
        "  published: process.env.NEXT_PUBLIC_RELEASE_SHA,",
        "  sentry: process.env.SENTRY_RELEASE",
        '}), { flag: "wx" });',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const installer = readFileSync(
      join(root, "apps/dashboard/Dockerfile"),
      "utf8",
    ).match(/^FROM base AS installer\r?\n([\s\S]*?)^FROM base AS runner$/m)?.[1];
    if (!installer) throw new Error("Missing dashboard installer stage");
    const commands = installer
      .replace(/\\\r?\n/g, "")
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith("RUN ") &&
          line.includes("node apps/dashboard/scripts/verify-release-source.mjs"),
      );
    const [instruction] = commands;
    if (
      commands.length !== 1 ||
      !instruction ||
      instruction.split("/tmp/git-sha.txt").length !== 2
    ) {
      throw new Error("Expected one stamped dashboard release build command");
    }
    const result = Bun.spawnSync({
      cmd: [
        "/bin/sh",
        "-ec",
        instruction
          .slice(4)
          .replace("/tmp/git-sha.txt", '"$AGSAAS_DOCKER_SHA_FILE"'),
      ],
      cwd: root,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NEXT_PUBLIC_RELEASE_SHA: published,
        AGSAAS_DOCKER_SHA_FILE: stamp,
        AGSAAS_DOCKER_BUILD_CAPTURE: capture,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024,
    });
    return {
      result,
      captured: existsSync(capture) ? readFileSync(capture, "utf8") : undefined,
    };
  }

  test.each([
    { name: "unset public argument", published: undefined },
    { name: "empty Docker ARG/ENV default", published: "" },
    { name: "explicit matching public argument", published: exact },
  ])("builds with one exact identity for $name", ({ published }) => {
    const { result, captured } = run(exact, published);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
    expect(captured).toBe(
      JSON.stringify({ git: exact, published: exact, sentry: exact }),
    );
  });

  test.each([
    { name: "explicit public mismatch", git: exact, published: "b".repeat(40) },
    { name: "missing stamped revision", git: "", published: undefined },
    { name: "short stamped revision", git: "a".repeat(39), published: "" },
    { name: "missing stamp with a public revision", git: "", published: exact },
  ])("rejects $name before the build boundary", ({ git, published }) => {
    const { result, captured } = run(git, published);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Exact matching release SHA required\n",
    );
    expect(captured).toBeUndefined();
  });
});

function assetFixture() {
  const root = mkdtempSync(join(tmpdir(), "agsaas-pdf-contract-"));
  temporaryRoots.push(root);
  const write = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  const dashboard = join(root, "apps/dashboard");
  write(
    join(dashboard, "package.json"),
    JSON.stringify({ name: "asset-fixture" }),
  );
  const reactPdf = join(root, "node_modules/react-pdf");
  write(
    join(reactPdf, "package.json"),
    JSON.stringify({ name: "react-pdf", main: "dist/index.js" }),
  );
  write(
    join(reactPdf, "dist/index.js"),
    "// Resolution fixture; never imported.\n",
  );
  const source = join(reactPdf, "node_modules/pdfjs-dist");
  const version = "5.4.296";
  write(
    join(source, "package.json"),
    JSON.stringify({ name: "pdfjs-dist", version }),
  );
  // A different hoisted package must never provide the React-PDF worker.
  write(
    join(root, "node_modules/pdfjs-dist/package.json"),
    JSON.stringify({ name: "pdfjs-dist", version: "9.9.9" }),
  );
  const files = {
    "pdf.worker.min.mjs": "// exact nested worker\n",
    LICENSE: "synthetic source license\n",
    "cmaps/test.bcmap": "synthetic CMap\n",
    "standard_fonts/test.pfb": "synthetic standard font\n",
    "wasm/test.wasm": "synthetic decoder\n",
  };
  const output = join(dashboard, "public/vendor/pdfjs", version);
  for (const [name, bytes] of Object.entries(files)) {
    write(
      join(source, name === "pdf.worker.min.mjs" ? `build/${name}` : name),
      bytes,
    );
    write(join(output, name), bytes);
  }
  const manifest = { version, files: Object.keys(files).sort() };
  const manifestPath = join(dashboard, browserAssetManifest);
  write(manifestPath, JSON.stringify(manifest));
  const workerSha256 = createHash("sha256")
    .update(files["pdf.worker.min.mjs"])
    .digest("hex");
  write(
    join(output, "receipt.json"),
    JSON.stringify({
      kind: "agsaas-own-pdf-assets-v1",
      version,
      workerSha256,
      publicBase: `/vendor/pdfjs/${version}/`,
      license: "LICENSE",
    }),
  );
  return { root, output, manifest, manifestPath, workerSha256, write };
}

describe("owned browser PDF asset preparation", () => {
  test("requires preparation in both build and dev before Next starts", () => {
    const scripts = {
      build:
        "node scripts/prepare-browser-assets.mjs && NODE_ENV=production next build --turbopack",
      dev: "node scripts/prepare-browser-assets.mjs && TZ=UTC next dev --turbopack",
    };
    expect(() => inspectDashboardAssetPreparation(scripts)).not.toThrow();
    for (const name of ["build", "dev"] as const) {
      expect(() =>
        inspectDashboardAssetPreparation({
          ...scripts,
          [name]: `next ${name}`,
        }),
      ).toThrow("must prepare");
    }
  });
  test("verifies the nested React-PDF dependency, its reviewed list and every prepared file", () => {
    const f = assetFixture();
    expect(verifyPreparedDashboardBrowserAssets(f.root)).toEqual({
      version: f.manifest.version,
      assetFiles: 5,
      workerSha256: f.workerSha256,
    });
  });
  test.each([
    "pdf.worker.min.mjs",
    "LICENSE",
    "cmaps/test.bcmap",
    "standard_fonts/test.pfb",
    "wasm/test.wasm",
  ])("rejects stale or corrupt prepared %s even if the worker receipt is intact", (name) => {
    const f = assetFixture();
    f.write(join(f.output, name), "corrupted fixture\n");
    expect(() => verifyPreparedDashboardBrowserAssets(f.root)).toThrow(
      "differ from the installed source",
    );
  });
  test("rejects a manifest from another dependency version", () => {
    const f = assetFixture();
    f.write(
      f.manifestPath,
      JSON.stringify({ ...f.manifest, version: "9.9.9" }),
    );
    expect(() => verifyPreparedDashboardBrowserAssets(f.root)).toThrow(
      "reviewed public PDF.js manifest",
    );
  });
  test("rejects additional or missing public allowlist paths", () => {
    const f = assetFixture();
    f.write(
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        files: [...f.manifest.files.slice(1), "../private"],
      }),
    );
    expect(() => verifyPreparedDashboardBrowserAssets(f.root)).toThrow(
      "reviewed public PDF.js manifest",
    );
  });
  test("rejects unexpected prepared files not present in the reviewed source", () => {
    const f = assetFixture();
    f.write(join(f.output, "unexpected.js"), "stale file\n");
    expect(() => verifyPreparedDashboardBrowserAssets(f.root)).toThrow(
      "unexpected",
    );
  });
});
