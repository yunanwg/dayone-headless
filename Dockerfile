# syntax=docker/dockerfile:1
#
# dayone-headless — a minimal, non-root image running the REST ingester + read
# serving layer (CLI / MCP). No browser, no Chromium: the Playwright "browser"
# ingester is a dev/oracle tool and is excluded (see .dockerignore).
#
#   build:  docker build -t dayone-headless .
#   sync:   docker run --rm --env-file .env -v dayone:/data dayone-headless sync
#   mcp:    docker run --rm --env-file .env -e DAYONE_MCP_PORT=8477 -p 8477:8477 \
#             -v dayone:/data dayone-headless mcp

# --- deps: production dependencies only (no biome/playwright/typescript) ---
FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- runtime ---
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DAYONE_MIRROR=/data/mirror.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# The mirror lives on a writable volume, owned by the non-root `bun` user.
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME ["/data"]

# Healthy once config is valid and the mirror has data (doctor exits non-zero
# until the first sync populates it).
HEALTHCHECK --interval=5m --timeout=15s --start-period=45s \
  CMD bun run src/serve/cli.ts doctor >/dev/null 2>&1 || exit 1

# `dayone <command>` — default to the MCP server; override with `sync`, `doctor`, etc.
ENTRYPOINT ["bun", "run", "src/serve/cli.ts"]
CMD ["mcp"]
