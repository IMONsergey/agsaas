# Trusted HTTP proxy boundary

## Security contract

`apps/api/src/rest/utils/ip.ts` obtains the actual socket peer through Hono's Bun
`getConnInfo`: the installed adapter reads `server.requestIP(c.req.raw)`. The API
already passes `app.fetch` directly to `Bun.serve`, so Bun supplies that server as
the fetch handler's second argument. Missing or failed connection metadata never
falls back to a request header.

`AGSAAS_TRUSTED_PROXY_IPS` is a server-only, comma-separated list of exact numeric
HTTP proxy addresses. The default is empty: no proxy is trusted. Spaces and tabs
around entries are allowed. Hostnames, CIDR ranges, named groups, wildcards,
unspecified listen addresses (`0.0.0.0`, `::`), empty entries and malformed
addresses invalidate the whole configuration. There is no implicit trust for
loopback, private networks, Docker networks or a fixed number of proxy hops.

The configured peer must be an HTTP proxy that records its observed upstream
peer in `X-Forwarded-For`. A raw transport/NAT gateway shared with untrusted
clients does not establish that property.

| Observed request | Resolved client IP |
| --- | --- |
| Valid socket peer, no trusted proxy configured | The socket peer; all IP headers ignored |
| Valid socket peer not in the configured list | The socket peer; all IP headers ignored |
| Trusted socket peer and valid XFF chain | First untrusted address, walking from right to left |
| No socket peer, invalid configuration, invalid/missing trusted XFF, or a chain consisting only of trusted addresses | Empty string: unknown |

The entire XFF value is validated before using any entry. Its limit is 1,024
characters and 16 IP entries. Configuration is limited to 2,048 characters and
32 entries. Only numeric IP literals and ordinary list whitespace are accepted;
ports, brackets, zone IDs, quoted values, control characters, hostnames and
legacy ambiguous IPv4 forms fail closed. `Forwarded`, `X-Real-IP` and
`CF-Connecting-IP` do not establish client identity.

IPv6 literals are canonicalized after strict numeric validation. IPv4-mapped
IPv6 (`::ffff:192.0.2.10`, including its equivalent hex notation) becomes the
same dotted IPv4 value for both proxy matching and downstream allowlists. Other
IPv6 translation/compatibility ranges are not treated as IPv4.

`withClientIp` stores this result in the Hono context. The inbox webhook's
existing Postmark allowlist consumes it. OAuth's general/DCR limiters and the
MCP limiter also consume this context value; they no longer use raw forwarding
headers. Unknown requests share the `unknown` rate-limit key, and an unknown IP
cannot satisfy the inbox allowlist. The separate mandatory inbox Basic-auth
boundary remains required even when the IP is allowed.

## Observed repository ingress

The source configuration reviewed for this change is:

| Source file | API route |
| --- | --- |
| `deploy/self-hosted/compose.apps.yml` | Host `127.0.0.1:3303` to API container port `8080` |
| `deploy/self-hosted/compose.preview.yml` and `nginx.preview.conf` | Host nginx TLS port `8544` to `127.0.0.1:3503`, then API port `8080` |
| `deploy/self-hosted/compose.candidate.yml` and `nginx.candidate.conf` | Host nginx TLS port `8548` to `127.0.0.1:13503`, then API port `8080` |

Both API nginx vhosts use
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`. Nginx appends its
observed peer to the incoming chain. For a direct ingress request with forged
prefix `3.134.147.250` and actual client `198.51.100.27`, nginx sends
`3.134.147.250, 198.51.100.27`; an explicitly trusted nginx peer resolves to
`198.51.100.27`, stopping before the forged value.

The repository's Caddy service is the optional private mail template file
server in `compose.mail-test.yml`; it is not an API ingress proxy.

The published loopback address is not proof of the peer address observed inside
the API container. Docker NAT may expose a different address. No live peer,
network ACL or deployed configuration was measured or changed by this source
patch. There is deliberately no guessed Docker gateway in the default config.

## Operator setup and acceptance

1. Keep `AGSAAS_TRUSTED_PROXY_IPS` blank until the approved ingress check records
   the actual Bun socket peer for every legitimate API proxy path. Record the
   exact addresses and how each path is restricted to the trusted HTTP proxy.
   A shared NAT source alone cannot distinguish trusted proxies from other
   callers; separate or restrict that path before enabling header trust.
2. Review the actual proxy configuration. Each configured hop must append its
   observed peer or replace the untrusted incoming chain with verified data.
   Do not enable arbitrary `real_ip_header`/`set_real_ip_from` trust upstream.
   Preserve the reviewed loopback host bindings and proxy-only access policy.
3. Set only those observed proxy IPs in the private application environment.
   For syntax only, `192.0.2.10,2001:db8::10` is a valid two-address example;
   these documentation addresses are not deployment values. Do not add the
   Postmark sender IPs to this list: provider senders are clients, not our HTTP
   proxies. Source `compose.apps.yml` passes the value only to the API service.
4. Through the controlled validation/deployment workflow, verify a legitimate
   proxy path and a direct API path with a forged allowlisted XFF prefix. The
   direct request must use its actual peer; the proxied request must stop at the
   first untrusted hop. Confirm a missing/malformed chain is denied by the
   webhook allowlist and that absent/wrong Basic credentials are denied even
   when the transport IP is legitimate. Do not send live provider traffic as
   part of the offline gate.
5. Remeasure and review the exact list after ingress, NAT or network changes.
   A stale list fails conservatively: requests may be grouped under the proxy
   address, and the webhook may reject them. Do not repair availability by
   adding entire private subnets or accepting arbitrary forwarded headers.

The offline regression file is
`apps/api/src/__tests__/auth/client-ip.test.ts`, also included in `test:auth`.
It uses pure parsing cases and the real Hono middleware/Bun adapter with fake
`requestIP` bindings. It starts no server and makes no provider/network calls.
The controlled API gate runs:

```sh
bun --no-env-file test --exit --timeout 30000 src/__tests__/auth/client-ip.test.ts
```

Source review and formatting do not replace that runtime gate or the subsequent
ingress acceptance. The existing `getGeoContext.ip` remains untrusted display
metadata used in notification content; it is not an authorization signal or a
rate-limit key. Do not treat that field as verified audit evidence.

## Primary references

- [Hono connection information](https://hono.dev/docs/helpers/conninfo). The
  inspected installed version is Hono `4.13.16` and still exports `hono/bun`;
  this patch does not change its version or migrate adapters.
- [Node numeric IP validation](https://nodejs.org/api/net.html#netisipinput).
- [Nginx forwarded chain variable](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#var_proxy_add_x_forwarded_for).
- [Postmark webhook source IPs](https://postmarkapp.com/support/article/800-ips-for-firewalls).
  The existing four webhook addresses are unchanged.
