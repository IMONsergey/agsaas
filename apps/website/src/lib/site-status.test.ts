import { expect, test } from "bun:test";
import { checkSiteStatus } from "./site-status";

test("status describes only successful own probes", async () => {
  const urls: string[] = [];
  const result = await checkSiteStatus(
    "https://api.example.test",
    "https://app.example.test",
    async (url) => {
      urls.push(url);
      return url.endsWith("/health/ready")
        ? Response.json({ status: "ok" })
        : new Response("login", { status: 200 });
    },
  );
  expect(result.probes.map((x) => x.state)).toEqual(["available", "available"]);
  expect(urls).toEqual([
    "https://api.example.test/health/ready",
    "https://app.example.test/login",
  ]);
  expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
});
test("dependency failure and redirected login are degraded", async () => {
  const result = await checkSiteStatus(
    "https://api.example.test",
    "https://app.example.test",
    async (url) =>
      url.endsWith("/health/ready")
        ? Response.json({ status: "degraded" }, { status: 503 })
        : new Response(null, { status: 302 }),
  );
  expect(result.probes.map((x) => x.state)).toEqual(["degraded", "degraded"]);
});
test("network failure never becomes an operational claim", async () => {
  const result = await checkSiteStatus(
    "https://api.example.test",
    "https://app.example.test",
    async () => {
      throw new Error("fixture transport failure");
    },
  );
  expect(result.probes.map((x) => x.state)).toEqual(["unknown", "unknown"]);
});
