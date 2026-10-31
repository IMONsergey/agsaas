import { describe, expect, test } from "bun:test";
import { parseRedisQueueUrl, RedisQueueUrlError } from "./redis-url";

describe("Redis queue URL identity", () => {
  test("keeps the existing plain Redis defaults", () => {
    expect(parseRedisQueueUrl("redis://redis.internal")).toEqual({
      host: "redis.internal",
      port: 6379,
      username: undefined,
      password: undefined,
    });
    expect(parseRedisQueueUrl("redis://redis.internal/")).toEqual(
      parseRedisQueueUrl("redis://redis.internal"),
    );
  });

  test("preserves TLS and the explicit port and database", () => {
    expect(
      parseRedisQueueUrl("rediss://user:password@redis.internal:6380/15"),
    ).toEqual({
      host: "redis.internal",
      port: 6380,
      username: "user",
      password: "password",
      db: 15,
      tls: {},
    });
  });

  test("decodes credentials once without treating a plus as a space", () => {
    expect(
      parseRedisQueueUrl("redis://user%40team:p%3Aa%2Fs%2525+word@localhost/0"),
    ).toMatchObject({
      username: "user@team",
      password: "p:a/s%25+word",
      db: 0,
    });
  });

  test("supports password-only URLs and an IPv6 literal", () => {
    expect(parseRedisQueueUrl("redis://:password@[::1]:6380/2")).toMatchObject({
      host: "::1",
      port: 6380,
      username: undefined,
      password: "password",
      db: 2,
    });
  });

  test.each([
    undefined,
    "",
    "not a URL",
    "http://localhost/0",
    "redis:///0",
    "redis:localhost",
    " redis://localhost/0",
    "redis://localhost/0\n",
    "redis://localhost:0/0",
    "redis://localhost:65536/0",
    "redis://localhost/-1",
    "redis://localhost/1.5",
    "redis://localhost/1/2",
    "redis://localhost/1x",
    "redis://localhost/9007199254740992",
    "redis://localhost/0?db=1",
    "redis://localhost/0?",
    "redis://localhost/0#fragment",
    "redis://localhost/0#",
    "redis://user:invalid%ZZ@localhost/0",
  ])("rejects invalid or ambiguous identity %#", (value) => {
    expect(() => parseRedisQueueUrl(value)).toThrow(RedisQueueUrlError);
  });

  test("configuration errors never disclose credentials", () => {
    try {
      parseRedisQueueUrl(
        "redis://private-user:private-secret@localhost/not-a-db",
      );
      throw new Error("Expected a configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(RedisQueueUrlError);
      expect(String(error)).not.toContain("private-user");
      expect(String(error)).not.toContain("private-secret");
      expect(String(error)).not.toContain("redis://");
    }
  });
});
