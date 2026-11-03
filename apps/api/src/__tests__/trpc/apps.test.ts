import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { appsRouter } from "../../trpc/routers/apps";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const createCaller = createCallerFactory(appsRouter);

describe("tRPC: apps.get", () => {
  beforeEach(() => {
    mocks.getApps.mockReset();
    mocks.getApps.mockImplementation(() => Promise.resolve([]));
  });

  test("returns apps for team", async () => {
    const caller = createCaller(createTestContext());

    expect(await caller.get()).toEqual([]);
    expect(mocks.getApps).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("returns integrations when query returns rows", async () => {
    mocks.getApps.mockImplementation(() =>
      Promise.resolve([{ app_id: "slack", settings: null, config: null }]),
    );

    const caller = createCaller(createTestContext());

    expect(await caller.get()).toEqual([
      { app_id: "slack", settings: null, config: null },
    ]);
  });
});


test("apps.get strips credentials at the transport boundary even from an unsanitized query result", async () => {
  const secret = "fixture-private-token";
  mocks.getApps.mockImplementation(() => Promise.resolve([
    { app_id: "slack", settings: null, config: { access_token: secret, team_name: "Workspace" } },
    { app_id: "xero", settings: null, config: { provider: "xero", accessToken: secret, refreshToken: secret, tenantName: "Company" } },
    { app_id: "future-provider", settings: null, config: { unknown: secret } },
  ]));
  const caller = createCaller(createTestContext());
  const result = await caller.get();
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result[0]?.config).toEqual({ team_name: "Workspace" });
  expect(result[1]?.config).toEqual({ provider: "xero", tenantName: "Company" });
  expect(result[2]?.config).toBeNull();
});
