import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { CreateEmailOptions } from "resend";

const fixturePath = fileURLToPath(
  new URL("./fixtures/payment-issue-child.ts", import.meta.url),
);
const workerDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const resultPrefix = "PAYMENT_ISSUE_FIXTURE ";

type FixtureResult = {
  imported: boolean;
  fetchAttempts: number;
  networkAttempts: number;
  registeredJobs?: string[];
  missingKeyError?: string;
  constructorCountAfterImport?: number;
  constructionKeys?: string[];
  sent?: CreateEmailOptions[];
  resultsWereUndefined?: boolean;
  preservedSdkError?: boolean;
};

async function runScenario(scenario: string): Promise<FixtureResult> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-install", fixturePath, scenario],
    {
      cwd: workerDirectory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Deliberately do not inherit credentials or load local .env files.
      // These loopback core settings never connect: the child forbids network
      // access and replaces only the eager BullMQ Queue constructor.
      env: {
        NODE_ENV: "production",
        WORKER_ENV: "production",
        INTERNAL_API_KEY: "agsaas-import-test-only",
        API_INTERNAL_URL: "http://127.0.0.1:1",
        DATABASE_PRIMARY_URL: "postgres://test:test@127.0.0.1:1/midday_test",
        REDIS_QUEUE_URL: "redis://127.0.0.1:1/15",
        REDIS_URL: "redis://127.0.0.1:1/15",
        ...(scenario === "configured-send" || scenario === "send-error"
          ? { RESEND_API_KEY: "re_fixture_only" }
          : {}),
      },
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    // Only terminate this exact fixture process, never an existing worker.
    child.kill("SIGKILL");
  }, 20_000);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut || exitCode !== 0) {
      throw new Error(
        `Payment issue fixture ${scenario} failed (exit ${exitCode}, timeout ${timedOut}): ${stderr}\n${stdout}`,
      );
    }
    const result = stdout
      .split("\n")
      .find((line) => line.startsWith(resultPrefix));
    if (!result) throw new Error("Payment issue fixture returned no result");
    return JSON.parse(result.slice(resultPrefix.length)) as FixtureResult;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

describe("payment issue optional email client in isolated processes", () => {
  test("the real full processor registry imports without optional provider keys", async () => {
    const result = await runScenario("registry-import");
    expect(result.imported).toBe(true);
    expect(result.registeredJobs).toEqual([
      "payment-issue",
      "enrich-transactions",
      "process-document",
      "notification",
    ]);
    expect(result.fetchAttempts).toBe(0);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);

  test("a missing email key fails only on use with the original SDK error", async () => {
    const result = await runScenario("missing-key");
    expect(result.imported).toBe(true);
    expect(result.missingKeyError).toBe(
      'Missing API key. Pass it to the constructor `new Resend("re_123")`',
    );
    expect(result.fetchAttempts).toBe(0);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);

  test("configured sends preserve addresses and rendered payload and reuse one client", async () => {
    const result = await runScenario("configured-send");
    expect(result.constructorCountAfterImport).toBe(0);
    expect(result.constructionKeys).toEqual(["re_fixture_only"]);
    expect(result.sent).toHaveLength(2);
    for (const [index, payload] of (result.sent ?? []).entries()) {
      expect(payload).toMatchObject({
        from: "Middaybot <middaybot@midday.ai>",
        replyTo: "pontus@midday.ai",
        to: `recipient-${index}@example.test`,
        subject: "Your payment didn't go through",
      });
      expect(payload.html).toContain(`FixtureTeam${index}`);
      expect(payload.html).toContain(`Hi FixtureName${index},`);
      expect(payload.html).toContain("/settings/billing");
    }
    expect(result.resultsWereUndefined).toBe(true);
    expect(result.fetchAttempts).toBe(0);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);

  test("SDK send rejections propagate without being replaced or swallowed", async () => {
    const result = await runScenario("send-error");
    expect(result.preservedSdkError).toBe(true);
    expect(result.constructionKeys).toEqual(["re_fixture_only"]);
    expect(result.sent).toHaveLength(1);
    expect(result.fetchAttempts).toBe(0);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);
});
