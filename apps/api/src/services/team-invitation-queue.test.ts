import { describe, expect, test } from "bun:test";
import { enqueueTeamInvitations } from "./team-invitation-queue";

const scope = {
  teamId: "7b28be0d-0722-4559-a5fb-36b29dd408cd",
  inviteId: "72ea4153-3151-4b51-8f84-c7b27c4bb303",
  deliveryId: "b6452d1d-c8c8-4c24-b546-bd7ca86f8d9c",
};
describe("durable invitation queue wake-up", () => {
  test("publishes only scoped IDs with a stable deduplication key", async () => {
    const calls: unknown[] = [];
    await enqueueTeamInvitations([scope], async (...args) => {
      calls.push(args);
      return { id: "job" };
    });
    expect(calls).toEqual([
      [
        "deliver-team-invitation",
        scope,
        "teams",
        { jobId: "team-invite-b6452d1d-c8c8-4c24-b546-bd7ca86f8d9c" },
      ],
    ]);
  });
  test("Redis rejection cannot turn committed invitations into a failed creation", async () => {
    await expect(
      enqueueTeamInvitations([scope], async () => {
        throw new Error("Redis unavailable");
      }),
    ).resolves.toBeUndefined();
  });
  test("a disconnected Redis connection cannot indefinitely hold the HTTP response", async () => {
    const start = performance.now();
    await enqueueTeamInvitations([scope], () => new Promise(() => {}), 5);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
