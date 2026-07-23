# syntax=docker/dockerfile:1
#
# dayone-headless — a minimal, non-root image running the REST ingester + read
# serving layer (CLI / MCP). No browser, no Chromium: the Playwright "browser"
# ingester is a dev/oracle tool and is excluded (see .dockerignore).
#
#   build:  docker build -t dayone-headless .
#   sync:   docker run --rm --env-file .env -v dayone:/data dayone-headless sync
#   mcp:    docker run --rm -e DAYONE_MIRROR=/data/mirror.db -e DAYONE_MCP_PORT=8477 \
#             -e DAYONE_MCP_HOST=0.0.0.0 -p 127.0.0.1:8477:8477 -v dayone:/data \
#             dayone-headless mcp   # no --env-file or Day One upstream secrets

# Multi-architecture OCI index for oven/bun:1.3.14-slim.
ARG BUN_IMAGE=oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

# --- deps: production dependencies only (no biome/playwright/typescript) ---
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- runtime ---
FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DAYONE_MIRROR=/data/mirror.db \
    DAYONE_MEDIA_DIR=/data/media

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts/container-entrypoint.sh /usr/local/bin/dayone-entrypoint

# The mirror lives on a writable volume, owned by the non-root `bun` user. The
# image starts with a minimal root init so Linux bind-mounted 0600 secrets can be
# copied into tmpfs regardless of host UID. The entrypoint then execs Bun as
# `bun` with an empty capability bounding set.
RUN chmod 0555 /usr/local/bin/dayone-entrypoint \
    && mkdir -p /data \
    && chown -R bun:bun /data /app \
    && chmod 0700 /data
USER root
VOLUME ["/data"]

# Health is service-specific and defined by Compose.
HEALTHCHECK NONE

# `dayone <command>` — default to the MCP server; override with `sync`, `doctor`, etc.
ENTRYPOINT ["/usr/local/bin/dayone-entrypoint"]
CMD ["mcp"]
