import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpContext } from "@api/mcp/types";
import type { Context as ApiContext } from "@api/rest/types";
import type { Scope } from "@api/utils/scopes";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ExportFileAccessReceipt } from "@midday/db/queries/export-file-access";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mockDb, mocks } from "./setup";

const teamId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";
const transactionId = "55555555-5555-4555-8555-555555555555";
const attachmentId = "66666666-6666-4666-8666-666666666666";
const teamOperation = "a".repeat(64);
const transactionOperation = "c".repeat(64);
const archiveHash = "b".repeat(64);
const teamPath = [teamId, "exports", teamOperation, archiveHash + ".zip"].join(
  "/",
);
const transactionPath = [
  teamId,
  "exports",
  transactionOperation,
  archiveHash + ".zip",
].join("/");
const legacyPath = teamId + "/exports/team-export-2026-11-03-1200.zip";
const ordinaryPath = teamId + "/documents/receipt.pdf";
const readScopes: Scope[] = [
  "documents.read",
  "transactions.read",
  "inbox.read",
];
const db = mockDb as unknown as ApiContext["Variables"]["db"];

function receipt(
  kind: "team" | "transactions",
  operation: string,
): ExportFileAccessReceipt {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    team_id: teamId,
    operation_key: operation,
    snapshot_hash: "d".repeat(64),
    snapshot_kind: kind,
    snapshot_version: "1",
    snapshot_at: "2026-11-03T12:00:00.000Z",
    transaction_assets_safe: kind === "transactions",
    result: {
      operationId: operation,
      snapshotId: "77777777-7777-4777-8777-777777777777",
      snapshotHash: "d".repeat(64),
      archiveHash,
      fullPath: [teamId, "exports", operation, archiveHash + ".zip"].join("/"),
      totalItems: 1,
      missingFiles: 0,
      status: "complete",
    },
  };
}

let receiptRows: ExportFileAccessReceipt[] = [];
const getReceipts = mock(
  async (
    _db: unknown,
    input: { teamId: string; operationIds: readonly string[] },
  ) =>
    receiptRows.filter(
      (row) =>
        row.team_id === input.teamId &&
        input.operationIds.includes(row.operation_key),
    ),
);
const download = mock(async () => ({
  data: new Blob(["ordinary fixture"]),
  error: null,
}));
const triggerJobAndWait = mock(async () => ({
  result: { fullPath: transactionPath, totalItems: 1 },
}));
// Preserve the existing fixture query exports while installing an explicitly
// owned app lookup before importing the REST/MCP consumers. setup.ts provides
// this export inline; it deliberately has no mocks.getAppByAppId property.
type AppLookup = typeof import("@midday/db/queries").getAppByAppId;
type AppFixture = Pick<NonNullable<Awaited<ReturnType<AppLookup>>>, "config">;
const getAppByAppId = mock(
  async (..._args: Parameters<AppLookup>): Promise<AppFixture | null> => null,
);
const existingQueryFixtures = { ...(await import("@midday/db/queries")) };
mock.module("@midday/db/queries", () => ({
  ...existingQueryFixtures,
  getAppByAppId,
}));
mock.module("@midday/db/queries/export-file-access", () => ({
  getExportFileAccessReceipts: getReceipts,
}));
mock.module("@midday/supabase/storage", () => ({
  signedUrl: mocks.signedUrl,
  download,
  remove: mock(async () => ({ error: null })),
}));
mock.module("@midday/job-client", () => ({
  triggerJob: mocks.triggerJob,
  triggerJobAndWait,
  getJobStatus: mocks.getJobStatus,
  removeInboxSyncScheduler: mocks.removeInboxSyncScheduler,
}));

const { documentsRouter } = await import("../rest/routers/documents");
const { inboxRouter } = await import("../rest/routers/inbox");
const { transactionsRouter } = await import("../rest/routers/transactions");
const { registerDocumentTools } = await import("../mcp/tools/documents");
const { registerInboxTools } = await import("../mcp/tools/inbox");
const { registerTransactionTools } = await import("../mcp/tools/transactions");

function document(path: string, id = documentId) {
  return {
    id,
    name: path,
    pathTokens: path.split("/"),
    title: null,
    metadata: { size: 12, mimetype: "application/zip" },
    processingStatus: "completed",
    summary: null,
    date: null,
  };
}

