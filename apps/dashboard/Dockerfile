# Bun remains the package manager and health/test tool; Next runs on native Node.
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS bun-tools
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS base
COPY --from=bun-tools /usr/local/bin/bun /usr/local/bin/bun
ENV BUN_INSTALL_BIN=/usr/local/bin
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && node -e 'if (process.versions.bun || process.versions.node !== "24.21.0") throw new Error("Native Node 24.21.0 is required")' \
    && test "$(bun --version)" = "1.3.11"

# Install turbo CLI globally using Bun
FROM base AS turbo-cli
RUN bun add -g turbo@2.11.10

# Builder stage - prune dashboard workspace
FROM turbo-cli AS builder
WORKDIR /app
# Copy all files
COPY . .
ARG GIT_COMMIT_SHA=""
RUN if [ -n "$GIT_COMMIT_SHA" ] || [ ! -f .git-commit-sha ]; then printf '%s' "$GIT_COMMIT_SHA" > .git-commit-sha; fi
# Prune dashboard workspace
RUN turbo prune @midday/dashboard --docker

# Installer stage
FROM base AS installer
WORKDIR /app

# Install CA certificates so Sentry CLI can verify SSL during source map upload
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package.json files from pruned workspace
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/bun.lock ./bun.lock
COPY bunfig.toml .

# Install dependencies
RUN bun install --frozen-lockfile

# Copy full source from pruned workspace
COPY --from=builder /app/out/full/ .

# Build-time NEXT_PUBLIC_ env vars (must match this installation's release)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_AUTH_COOKIE_NAME
ARG NEXT_PUBLIC_SUPABASE_ID
ARG NEXT_PUBLIC_URL
ARG NEXT_PUBLIC_RELEASE_SHA
ENV NEXT_PUBLIC_RELEASE_SHA=$NEXT_PUBLIC_RELEASE_SHA
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_OPENPANEL_CLIENT_ID
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_PLAID_ENVIRONMENT
ARG NEXT_PUBLIC_TELLER_APPLICATION_ID
ARG NEXT_PUBLIC_TELLER_ENVIRONMENT
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_GOOGLE_API_KEY
ARG NEXT_PUBLIC_DESKTOP_SCHEME
ARG NEXT_PUBLIC_WHATSAPP_NUMBER
ARG NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
ARG NEXT_PUBLIC_SENDBLUE_NUMBER

# Sentry source map upload (build-time only)
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT

# Server Action encryption key — must be identical across all replicas/regions
# to prevent "Failed to find Server Action" errors. Base64-encoded, 32 bytes.
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

# The builder accepts a GIT_COMMIT_SHA build arg, a legacy CI stamp, or no stamp.
COPY --from=builder /app/.git-commit-sha /tmp/git-sha.txt

ENV CI=true
ENV NODE_ENV=production

# Derive an omitted public revision from the same stamped source revision.
# An explicitly supplied nonempty public revision must still pass the verifier.
# Export all three identities for Next.js and the Sentry webpack plugin.
RUN GIT_COMMIT_SHA=$(cat /tmp/git-sha.txt 2>/dev/null || echo ""); \
    export GIT_COMMIT_SHA; \
    export NEXT_PUBLIC_RELEASE_SHA="${NEXT_PUBLIC_RELEASE_SHA:-$GIT_COMMIT_SHA}"; \
    export SENTRY_RELEASE="$GIT_COMMIT_SHA"; \
    node apps/dashboard/scripts/verify-release-source.mjs && \
    bunx turbo run build --filter=@midday/dashboard --only

# Runner stage - native Node plus Bun health/test tools, no turbo
FROM base AS runner
ARG GIT_COMMIT_SHA=""
LABEL org.opencontainers.image.source="https://github.com/IMONsergey/agsaas" \
      org.opencontainers.image.revision=$GIT_COMMIT_SHA \
      org.opencontainers.image.title="AGSaaS dashboard"
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --no-log-init -g nodejs nextjs

# Copy standalone output
COPY --from=installer --chown=nextjs:nodejs /app/apps/dashboard/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/dashboard/public ./apps/dashboard/public
COPY --from=installer /app/packages/invoice/src/fonts/LICENSE-Liberation.txt ./licenses/Liberation-OFL.txt
COPY --from=installer /app/apps/dashboard/src/fonts/LICENSE-Hedvig.txt ./licenses/Hedvig-OFL.txt

# Carry the git SHA into the runtime container and use the shared entrypoint to
# set GIT_COMMIT_SHA / SENTRY_RELEASE when Railway doesn't provide them.
COPY --from=installer /tmp/git-sha.txt /tmp/git-sha.txt
COPY --from=builder /app/scripts/docker-entrypoint.sh /app/entrypoint.sh
# The non-root runner must be able to read this root-owned shell script.
# chmod +x alone leaves a private 0700 checkout unreadable as mode 0711.
RUN chmod 0755 /app/entrypoint.sh

USER nextjs

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "apps/dashboard/server.js"]
