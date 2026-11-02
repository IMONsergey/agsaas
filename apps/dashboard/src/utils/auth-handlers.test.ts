import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("./fixtures/auth-handlers-child.ts", import.meta.url),
);
const dashboardDirectory = fileURLToPath(new URL("../../", import.meta.url));

describe("actual OTP action and OAuth callback with isolated Auth responses", () => {
  test.each([
    "otp-valid",
    "otp-error",
    "otp-throw",
    "otp-waitlist",
    "otp-disabled",
    "otp-unsafe-redirect",
    "otp-relative-redirect",
    "password-valid",
    "password-error",
    "password-throw",
    "password-no-session",
    "password-disabled",
    "password-waitlist",
    "password-unsafe-redirect",
    "oauth-valid",
    "oauth-onboarding",
    "oauth-error",
    "oauth-throw",
    "oauth-no-code",
    "oauth-provider-error",
    "oauth-waitlist",
    "oauth-desktop",
  ])("%s preserves successful navigation and rejects failed authentication", async (scenario) => {
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
        throw new Error(`Auth handler fixture failed: ${stderr}\n${stdout}`);
      expect(stdout.trim()).toBe(
        `AUTH_HANDLERS_OK ${scenario} networkAttempts=0`,
      );
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 15_000);
});
