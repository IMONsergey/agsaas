# Client installation boundaries — 2026-11-03

## Changes

- CLI requires explicit API and, for browser login, dashboard origins. AGSAAS_* variables are preferred; explicit MIDDAY_* aliases remain supported. There is no default upstream endpoint or inferred dashboard hostname.
- Shared installation validation also refuses DNS names ending in a dot, including percent-encoded trailing dots, which otherwise bypassed the upstream hostname exclusion.
- Credentials use a separate agsaas configuration directory, private permissions, atomic replacement, a schema version and exact API-origin binding including the port. Unbound/expired/different-origin credentials are not sent. Environment API keys require matching explicit configured origins even with --api-url.
- API requests reject foreign absolute/protocol-relative/backslash paths before credentials are read; redirects are disabled and requests have a 30-second deadline.
- OAuth browser login binds both listener and redirect to 127.0.0.1, checks state before error/code, rejects duplicate parameters and closes the listener in finally. Unrelated wrong-state callbacks do not consume the login. Registration failure, timeout and cancellation also close it.
- The private CLI bundle includes the shared TypeScript origin helper. Its upstream npm installation instructions were removed; the package and midday alias remain compatibility identifiers, with an additional agsaas executable alias. No npm publication is part of this change.
- Slack home, match and transaction destinations use the configured dashboard, preserving ports and encoded record IDs. The fixed upstream Slack application link was removed. No Slack message is sent during preparation or tests: the suite substitutes fake database, Slack client and network boundaries.
- All 15 MCP catalog descriptions provide the configured API endpoint; upstream setup links and non-existent Install instructions are removed. Provider names and existing client-specific setup components remain.

## Verification contract

Source formatting and diff checks have passed. The separate queue gate must install and record the resolved lock, typecheck CLI/dashboard/API/worker, execute each test file in its own Bun process, build the CLI with tsup and run its built executable with Node. Passing source review is not equivalent to those checks passing.

Regression files: packages/utils/src/envs.test.ts; packages/cli/src/client/installation.test.ts; packages/cli/src/client/callback.test.ts; packages/app-store/src/installation-catalog.test.ts; packages/app-store/src/slack/server/installation-links.test.ts.

## Remaining acceptance

Real OAuth acceptance, provider/client interoperability and browser/device QA require the deployed own installation. CLI token refresh is not implemented; expired access tokens require a new login. JSON response bodies have request deadlines but no dedicated byte ceiling. Callback security relies on its unpredictable state and loopback listener; it does not authenticate the Host header. The disabled desktop package still needs its own distribution/signing work before activation. No real provider credentials, production database, deployed services, DNS or upstream Git history were changed by this packet.
