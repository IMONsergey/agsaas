import { expect, test } from "bun:test";
import { startCallbackServer } from "./callback";

test("unrelated and wrong-state error callbacks cannot consume a legitimate login", async () => {
  const listener = await startCallbackServer("fixture-expected-state");
  const url = "http://127.0.0.1:" + listener.port + "/callback";
  try {
    expect((await fetch(url + "?state=wrong&error=access_denied")).status).toBe(
      400,
    );
    expect(
      (
        await fetch(
          url +
            "?state=fixture-expected-state&state=fixture-expected-state&code=x",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url + "?state=fixture-expected-state&code=good-code", {
          method: "POST",
        })
      ).status,
    ).toBe(405);
    const response = await fetch(
      url + "?state=fixture-expected-state&code=good-code",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await listener.code).toBe("good-code");
    expect(
      (await fetch(url + "?state=fixture-expected-state&code=second-code"))
        .status,
    ).toBe(409);
  } finally {
    listener.close();
  }
});

test("valid-state rejection reaches the caller", async () => {
  const listener = await startCallbackServer("fixture-state");
  try {
    const response = await fetch(
      "http://127.0.0.1:" +
        listener.port +
        "/callback?state=fixture-state&error=denied",
    );
    expect(response.status).toBe(400);
    await expect(listener.code).rejects.toThrow("declined");
  } finally {
    listener.close();
  }
});

test("deadline rejects and releases the callback listener", async () => {
  const listener = await startCallbackServer("fixture-state", 30);
  await expect(listener.code).rejects.toThrow("timed out");
  await expect(
    fetch("http://127.0.0.1:" + listener.port + "/callback", {
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow();
});

test("explicit cancellation settles the callback without leaving a server", async () => {
  const listener = await startCallbackServer("fixture-state");
  listener.close();
  await expect(listener.code).rejects.toThrow("closed");
});
