import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("./fixtures/auth-entry-child.tsx", import.meta.url),
);
const dashboardDirectory = fileURLToPath(new URL("../../", import.meta.url));

describe("configured login rendering and OAuth request outcomes", () => {
  test.each([
    "login-default",
    "login-password",
    "login-stale-preference",
    "login-enabled-preference",
    "oauth-success",
    "oauth-error",
    "oauth-throw",
    "oauth-concurrent",
  ])("%s", async (scenario) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-install",
        fixturePath,
        scenario,
      ],
      {
        cwd: dashboardDirectory,
        env: { NODE_ENV: "test", NEXT_PUBLIC_URL: "http://127.0.0.1:3001" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0)
        throw new Error(`Auth entry fixture failed: ${stderr}\n${stdout}`);
      expect(stdout.trim()).toBe(`AUTH_ENTRY_OK ${scenario} networkAttempts=0`);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 15_000);
});
