import { expect, test } from "bun:test";
import { assertReadiness, pollUntil } from "./runtime-smoke";

const checks = {
  database: { status: "ok" },
  redis_cache: { status: "ok" },
  redis_queue: { status: "ok" },
  supabase: { status: "ok" },
};

test.each([
  "api",
  "worker",
] as const)("%s requires core checks, not just a healthy status", (service) => {
  expect(() =>
    assertReadiness({ status: "ok", checks }, service, true),
  ).not.toThrow();
  expect(() => assertReadiness({ status: "ok" }, service, true)).toThrow();
});
test.each([
  "database",
  "redis_cache",
  "redis_queue",
  "supabase",
])("API smoke fails if %s is absent", (key) => {
  const partial = { ...checks } as Record<string, { status: string }>;
  delete partial[key];
  expect(() =>
    assertReadiness({ status: "ok", checks: partial }, "api", true),
  ).toThrow();
});
test("failure smoke requires the isolated fixture to be the only failed probe", () => {
  const degraded = { ...checks, supabase: { status: "error" } };
  expect(() =>
    assertReadiness({ status: "degraded", checks: degraded }, "api", false),
  ).not.toThrow();
  expect(() =>
    assertReadiness(
      {
        status: "degraded",
        checks: { ...degraded, database: { status: "error" } },
      },
      "api",
      false,
    ),
  ).toThrow();
});
test("poll stops at first success", async () => {
  let calls = 0;
  await pollUntil(async () => ++calls === 2, 100, 1);
  expect(calls).toBe(2);
});
test("poll is bounded when the condition never becomes true", async () => {
  await expect(pollUntil(async () => false, 5, 1)).rejects.toThrow("deadline");
});
