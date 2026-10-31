import { describe, expect, mock, test } from "bun:test";
import { pingRedisClient, type RedisProbeClient } from "./redis-probe";

function createClient() {
  return {
    connect: mock(async () => undefined),
    send: mock(async (_command: string, _args: string[]) => "PONG"),
    close: mock(() => undefined),
  } satisfies RedisProbeClient;
}

describe("Redis probe cleanup", () => {
  test("pings and closes its client on success", async () => {
    const client = createClient();

    expect(await pingRedisClient(client)).toBe(true);
    expect(client.send).toHaveBeenCalledWith("PING", []);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("closes the client after a connection failure", async () => {
    const client = createClient();
    const error = new Error("connection failed");
    client.connect.mockRejectedValueOnce(error);

    await expect(pingRedisClient(client)).rejects.toBe(error);
    expect(client.send).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("closes the client after a PING failure", async () => {
    const client = createClient();
    const error = new Error("PING failed");
    client.send.mockRejectedValueOnce(error);

    await expect(pingRedisClient(client)).rejects.toBe(error);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("does not replace a connection error with a cleanup error", async () => {
    const client = createClient();
    const error = new Error("original failure");
    client.connect.mockRejectedValueOnce(error);
    client.close.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    await expect(pingRedisClient(client)).rejects.toBe(error);
  });

  test("reports a cleanup failure after an otherwise successful probe", async () => {
    const client = createClient();
    const error = new Error("cleanup failed");
    client.close.mockImplementationOnce(() => {
      throw error;
    });

    await expect(pingRedisClient(client)).rejects.toBe(error);
  });
});
