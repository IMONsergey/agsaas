# Base image with Bun
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS base

# Install turbo CLI globally
FROM base AS turbo-cli
RUN bun add -g turbo@2.11.10

# Builder stage - prune API workspace
FROM turbo-cli AS builder
WORKDIR /app
COPY . .
ARG GIT_COMMIT_SHA=""
# Support both explicit build args and legacy CI stamps; an unstamped checkout
# must still build. An empty stamp leaves runtime/build-id fallbacks intact.
RUN if [ -n "$GIT_COMMIT_SHA" ] || [ ! -f .git-commit-sha ]; then printf '%s' "$GIT_COMMIT_SHA" > .git-commit-sha; fi
RUN turbo prune @midday/api --docker

# Installer stage - install deps and build
FROM base AS installer
WORKDIR /app

# Install dependencies
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/bun.lock ./bun.lock
COPY bunfig.toml .
RUN bun install --frozen-lockfile

# Copy full source
COPY --from=builder /app/out/full/ .

# Build the mcp-apps package (produces self-contained HTML files)
RUN cd packages/mcp-apps && bun run build

# Runner stage - clean image
FROM base AS runner
ARG GIT_COMMIT_SHA=""
LABEL org.opencontainers.image.source="https://github.com/IMONsergey/agsaas" \
      org.opencontainers.image.revision=$GIT_COMMIT_SHA \
      org.opencontainers.image.title="AGSaaS api"
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy only what's needed at runtime
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/api ./apps/api
COPY --from=installer /app/packages ./packages
COPY --from=installer /app/package.json ./package.json

# Carry the git SHA into the runtime container (stamped by CI before `railway up`)
COPY --from=builder /app/.git-commit-sha /tmp/git-sha.txt
COPY --from=builder /app/scripts/docker-entrypoint.sh /app/entrypoint.sh
# Normalize read/execute permissions even when the checkout used umask 0077.
RUN chmod 0755 /app/entrypoint.sh

WORKDIR /app/apps/api

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
