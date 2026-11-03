import { describe, expect, test } from "bun:test";
import { getApiUrl, getAppUrl, getCdnUrl, getEmailUrl } from "./envs";

describe("installation origins", () => {
  test("production fails closed without explicit origins", () => {
    for (const getter of [getAppUrl, getApiUrl, getEmailUrl, getCdnUrl])
      expect(() => getter({ NODE_ENV: "production" })).toThrow();
  });
  test("local development retains explicit loopback defaults", () => {
    expect(getAppUrl({ NODE_ENV: "test" })).toBe("http://localhost:3001");
    expect(getApiUrl({ NODE_ENV: "development" })).toBe(
      "http://localhost:3003",
    );
  });
  test("configured own origins are normalized and legacy variable names remain compatible", () => {
    expect(
      getAppUrl({
        NODE_ENV: "production",
        DASHBOARD_URL: "https://app.example.test/",
      }),
    ).toBe("https://app.example.test");
    expect(
      getApiUrl({
        NODE_ENV: "production",
        MIDDAY_API_URL: "https://api.example.test:8544",
      }),
    ).toBe("https://api.example.test:8544");
  });
  test("upstream, credential-bearing and ambiguous URLs are rejected", () => {
    for (const raw of [
      "https://app.midday.ai",
      "https://api.midday.ai",
      "https://midday.ai",
      "https://user:secret@own.example.test",
      "http://own.example.test",
      "https://own.example.test/path",
      "https://own.example.test?redirect=1",
      "https://own.example.test#x",
      "//own.example.test",
      "javascript:alert(1)",
    ]) {
      expect(() =>
        getAppUrl({ NODE_ENV: "production", DASHBOARD_URL: raw }),
      ).toThrow();
      expect(() =>
        getApiUrl({ NODE_ENV: "production", API_URL: raw }),
      ).toThrow();
    }
  });
});
