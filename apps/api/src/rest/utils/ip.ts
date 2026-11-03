import { isIP } from "node:net";
import type { Context } from "@api/rest/types";
import type { Context as HonoContext } from "hono";
import { getConnInfo } from "hono/bun";

const MAX_IP_LENGTH = 45;
const MAX_TRUSTED_PROXY_CONFIG_LENGTH = 2048;
const MAX_TRUSTED_PROXIES = 32;
const MAX_FORWARDED_FOR_LENGTH = 1024;
const MAX_FORWARDED_HOPS = 16;
const INVALID_IP_LIST_CHARACTERS = /[^0-9a-fA-F:., \t]/;

/** Strict numeric literals only: no DNS, URL, port, zone ID or legacy IPv4 form. */
function normalizeIp(address: string | undefined): string | null {
  if (
    !address ||
    address.length > MAX_IP_LENGTH ||
    /[^0-9a-fA-F:.]/.test(address)
  ) {
    return null;
  }

  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;

  // isIP has already validated the literal. URL only canonicalizes IPv6 here;
  // constructing it does not perform DNS or network I/O.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;

  // Bun may report an IPv4 peer as IPv4-mapped IPv6. Compare the same address
  // against both the explicit proxy list and existing IPv4 webhook allowlists.
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

function parseTrustedProxies(value: string | undefined): Set<string> | null {
  if (value === undefined || value === "") return new Set();
  if (
    value.length > MAX_TRUSTED_PROXY_CONFIG_LENGTH ||
    INVALID_IP_LIST_CHARACTERS.test(value)
  ) {
    return null;
  }
  if (!value.trim()) return new Set();

  const entries = value.split(",");
  if (entries.length > MAX_TRUSTED_PROXIES) return null;

  const trusted = new Set<string>();
  for (const entry of entries) {
    const address = normalizeIp(entry.trim());
    // These are listen wildcards, never an identifiable trusted HTTP proxy.
    if (!address || address === "0.0.0.0" || address === "::") return null;
    trusted.add(address);
  }
  return trusted;
}

/**
 * Resolve an IP only from the socket peer and explicitly trusted HTTP proxies.
 * An empty result means unknown and must never satisfy an IP allowlist.
 */
export function resolveClientIp({
  remoteAddress,
  forwardedFor,
  trustedProxyIps,
}: {
  remoteAddress: string | undefined;
  forwardedFor?: string;
  trustedProxyIps?: string;
}): string {
  const peer = normalizeIp(remoteAddress);
  if (!peer) return "";

  const trusted = parseTrustedProxies(trustedProxyIps);
  if (!trusted) return ""; // Invalid operator configuration fails closed.
  if (!trusted.has(peer)) return peer; // Ignore all client-supplied IP headers.

  // A trusted proxy must provide a complete, bounded numeric XFF chain. Do not
  // substitute the proxy itself when the originating address is unavailable.
  if (
    !forwardedFor ||
    forwardedFor.length > MAX_FORWARDED_FOR_LENGTH ||
    INVALID_IP_LIST_CHARACTERS.test(forwardedFor)
  ) {
    return "";
  }
  const entries = forwardedFor.split(",");
  if (entries.length > MAX_FORWARDED_HOPS) return "";

  const hops: string[] = [];
  for (const entry of entries) {
    const address = normalizeIp(entry.trim());
    if (!address) return "";
    hops.push(address);
  }

  // Each trusted proxy appends the peer it actually observed. Stop at the
  // nearest untrusted hop; everything to its left may have been forged by it.
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const address = hops[index]!;
    if (!trusted.has(address)) return address;
  }
  return ""; // A chain of proxy addresses alone provides no client identity.
}

export function getClientIp(c: HonoContext<Context>): string {
  let remoteAddress: string | undefined;
  try {
    // Installed Hono's Bun adapter reads server.requestIP(c.req.raw), using the
    // server object passed as the second argument of Bun.serve's fetch handler.
    remoteAddress = getConnInfo(c).remote.address;
  } catch {
    return ""; // Never fall back to a header when the actual peer is unknown.
  }

  return resolveClientIp({
    remoteAddress,
    forwardedFor: c.req.header("x-forwarded-for"),
    trustedProxyIps: process.env.AGSAAS_TRUSTED_PROXY_IPS,
  });
}
