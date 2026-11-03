# Own website release: native Node, frozen Bun dependencies, no Vercel runtime.
FROM oven/bun:1.3.11 AS bun-tools
FROM node:24.21.0-trixie-slim AS base
COPY --from=bun-tools /usr/local/bin/bun /usr/local/bin/bun
ENV BUN_INSTALL_BIN=/usr/local/bin
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

FROM base AS pruner
RUN bun add -g turbo@2.11.10
ENV PATH=/root/.bun/bin:$PATH
WORKDIR /app
COPY . .
RUN turbo prune @midday/website --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
COPY bunfig.toml .
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
ARG GIT_COMMIT_SHA
ARG NEXT_PUBLIC_RELEASE_SHA
ARG NEXT_PUBLIC_WEBSITE_URL
ARG NEXT_PUBLIC_DASHBOARD_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_INDEXABLE=false
ENV NODE_ENV=production CI=true
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ENV NEXT_PUBLIC_RELEASE_SHA=$NEXT_PUBLIC_RELEASE_SHA
ENV NEXT_PUBLIC_WEBSITE_URL=$NEXT_PUBLIC_WEBSITE_URL
ENV NEXT_PUBLIC_DASHBOARD_URL=$NEXT_PUBLIC_DASHBOARD_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SITE_INDEXABLE=$NEXT_PUBLIC_SITE_INDEXABLE
RUN node -e 'const e=process.env; if(!/^[a-f0-9]{40}$/.test(e.GIT_COMMIT_SHA||"") || e.NEXT_PUBLIC_RELEASE_SHA!==e.GIT_COMMIT_SHA) throw Error("Exact matching release SHA required"); for(const k of ["NEXT_PUBLIC_WEBSITE_URL","NEXT_PUBLIC_DASHBOARD_URL","NEXT_PUBLIC_API_URL"]){const u=new URL(e[k]);if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||u.pathname!=="/")throw Error("Canonical own HTTPS origins required");}'
RUN printf '%s' "$GIT_COMMIT_SHA" > /tmp/git-sha.txt
RUN bun run --cwd apps/website build

FROM base AS runner
WORKDIR /app
ARG GIT_COMMIT_SHA
LABEL org.opencontainers.image.source="https://github.com/IMONsergey/agsaas" \
      org.opencontainers.image.revision=$GIT_COMMIT_SHA \
      org.opencontainers.image.title="AGSaaS website"
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --no-log-init -g nodejs nextjs
COPY --from=installer --chown=nextjs:nodejs /app/apps/website/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/website/.next/static ./apps/website/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/website/public ./apps/website/public
COPY --from=installer /tmp/git-sha.txt /tmp/git-sha.txt
COPY --from=pruner /app/scripts/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh
USER nextjs
EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "apps/website/server.js"]
