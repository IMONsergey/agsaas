import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { withClientIp } from "@api/rest/middleware/ip";
import type { Context } from "@api/rest/types";
import { resolveClientIp } from "@api/rest/utils/ip";
import { Hono } from "hono";

const PROXY = "192.0.2.10";
const SECOND_PROXY = "192.0.2.11";
const CLIENT = "198.51.100.27";
const POSTMARK = "3.134.147.250";

describe("socket and trusted proxy IP boundary", () => {
  it("ignores a forged allowed sender when the actual peer is untrusted", () => {
    expect(
      resolveClientIp({ remoteAddress: CLIENT, forwardedFor: POSTMARK }),
    ).toBe(CLIENT);
    expect(
      resolveClientIp({
        remoteAddress: CLIENT,
        forwardedFor: `${POSTMARK}, ${PROXY}`,
        trustedProxyIps: PROXY,
      }),
    ).toBe(CLIENT);
  });

  it.each([
    "10.0.0.9",
    "172.18.0.1",
    "192.168.1.2",
    "127.0.0.1",
    "::1",
  ])("does not implicitly trust private or loopback peer %s", (remoteAddress) => {
    expect(resolveClientIp({ remoteAddress, forwardedFor: POSTMARK })).toBe(
      remoteAddress,
    );
  });

  it.each([
    undefined,
    "",
    " ",
    "proxy.example",
    "192.0.2.10:8080",
  ])("never substitutes a header when the actual peer is absent or invalid (%s)", (remoteAddress) => {
    expect(
      resolveClientIp({
        remoteAddress,
        forwardedFor: POSTMARK,
        trustedProxyIps: PROXY,
      }),
    ).toBe("");
  });

  it("walks right to left and ignores attacker-supplied values before the real peer", () => {
    expect(
      resolveClientIp({
        remoteAddress: PROXY,
        forwardedFor: `${POSTMARK}, ${CLIENT}`,
        trustedProxyIps: PROXY,
      }),
    ).toBe(CLIENT);
  });

  it("accepts an exact trusted multi-hop chain and stops at the nearest untrusted hop", () => {
    const trustedProxyIps = `${PROXY}, ${SECOND_PROXY}`;
    expect(
      resolveClientIp({
        remoteAddress: PROXY,
        forwardedFor: `${POSTMARK}, ${SECOND_PROXY}`,
        trustedProxyIps,
      }),
    ).toBe(POSTMARK);
    expect(
      resolveClientIp({
        remoteAddress: PROXY,
        forwardedFor: `${POSTMARK}, ${CLIENT}, ${SECOND_PROXY}`,
        trustedProxyIps,
      }),
    ).toBe(CLIENT);
  });

  it("requires client evidence when a configured trusted proxy is the peer", () => {
    for (const forwardedFor of [
      undefined,
      "",
      " \t",
      PROXY,
      `${SECOND_PROXY}, ${PROXY}`,
    ]) {
      expect(
        resolveClientIp({
          remoteAddress: PROXY,
          forwardedFor,
          trustedProxyIps: `${PROXY},${SECOND_PROXY}`,
        }),
      ).toBe("");
    }
  });

  it.each([
    `,${POSTMARK}`,
    `${POSTMARK},`,
    `${POSTMARK},,${PROXY}`,
    "unknown",
    "for=3.134.147.250",
    '"3.134.147.250"',
    "3.134.147.250:443",
    "[2001:db8::1]",
    "[2001:db8::1]:443",
    "fe80::1%eth0",
    "0x038693fa",
    "3.134.147.0250",
    "3.134.147",
    "example.com",
    "https://3.134.147.250/",
    `${POSTMARK}\r\n`,
    `${POSTMARK}\n`,
    `\u00a0${POSTMARK}`,
  ])("fails closed on malformed forwarded chain %s", (forwardedFor) => {
    expect(
      resolveClientIp({
        remoteAddress: PROXY,
        forwardedFor,
        trustedProxyIps: PROXY,
      }),
    ).toBe("");
  });

  it("bounds the entire header and number of hops before accepting any address", () => {
    const resolve = (forwardedFor: string) =>
      resolveClientIp({
        remoteAddress: PROXY,
        forwardedFor,
        trustedProxyIps: PROXY,
      });
    expect(
      resolve([POSTMARK, ...Array<string>(15).fill(PROXY)].join(",")),
    ).toBe(POSTMARK);
    expect(
      resolve([POSTMARK, ...Array<string>(16).fill(PROXY)].join(",")),
    ).toBe("");
    expect(resolve(`${" ".repeat(1024)}${POSTMARK}`)).toBe("");
  });

  it.each([
    "*",
    "localhost",
    "private",
    "loopback",
    "0.0.0.0",
    "::",
    "0.0.0.0/0",
    "::/0",
    "192.0.2.0/24",
    "192.0.2.10:8080",
    `${PROXY},`,
    `${PROXY},,${SECOND_PROXY}`,
    `${PROXY},localhost`,
    `${PROXY}\n`,
    `${PROXY}\r\n`,
    `\u00a0${PROXY}`,
  ])("rejects the entire malformed trust configuration %s", (trustedProxyIps) => {
    for (const remoteAddress of [PROXY, CLIENT]) {
      expect(
        resolveClientIp({
          remoteAddress,
          forwardedFor: POSTMARK,
          trustedProxyIps,
        }),
      ).toBe("");
    }
  });

  it("accepts only bounded explicit IP configuration, with ordinary whitespace", () => {
    expect(
      resolveClientIp({
        remoteAddress: PROXY,
        forwardedFor: ` \t${POSTMARK}\t `,
        trustedProxyIps: ` \t${PROXY} , ${SECOND_PROXY}\t `,
      }),
    ).toBe(POSTMARK);
    expect(
      resolveClientIp({
        remoteAddress: CLIENT,
        forwardedFor: POSTMARK,
        trustedProxyIps: " \t ",
      }),
    ).toBe(CLIENT);
    expect(
      resolveClientIp({
        remoteAddress: CLIENT,
        trustedProxyIps: " ".repeat(2049),
      }),
    ).toBe("");
    expect(
      resolveClientIp({
        remoteAddress: CLIENT,
        trustedProxyIps: Array<string>(33).fill(PROXY).join(","),
      }),
    ).toBe("");
  });

  it("canonicalizes equivalent IPv6 literals on both sides of the trust boundary", () => {
    expect(
      resolveClientIp({
        remoteAddress: "2001:DB8:0:0:0:0:0:10",
        forwardedFor: "2001:DB8:abcd:0:0:0:0:44",
        trustedProxyIps: "2001:db8::10",
      }),
    ).toBe("2001:db8:abcd::44");
  });

  it.each([
    "::ffff:3.134.147.250",
    "0:0:0:0:0:ffff:0386:93fa",
  ])("normalizes IPv4-mapped peer %s for the existing IPv4 allowlist", (remoteAddress) => {
    expect(resolveClientIp({ remoteAddress })).toBe(POSTMARK);
  });

  it("matches mapped proxy aliases and normalizes mapped forwarded clients", () => {
    expect(
      resolveClientIp({
        remoteAddress: "::ffff:192.0.2.10",
        forwardedFor: "::ffff:3.134.147.250",
        trustedProxyIps: PROXY,
      }),
    ).toBe(POSTMARK);
    expect(
      resolveClientIp({
        remoteAddress: PROXY,
        forwardedFor: POSTMARK,
        trustedProxyIps: "::ffff:c000:20a",
      }),
    ).toBe(POSTMARK);
  });

  it("does not conflate other IPv6 encodings or address translation ranges with IPv4", () => {
    expect(resolveClientIp({ remoteAddress: "::3.134.147.250" })).toBe(
      "::386:93fa",
    );
    expect(resolveClientIp({ remoteAddress: "64:ff9b::386:93fa" })).toBe(
      "64:ff9b::386:93fa",
    );
  });
});

