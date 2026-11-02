import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { createTRPCContext } from "@api/trpc/init";
import type {
  globalSearchQuery,
  globalSemanticSearchQuery,
} from "@midday/db/queries";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { initTRPC } from "@trpc/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { withReplicas } from "../../../../packages/db/src/replicas";
import { runtimeSchema } from "../../../../packages/db/src/runtime-schema";

// Run this suite in a fresh process, without the shared API preload. It tests
// the real search router/parser with only DB, procedure context and AI I/O mocked;
// authentication/authorization are covered by their separate boundary suites.
type SearchContext = Awaited<ReturnType<typeof createTRPCContext>>;
type SearchResults = Awaited<ReturnType<typeof globalSearchQuery>>;
type SearchFilters = NonNullable<
  Awaited<ReturnType<typeof generateLLMFilters>>
>;
type GenerationResult = { object: SearchFilters };
const t = initTRPC.context<SearchContext>().create();
mock.module("@api/trpc/init", () => ({
  createTRPCRouter: t.router,
  protectedProcedure: t.procedure,
}));

const localSearch = mock<typeof globalSearchQuery>(async () => []);
const semanticSearch = mock<typeof globalSemanticSearchQuery>(async () => []);
mock.module("@midday/db/queries", () => ({
  globalSearchQuery: localSearch,
  globalSemanticSearchQuery: semanticSearch,
  getInboxSearch: mock(async () => []),
  getInvoices: mock(async () => ({ data: [] })),
}));

type GenerationRequest = {
  prompt?: string;
  model?: { modelId?: string };
  maxRetries?: number;
  abortSignal?: AbortSignal;
};
const validFilters: SearchFilters = {
  searchTerm: "Acme",
  types: ["invoices"],
  language: "english",
  status: "unpaid",
};
const generate = mock(
  async (_request: GenerationRequest): Promise<GenerationResult> => ({
    object: validFilters,
  }),
);
mock.module("ai", () => ({ generateObject: generate }));

const { generateLLMFilters, isSearchAIConfigured, SEARCH_FILTER_TIMEOUT_MS } =
  await import("../utils/search-filters");
const { searchRouter } = await import("../trpc/routers/search");
const originalKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
const blockNetwork = (): never => {
  throw new Error("Provider network is forbidden in the isolated search suite");
};
const forbiddenFetch = mock(
  async (
    _input: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => blockNetwork(),
);
const forbiddenPreconnect = mock(blockNetwork);
globalThis.fetch = Object.assign(forbiddenFetch, {
  preconnect: forbiddenPreconnect,
});

// Fully typed context with real, inert clients: neither is used by this router.
// Reject accidental DB access rather than weakening the production context type.
const pool = new Pool({ host: "127.0.0.1", database: "query_only" });
pool.query = blockNetwork;
pool.connect = blockNetwork;
const primary = drizzle(pool, { schema: runtimeSchema, casing: "snake_case" });
const db = withReplicas(primary, [primary], () => primary);
const supabase = createSupabaseClient(
  "https://search-fixture.example.test",
  "fixture-key-never-sent",
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const context: SearchContext = {
  db,
  supabase,
  session: null,
  teamId: "team-fixture",
  requestId: "search-fixture-request",
  geo: {
    country: null,
    city: null,
    region: null,
    continent: null,
    locale: null,
    timezone: null,
    ip: null,
  },
};
const caller = searchRouter.createCaller(context);

function searchResults(id: string, type = "customers"): SearchResults {
  return [
    {
      id,
      type,
      title: "Fixture result",
      relevance: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      data: { id },
    },
  ];
}

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  forbiddenFetch.mockClear();
  forbiddenPreconnect.mockClear();
  generate.mockReset();
  generate.mockImplementation(async () => ({ object: validFilters }));
  localSearch.mockReset();
  localSearch.mockImplementation(async () => []);
  semanticSearch.mockReset();
  semanticSearch.mockImplementation(async () => []);
});
afterEach(() => {
  expect(forbiddenFetch).not.toHaveBeenCalled();
  expect(forbiddenPreconnect).not.toHaveBeenCalled();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  await supabase.auth.stopAutoRefresh();
  await pool.end();
});

