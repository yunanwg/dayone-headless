# Deployment

Running `dayone-headless` as an always-on homelab service: a periodic sync plus
a read-only MCP server, reached remotely and safely. See [SECURITY.md](../SECURITY.md)
for the threat model this follows and [architecture.md](architecture.md) for how
the pieces fit.

## What runs

`docker compose up -d` brings up two services that share **one mirror volume**:

- **`sync`** — runs the REST ingester on a loop (`DAYONE_SYNC_INTERVAL` seconds,
  default 3600). The first sync is full; the rest are incremental and cheap.
- **`mcp`** — an always-on read-only MCP server over streamable-HTTP, bound to
  **loopback `127.0.0.1:8477`**.

The image (`Dockerfile`) is a multi-stage `oven/bun` build. It runs **non-root**
(`bun` user), contains **no browser** (the browser ingester is dev-only), and
declares a `HEALTHCHECK` that goes healthy once `daytwo doctor` passes (i.e. once
the first sync has populated the mirror).

The MCP server waits for the mirror to appear before serving (up to
`DAYONE_MIRROR_WAIT` seconds, default 300), so the two services can start
together on a fresh volume.

## First run

```bash
cp .env.example .env      # fill in the secrets (below)
docker compose up -d
docker compose logs -f sync   # watch the first (full) sync populate the mirror
```

Or run the image directly:

```bash
docker build -t dayone-headless .
docker run --rm --env-file .env -v dayone:/data dayone-headless sync
docker run --rm --env-file .env -e DAYONE_MCP_PORT=8477 \
  -p 127.0.0.1:8477:8477 -v dayone:/data dayone-headless mcp
```

## Environment & secrets

Configure everything through `.env` (git-ignored) or your orchestrator's secret
store. The full list is in [`.env.example`](../.env.example); the essentials:

| Variable | Required | Purpose |
|---|---|---|
| `DAYONE_ENCRYPTION_KEY` | yes | Your Day One encryption key, `D1-<userId>-<code…>`. Decrypts everything. |
| `DAYONE_API_TOKEN` | one of | A 32-char API token. |
| `DAYONE_EMAIL` + `DAYONE_PASSWORD` | one of | Credentials the client uses to self-mint / auto-renew a token. |
| `DAYONE_DEVICE_ID` | recommended | Pin a 32-hex device identity (see below). |
| `DAYONE_MIRROR` | no | Mirror path (compose sets `/data/mirror.db`). |
| `DAYONE_MCP_PORT` / `DAYONE_MCP_HOST` | no | Serve streamable-HTTP on this port/host instead of stdio. |
| `DAYONE_SYNC_INTERVAL` | no | Seconds between syncs in compose (default 3600). |
| `DAYONE_MIRROR_WAIT` | no | Seconds the MCP server waits for the mirror on first boot (default 300). |

Handling rules (the code cooperates — it only ever reads secrets from env and
never logs them):

- Keep `.env` with tight permissions on the ingestion host only, or use
  Docker/compose secrets. Never commit it (it is git-ignored, and gitleaks runs
  in CI and pre-commit).
- The **reading** side (a remote MCP client) needs only the mirror, not the
  secrets. Only the `sync` side needs `DAYONE_ENCRYPTION_KEY` and auth.
- Verify config without exposing values: `docker compose run --rm sync doctor`
  reports secret *presence and shape*, never the values.

## Pin the device id

Without `DAYONE_DEVICE_ID`, each run generates a fresh random device identity, so
Day One registers a **new device every sync**. Pin a stable 32-hex value once
(any 32 hex chars) and reuse it, so repeat runs look like the same device.

## Freshness & sync cadence

- `DAYONE_SYNC_INTERVAL` sets how often the mirror refreshes. Incremental syncs
  are cheap, so a short interval (e.g. 15–60 min) is fine.
- Every read result carries `synced_at`; `daytwo doctor` warns when the mirror is
  more than 24h stale.
- One bad entry can't fail a whole sync — it is skipped and the rest proceed.

## Expose it safely (Cloudflare Access)

**Do not publish the MCP port raw.** It decrypts your entire journal; anyone who
reaches it reads everything. The compose file binds it to `127.0.0.1:8477` on
purpose.

Front it with an authenticating proxy — a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/)
tunnel is the usual self-hosted-MCP pattern:

1. Run `cloudflared` alongside the stack, pointed at `http://127.0.0.1:8477`.
2. Put a Cloudflare Access policy in front of the resulting hostname so only your
   identity can reach it.
3. Point your remote MCP client at the Access-protected URL.

Harden the host like any box holding a private key: least privilege, disk
encryption, restricted egress.

## Backups

The mirror is a plain SQLite file and a **lossless copy** of your journal (every
row keeps the verbatim source in its `raw` column; only media bytes live
elsewhere). To back it up, snapshot the volume or copy `mirror.db` (include the
`-wal` / `-shm` sidecars, or checkpoint first) somewhere private — it contains
decrypted journal text, so treat it as sensitive as the journal itself. Restoring
is just putting the file back; a fresh `sync` will also rebuild it from scratch.

## Releases

Tagging `v*` triggers the release workflow: it builds and pushes the image to
GHCR, generates an SBOM and build provenance, and signs the image with keyless
[cosign](https://github.com/sigstore/cosign).
