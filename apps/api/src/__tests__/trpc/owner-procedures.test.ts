import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { apiKeysRouter } from "../../trpc/routers/api-keys";
import { appsRouter } from "../../trpc/routers/apps";
import { invoicePaymentsRouter } from "../../trpc/routers/invoice-payments";
import { teamRouter } from "../../trpc/routers/team";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const context = () => createTestContext();
beforeEach(() => {
  mocks.getTeamMemberRole.mockReset();
  mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("owner"));
  mocks.updateTeam.mockClear();
  mocks.upsertApiKey.mockClear();
  mocks.disconnectApp.mockClear();
  mocks.requestStripeDisconnect.mockClear();
});
describe("owner-only administration", () => {
  for (const role of ["member", null]) {
    test(`role ${role} cannot change team settings, keys, integrations or money`, async () => {
      mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve(role));
      const team = createCallerFactory(teamRouter)(context());
      const apps = createCallerFactory(appsRouter)(context());
      const keys = createCallerFactory(apiKeysRouter)(context());
      const payments = createCallerFactory(invoicePaymentsRouter)(context());
      const attempts = [
        () => team.update({ name: "Denied" }),
        () => keys.get(),
        () => keys.upsert({ name: "Denied", scopes: ["apis.all"] }),
        () => apps.disconnect({ appId: "slack" }),
        () => payments.disconnectStripe(),
        () =>
          payments.refundPayment({
            invoiceId: "00000000-0000-4000-8000-000000000001",
          }),
      ];
      for (const operation of attempts)
        await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.updateTeam).not.toHaveBeenCalled();
      expect(mocks.upsertApiKey).not.toHaveBeenCalled();
      expect(mocks.disconnectApp).not.toHaveBeenCalled();
      expect(mocks.requestStripeDisconnect).not.toHaveBeenCalled();
    });
  }
  test("owner list access remains usable and reads are not restricted for members", async () => {
    mocks.getApiKeysByTeam.mockImplementation(() => Promise.resolve([]));
    expect(await createCallerFactory(apiKeysRouter)(context()).get()).toEqual(
      [],
    );
    mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("member"));
    mocks.getApps.mockImplementation(() => Promise.resolve([]));
    expect(await createCallerFactory(appsRouter)(context()).get()).toEqual([]);
  });
  test("owner disconnect retains cleanup using the authenticated team and actor", async () => {
    const result = await createCallerFactory(invoicePaymentsRouter)(
      context(),
    ).disconnectStripe();
    expect(result.cleanupPending).toBe(true);
    expect(mocks.requestStripeDisconnect).toHaveBeenCalledTimes(1);
    expect(mocks.requestStripeDisconnect.mock.calls[0]?.[1]).toEqual({
      teamId: "test-team-id",
      actorUserId: "test-user-id",
    });
  });
});
