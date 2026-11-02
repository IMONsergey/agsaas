import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";

type Environment = Record<string, string | undefined>;
export type SmokeOptions = { appDir: string; port: number; timeoutMs: number };
export class DashboardSmokeError extends Error {}

/** This script tests the packaged server, not Supabase or authenticated product flows. */
export function parseSmokeOptions(args: string[]): SmokeOptions {
  const options = {
    appDir: "/app/apps/dashboard",
    port: 3000,
    timeoutMs: 30_000,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || seen.has(name)) {
      throw new DashboardSmokeError(
        "Each smoke option requires exactly one value.",
      );
    }
    seen.add(name);
    if (name === "--app-dir") {
      options.appDir = resolve(value);
    } else if (name === "--port" || name === "--timeout-ms") {
      const max = name === "--port" ? 65535 : 60_000;
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
        throw new DashboardSmokeError(
          "Smoke port or timeout is outside its supported range.",
        );
      }
      if (name === "--port") options.port = Number(value);
      else options.timeoutMs = Number(value);
    } else {
      throw new DashboardSmokeError(
        "Supported smoke options: --app-dir, --port, --timeout-ms.",
      );
    }
  }
  return options;
}

/** No provider credentials, public endpoint overrides, proxy settings, or preloads. */
export function smokeEnvironment(
  source: Environment,
  port: number,
): Environment {
  const env: Environment = {
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    CI: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
  };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export function selectStaticAssets(files: string[]) {
  const sorted = [...files].sort();
  const script = sorted.find((file) => file.endsWith(".js"));
  const stylesheet = sorted.find((file) => file.endsWith(".css"));
  if (!script || !stylesheet) {
    throw new DashboardSmokeError(
      "The final image must contain real Next.js JavaScript and CSS assets.",
    );
  }
  return { script, stylesheet };
}

export async function assertHealthResponse(response: Response) {
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    throw new DashboardSmokeError(
      "The packaged dashboard health route did not return HTTP 200 JSON.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DashboardSmokeError(
      "The packaged dashboard health route returned invalid JSON.",
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("status" in body) ||
    body.status !== "ok"
  ) {
    throw new DashboardSmokeError(
      "The packaged dashboard health route did not report status ok.",
    );
  }
}

export async function assertStaticResponse(
  response: Response,
  expected: Uint8Array,
  kind: "script" | "stylesheet",
) {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  const validType =
    kind === "stylesheet"
      ? contentType === "text/css"
      : contentType === "application/javascript" ||
        contentType === "text/javascript";
  if (response.status !== 200 || !validType) {
    throw new DashboardSmokeError(
      "A packaged Next.js static asset was missing, redirected, or served with the wrong content type.",
    );
  }
  const received = new Uint8Array(await response.arrayBuffer());
  if (
    expected.byteLength === 0 ||
    !Buffer.from(received).equals(Buffer.from(expected))
  ) {
    throw new DashboardSmokeError(
      "A served Next.js static asset differs from the final image's file.",
    );
  }
}

function staticFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory())
      return staticFiles(join(directory, entry.name), relative);
    return entry.isFile() ? [relative] : [];
  });
}

function inspectStandalone(appDir: string) {
  const server = join(appDir, "server.js");
  const staticDir = join(appDir, ".next", "static");
  try {
    if (
      !statSync(server).isFile() ||
      !statSync(join(appDir, ".next", "BUILD_ID")).isFile() ||
      !statSync(staticDir).isDirectory() ||
      !statSync(join(appDir, "public")).isDirectory()
    ) {
      throw new Error("incomplete output");
    }
  } catch {
    throw new DashboardSmokeError(
      "The standalone server, build ID, static assets, or public directory is missing from the final image.",
    );
  }
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    if (existsSync(join(appDir, name))) {
      throw new DashboardSmokeError(
        "The standalone directory contains dotenv configuration; this smoke check requires a credential-free image.",
      );
    }
  }
  return {
    server,
    staticDir,
    assets: selectStaticAssets(staticFiles(staticDir)),
  };
}

async function requireAvailablePort(port: number) {
  // Fail before spawning if another service is listening. Never accidentally
  // report a successful probe against an unrelated local server.
  await new Promise<void>((accept, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(
        new DashboardSmokeError(
          "The smoke loopback port is already in use or unavailable.",
        ),
      ),
    );
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      probe.close((error) => {
        if (error)
          reject(
            new DashboardSmokeError(
              "The smoke loopback port could not be released.",
            ),
          );
        else accept();
      }),
    );
  });
}

async function stopOwnServer(child: Bun.Subprocess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<false>((accept) => {
        timer = setTimeout(() => accept(false), 5000);
      }),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function smokeDashboard(options: SmokeOptions) {
  const { server, staticDir, assets } = inspectStandalone(options.appDir);
  await requireAvailablePort(options.port);
  const shutdown = new AbortController();
  const interrupt = () => shutdown.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let child: Bun.Subprocess | undefined;
  try {
    child = Bun.spawn({
      // Match the production image's Node CMD even though Bun runs this harness.
      cmd: ["node", server],
      cwd: options.appDir,
      env: smokeEnvironment(process.env, options.port),
      stdin: "ignore",
      // Do not print application logs: unexpected diagnostics may contain config.
      stdout: "ignore",
      stderr: "ignore",
      signal: shutdown.signal,
      timeout: options.timeoutMs + 20_000,
      killSignal: "SIGKILL",
    });
    const baseUrl = `http://127.0.0.1:${options.port}`;
    const request = (path: string, timeoutMs: number) =>
      fetch(`${baseUrl}${path}`, {
        redirect: "manual",
        signal: AbortSignal.any([
          shutdown.signal,
          AbortSignal.timeout(timeoutMs),
        ]),
        headers: { "accept-encoding": "identity" },
      });
    const deadline = Date.now() + options.timeoutMs;
    let healthy = false;
    while (Date.now() < deadline) {
      if (shutdown.signal.aborted)
        throw new DashboardSmokeError("Dashboard smoke interrupted.");
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new DashboardSmokeError(
          "The packaged dashboard process exited before its health route was ready.",
        );
      }
      try {
        const response = await request(
          "/api/health",
          Math.max(1, Math.min(1000, deadline - Date.now())),
        );
        await assertHealthResponse(response);
        healthy = true;
        break;
      } catch (error) {
        if (error instanceof DashboardSmokeError) throw error;
        await Bun.sleep(100);
      }
    }
    if (!healthy)
      throw new DashboardSmokeError(
        "The packaged dashboard did not become healthy before the timeout.",
      );
    for (const kind of ["script", "stylesheet"] as const) {
      const relative = assets[kind];
      const path = relative.split(sep).map(encodeURIComponent).join("/");
      const response = await request(`/_next/static/${path}`, 5000);
      await assertStaticResponse(
        response,
        readFileSync(join(staticDir, relative)),
        kind,
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new DashboardSmokeError(
        "The packaged dashboard exited during static asset verification.",
      );
    }
  } finally {
    try {
      if (child) await stopOwnServer(child);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

if (import.meta.main) {
  try {
    await smokeDashboard(parseSmokeOptions(Bun.argv.slice(2)));
    console.log(
      "Dashboard standalone smoke passed: real HTTP health plus byte-identical JavaScript and CSS from the final image, without provider credentials. Authenticated product flows were not tested.",
    );
  } catch (error) {
    console.error(
      error instanceof DashboardSmokeError
        ? error.message
        : "Dashboard standalone smoke failed; application diagnostics were not printed to avoid disclosing configuration.",
    );
    process.exitCode = 1;
  }
}
