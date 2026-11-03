import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { SearchParams } from "nuqs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Item = { id: string };
type Account = { id: string; lastAccessed: string | null };

let queryClient: QueryClient;
let inboxItems: Item[] = [];
let accounts: Account[] = [];
let inboxFailure: Error | null = null;
let accountsFailure: Error | null = null;
let inboxReads = 0;
let accountReads = 0;
let retryAction: (() => void) | undefined;

function freshQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

const network = spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new Error("Unexpected network access in the Inbox page regression");
});

// Keep the actual page, query client and URL parsers. Only transport and client
// presentation leaves are replaced; none of the empty/error decisions live here.
mock.module("@/trpc/server", () => ({
  getQueryClient: () => queryClient,
  HydrateClient: ({ children }: { children: ReactNode }) => <>{children}</>,
  trpc: {
    inbox: {
      get: {
        infiniteQueryOptions: (
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => ({
          ...options,
          queryKey: ["inbox", input],
          initialPageParam: null,
          queryFn: async () => {
            inboxReads += 1;
            if (inboxFailure) throw inboxFailure;
            return { data: inboxItems, meta: { cursor: undefined } };
          },
        }),
      },
    },
    inboxAccounts: {
      get: {
        queryOptions: () => ({
          queryKey: ["inboxAccounts"],
          queryFn: async () => {
            accountReads += 1;
            if (accountsFailure) throw accountsFailure;
            return accounts;
          },
        }),
      },
    },
  },
}));

mock.module("@/components/inbox", () => ({
  Inbox: ({ children }: { children: ReactNode }) => (
    <section data-testid="inbox-shell">{children}</section>
  ),
}));
mock.module("@/components/inbox/inbox-get-started", () => ({
  InboxGetStarted: () => <div data-testid="inbox-get-started" />,
}));
mock.module("@/components/inbox/inbox-empty", () => ({
  InboxConnectedEmpty: () => <div data-testid="inbox-connected-empty" />,
}));
mock.module("@/components/inbox/inbox-view", () => ({
  InboxView: () => <div data-testid="inbox-view" />,
}));
mock.module("@/components/inbox/inbox-skeleton", () => ({
  InboxViewSkeleton: () => <div data-testid="inbox-skeleton" />,
}));
mock.module("@/components/error-fallback", () => ({
  ErrorFallback: () => <div data-testid="content-error" />,
}));
mock.module("next/dist/client/components/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module("@midday/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick: () => void;
  }) => {
    retryAction = onClick;
    return <button type="button">{children}</button>;
  },
}));

const { default: Page } = await import("./page");
const { default: SidebarError } = await import("../error");

function page(searchParams: SearchParams = {}) {
  return Page({ searchParams: Promise.resolve(searchParams) });
}

function connectedAccount(
  lastAccessed: string | null = "2026-11-03T00:00:00Z",
) {
  return { id: "account-1", lastAccessed };
}

beforeEach(() => {
  queryClient = freshQueryClient();
  inboxItems = [];
  accounts = [];
  inboxFailure = null;
  accountsFailure = null;
  inboxReads = 0;
  accountReads = 0;
  retryAction = undefined;
  network.mockClear();
});

afterEach(() => {
  queryClient.clear();
  expect(network).not.toHaveBeenCalled();
});

afterAll(() => {
  network.mockRestore();
  mock.restore();
});

describe("Inbox page loading failures", () => {
  test("both failed queries reject the page rather than selecting onboarding", async () => {
    inboxFailure = new Error("Inbox unavailable");
    accountsFailure = new Error("Accounts unavailable");

    await expect(page()).rejects.toThrow("unavailable");
    expect(inboxReads).toBe(1);
    expect(accountReads).toBe(1);
  });

  test("a failed inbox query reaches the segment boundary even with synced accounts", async () => {
    accounts = [connectedAccount()];
    inboxFailure = new Error("Inbox unavailable");

    await expect(page()).rejects.toBe(inboxFailure);
    expect(inboxReads).toBe(1);
    expect(accountReads).toBe(1);
  });

  test("a failed accounts query is not hidden by successful receipt data", async () => {
    inboxItems = [{ id: "receipt-1" }];
    accountsFailure = new Error("Accounts unavailable");

    await expect(page()).rejects.toBe(accountsFailure);
    expect(inboxReads).toBe(1);
    expect(accountReads).toBe(1);
  });

  test("a failed accounts query cannot turn a successful empty inbox into onboarding", async () => {
    accountsFailure = new Error("Accounts unavailable");

    await expect(page()).rejects.toBe(accountsFailure);
  });

  test("the existing error UI invokes Next retry and a fresh request can recover", async () => {
    const queryError = Object.assign(new Error("private query failure"), {
      digest: "inbox-error-id",
    });
    inboxFailure = queryError;
    accounts = [connectedAccount()];
    await expect(page()).rejects.toBe(queryError);

    const renders: Array<ReturnType<typeof page>> = [];
    const reset = mock(() => {});
    const retry = mock(() => {
      queryClient.clear();
      queryClient = freshQueryClient();
      renders.push(page());
    });
    const html = renderToStaticMarkup(
      <SidebarError error={queryError} reset={reset} retry={retry} />,
    );

    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    expect(html).toContain("inbox-error-id");
    expect(html).not.toContain("private query failure");
    expect(retryAction).toBeDefined();
    expect(retry).not.toHaveBeenCalled();

    inboxFailure = null;
    inboxItems = [{ id: "receipt-after-retry" }];
    retryAction?.();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(renders).toHaveLength(1);
    const retried = renders[0];
    if (!retried)
      throw new Error("The retry did not start a fresh page request");
    expect(renderToStaticMarkup(await retried)).toContain(
      'data-testid="inbox-view"',
    );
    expect(inboxReads).toBe(2);
    expect(accountReads).toBe(2);
  });
});

describe("successful Inbox page states", () => {
  test("real empty data without accounts retains onboarding", async () => {
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('data-testid="inbox-get-started"');
    expect(html).not.toContain('data-testid="inbox-connected-empty"');
    expect(inboxReads).toBe(1);
    expect(accountReads).toBe(1);
  });

  test("real empty data with a synced account retains the connected empty state", async () => {
    accounts = [connectedAccount()];
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('data-testid="inbox-connected-empty"');
    expect(html).toContain('data-testid="inbox-shell"');
    expect(html).not.toContain('data-testid="inbox-get-started"');
  });

  test("an account awaiting its first sync retains the normal view", async () => {
    accounts = [connectedAccount(null)];
    expect(renderToStaticMarkup(await page())).toContain(
      'data-testid="inbox-view"',
    );
  });

  test("a filtered empty result retains the view that owns filter controls", async () => {
    expect(
      renderToStaticMarkup(await page({ q: "unmatched receipt" })),
    ).toContain('data-testid="inbox-view"');
  });

  test("an empty other tab does not become the connected all-tab empty state", async () => {
    accounts = [connectedAccount()];
    expect(renderToStaticMarkup(await page({ tab: "other" }))).toContain(
      'data-testid="inbox-view"',
    );
  });

  test("the successful connection return retains its normal sync view", async () => {
    accounts = [connectedAccount()];
    expect(renderToStaticMarkup(await page({ connected: "true" }))).toContain(
      'data-testid="inbox-view"',
    );
  });

  test("successful receipt data without an account still renders the inbox", async () => {
    inboxItems = [{ id: "receipt-uploaded-directly" }];
    expect(renderToStaticMarkup(await page())).toContain(
      'data-testid="inbox-view"',
    );
  });
});
