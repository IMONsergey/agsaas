# Dashboard release source binding

The dashboard source page reads NEXT_PUBLIC_RELEASE_SHA. The image build previously supplied only GIT_COMMIT_SHA, so a real release image could display the development / unknown-revision notice.

The dashboard Compose definition now binds image tag, build SHA, public source SHA and runtime SHA to the required AGSAAS_RELEASE value. Its Dockerfile exports the public SHA and runs the owned verify-release-source.mjs script before the Turbo build. The script rejects an absent, malformed or mismatched revision with a value-free error; both values must match the same 40-character lowercase hexadecimal commit.

The page itself is unchanged. Development builds without a public revision continue to state that they do not identify a matching release source. A syntactically valid revision does not establish that its commit/archive is available on GitHub. Source publication and the final release check remain separate acceptance work.

## Verification contract

- deploy/self-hosted/config.test.ts checks exact Compose build/runtime equality and the Docker guard's position before the build.
- scripts/test-dashboard-build-contract.test.ts executes the actual image validator under a sterile environment for a matching revision and seven refusal cases. It also rejects a missing or passthrough-only public release input.
- The existing actual Turbo dry-run verifier now checks seven independent cache-invalidating inputs with nine dry runs, including NEXT_PUBLIC_RELEASE_SHA. The source page and validator must remain source-hashed inputs. Existing PDF asset checks are retained.

Runtime tests, Turbo dry runs, Docker builds and deployment must run through the shared queue and are not claimed by this source packet. No lockfile, published source or frozen integration worktree is changed.
