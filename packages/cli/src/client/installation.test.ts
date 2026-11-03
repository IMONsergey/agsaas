import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredentials, getToken, saveCredentials } from "../config/store";
import { getApiUrl, getDashboardUrl } from "../utils/env";
import { request } from "./api";
import { loginWithBrowser, loginWithToken } from "./auth";

const keys = [
  "XDG_CONFIG_HOME",
  "AGSAAS_API_URL",
  "MIDDAY_API_URL",
  "AGSAAS_DASHBOARD_URL",
  "MIDDAY_DASHBOARD_URL",
  "AGSAAS_API_KEY",
  "MIDDAY_API_KEY",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));
const nativeFetch = globalThis.fetch;
let dir = "";
let calls: Array<{ url: string; options: RequestInit }> = [];
const origin = "https://api.owned.example:8443";

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), "agsaas-cli-fixture-"));
  process.env.XDG_CONFIG_HOME = dir;
  calls = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    options: RequestInit = {},
  ) => {
    calls.push({ url: String(url), options });
    return Response.json({
      id: "fixture-user",
      email: "fixture@example.invalid",
      team: { id: "fixture-team", name: "Fixture" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("explicit CLI installation", () => {
  test("requires separately configured API and dashboard without upstream or guessed defaults", () => {
    expect(() => getApiUrl()).toThrow("must be configured");
    process.env.AGSAAS_API_URL = origin;
    expect(getApiUrl()).toBe(origin);
    expect(() => getDashboardUrl()).toThrow("must be configured");
    process.env.AGSAAS_DASHBOARD_URL = "https://workspace.example:8543";
    expect(getDashboardUrl()).toBe("https://workspace.example:8543");
  });
  test("rejects upstream, credentials, insecure remote origin, path, query and fragment", () => {
    for (const value of [
      "https://api.midday.ai",
      "https://midday.ai",
      "https://api.midday.ai.",
      "https://api.midday.ai%2e",
      "https://user:secret@api.owned.example",
      "http://api.owned.example",
      origin + "/api",
      origin + "?secret=x",
      origin + "#x",
      "file:///tmp/api",
    ]) {
      expect(() => getApiUrl(value)).toThrow();
    }
    expect(getApiUrl("http://127.0.0.1:3003")).toBe("http://127.0.0.1:3003");
  });
  test("retains legacy variable names only as explicit configuration", () => {
    process.env.MIDDAY_API_URL = origin;
    process.env.MIDDAY_DASHBOARD_URL = "https://dashboard.owned.example";
    expect(getApiUrl()).toBe(origin);
    expect(getDashboardUrl()).toBe("https://dashboard.owned.example");
  });
});

describe("credential destination", () => {
  test("atomically saves private credentials bound to canonical origin and port", () => {
    saveCredentials({ apiOrigin: origin + "/", accessToken: "fixture-token" });
    expect(getCredentials(origin)?.accessToken).toBe("fixture-token");
    expect(getCredentials("https://api.owned.example")).toBeNull();
    expect(getCredentials("https://other.example")).toBeNull();
    expect(statSync(join(dir, "agsaas")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "agsaas", "credentials.json")).mode & 0o777).toBe(
      0o600,
    );
  });
  test("refuses unbound legacy records, expired values and permissive token files", () => {
    saveCredentials({ apiOrigin: origin, accessToken: "fixture-token" });
    const path = join(dir, "agsaas", "credentials.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, apiOrigin: undefined }));
    expect(getCredentials(origin)).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({ ...record, expiresAt: Date.now() - 1 }),
    );
    expect(getCredentials(origin)).toBeNull();
    writeFileSync(path, JSON.stringify(record));
    chmodSync(path, 0o644);
    expect(getCredentials(origin)).toBeNull();
    saveCredentials({ apiOrigin: origin, accessToken: "fixture-new-token" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test("requires environment key origin and refuses an unrelated command override", () => {
    process.env.AGSAAS_API_KEY = "fixture-env-token";
    expect(() => getToken(origin)).toThrow();
    process.env.AGSAAS_API_URL = origin;
    expect(getToken(origin)).toBe("fixture-env-token");
    expect(() => getToken("https://other.example")).toThrow("origin differs");
  });
  test("does not send a saved token to a changed installation", async () => {
    saveCredentials({ apiOrigin: origin, accessToken: "fixture-token" });
    await expect(
      request({ apiUrl: "https://other.example", path: "/users/me" }),
    ).rejects.toThrow("Not logged in");
    expect(calls).toHaveLength(0);
  });
  test("refuses absolute, protocol-relative and backslash foreign paths before fetch", async () => {
    saveCredentials({ apiOrigin: origin, accessToken: "fixture-token" });
    for (const path of [
      "https://other.example/x",
      "//other.example/x",
      "/\\other.example/x",
      "/users/me#fragment",
    ]) {
      await expect(request({ apiUrl: origin, path })).rejects.toThrow(
        "relative path",
      );
    }
    expect(calls).toHaveLength(0);
  });
  test("keeps query encoding, disables redirects and adds a request deadline", async () => {
    saveCredentials({ apiOrigin: origin, accessToken: "fixture-token" });
    await request({
      apiUrl: origin,
      path: "/users/me",
      query: { q: "a&b", pageSize: 2 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(origin + "/users/me?q=a%26b&pageSize=2");
    expect(calls[0]?.options.redirect).toBe("error");
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(calls[0]?.options.headers).get("Authorization")).toBe(
      "Bearer fixture-token",
    );
  });
  test("token login honors the explicit command origin and saves the same binding", async () => {
    await loginWithToken("fixture-input-token", { apiUrl: origin });
    expect(calls[0]?.url).toBe(origin + "/users/me");
    expect(calls[0]?.options.redirect).toBe("error");
    expect(getCredentials(origin)?.accessToken).toBe("fixture-input-token");
    expect(getCredentials("https://other.example")).toBeNull();
  });
  test("failed registration closes the loopback listener and stores no credentials", async () => {
    process.env.AGSAAS_DASHBOARD_URL = "https://dashboard.owned.example";
    let redirectUri = "";
    globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
      redirectUri = JSON.parse(String(options.body)).redirect_uris[0];
      return new Response("fixture registration failure", { status: 503 });
    }) as typeof fetch;
    await expect(
      loginWithBrowser({ apiUrl: origin, noBrowser: true }),
    ).rejects.toThrow("HTTP 503");
    expect(new URL(redirectUri).hostname).toBe("127.0.0.1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      nativeFetch(redirectUri, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
    expect(getCredentials(origin)).toBeNull();
  });
});
