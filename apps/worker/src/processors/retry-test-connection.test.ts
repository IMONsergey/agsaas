import { describe, expect, test } from "bun:test";
import { readRetryTestConnection } from "./fixtures/retry-test-connection";

describe("worker retry Redis test opt-in", () => {
  test("does not connect unless explicitly configured", () => {
    expect(readRetryTestConnection(undefined)).toBeUndefined();
  });

  test.each([
    { url: "redis://127.0.0.1:16379/15", host: "127.0.0.1", port: 16379 },
    { url: "redis://localhost/15", host: "localhost", port: 6379 },
    { url: "redis://[::1]:16379/15", host: "::1", port: 16379 },
  ])("accepts explicit loopback DB 15: $host", ({ url, host, port }) => {
    expect(readRetryTestConnection(url)).toMatchObject({ host, port, db: 15 });
  });

  test.each([
    { label: "empty", url: "" },
    { label: "non-URL", url: "private-not-a-url" },
    { label: "remote", url: "redis://redis.example.test/15" },
    { label: "compose service", url: "redis://redis/15" },
    { label: "TLS", url: "rediss://127.0.0.1/15" },
    { label: "implicit database", url: "redis://127.0.0.1" },
    { label: "database zero", url: "redis://127.0.0.1/0" },
    { label: "database one", url: "redis://127.0.0.1/1" },
    {
      label: "credentials",
      url: "redis://fixture-user:private-password@127.0.0.1/15",
    },
    {
      label: "query override",
      url: "redis://127.0.0.1/15?host=remote.example.test",
    },
    { label: "empty query", url: "redis://127.0.0.1/15?" },
    { label: "fragment", url: "redis://127.0.0.1/15#private-fragment" },
    { label: "empty fragment", url: "redis://127.0.0.1/15#" },
    { label: "port zero", url: "redis://127.0.0.1:0/15" },
  ])("rejects $label without returning the input", ({ url }) => {
    let error: unknown;
    try {
      readRetryTestConnection(url);
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "REDIS_TEST_URL must explicitly select loopback redis:// DB 15 without credentials, query or fragment",
    );
    expect((error as Error).message).not.toContain("private-password");
    expect((error as Error).message).not.toContain("private-fragment");
  });
});
