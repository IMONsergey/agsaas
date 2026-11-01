import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("./fixtures/password-flows-child.tsx", import.meta.url),
);
const dashboardDirectory = fileURLToPath(new URL("../../", import.meta.url));

describe("password actions, PKCE callback, UI capability and proxy boundaries", () => {
  test.each([
    "request-valid",
    "request-error",
    "request-throw",
    "request-disabled",
    "request-password-disabled",
    "request-nonliteral-flag",
    "callback-valid",
    "callback-error",
    "callback-throw",
    "callback-no-code",
    "callback-no-session",
    "callback-provider-error",
    "callback-disabled",
    "callback-password-amr",
    "callback-expired",
    "callback-metadata-amr",
    "callback-claims-error",
    "reset-valid",
    "reset-password-amr",
    "reset-expired",
    "reset-mfa-denied",
    "reset-deleting",
    "reset-no-user",
    "reset-error",
    "reset-throw",
    "reset-disabled",
    "reset-logout-throw",
    "change-valid",
    "change-verifier-error",
    "change-verifier-throw",
    "change-wrong-user",
    "change-no-session",
    "change-same-password",
    "change-no-user",
    "change-mfa-denied",
    "change-deleting",
    "change-error",
    "change-throw",
    "change-disabled",
    "validation",
    "sdk-isolation",
    "sdk-recovery",
    "proxy-public",
    "proxy-protected",
    "proxy-mfa",
    "page-forgot-enabled",
    "page-forgot-disabled",
    "page-reset-valid",
    "page-reset-password-amr",
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
        env: {
          NODE_ENV: "test",
          NEXT_PUBLIC_URL: "https://dashboard.example.test",
        },
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
        throw new Error(`Password fixture failed: ${stderr}\n${stdout}`);
      expect(stdout.trim()).toBe(
        `PASSWORD_FLOWS_OK ${scenario} networkAttempts=0`,
      );
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 15_000);
});