describe("optional AI search filter generation", () => {
  test.each([
    { label: "unset", environment: {} },
    { label: "empty", environment: { OPENAI_API_KEY: "" } },
    { label: "whitespace", environment: { OPENAI_API_KEY: " \t " } },
  ])("does not advertise $label configuration", ({ environment }) => {
    expect(isSearchAIConfigured(environment)).toBe(false);
  });

  test("reads optional configuration at call time, without caching it", async () => {
    expect(await generateLLMFilters("unpaid Acme invoices")).toBeNull();
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    expect(isSearchAIConfigured()).toBe(true);
    expect(await generateLLMFilters("unpaid Acme invoices")).toEqual(
      validFilters,
    );
    delete process.env.OPENAI_API_KEY;
    expect(await generateLLMFilters("unpaid Acme invoices")).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("preserves successful configured model, prompt and generated filters", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    expect(await generateLLMFilters("unpaid Acme invoices")).toEqual(
      validFilters,
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "unpaid Acme invoices",
        model: expect.objectContaining({ modelId: "gpt-4o-mini" }),
        maxRetries: 0,
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(generate.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
  });

  test.each([
    { label: "provider rejection" },
    { label: "invalid structured output" },
    { label: "credential rejection" },
  ])("falls back without exposing $label", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    generate.mockImplementation(async () => {
      throw new Error("private provider body fixture-key-never-sent");
    });
    expect(await generateLLMFilters("private fixture query")).toBeNull();
  });

  test("aborts and returns even when the provider ignores cancellation", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    generate.mockImplementation(() => new Promise(() => {}));
    expect(
      await generateLLMFilters("unpaid Acme invoices", { timeoutMs: 10 }),
    ).toBeNull();
    expect(generate.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
  });

  test("observes a late provider rejection after returning the timeout fallback", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    let rejectProvider: ((error: Error) => void) | undefined;
    generate.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectProvider = reject;
        }),
    );
    expect(
      await generateLLMFilters("unpaid Acme invoices", { timeoutMs: 10 }),
    ).toBeNull();
    rejectProvider?.(new Error("late provider fixture failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("real search router with optional AI", () => {
  test("multi-word local queries work without AI and preserve the caller's filters", async () => {
    const results = searchResults("local-match");
    localSearch.mockImplementation(async () => results);
    expect(
      await caller.global({
        searchTerm: "Acme Limited",
        relevanceThreshold: 0.42,
        language: "english",
        limit: 12,
        itemsPerTableLimit: 4,
      }),
    ).toEqual(results);
    expect(localSearch).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        teamId: "team-fixture",
        searchTerm: "Acme Limited",
        relevanceThreshold: 0.42,
        language: "english",
        limit: 12,
        itemsPerTableLimit: 4,
      }),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  test("empty multi-word local results remain a successful response without AI", async () => {
    expect(await caller.global({ searchTerm: "missing fixture" })).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  test("single-word queries do not invoke AI even when configured", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    expect(
      await caller.global({ searchTerm: "Acme", relevanceThreshold: 0.4 }),
    ).toEqual([]);
    expect(localSearch).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ relevanceThreshold: 0.4 }),
    );
    expect(generate).not.toHaveBeenCalled();
  });

  test("nonempty local results skip AI even for a configured multi-word query", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    const results = searchResults("local-match");
    localSearch.mockImplementation(async () => results);
    expect(await caller.global({ searchTerm: "Acme Limited" })).toEqual(
      results,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  test("preserves successful configured semantic search with the same team/limit", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    const results = searchResults("semantic-match", "invoices");
    semanticSearch.mockImplementation(async () => results);
    expect(
      await caller.global({
        searchTerm: "unpaid Acme invoices",
        itemsPerTableLimit: 7,
      }),
    ).toEqual(results);
    expect(localSearch).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ relevanceThreshold: 0.01 }),
    );
    expect(semanticSearch).toHaveBeenCalledWith(db, {
      teamId: "team-fixture",
      itemsPerTableLimit: 7,
      ...validFilters,
    });
  });

  test("provider failures do not break a successful local query", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    generate.mockImplementation(async () => {
      throw new Error("provider fixture failed");
    });
    expect(await caller.global({ searchTerm: "unpaid Acme invoices" })).toEqual(
      [],
    );
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  test("generated filters rejected by SQL fall back to the original local results", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    semanticSearch.mockImplementation(async () => {
      throw new Error("generated language fixture rejected");
    });
    expect(await caller.global({ searchTerm: "unpaid Acme invoices" })).toEqual(
      [],
    );
    expect(localSearch).toHaveBeenCalledTimes(1);
    expect(semanticSearch).toHaveBeenCalledTimes(1);
  });

  test("does not mask a failure of the original local database query", async () => {
    localSearch.mockImplementation(async () => {
      throw new Error("local database fixture unavailable");
    });
    await expect(caller.global({ searchTerm: "Acme Limited" })).rejects.toThrow(
      "local database fixture unavailable",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  test("the actual route returns fallback within the configured AI deadline", async () => {
    process.env.OPENAI_API_KEY = "fixture-key-never-sent";
    generate.mockImplementation(() => new Promise(() => {}));
    expect(SEARCH_FILTER_TIMEOUT_MS).toBe(2_000);
    expect(await caller.global({ searchTerm: "unpaid Acme invoices" })).toEqual(
      [],
    );
    expect(generate.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
    expect(semanticSearch).not.toHaveBeenCalled();
  }, 10_000);
});
