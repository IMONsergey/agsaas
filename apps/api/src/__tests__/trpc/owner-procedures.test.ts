import { beforeEach, describe, expect, test } from "bun:test";
import { mocks } from "../setup";
import { createTestContext } from "../helpers/test-context";
import { createCallerFactory } from "../../trpc/init";
import { teamRouter } from "../../trpc/routers/team";
import { appsRouter } from "../../trpc/routers/apps";
import { apiKeysRouter } from "../../trpc/routers/api-keys";
import { invoicePaymentsRouter } from "../../trpc/routers/invoice-payments";

const context = () => createTestContext();
beforeEach(() => {
  mocks.getTeamMemberRole.mockReset();
  mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("owner"));
  mocks.updateTeam.mockClear(); mocks.upsertApiKey.mockClear(); mocks.disconnectApp.mockClear();
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
        () => payments.refundPayment({ invoiceId: "00000000-0000-4000-8000-000000000001" }),
      ];
      for (const operation of attempts) await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.updateTeam).not.toHaveBeenCalled();
      expect(mocks.upsertApiKey).not.toHaveBeenCalled();
      expect(mocks.disconnectApp).not.toHaveBeenCalled();
    });
  }
  test("owner list access remains usable and reads are not restricted for members", async () => {
    mocks.getApiKeysByTeam.mockImplementation(() => Promise.resolve([]));
    expect(await createCallerFactory(apiKeysRouter)(context()).get()).toEqual([]);
    mocks.getTeamMemberRole.mockImplementation(() => Promise.resolve("member"));
    mocks.getApps.mockImplementation(() => Promise.resolve([]));
    expect(await createCallerFactory(appsRouter)(context()).get()).toEqual([]);
  });
});
