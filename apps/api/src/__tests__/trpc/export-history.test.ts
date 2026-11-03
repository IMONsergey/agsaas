import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  getTeamExportHistoryById,
  listTeamExportHistory,
} from "@midday/db/queries/export-snapshots";
import type { consumeRequestBudget } from "@midday/db/queries/resource-admission";
import { createTestContext } from "../helpers/test-context";
import { mockDb, mocks } from "../setup";

const USER = "44444444-4444-4444-8444-444444444444";
const TEAM = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "33333333-3333-4333-8333-333333333333";
const ENTRY = "22222222-2222-4222-8222-222222222222";
class TestBudgetExceededError extends Error {
  readonly retryAfterSeconds = 60;
}
const consumeBudget = mock(
  async (..._args: Parameters<typeof consumeRequestBudget>): Promise<void> =>
    undefined,
);
mock.module("@midday/db/queries/resource-admission", () => ({
  consumeRequestBudget: consumeBudget,
  ResourceBudgetExceededError: TestBudgetExceededError,
}));
const createContext = (teamId = TEAM) =>
  createTestContext({ teamId, userId: USER });
const listHistory = mock(
  async (
    _db: unknown,
    input: { teamId: string },
  ): Promise<Awaited<ReturnType<typeof listTeamExportHistory>>> => ({
    teamId: input.teamId,
    items: [],
    nextCursor: null,
  }),
);
const getHistory = mock(
  async (
    _db: unknown,
    input: { teamId: string },
  ): Promise<Awaited<ReturnType<typeof getTeamExportHistoryById>>> => ({
    teamId: input.teamId,
    item: null,
  }),
);
mock.module("@midday/db/queries/export-snapshots", () => ({
  listTeamExportHistory: listHistory,
  getTeamExportHistoryById: getHistory,
}));
const { createCallerFactory } = await import("../../trpc/init");
const { teamRouter } = await import("../../trpc/routers/team");
const createCaller = createCallerFactory(teamRouter);
const user = () => ({
  id: USER,
  teamId: TEAM,
  email: "test@example.com",
  usersOnTeams: [{ id: "membership-1", teamId: TEAM, role: "member" }],
});

beforeEach(() => {
  mockDb.query.users.findFirst.mockReset();
  mockDb.query.users.findFirst.mockImplementation(async () => user());
  consumeBudget.mockClear();
  listHistory.mockClear();
  getHistory.mockClear();
  mocks.triggerJob.mockClear();
});

describe("tRPC team export history uses the full export session boundary", () => {
  test("ordinary current members can read; primary membership overrides a forged context team", async () => {
    const result = await createCaller(createContext(FOREIGN)).exportHistory({
      limit: 5,
    });
    expect(result).toEqual({ teamId: TEAM, items: [], nextCursor: null });
    expect(consumeBudget).toHaveBeenCalledTimes(1);
    expect(consumeBudget).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      teamId: TEAM,
      cost: 20,
    });
    expect(listHistory).toHaveBeenCalledWith(expect.anything(), {
      teamId: TEAM,
      limit: 5,
      cursor: undefined,
    });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("lookup passes only the current team and exact entry ID, with absence remaining absence", async () => {
    const result = await createCaller(createContext()).exportHistoryEntry({
      id: ENTRY,
    });
    expect(getHistory).toHaveBeenCalledWith(expect.anything(), {
      teamId: TEAM,
      id: ENTRY,
    });
    expect(result).toEqual({ teamId: TEAM, item: null });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("an anonymous caller cannot reach either history query", async () => {
    const context = createContext();
    context.session = null;
    const caller = createCaller(context);
    await expect(caller.exportHistory({ limit: 5 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.exportHistoryEntry({ id: ENTRY }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(listHistory).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("revoked membership cannot read even with a formerly valid team context", async () => {
    mockDb.query.users.findFirst.mockImplementation(async () => ({
      ...user(),
      usersOnTeams: [],
    }));
    const caller = createCaller(createContext());
    await expect(caller.exportHistory({ limit: 5 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.exportHistoryEntry({ id: ENTRY }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(listHistory).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("a profile without a current team does not use a browser-supplied fallback", async () => {
    mockDb.query.users.findFirst.mockImplementation(async () => ({
      ...user(),
      teamId: null,
      usersOnTeams: [],
    }));
    const caller = createCaller(createContext(FOREIGN));
    await expect(caller.exportHistory({ limit: 5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(listHistory).not.toHaveBeenCalled();
  });

  test("strict inputs reject a supplied team or archive path", async () => {
    const caller = createCaller(createContext());
    const forgedList = { limit: 5, teamId: FOREIGN };
    const forgedEntry = { id: ENTRY, path: `${FOREIGN}/exports/private.zip` };
    await expect(caller.exportHistory(forgedList)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.exportHistoryEntry(forgedEntry)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(listHistory).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("page bounds and timestamp precision are enforced before the history read", async () => {
    const caller = createCaller(createContext());
    for (const limit of [0, 26, 1.5]) {
      await expect(caller.exportHistory({ limit })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    await expect(
      caller.exportHistory({
        limit: 5,
        cursor: { id: ENTRY, createdAt: "2026-11-03T12:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listHistory).not.toHaveBeenCalled();
    const cursor = { id: ENTRY, createdAt: "2026-11-03T12:00:00.000001Z" };
    await caller.exportHistory({ limit: 25, cursor });
    expect(listHistory).toHaveBeenCalledWith(expect.anything(), {
      teamId: TEAM,
      limit: 25,
      cursor,
    });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});
