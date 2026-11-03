import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInvoiceTools } from "../../mcp/tools/invoices";
import type { McpContext } from "../../mcp/types";
import { mocks, mockDb } from "../setup";

const id = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const operation = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "pending",
};
describe("MCP invoice atomic update boundary", () => {
  let client: Client;
  let server: McpServer;
  beforeEach(async () => {
    mocks.updateInvoiceWithIntent.mockReset();
    mocks.updateInvoice.mockClear();
    mocks.triggerJob.mockClear();
    mocks.getInvoiceById.mockReset();
    mocks.getInvoiceById.mockImplementation(() => ({ id, status: "draft" }));
    server = new McpServer({ name: "invoice-fixture", version: "1" });
    registerInvoiceTools(server, {
      db: mockDb as unknown as McpContext["db"],
      teamId: "test-team-id",
      userId: "test-user-id",
      userEmail: "fixture@example.test",
      scopes: ["invoices.write"],
      apiUrl: "https://fixture.invalid",
      timezone: "UTC",
      locale: "en",
      countryCode: "US",
      dateFormat: null,
      timeFormat: 24,
    });
    client = new Client({ name: "invoice-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });
  afterEach(async () => {
    await client?.close();
    await server?.close();
  });
  test("generic unpaid update returns the durable receipt and never calls primitive writes or Redis", async () => {
    mocks.updateInvoiceWithIntent.mockImplementation(() => ({
      id,
      status: "unpaid",
      operation,
    }));
    const result = await client.callTool({
      name: "invoices_update",
      arguments: { id, status: "unpaid" },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain(operation.id);
    expect(mocks.updateInvoiceWithIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id,
        teamId: "test-team-id",
        userId: "test-user-id",
        status: "unpaid",
      }),
    );
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("SQL failure is reported as an error and does not fall back to queue-only acceptance", async () => {
    mocks.updateInvoiceWithIntent.mockImplementation(() => {
      throw new Error("atomic fixture failure");
    });
    const result = await client.callTool({
      name: "invoices_update",
      arguments: { id, status: "unpaid" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("atomic fixture failure");
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
  test("missing or foreign invoice performs no mutation", async () => {
    mocks.getInvoiceById.mockImplementation(() => null);
    const result = await client.callTool({
      name: "invoices_update",
      arguments: { id, status: "unpaid" },
    });
    expect(result.isError).toBe(true);
    expect(mocks.updateInvoiceWithIntent).not.toHaveBeenCalled();
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});
