import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/plain-support-child.ts", import.meta.url),
);
const cwd = fileURLToPath(new URL("../../", import.meta.url));

describe("actual support/feedback actions with isolated Plain HTTP", () => {
  test.each([
    "support-success",
    "feedback-success",
    "no-labels",
    "priorities",
    "lazy-key",
    "support-unconfigured",
    "feedback-unconfigured",
    "invalid-label",
    "validation",
    "customer-error",
    "customer-missing-id",
    "thread-error",
    "thread-missing-id",
    "graphql-error",
    "http-unauthorized",
    "http-rate-limit",
    "http-server-error",
    "invalid-json",
    "oversize-body",
    "transport-throw",
    "timeout",
    "body-timeout",
  ])("%s", async (scenario) => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--no-install", fixture, scenario],
      {
        cwd,
        env: { NODE_ENV: "test" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0)
        throw new Error(`Plain fixture failed: ${stderr}\n${stdout}`);
      expect(stdout.trim()).toBe(
        `PLAIN_SUPPORT_OK ${scenario} networkAttempts=0`,
      );
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 15_000);
});