/**
 * The router fixture installs already-authenticated server context. Actual
 * signed JWT, opaque API-key/OAuth and file-capability authentication is
 * exercised separately in auth/file-access.test.ts, without replacing auth.
 */
function restApp({
  scopes = readScopes,
  authType = "api-key",
  boundSessionId,
}: {
  scopes?: Scope[];
  authType?: "session" | "api-key" | "oauth";
  boundSessionId?: string;
} = {}) {
  const app = new OpenAPIHono<ApiContext>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("teamId", teamId);
    c.set("session", {
      user: { id: userId, email: "fixture@example.test" },
      ...(boundSessionId && { sessionId: boundSessionId }),
    });
    c.set("authType", authType);
    c.set("scopes", scopes);
    await next();
  });
  app.route("/documents", documentsRouter);
  app.route("/inbox", inboxRouter);
  app.route("/transactions", transactionsRouter);
  return app;
}

beforeEach(() => {
  receiptRows = [
    receipt("team", teamOperation),
    receipt("transactions", transactionOperation),
  ];
  getReceipts.mockClear();
  getReceipts.mockImplementation(async (_db, input) =>
    receiptRows.filter(
      (row) =>
        row.team_id === input.teamId &&
        input.operationIds.includes(row.operation_key),
    ),
  );
  mocks.signedUrl.mockReset();
  mocks.signedUrl.mockImplementation(async () => ({
    data: { signedUrl: "https://storage.fixture.invalid/signed" },
    error: null,
  }));
  download.mockClear();
  mocks.getDocuments.mockReset();
  mocks.getDocumentById.mockReset();
  mocks.getInboxById.mockReset();
  mocks.getTransactionAttachment.mockReset();
  mocks.triggerJob.mockClear();
  mocks.getJobStatus.mockReset();
  getAppByAppId.mockReset();
  triggerJobAndWait.mockClear();
  mocks.getDocumentById.mockImplementation(() => document(teamPath));
  mocks.getInboxById.mockImplementation(() => ({
    id: documentId,
    filePath: teamPath.split("/"),
    fileName: "archive.zip",
  }));
  mocks.getTransactionAttachment.mockImplementation(() => ({
    id: attachmentId,
    path: teamPath.split("/"),
    name: "archive.zip",
  }));
  mocks.getDocuments.mockImplementation(() => ({
    data: [
      document(ordinaryPath),
      document(teamPath, "88888888-8888-4888-8888-888888888888"),
      document(transactionPath, "99999999-9999-4999-8999-999999999999"),
      document(legacyPath, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ],
    meta: { cursor: "next-page", hasNextPage: true, hasPreviousPage: false },
  }));
});

describe("REST reserved export file authority", () => {
  for (const authType of ["api-key", "oauth"] as const) {
    test(
      authType +
        " documents.read cannot enumerate full, transaction or legacy export documents",
      async () => {
        const response = await restApp({
          authType,
          scopes: ["documents.read"],
        }).request("/documents");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(
          body.data.map((row: { pathTokens: string[] }) =>
            row.pathTokens.join("/"),
          ),
        ).toEqual([ordinaryPath]);
        expect(body.meta).toMatchObject({
          cursor: "next-page",
          hasNextPage: true,
        });
        expect(getReceipts).not.toHaveBeenCalled();
        expect(mocks.signedUrl).not.toHaveBeenCalled();
      },
    );

    test(
      authType +
        " broader scopes and a known document ID still cannot read or sign a full-team archive",
      async () => {
        const app = restApp({
          authType,
          scopes: [...readScopes, "transactions.write", "documents.write"],
          // A stray session field on a non-session auth context is not authority.
          boundSessionId: sessionId,
        });
        expect((await app.request("/documents/" + documentId)).status).toBe(
          403,
        );
        expect(
          (
            await app.request("/documents/" + documentId + "/presigned-url", {
              method: "POST",
            })
          ).status,
        ).toBe(403);
        expect(mocks.signedUrl).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
        expect(getReceipts).toHaveBeenCalledWith(db, {
          teamId,
          operationIds: [teamOperation],
        });
      },
    );
  }

  test("transaction archives require both the route scope and exact primary transaction receipt", async () => {
    mocks.getDocumentById.mockImplementation(() => document(transactionPath));
    const app = restApp();
    const response = await app.request("/documents");
    const body = await response.json();
    expect(
      body.data.map((row: { pathTokens: string[] }) =>
        row.pathTokens.join("/"),
      ),
    ).toEqual([ordinaryPath, transactionPath]);
    expect(
      (
        await app.request("/documents/" + documentId + "/presigned-url", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(mocks.signedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bucket: "vault", path: transactionPath }),
    );
    mocks.signedUrl.mockClear();
    expect(
      (
        await restApp({ scopes: ["documents.read"] }).request(
          "/documents/" + documentId + "/presigned-url",
          { method: "POST" },
        )
      ).status,
    ).toBe(403);
    expect(mocks.signedUrl).not.toHaveBeenCalled();
  });

  test("nested archives, unknown receipts and mismatched archive hashes never reach Storage", async () => {
    mocks.getDocumentById.mockImplementation(() => document(transactionPath));
    const app = restApp();
    const nested = receipt("transactions", transactionOperation);
    nested.transaction_assets_safe = false;
    const mismatched = receipt("transactions", transactionOperation);
    mismatched.result = {
      ...(mismatched.result as Record<string, unknown>),
      archiveHash: "e".repeat(64),
    };
    for (const rows of [[nested], [], [mismatched]]) {
      receiptRows = rows;
      const response = await app.request(
        "/documents/" + documentId + "/presigned-url",
        { method: "POST" },
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.signedUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  test("primary receipt failures are redacted and cannot fall back to an administrative signer", async () => {
    getReceipts.mockImplementation(async () => {
      throw new Error("postgres://secret:credential@private.invalid");
    });
    const response = await restApp().request(
      "/documents/" + documentId + "/presigned-url",
      { method: "POST" },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("credential");
    expect(mocks.signedUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  test("ordinary Vault documents preserve their scoped download path without archive metadata lookup", async () => {
    mocks.getDocumentById.mockImplementation(() => document(ordinaryPath));
    const response = await restApp({ scopes: ["documents.read"] }).request(
      "/documents/" + documentId + "/presigned-url",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(mocks.signedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: ordinaryPath }),
    );
    expect(getReceipts).not.toHaveBeenCalled();
  });

  test("verified interactive members preserve current and legacy full export access", async () => {
    const app = restApp({ authType: "session", boundSessionId: sessionId });
    for (const path of [teamPath, legacyPath]) {
      mocks.getDocumentById.mockImplementation(() => document(path));
      expect(
        (
          await app.request("/documents/" + documentId + "/presigned-url", {
            method: "POST",
          })
        ).status,
      ).toBe(200);
    }
    expect(mocks.signedUrl).toHaveBeenCalledTimes(2);
    expect(getReceipts).not.toHaveBeenCalled();
  });

  test("a session auth label without a verified session identity grants no full-export privilege", async () => {
    const response = await restApp({ authType: "session" }).request(
      "/documents/" + documentId + "/presigned-url",
      { method: "POST" },
    );
    expect(response.status).toBe(403);
    expect(mocks.signedUrl).not.toHaveBeenCalled();
  });

  test("Inbox and transaction attachment aliases cannot mint a full-team archive URL", async () => {
    const app = restApp();
    expect(
      (
        await app.request("/inbox/" + documentId + "/presigned-url", {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          "/transactions/" +
            transactionId +
            "/attachments/" +
            attachmentId +
            "/presigned-url",
          { method: "POST" },
        )
      ).status,
    ).toBe(403);
    expect(mocks.signedUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});

describe("MCP reserved export file authority over an actual in-memory transport", () => {
  let client: Client | undefined;
  let server: McpServer | undefined;
  async function connect(scopes: Scope[], boundSessionId?: string) {
    server = new McpServer({ name: "export-authority-fixture", version: "1" });
    const ctx: McpContext = {
      db,
      teamId,
      userId,
      userEmail: "fixture@example.test",
      ...(boundSessionId && { sessionId: boundSessionId }),
      scopes,
      apiUrl: "https://fixture.invalid",
      timezone: "UTC",
      locale: "en",
      countryCode: "US",
      dateFormat: null,
      timeFormat: 24,
    };
    registerDocumentTools(server, ctx);
    registerInboxTools(server, ctx);
    registerTransactionTools(server, ctx);
    client = new Client({ name: "export-authority-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }
  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  test("documents_list excludes privileged archive metadata but retains verified transaction archives", async () => {
    const mcp = await connect(readScopes);
    const result = await mcp.callTool({
      name: "documents_list",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      meta: { cursor: "next-page", hasNextPage: true },
      data: [
        { pathTokens: ordinaryPath.split("/") },
        { pathTokens: transactionPath.split("/") },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(teamOperation);
    expect(JSON.stringify(result)).not.toContain("team-export-");
  });

  test("documents_get cannot sign or embed a known full-team archive", async () => {
    const mcp = await connect(readScopes);
    const result = await mcp.callTool({
      name: "documents_get",
      arguments: { id: documentId, download: true },
    });
    expect(result.isError).toBe(true);
    expect(mocks.signedUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  test("ordinary documents use their canonical stored path once for signing and binary download", async () => {
    mocks.getDocumentById.mockImplementation(() => document(ordinaryPath));
    const mcp = await connect(["documents.read"]);
    const result = await mcp.callTool({
      name: "documents_get",
      arguments: { id: documentId, download: true },
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.signedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bucket: "vault", path: ordinaryPath }),
    );
    expect(download).toHaveBeenCalledWith(expect.anything(), {
      bucket: "vault",
      path: ordinaryPath,
    });
    expect(JSON.stringify(result)).toContain('"type":"resource"');
    expect(getReceipts).not.toHaveBeenCalled();
  });

  test("inbox_get cannot bypass reserved export authority through an attachment alias", async () => {
    const mcp = await connect(["inbox.read", "transactions.read"]);
    const result = await mcp.callTool({
      name: "inbox_get",
      arguments: { id: documentId, download: true },
    });
    expect(result.isError).toBe(true);
    expect(mocks.signedUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  test("export_job_status restricts job kind before accepting a returned archive path", async () => {
    mocks.getJobStatus.mockImplementation(async () => ({
      status: "completed",
      result: { fullPath: teamPath },
    }));
    const mcp = await connect(["transactions.read", "transactions.write"]);
    const result = await mcp.callTool({
      name: "export_job_status",
      arguments: { jobId: "transactions:42" },
    });
    expect(mocks.getJobStatus).toHaveBeenCalledWith("transactions:42", {
      teamId,
      allowedJobNames: ["export-transactions", "export-to-accounting"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(teamPath);
    expect(mocks.signedUrl).not.toHaveBeenCalled();
  });

  test("transactions.write alone cannot enqueue a data export or read job output", async () => {
    const mcp = await connect(["transactions.write"]);
    const exportResult = await mcp.callTool({
      name: "transactions_export",
      arguments: { transactionIds: [transactionId] },
    });
    const statusResult = await mcp.callTool({
      name: "export_job_status",
      arguments: { jobId: "transactions:42" },
    });
    expect(exportResult.isError).toBe(true);
    expect(statusResult.isError).toBe(true);
    expect(mocks.triggerJob).not.toHaveBeenCalled();
    expect(triggerJobAndWait).not.toHaveBeenCalled();
    expect(mocks.getJobStatus).not.toHaveBeenCalled();
    expect(mocks.signedUrl).not.toHaveBeenCalled();
  });

  test("transactions.write alone cannot read integration configuration or enqueue an accounting export", async () => {
    // This configured app would reach triggerJob without the read-scope guard.
    getAppByAppId.mockImplementation(async () => ({
      config: {
        provider: "xero",
        tenantId: "fixture-org",
        tenantName: "Fixture organization",
      },
    }));
    const mcp = await connect(["transactions.write"]);
    const result = await mcp.callTool({
      name: "transactions_export_to_accounting",
      arguments: { transactionIds: [transactionId], providerId: "xero" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("transactions.read is required");
    expect(getAppByAppId).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
    expect(triggerJobAndWait).not.toHaveBeenCalled();
    expect(mocks.signedUrl).not.toHaveBeenCalled();
  });

  test("server-bound interactive MCP members retain full archive access", async () => {
    const mcp = await connect(["documents.read"], sessionId);
    const result = await mcp.callTool({
      name: "documents_get",
      arguments: { id: documentId },
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.signedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: teamPath }),
    );
    expect(getReceipts).not.toHaveBeenCalled();
  });
});
