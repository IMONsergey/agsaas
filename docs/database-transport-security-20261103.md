# PostgreSQL transport security

The application database clients use `packages/db/src/connection-config.ts` to
select transport explicitly. TLS verifies the certificate chain and connection
hostname/IP by default in development, test and production. The existing isolated
Docker connections remain plain only when their operator-supplied URL includes
exactly `sslmode=disable`.

This is a source contract. It does not certify a deployed database endpoint,
certificate, CA mount, live connection or migration result.

## Configuration contract

| Configuration | Result |
| --- | --- |
| PostgreSQL URL with no TLS query options | TLS with `rejectUnauthorized: true` and the runtime's normal trust store |
| One `sslmode=verify-full` | The same verified TLS policy |
| One `sslmode=disable` | Explicit plain connection; no CA file is read |
| `sslmode=require`, `prefer`, `verify-ca`, `allow`, `no-verify`, an empty/duplicate mode, a case alias or any other `ssl*` query key | Configuration error before pool creation |
| Any `uselibpqcompat` query key, including `false` | Configuration error before pool creation |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | Configuration error, including for an explicit plain URL |
| `PGSSLMODE` or `PGSSLNEGOTIATION` | Cannot override the helper's explicit `ssl` and `sslnegotiation` values |

The helper consumes the supported mode and removes it from the connection URL
before passing it to `pg`. Non-TLS connection options retain the driver's normal
behavior. It does not log URLs, credentials, CA paths, PEM contents or underlying
parsing errors. Invalid configured URLs and invalid CA settings throw the named
`DatabaseTransportConfigurationError` with a fixed diagnostic message.

This policy is intentionally stricter than existing URLs that used `require`,
`prefer` or `verify-ca`. An operator must replace those modes with `verify-full`
and establish a valid CA/hostname relationship, or explicitly approve an isolated
plain connection and use `disable`. There is no fallback after a TLS error.

## Why the URL must be canonicalized

The inspected installation uses `pg` 8.23.1 and `pg-connection-string` 2.14.1.
`pg/lib/connection-parameters.js` parses `connectionString` over the supplied
configuration; URL SSL controls can therefore replace an explicit `ssl` object.
Changing only `rejectUnauthorized: false` to `true` would leave that override.
The installed parser also has separate libpq-compatibility behavior, and its
defaults are not a stable application security policy.

The application leaves TLS hostname checks to the driver/runtime. It does not
install a permissive `checkServerIdentity` callback or override `servername`.
The installed `pg/lib/connection.js` supplies the actual connection host to TLS,
and sets SNI for DNS hosts. Certificates must cover the configured DNS name or
IP address as applicable.

Primary references: [node-postgres SSL configuration](https://node-postgres.com/features/ssl),
[node-postgres Client configuration](https://node-postgres.com/apis/client), and
[Node TLS connection options](https://nodejs.org/api/tls.html#tlsconnectoptions-callback).

## Explicit private CA

Leave `DATABASE_SSL_CA_FILE` empty when the database certificate is trusted by
the runtime's normal trust store. For a private CA, configure an absolute path
inside each API/worker container and mount the reviewed PEM bundle read-only at
that exact path. Compose passes the variable to those two services; it does not
create or mount a certificate automatically. No actual container configuration
or certificate was changed by this source patch.

The file must be a regular file, its final path component must not be a symlink,
and the path must have no surrounding whitespace or control characters. The
reader checks and bounds the actual read to 256 KiB and at most 64 PEM
certificates, validates each certificate, and rejects mixed content or private
keys. Files supplied by URL options such as `sslrootcert`, `sslcert` and `sslkey`
are rejected. The CA path is trusted operator configuration, never request data.

Supplying `ca` explicitly replaces the TLS runtime's default CA list for that
connection. If the primary, selected replica and worker pooler use different
trust anchors, the one configured bundle must contain the required reviewed
anchors. A CA bundle does not bypass hostname/IP verification. This helper does
not implement client-certificate authentication.

## Coverage and startup

| Consumer | URL selection | Policy application |
| --- | --- | --- |
| API primary, `src/client.ts` | `DATABASE_PRIMARY_URL` | Before primary `Pool` construction |
| API optional regional replica | `DATABASE_FRA_URL`, `DATABASE_IAD_URL` or `DATABASE_SJC_URL` selected by the existing region mapping | Independently for the selected replica; absent/same replica reuses the primary |
| Shared BullMQ worker, `src/worker-client.ts` | `DATABASE_PRIMARY_POOLER_URL ?? DATABASE_PRIMARY_URL` | Before worker `Pool` construction; existing missing-URL guard remains |
| Legacy job client, `src/job-client.ts` | `DATABASE_PRIMARY_POOLER_URL` | For every `createJobDb()` pool |
| Three evaluation scripts | `DATABASE_PRIMARY_URL || DATABASE_URL` | `eval-similar-transactions.ts`, `matching-progress.ts`, `matching-eval-db.ts` |

The API and legacy job client retain their existing lazy-pool import behavior
when a URL is absent. The helper supplies verified TLS even in that case and
does not invent an application URL; the driver's other defaults remain in
effect until connection. An explicitly malformed URL still fails immediately.
The worker continues to require a configured URL. Importing a pool is not a
database readiness check; deployment must provide the intended URL and verify
an actual connection separately.

`packages/db/drizzle.config.ts` is a separate legacy operator migration entry
point using `DATABASE_SESSION_POOLER` through Drizzle Kit. It is not a runtime
client and is not covered by this helper. The isolated SQL test/synthetic
fixture runners also retain their own strict loopback-only connection checks.
Do not infer their behavior from application TLS settings. No migration or
production endpoint is run by the transport tests.

## Validation scope

`src/test/connection-config.test.ts` constructs the actual installed `pg.Client`
to exercise `ConnectionParameters` and URL precedence without connecting.
`src/test/connection-config-clients.test.ts` imports the real API, replica,
worker and legacy job clients in isolated child processes, observes their pool
configuration through the actual driver, and blocks socket/HTTP attempts.
The public test CA is a tracked TypeScript fixture; tests create and remove
their own bounded temporary PEM file. No private key is retained.

The intended follow-up gate is `bun run test:transport` in `packages/db`, DB/API/
worker type checks, API startup/optional-client regressions and the existing
synthetic production build configuration. Source formatting alone is not proof
that these gates passed. A later live transport acceptance must separately
verify valid certificates succeed and untrusted or mismatched certificates fail
against the explicitly selected controlled endpoint.
