FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS base
WORKDIR /app
COPY package.json bun.lock ./
FROM base AS dependencies
RUN bun install --frozen-lockfile --production
FROM base AS build
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN bun run build
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime-base
ENV NODE_ENV=production PORT=3000
WORKDIR /app
FROM runtime-base AS runtime
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node package.json ./
COPY --chown=node:node skills ./skills
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# Pinned client only; the host's existing Docker daemon runs the task containers.
FROM docker:29-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c AS docker-client

# Install supervisor tools before application files so code changes reuse this layer.
FROM runtime-base AS codex-supervisor-dependencies
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends podman ca-certificates \
    && test -s /etc/ssl/certs/ca-certificates.crt \
    && npm install -g @openai/codex@0.155.1 \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
# Trusted supervisor: only this service receives the selected engine socket.
FROM codex-supervisor-dependencies AS codex-supervisor
COPY --from=runtime --chown=node:node /app /app
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "require('fs').accessSync('/etc/ssl/certs/ca-certificates.crt');fetch('http://127.0.0.1:3020/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/runner-server.js"]

# Reused for preparation, isolated implementation, and fresh PR publication.
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS codex-job
ARG CODEX_VERSION=0.155.1
ARG OPEN_CODE_REVIEW_VERSION=1.12.12
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} @alibaba-group/open-code-review@${OPEN_CODE_REVIEW_VERSION} \
    && npm cache clean --force
COPY --from=base /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/deepx
COPY --from=build /app/dist/job.js ./job.js
COPY --from=dependencies /app/node_modules/zod ./node_modules/zod
RUN mkdir /task /input /auth && chown node:node /task /auth
ENV HOME=/task/home
USER node
ENTRYPOINT ["node", "/opt/deepx/job.js"]

# Preserve the ordinary app as the default build target.
FROM runtime AS app
