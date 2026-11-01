import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

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
  requests?: Array<Record<string, unknown>>;
  errors?: Array<{ name: string; message: string }>;
  states?: Array<{
    status: string;
    attempts: number;
    startedAt: string | null;
    outcome?: { sent: number; failed: number; uncertain: number };
  }>;
  first?: { status: string; accepted: number; reused: boolean };
  duplicate?: { status: string; accepted: number; reused: boolean };
  second?: { status: string; accepted: number; reused: boolean };
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
        EMAIL_FROM: "AGSaaS <accounts@example.test>",
        EMAIL_REPLY_TO: "support@example.test",
        APP_NAME: "AGSaaS",
        DASHBOARD_URL: "https://app.example.test",
        WORKER_ENV: "production",
        INTERNAL_API_KEY: "agsaas-import-test-only",
        API_INTERNAL_URL: "http://127.0.0.1:1",
        DATABASE_PRIMARY_URL: "postgres://test:test@127.0.0.1:1/midday_test",
        REDIS_QUEUE_URL: "redis://127.0.0.1:1/15",
        REDIS_URL: "redis://127.0.0.1:1/15",
        ...(scenario !== "registry-import" && scenario !== "missing-key"
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

describe("payment issue delivery in isolated processes", () => {
  test("the real full processor registry imports without optional provider keys", async () => {
    const result = await runScenario("registry-import");
    expect(result.imported).toBe(true);
    expect(result.registeredJobs).toEqual([
      "payment-issue",
      "enrich-transactions",
      "process-document",
      "notification",
      "reconcile-notification-dispatches",
    ]);
    expect(result.fetchAttempts).toBe(0);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);
  test("a missing provider key remains recoverable with zero attempts and HTTP requests", async () => {
    const result = await runScenario("missing-key");
    expect(result.imported).toBe(true);
    expect(result.errors?.map((error) => error.name)).toEqual([
      "NotificationDispatchPendingError",
      "NotificationDispatchPendingError",
    ]);
    expect(result.states).toEqual([
      { status: "pending", attempts: 0, startedAt: null },
    ]);
    expect(result.fetchAttempts).toBe(0);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);
  test("own identity and real rendered payload are accepted once per job identity", async () => {
    const result = await runScenario("configured-send");
    expect(result.requests).toHaveLength(2);
    for (const [index, payload] of (result.requests ?? []).entries()) {
      expect(payload).toMatchObject({
        from: "AGSaaS <accounts@example.test>",
        reply_to: "support@example.test",
        to: `recipient-${index}@example.test`,
        subject: "Your payment didn't go through",
      });
      expect(payload.html).toContain(`FixtureTeam${index}`);
      expect(payload.html).toContain(`Hi FixtureName${index},`);
      expect(payload.html).toContain(
        "https://app.example.test/settings/billing",
      );
      expect(payload.html).not.toContain("midday.ai");
    }
    expect(result.first).toMatchObject({
      status: "completed",
      accepted: 1,
      reused: false,
    });
    expect(result.duplicate).toMatchObject({
      status: "completed",
      accepted: 1,
      reused: true,
    });
    expect(result.second).toMatchObject({
      status: "completed",
      accepted: 1,
      reused: false,
    });
    expect(result.fetchAttempts).toBe(2);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);
  test("resolved SDK rejection is failed, sanitized and not reported as sent", async () => {
    const result = await runScenario("resolved-rejection");
    expect(result.states?.[0]).toMatchObject({
      status: "rejected",
      attempts: 1,
      outcome: { sent: 0, failed: 1, uncertain: 0 },
    });
    expect(
      result.errors?.every(
        (error) =>
          error.name === "NonRetryableError" &&
          !error.message.includes("recipient-private-value"),
      ),
    ).toBe(true);
    expect(result.fetchAttempts).toBe(1);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);
  test("lost SDK acknowledgement becomes reconciliation and a retry never resends", async () => {
    const result = await runScenario("send-error");
    expect(result.states?.[0]).toMatchObject({
      status: "reconciliation",
      attempts: 1,
      outcome: { sent: 0, failed: 1, uncertain: 1 },
    });
    expect(
      result.errors?.every(
        (error) =>
          error.name === "NonRetryableError" &&
          error.message.includes("reconciliation"),
      ),
    ).toBe(true);
    expect(result.fetchAttempts).toBe(1);
    expect(result.networkAttempts).toBe(0);
  }, 25_000);
});
