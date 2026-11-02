import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

type SignalEmitter = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

/** Keep handlers installed throughout cleanup, including repeated signals. */
export function createRuntimeInterruption(emitter: SignalEmitter = process) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  emitter.on("SIGINT", interrupt);
  emitter.on("SIGTERM", interrupt);
  return {
    signal: controller.signal,
    dispose() {
      emitter.removeListener("SIGINT", interrupt);
      emitter.removeListener("SIGTERM", interrupt);
    },
  };
}

type DockerOptions = { timeoutMs?: number; cancellable?: boolean };

/** The executable override exists only to test cancellation with local children. */
export function createDockerRunner(signal: AbortSignal, executable = "docker") {
  return async (args: string[], options: DockerOptions = {}) => {
    const cancellable = options.cancellable !== false;
    if (cancellable) signal.throwIfAborted();
    const child = Bun.spawn([executable, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: cancellable ? signal : undefined,
      timeout: options.timeoutMs ?? 180_000,
      killSignal: "SIGKILL",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0)
      throw new Error(`Docker operation failed (${code}): ${stderr || stdout}`);
    return stdout.trim();
  };
}

export async function testRuntimeContainers(app: "api" | "worker") {
  const project = `agsaas-runtime-${app}-${crypto.randomUUID().slice(0, 8)}`;
  const composeFile = fileURLToPath(
    new URL("../docker-compose.runtime-test.yml", import.meta.url),
  );
  const compose = [
    "compose",
    "--file",
    composeFile,
    "--project-name",
    project,
    "--profile",
    app,
  ];
  const interruption = createRuntimeInterruption();
  const docker = createDockerRunner(interruption.signal);
  let failed = false;
  try {
    // Resolve the final image before allocating any resources. Never build/pull an
    // app image silently; the exact image verified here is the one just built in CI.
    await docker(["image", "inspect", `agsaas-${app}:ci`]);
    try {
      console.log(`Starting isolated ${app} runtime checks`);
      await docker([
        ...compose,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "90",
        "postgres",
        "redis",
        "auth-health-fixture",
      ]);
      if (app === "worker") {
        // Pause ONLY this disposable Redis database before startup. Schedulers still
        // register, and all real queue connections initialize, but cron processors
        // cannot accidentally call providers or query nonexistent application tables.
        await docker([
          ...compose,
          "run",
          "--rm",
          "--no-deps",
          "worker",
          "bun",
          "--eval",
          `
          import { getAllQueues } from "./src/queues";
          const queues = getAllQueues();
          try { await Promise.all(queues.map(queue => queue.pause())); }
          finally { await Promise.all(queues.map(queue => queue.close())); }
        `,
        ]);
      }
      await docker([...compose, "up", "--detach", "--no-deps", app]);
      const container = await docker([...compose, "ps", "--quiet", app]);
      assert.match(
        container,
        /^[a-f0-9]{12,64}$/,
        "Expected exactly one test application container",
      );
      const output = await docker(
        ["exec", container, "bun", "/tmp/agsaas-runtime-smoke.ts", app],
        { timeoutMs: 210_000 },
      );
      console.log(output);
      const startedAt = performance.now();
      // SIGTERM goes through the real image entrypoint/process, not a mocked handler.
      await docker(["stop", "--time", "40", container], { timeoutMs: 45_000 });
      const exitCode = await docker([
        "inspect",
        "--format",
        "{{.State.ExitCode}}",
        container,
      ]);
      assert.equal(
        exitCode,
        "0",
        "Graceful SIGTERM must finish with exit code 0 (not Docker SIGKILL/137)",
      );
      assert.ok(
        performance.now() - startedAt < 35_000,
        "Graceful stop exceeded the application deadline",
      );
      console.log(`${app}: real process SIGTERM shutdown passed`);
    } catch (error) {
      failed = true;
      if (interruption.signal.aborted) {
        console.error(
          "Runtime checks interrupted; cleaning up the isolated project",
        );
      } else {
        console.error(error);
        try {
          console.error(
            await docker([...compose, "logs", "--no-color", "--tail", "200"]),
          );
        } catch {
          console.error("Could not collect isolated test container logs");
        }
      }
    } finally {
      // Explicit random project name scopes deletion to resources created above.
      // There are no host bind-mounted data directories or persistent user volumes.
      // Cleanup is deliberately NOT attached to the cancelled operation's signal.
      try {
        await docker(
          [
            ...compose,
            "down",
            "--volumes",
            "--remove-orphans",
            "--timeout",
            "5",
          ],
          { timeoutMs: 30_000, cancellable: false },
        );
      } catch (error) {
        failed = true;
        console.error(`Test resource cleanup failed for ${project}`, error);
      }
    }
    return !failed && !interruption.signal.aborted;
  } finally {
    interruption.dispose();
  }
}

if (import.meta.main) {
  const app = Bun.argv[2];
  if ((app !== "api" && app !== "worker") || Bun.argv.length !== 3) {
    console.error(
      "Usage: bun scripts/test-runtime-containers.ts <api|worker> (requires Docker and the matching agsaas-<app>:ci image)",
    );
    process.exitCode = 2;
  } else {
    try {
      if (!(await testRuntimeContainers(app))) process.exitCode = 1;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
