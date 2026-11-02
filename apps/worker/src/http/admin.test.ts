import { describe, expect, it, mock } from "bun:test";
import type { JobsOptions, Queue } from "bullmq";
import { Hono } from "hono";
import { createWorkerAdminApp, getWorkerAdminAuth } from "./admin";

const auth = { username: "local-admin", password: "local-test:password" };
const authorization = `Basic ${btoa(`${auth.username}:${auth.password}`)}`;

function makeQueue() {
  const add = mock(
    async (_name: string, _data: unknown, _options?: JobsOptions) => ({
      id: "local-job",
    }),
  );
  // The real adapter is used; omitting connection prevents Redis I/O.
  const queue = { name: "local-test", opts: {}, add } as unknown as Queue;
  return { queue, add };
}

const adminRequests = [
  ["GET", "/admin"],
  ["GET", "/admin/queues/local-test"],
  ["GET", "/admin/config"],
  ["GET", "/admin/api/queue-names"],
  ["POST", "/admin/api/test"],
  ["POST", "/admin/api/refresh"],
  ["GET", "/info"],
] as const;

describe("worker administration configuration", () => {
  it("disabled administration has an idempotent no-op close", async () => {
    const app = createWorkerAdminApp({ queues: [] });
    const first = app.close();
    expect(app.close()).toBe(first);
    await first;
    expect((await app.request("/admin/config")).status).toBe(404);
  });

  it("enabled administration closes without owning its supplied queues", async () => {
    const { queue } = makeQueue();
    const close = mock(async () => {});
    queue.close = close;
    const app = createWorkerAdminApp({ queues: [queue], auth });
    const first = app.close();
    expect(app.close()).toBe(first);
    await first;
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { BOARD_USERNAME: "local-admin" },
    { BOARD_PASSWORD: "local-password" },
    { BOARD_USERNAME: "", BOARD_PASSWORD: "local-password" },
    { BOARD_USERNAME: "local-admin", BOARD_PASSWORD: "" },
  ])("disables every admin route with incomplete credentials %j", async (env) => {
    const { queue, add } = makeQueue();
    const configuredAuth = getWorkerAdminAuth(env);
    expect(configuredAuth).toBeUndefined();
    const app = createWorkerAdminApp({ queues: [queue], auth: configuredAuth });

    for (const [method, path] of adminRequests) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(404);
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("preserves the configured password exactly", () => {
    expect(
      getWorkerAdminAuth({
        BOARD_USERNAME: auth.username,
        BOARD_PASSWORD: " password:with:colons ",
      }),
    ).toEqual({ username: auth.username, password: " password:with:colons " });
  });

  it("rejects incomplete auth passed directly to the router", async () => {
    const { queue } = makeQueue();
    const app = createWorkerAdminApp({
      queues: [queue],
      auth: { username: auth.username, password: "" },
    });
    expect((await app.request("/admin/config")).status).toBe(404);
  });

  it("does not mount administration when there are no queues", async () => {
    const app = createWorkerAdminApp({ queues: [], auth });
    expect(
      (await app.request("/info", { headers: { authorization } })).status,
    ).toBe(404);
  });
});

describe("worker administration authentication", () => {
  it.each(adminRequests)("requires auth for %s %s", async (method, path) => {
    const { queue, add } = makeQueue();
    const app = createWorkerAdminApp({ queues: [queue], auth });
    const response = await app.request(path, { method });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(add).not.toHaveBeenCalled();
  });

  it.each([
    `Basic ${btoa("wrong:local-test:password")}`,
    `Basic ${btoa("local-admin:wrong")}`,
    "Basic not-base64",
    "Bearer not-a-basic-credential",
  ])("rejects incorrect or malformed credentials %s", async (credential) => {
    const { queue, add } = makeQueue();
    const app = createWorkerAdminApp({ queues: [queue], auth });
    for (const path of ["/info", "/admin/config", "/admin/api/queue-names"]) {
      const response = await app.request(path, {
        headers: { authorization: credential },
      });
      expect(response.status).toBe(401);
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("serves the unchanged dashboard config to an authenticated administrator", async () => {
    const { queue } = makeQueue();
    const app = createWorkerAdminApp({ queues: [queue], auth });
    const response = await app.request("/admin/config", {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      title: "Midday Jobs",
      readonly: false,
      queues: ["local-test"],
      tags: ["teamId"],
    });
  });

  it("serves queue info only after authentication", async () => {
    const { queue } = makeQueue();
    const app = createWorkerAdminApp({ queues: [queue], auth });
    const response = await app.request("/info", { headers: { authorization } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      queues: [{ name: "local-test" }],
      dashboardUrl: "/admin/queues",
    });
  });

  it("authenticates before any queue mutation", async () => {
    const { queue, add } = makeQueue();
    const app = createWorkerAdminApp({ queues: [queue], auth });
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queueName: queue.name,
        jobName: "local-task",
        data: { test: true },
      }),
    };
    expect((await app.request("/admin/api/test", request)).status).toBe(401);
    expect(add).not.toHaveBeenCalled();

    const response = await app.request("/admin/api/test", {
      ...request,
      headers: { ...request.headers, authorization },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "local-job" });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.slice(0, 2)).toEqual([
      "local-task",
      { test: true },
    ]);
  });

  it.each([
    undefined,
    auth,
  ])("does not add auth requirements to liveness or readiness routes (%j)", async (configuredAuth) => {
    const { queue } = makeQueue();
    const app = new Hono();
    app.route(
      "/",
      createWorkerAdminApp({ queues: [queue], auth: configuredAuth }),
    );
    for (const path of ["/", "/health", "/health/ready"]) {
      app.get(path, (c) => c.json({ status: "ok" }));
    }
    for (const path of ["/", "/health", "/health/ready"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    }
  });
});
