import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpContext } from "@api/mcp/types";

const connectMock = mock(() => Promise.resolve());
const serverCloseMock = mock(() => Promise.resolve());
const clientCloseMock = mock(() => Promise.resolve());
const listToolsMock = mock(() => Promise.resolve({ tools: [] }));
const toolsFromDefinitionsMock = mock(() => ({}));
const client = {
  close: clientCloseMock,
  listTools: listToolsMock,
  toolsFromDefinitions: toolsFromDefinitionsMock,
};
const createMCPClientMock = mock(() => Promise.resolve(client));
const warmUpMock = mock(() => Promise.resolve());
const index = { warmUp: warmUpMock };
const createToolIndexMock = mock(() => Promise.resolve(index));
const warnMock = mock(() => undefined);

mock.module("@ai-sdk/mcp", () => ({
  createMCPClient: createMCPClientMock,
}));
mock.module("@api/mcp/server", () => ({
  createMcpServer: () => ({
    connect: connectMock,
    close: serverCloseMock,
  }),
}));
mock.module("@modelcontextprotocol/sdk/inMemory.js", () => ({
  InMemoryTransport: {
    createLinkedPair: () => [{}, {}],
  },
}));
mock.module("@ai-sdk/openai", () => ({
  openai: { embeddingModel: () => ({}) },
}));
mock.module("@midday/logger", () => ({
  logger: { warn: warnMock },
}));
mock.module("toolpick", () => ({
  createToolIndex: createToolIndexMock,
  fileCache: () => ({}),
}));

const { createExecutionClient, ensureToolIndex, warmToolIndex } = await import(
  "../../chat/tools"
);

const context: McpContext = {
  db: {} as McpContext["db"],
  teamId: "test-team",
  userId: "test-user",
  userEmail: null,
  scopes: [],
  apiUrl: "https://api.example.test",
  timezone: "UTC",
  locale: "en",
  countryCode: null,
  dateFormat: null,
  timeFormat: 24,
};

beforeEach(() => {
  connectMock.mockReset();
  connectMock.mockResolvedValue(undefined);
  serverCloseMock.mockReset();
  serverCloseMock.mockResolvedValue(undefined);
  clientCloseMock.mockReset();
  clientCloseMock.mockResolvedValue(undefined);
  listToolsMock.mockReset();
  listToolsMock.mockResolvedValue({ tools: [] });
  toolsFromDefinitionsMock.mockReset();
  toolsFromDefinitionsMock.mockReturnValue({});
  createMCPClientMock.mockReset();
  createMCPClientMock.mockResolvedValue(client);
  warmUpMock.mockReset();
  warmUpMock.mockResolvedValue(undefined);
  createToolIndexMock.mockReset();
  createToolIndexMock.mockResolvedValue(index);
  warnMock.mockClear();
});

describe("chat MCP client lifecycle", () => {
  test("does not pre-warm optional embeddings without an OpenAI key", () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      warmToolIndex();
      expect(connectMock).not.toHaveBeenCalled();
      expect(createToolIndexMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("transfers a successfully connected execution client to the caller", async () => {
    expect(Object.is(await createExecutionClient(context), client)).toBe(true);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(createMCPClientMock).toHaveBeenCalledTimes(1);
    expect(clientCloseMock).not.toHaveBeenCalled();
    expect(serverCloseMock).not.toHaveBeenCalled();
  });

  test("closes the server when its connection fails", async () => {
    const failure = new Error("server connection failed");
    connectMock.mockRejectedValueOnce(failure);

    await expect(createExecutionClient(context)).rejects.toBe(failure);
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
    expect(createMCPClientMock).not.toHaveBeenCalled();
  });

  test("closes the server when client initialization fails", async () => {
    const failure = new Error("client initialization failed");
    createMCPClientMock.mockRejectedValueOnce(failure);

    await expect(createExecutionClient(context)).rejects.toBe(failure);
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
  });

  test("does not mask initialization errors with cleanup failures", async () => {
    const failure = new Error("initialization failed");
    createMCPClientMock.mockRejectedValueOnce(failure);
    serverCloseMock.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(createExecutionClient(context)).rejects.toBe(failure);
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
  });

  test("closes bootstrap client when listing tools fails", async () => {
    const failure = new Error("listing tools failed");
    listToolsMock.mockRejectedValueOnce(failure);

    await expect(ensureToolIndex(context)).rejects.toBe(failure);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
    expect(createToolIndexMock).not.toHaveBeenCalled();
  });

  test("closes bootstrap client when tool conversion fails", async () => {
    const failure = new Error("tool conversion failed");
    toolsFromDefinitionsMock.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(ensureToolIndex(context)).rejects.toBe(failure);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
    expect(createToolIndexMock).not.toHaveBeenCalled();
  });

  test("preserves bootstrap errors when client cleanup also fails", async () => {
    const failure = new Error("listing tools failed");
    listToolsMock.mockRejectedValueOnce(failure);
    clientCloseMock.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(ensureToolIndex(context)).rejects.toBe(failure);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
  });

  test("retries a failed bootstrap and closes once before caching its index", async () => {
    const cleanupFailure = new Error("bootstrap cleanup failed");
    clientCloseMock.mockRejectedValueOnce(cleanupFailure);

    await expect(ensureToolIndex(context)).rejects.toBe(cleanupFailure);
    expect(createToolIndexMock).not.toHaveBeenCalled();
    clientCloseMock.mockClear();
    createMCPClientMock.mockClear();

    const first = ensureToolIndex(context);
    const concurrent = ensureToolIndex(context);

    expect(concurrent).toBe(first);
    expect(Object.is(await first, index)).toBe(true);
    expect(Object.is(await ensureToolIndex(context), index)).toBe(true);
    expect(createMCPClientMock).toHaveBeenCalledTimes(1);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
    expect(warmUpMock).toHaveBeenCalledTimes(1);
  });
});
