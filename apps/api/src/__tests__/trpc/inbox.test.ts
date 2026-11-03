import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { inboxRouter } from "../../trpc/routers/inbox";
import {
  createInboxListResponse,
  createMinimalInboxResponse,
  createValidInboxResponse,
} from "../factories/inbox";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const createCaller = createCallerFactory(inboxRouter);

describe("tRPC: inbox.get", () => {
  beforeEach(() => {
    mocks.getInbox.mockReset();
    mocks.getInbox.mockImplementation(() => createInboxListResponse());
  });

  test("returns inbox list", async () => {
    mocks.getInbox.mockImplementation(() =>
      createInboxListResponse([createValidInboxResponse()]),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.get({});

    expect(result.data).toHaveLength(1);
    expect(result.meta.hasNextPage).toBe(false);
  });

  test("handles minimal inbox data", async () => {
    mocks.getInbox.mockImplementation(() =>
      createInboxListResponse([createMinimalInboxResponse()]),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.get({});

    expect(result.data[0]!.transactionId).toBeNull();
  });

  test("handles empty list", async () => {
    mocks.getInbox.mockImplementation(() => createInboxListResponse([]));

    const caller = createCaller(createTestContext());
    const result = await caller.get({});

    expect(result.data).toHaveLength(0);
  });
});

describe("tRPC: inbox.getById", () => {
  beforeEach(() => {
    mocks.getInboxById.mockReset();
  });

  test("returns single inbox item", async () => {
    mocks.getInboxById.mockImplementation(() => createValidInboxResponse());

    const caller = createCaller(createTestContext());
    const result = await caller.getById({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    });

    expect(result?.id).toBe("a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
  });

  test("returns null for non-existent item", async () => {
    mocks.getInboxById.mockImplementation(() => null);

    const caller = createCaller(createTestContext());
    const result = await caller.getById({
      id: "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    });

    expect(result).toBeNull();
  });
});

describe("tRPC: inbox.update", () => {
  beforeEach(() => {
    mocks.updateInbox.mockReset();
    mocks.updateInbox.mockImplementation(() => createValidInboxResponse());
  });

  test("updates inbox item successfully", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.update({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      status: "done",
    });

    expect(result).toBeDefined();
  });
});

describe("tRPC: inbox.delete", () => {
  beforeEach(() => {
    mocks.deleteInbox.mockReset();
    mocks.deleteInbox.mockImplementation(() => ({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      filePath: null,
      cleanupPending: false,
      cleanupId: null,
    }));
  });

  test("deletes inbox item successfully", async () => {
    const caller = createCaller(createTestContext());
    expect(
      await caller.delete({ id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }),
    ).toEqual({
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      filePath: null,
      cleanupPending: false,
      cleanupId: null,
    });
    expect(mocks.deleteInbox).toHaveBeenCalledWith(expect.anything(), {
      id: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      teamId: "test-team-id",
    });
  });
});

describe("tRPC: inbox.getByStatus", () => {
  beforeEach(() => {
    mocks.getInboxByStatus.mockReset();
    mocks.getInboxByStatus.mockImplementation(() => [
      { id: "item-1", displayName: "Test", status: "pending" },
    ]);
  });

  test("returns inbox items by status", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.getByStatus({ status: "pending" });

    expect(result).toHaveLength(1);
  });
});

const INBOX_NEW_ID = "b3b7c1e2-4c2a-4e7a-9c1a-2b7c1e24c2a4";
const UPLOAD_TEAM_ID = "d9ea81b7-9e02-4c12-b2c3-dcaeb6c4d311";

function createUploadContext() {
  const ctx = createTestContext({ teamId: UPLOAD_TEAM_ID });
  const db = {
    ...ctx.db,
    query: {
      ...ctx.db.query,
      users: {
        findFirst: async () => ({
          id: ctx.session.user.id,
          teamId: UPLOAD_TEAM_ID,
          usersOnTeams: [{ id: "upload-membership", teamId: UPLOAD_TEAM_ID }],
        }),
      },
    },
  };
  db.usePrimaryOnly = () => db;
  return { ...ctx, db };
}

describe("tRPC: inbox.create", () => {
  beforeEach(() => {
    mocks.createInbox.mockReset();
    mocks.createInbox.mockImplementation(() =>
      Promise.resolve({ id: INBOX_NEW_ID }),
    );
  });

  test("creates inbox row from upload metadata", async () => {
    const caller = createCaller(createUploadContext());
    const result = await caller.create({
      filename: "invoice.pdf",
      mimetype: "application/pdf",
      size: 2048,
      filePath: [UPLOAD_TEAM_ID, "inbox", "invoice.pdf"],
    });

    expect(result).toMatchObject({ id: INBOX_NEW_ID });
    expect(mocks.createInbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: UPLOAD_TEAM_ID,
        displayName: "invoice.pdf",
        fileName: "invoice.pdf",
        filePath: [UPLOAD_TEAM_ID, "inbox", "invoice.pdf"],
        contentType: "application/pdf",
        size: 2048,
        status: "processing",
      }),
    );
  });

  test("rejects another team's file before writing inbox metadata", async () => {
    const caller = createCaller(createUploadContext());
    await expect(
      caller.create({
        filename: "invoice.pdf",
        mimetype: "application/pdf",
        size: 2048,
        filePath: [
          "b02dd84b-5fb6-4e66-9ed1-c63164715b8d",
          "inbox",
          "invoice.pdf",
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.createInbox).not.toHaveBeenCalled();
  });
});

describe("tRPC: inbox.deleteMany", () => {
  beforeEach(() => {
    mocks.deleteInboxMany.mockReset();
    mocks.deleteInboxMany.mockImplementation(() =>
      Promise.resolve([
        {
          id: INBOX_NEW_ID,
          filePath: null,
          cleanupPending: false,
          cleanupId: null,
        },
      ]),
    );
  });

  test("deletes multiple inbox items by id", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.deleteMany([INBOX_NEW_ID]);

    expect(result).toEqual([
      {
        id: INBOX_NEW_ID,
        filePath: null,
        cleanupPending: false,
        cleanupId: null,
      },
    ]);
    expect(mocks.deleteInboxMany).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ids: [INBOX_NEW_ID],
        teamId: "test-team-id",
      }),
    );
  });
  test("an attached object's deferred cleanup remains visible in the response", async () => {
    const receipt = {
      id: INBOX_NEW_ID,
      filePath: ["test-team-id", "inbox", "invoice.pdf"],
      cleanupPending: true,
      cleanupId: "1cccb8f3-febf-4d7f-969b-60b3d3fe166d",
    };
    mocks.deleteInboxMany.mockImplementationOnce(() =>
      Promise.resolve([receipt]),
    );
    expect(
      await createCaller(createTestContext()).deleteMany([INBOX_NEW_ID]),
    ).toEqual([receipt]);
  });
});

describe("tRPC: inbox.search", () => {
  beforeEach(() => {
    mocks.getInboxSearch.mockReset();
    mocks.getInboxSearch.mockImplementation(() => Promise.resolve([]));
  });

  test("searches inbox with query string", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.search({ q: "test" });

    expect(result).toEqual([]);
    expect(mocks.getInboxSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "test-team-id",
        q: "test",
        limit: 10,
      }),
    );
  });
});