describe("Hono uses the real Bun connection adapter", () => {
  const originalTrust = process.env.AGSAAS_TRUSTED_PROXY_IPS;

  beforeEach(() => {
    delete process.env.AGSAAS_TRUSTED_PROXY_IPS;
  });
  afterEach(() => {
    if (originalTrust === undefined)
      delete process.env.AGSAAS_TRUSTED_PROXY_IPS;
    else process.env.AGSAAS_TRUSTED_PROXY_IPS = originalTrust;
  });

  function createApp() {
    const app = new Hono<Context>();
    app.use("*", withClientIp);
    app.get("/", (c) => c.json({ ip: c.get("clientIp") }));
    return app;
  }

  function serverPeer(address: string) {
    return {
      requestIP: mock((_request: Request) => ({
        address,
        family: "IPv4",
        port: 54321,
      })),
    };
  }

  it("uses the fetch server argument and ignores every forged header on a direct connection", async () => {
    const server = serverPeer(CLIENT);
    const response = await createApp().request(
      "http://api.example/",
      {
        headers: {
          "x-forwarded-for": POSTMARK,
          "x-real-ip": POSTMARK,
          "cf-connecting-ip": POSTMARK,
          forwarded: `for=${POSTMARK}`,
        },
      },
      server,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ip: CLIENT });
    expect(server.requestIP).toHaveBeenCalledTimes(1);
    expect(server.requestIP.mock.calls[0]?.[0]).toBeInstanceOf(Request);
  });

  it("uses wrapped server bindings and only the configured numeric XFF chain", async () => {
    process.env.AGSAAS_TRUSTED_PROXY_IPS = PROXY;
    const response = await createApp().request(
      "http://api.example/",
      {
        headers: {
          "x-forwarded-for": `${POSTMARK}, ${CLIENT}`,
          "x-real-ip": POSTMARK,
          "cf-connecting-ip": POSTMARK,
        },
      },
      { server: serverPeer(PROXY) },
    );
    expect(await response.json()).toEqual({ ip: CLIENT });
  });

  it("does not consult alternate forwarded headers when a trusted proxy omits XFF", async () => {
    process.env.AGSAAS_TRUSTED_PROXY_IPS = PROXY;
    const response = await createApp().request(
      "http://api.example/",
      {
        headers: {
          "x-real-ip": POSTMARK,
          "cf-connecting-ip": POSTMARK,
          forwarded: `for=${POSTMARK}`,
        },
      },
      serverPeer(PROXY),
    );
    expect(await response.json()).toEqual({ ip: "" });
  });

  it("fails closed for missing, unavailable or failed connection metadata", async () => {
    process.env.AGSAAS_TRUSTED_PROXY_IPS = PROXY;
    const environments = [
      {},
      { requestIP: () => null },
      {
        requestIP: () => {
          throw new Error("Connection unavailable");
        },
      },
    ];
    for (const env of environments) {
      const response = await createApp().request(
        "http://api.example/",
        {
          headers: { "x-forwarded-for": POSTMARK },
        },
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ip: "" });
    }
  });

  it("propagates a malformed trust configuration as unknown instead of trusting a partial list", async () => {
    process.env.AGSAAS_TRUSTED_PROXY_IPS = `${PROXY},invalid`;
    const response = await createApp().request(
      "http://api.example/",
      {
        headers: { "x-forwarded-for": POSTMARK },
      },
      serverPeer(PROXY),
    );
    expect(await response.json()).toEqual({ ip: "" });
  });
});
