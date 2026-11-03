# Database connections and pooling

This document describes the current source configuration. Pool creation does
not establish that a database is reachable or that a deployed instance uses
these settings. See [PostgreSQL transport security](database-transport-security-20261103.md)
for TLS, CA configuration and stricter URL validation.

## Owned deployment

The application Compose template maps `AGSAAS_DATABASE_URL` to the API's
`DATABASE_PRIMARY_URL`. Its direct example targets `db:5432`. It maps
`AGSAAS_WORKER_DATABASE_URL` to the worker's `DATABASE_PRIMARY_POOLER_URL`;
the transaction pooler example targets `supavisor:6543`. Both template examples
explicitly select `sslmode=disable` for the isolated same-host Docker network.
They do not authorize plain traffic to an external database.

API and worker connection selection lives in `packages/db/src/client.ts` and
`packages/db/src/worker-client.ts`. Every runtime pool applies
`getDatabaseConnectionConfig` after the size/lifetime settings. TLS verification
is independent of `NODE_ENV`; local application clients need an explicit plain
URL when their deliberately isolated database has no TLS.

## Primary and optional replica

The API always creates a primary pool. It optionally creates one replica pool
using the existing `RAILWAY_REPLICA_REGION` mapping:

| Region selector | Replica URL variable |
| --- | --- |
| `europe-west4-drams3a` | `DATABASE_FRA_URL` |
| `us-east4-eqdc4a` | `DATABASE_IAD_URL` |
| `us-west2` | `DATABASE_SJC_URL` |

An absent region, absent matching URL or URL identical to the primary reuses
the primary pool. This compatibility mapping does not imply that an owned
installation has three regions or any read replicas. `src/replicas.ts` controls
read selection; authority-sensitive operations explicitly select the primary.

## API pool settings

| Setting | Development | Non-development with `RAILWAY_ENVIRONMENT_NAME=production` | Other non-development |
| --- | --- | --- | --- |
| `max` | 8 | 40 | 6 |
| `min` | 0 | 8 | 1 |
| `idleTimeoutMillis` | 5,000 | 30,000 | 10,000 |
| `connectionTimeoutMillis` | 5,000 | 5,000 | 5,000 |
| `maxUses` | 100 | 7,500 | 7,500 |

`allowExitOnIdle` is the inverse of the production selector, independently of
`NODE_ENV`. Keep-alive is enabled with an initial delay of 10,000 ms. A separately
configured replica adds another pool with the same limits. Capacity planning
must count every API process, optional replica and worker process against the
actual database/pooler configuration; these numbers are client pool ceilings.

## Worker and legacy jobs

The shared BullMQ worker selects `DATABASE_PRIMARY_POOLER_URL`, falling back to
`DATABASE_PRIMARY_URL` only when the pooler variable is absent. A missing or
empty resulting URL is a configuration error.

| Setting | Worker development | Worker non-development | Legacy per-job client |
| --- | --- | --- | --- |
| `max` | 10 | 50 | 1 |
| `idleTimeoutMillis` | 5,000 | 60,000 | 5,000 development / 60,000 otherwise |
| `connectionTimeoutMillis` | 15,000 | 15,000 | 15,000 |
| `maxUses` | 200 | 3,000 | 0 |
| `allowExitOnIdle` | true | true | true |

The shared worker enables keep-alive with a 10,000 ms initial delay. Its pool is
closed through `closeWorkerDb()`. The legacy `createJobDb()` in `src/job-client.ts`
creates a separate one-connection pool using `DATABASE_PRIMARY_POOLER_URL`; its
caller must call the returned `disconnect()`. API shutdown uses `closeDb()`.

These runtime clients use the installed node-postgres driver through Drizzle.
Transaction-pooler compatibility also depends on actual server/pooler settings
and the query features in use. This source patch does not certify a live pooler
or change the separate Drizzle Kit migration entry point.

## Operational configuration

`DATABASE_SSL_CA_FILE` is an optional absolute path to a reviewed read-only CA
bundle mounted inside both application containers that need it. The source
template passes the value but does not provision a mount. Default TLS uses the
runtime trust store and verifies the connection hostname/IP. Never use
`NODE_TLS_REJECT_UNAUTHORIZED=0` as an operational workaround.

The isolated `TEST_DATABASE_URL` harness retains its own strict loopback-only
contract. Follow [development instructions](agsaas-development.md) for that
harness; application pool defaults do not change its URL validator.
