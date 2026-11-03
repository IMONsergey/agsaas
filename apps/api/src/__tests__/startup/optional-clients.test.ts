import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { ProductEmailConfigurationError } from "@midday/email/config";

const previousResendKey = process.env.RESEND_API_KEY;
const previousComposioKey = process.env.COMPOSIO_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.COMPOSIO_API_KEY;

const sendEmail = mock(async (_input: unknown) => ({
  data: { id: "email-1" },
}));
const removeContact = mock(async (_input: unknown) => ({
  data: { id: "user-1" },
}));
const resendConstructed = mock((_key: string) => undefined);
let resendFailure: Error | undefined;

mock.module("resend", () => ({
  Resend: class {
    emails = { send: sendEmail };
    contacts = { remove: removeContact };
    constructor(key: string) {
      resendConstructed(key);
      if (resendFailure) throw resendFailure;
      if (!key) throw new Error("Missing API key");
    }
  },
}));

const createSession = mock(async (_userId: string) => ({ id: "session-1" }));
const listAccounts = mock(async () => ({ items: [] }));
const composioConstructed = mock((_options: unknown) => undefined);
let composioFailure: Error | undefined;

mock.module("@composio/core", () => ({
  Composio: class {
    create = createSession;
    connectedAccounts = { list: listAccounts };
    constructor(options: { apiKey?: string }) {
      composioConstructed(options);
      if (composioFailure) throw composioFailure;
      if (!options.apiKey) throw new Error("No Composio API key provided");
    }
  },
}));
mock.module("@composio/vercel", () => ({ VercelProvider: class {} }));

const readCache = mock(async () => {
  throw new Error("Disabled providers must not access Redis");
});
mock.module("@midday/cache/connectors-cache", () => ({
  connectorsCache: { getOrSet: readCache },
}));

// Every request is intercepted, including accidentally eager SDK requests.
const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
  new Error("Network is disabled in optional-client tests"),
);
const email = await import("../../services/resend");
const connectors = await import("../../composio/client");

afterAll(() => {
  fetchSpy.mockRestore();
  if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousResendKey;
  if (previousComposioKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = previousComposioKey;
});

describe("optional provider imports", () => {
  test("imports without provider credentials, client construction, or network", () => {
    expect(resendConstructed).not.toHaveBeenCalled();
    expect(composioConstructed).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("disabled Composio tools and connections need neither SDK nor Redis", async () => {
    // Unapproved external tools and user-scoped helpers are no longer exposed.
    expect("getComposioTools" in connectors).toBe(false);
    expect("getUserToolkits" in connectors).toBe(false);
    expect(
      await connectors.getTeamToolkits("922b0346-5f35-46f9-b81d-ee34d4b049a5"),
    ).toEqual([]);
    expect(readCache).not.toHaveBeenCalled();
    expect(composioConstructed).not.toHaveBeenCalled();
  });

  test("disabled Composio REST calls fail locally before fetch", async () => {
    await expect(connectors.composioFetch("/toolkits/example")).rejects.toThrow(
      "COMPOSIO_API_KEY is required",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("Resend retries missing/failed configuration and caches only success", async () => {
    expect(() => email.resend.emails).toThrow(ProductEmailConfigurationError);
    expect(resendConstructed).not.toHaveBeenCalled();

    process.env.RESEND_API_KEY = "local-test-resend-key";
    resendFailure = new Error("Test SDK construction failed");
    expect(() => email.getResend()).toThrow(resendFailure.message);
    resendFailure = undefined;

    const client = email.getResend();
    expect(Object.is(email.getResend(), client)).toBe(true);
    const payload = { to: "recipient@example.test", subject: "Test" };
    await email.resend.emails.send({
      ...payload,
      from: "sender@example.test",
      text: "Test",
    });
    await email.resend.contacts.remove({ id: "contact-1" });
    expect(sendEmail).toHaveBeenCalledWith({
      ...payload,
      from: "sender@example.test",
      text: "Test",
    });
    expect(removeContact).toHaveBeenCalledWith({ id: "contact-1" });
    expect(resendConstructed).toHaveBeenCalledTimes(2);
    expect(resendConstructed).toHaveBeenLastCalledWith("local-test-resend-key");
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.RESEND_API_KEY;
  });

  test("Composio retries failed construction and preserves configured calls", async () => {
    expect(() => connectors.composio.create).toThrow(
      "COMPOSIO_API_KEY is required",
    );
    expect(composioConstructed).not.toHaveBeenCalled();

    process.env.COMPOSIO_API_KEY = "local-test-composio-key";
    composioFailure = new Error("Test SDK construction failed");
    expect(() => connectors.getComposio()).toThrow(composioFailure.message);
    composioFailure = undefined;

    const client = connectors.getComposio();
    expect(Object.is(connectors.getComposio(), client)).toBe(true);
    await connectors.composio.create("user-1");
    await connectors.composio.connectedAccounts.list();
    expect(createSession).toHaveBeenCalledWith("user-1");
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(composioConstructed).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    delete process.env.COMPOSIO_API_KEY;
  });

  test("configured Composio REST requests remain bounded and refuse redirects", async () => {
    process.env.COMPOSIO_API_KEY = "local-test-composio-rest-key";
    fetchSpy.mockResolvedValueOnce(Response.json({ slug: "example" }));

    expect(await connectors.composioFetch("/toolkits/example")).toEqual({
      slug: "example",
    });
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://backend.composio.dev/api/v3/toolkits/example",
      {
        headers: { "x-api-key": "local-test-composio-rest-key" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
    delete process.env.COMPOSIO_API_KEY;
  });

  test("configured Composio REST errors retain their upstream status", async () => {
    process.env.COMPOSIO_API_KEY = "local-test-composio-rest-key";
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(connectors.composioFetch("/toolkits/example")).rejects.toThrow(
      "Composio API error: 429",
    );
    delete process.env.COMPOSIO_API_KEY;
  });
});
