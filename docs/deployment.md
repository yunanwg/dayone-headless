# Deployment

Run `dayone-headless` as two least-privilege services: a periodic ingester and a
read-only MCP server over the same private mirror. The public boundary is an
authenticating reverse proxy; the MCP port itself stays on loopback.

## What runs

The Compose stack defines:

- **`sync`** — REST ingestion every `DAYONE_SYNC_INTERVAL` seconds (default
  3600). It alone receives the Day One encryption key and upstream credential.
- **`mcp`** — stateless Streamable HTTP on **`POST /mcp`**, published only as
  **`127.0.0.1:8477`**. It receives no Day One upstream credentials. Because
  the process must bind the container wildcard for a published port, it refuses
  to start with `DAYONE_MCP_AUTH_MODE=none`; choose static or Cloudflare Access
  authentication before starting this service.

The application in both containers runs as the non-root `bun` user. A short
root entrypoint receives only the capabilities needed to read an owner-only
bind-mounted secret, copy it, assign it to `bun`, and change UID/GID. It stages
the known files as `0400` in a non-listable `/run/dayone-secrets` tmpfs. Each
`*_FILE` variable must name its exact `/run/secrets/<known-name>` mount; the
container entrypoint rejects alternate paths, symlinks, and non-regular files.
General local, non-container `*_FILE` paths remain supported by the runtime. It then
executes Bun with empty inherited, permitted, effective, ambient, and bounding
capability sets plus `no-new-privileges`. Secret values remain out of
environment and Compose/container metadata. Compose also limits PIDs and uses a
read-only root filesystem plus separate `/tmp` and secret-staging tmpfs mounts.
The Dockerfile pins both the Bun version and its multi-architecture OCI index
digest so an existing source revision cannot silently resolve to different base
image bytes.

The shared `/data` volume remains writable in both containers for SQLite WAL
compatibility. SQLite may need to create or open `mirror.db-wal` and
`mirror.db-shm`, including when the application connection is read-only. The MCP
code therefore enforces read-only access at two independent SQLite layers:
the database is opened with `readonly: true` and `PRAGMA query_only = ON`.
Container filesystem policy is defense in depth, not the read-only product
boundary.

Decrypted media is shared at `/data/media`; otherwise an MCP media lookup could
return a cache path that exists only in `sync`.

## First run: file-mounted secrets

Compose does not load credentials through `env_file`. Create owner-only files
outside version control:

```bash
install -d -m 700 secrets
install -m 600 /dev/null secrets/dayone_encryption_key
install -m 600 /dev/null secrets/dayone_api_token
```

Write each value with an editor or secret manager that does not add it to shell
history. The default stack expects:

- `secrets/dayone_encryption_key`
- `secrets/dayone_api_token`

Paths can be replaced with `DAYONE_ENCRYPTION_KEY_SECRET_FILE` and
`DAYONE_API_TOKEN_SECRET_FILE`. Runtime code reads the mounted files through
`DAYONE_ENCRYPTION_KEY_FILE` and `DAYONE_API_TOKEN_FILE`. Setting both a direct
secret variable and its `_FILE` companion is a startup error.

Compose secret `file:` sources are bind mounts on ordinary Linux and preserve
the host file's numeric ownership. A host-side `0600` file therefore cannot be
read portably by a fixed image UID. The entrypoint's tmpfs staging is the
compatibility boundary: it starts with narrow capabilities only long enough to
copy the file, then the long-running process is UID/GID 1000 with no
capabilities. `scripts/container-security-smoke.sh` creates synthetic secrets
owned by UID/GID 2000, verifies that UID 1000 can read only the staged copies,
rejects arbitrary/symlink/non-regular sources, starts with the same init topology
as Compose, and checks the actual Bun child process for its final privilege state:

```bash
docker build -t dayone-headless:security-smoke .
./scripts/container-security-smoke.sh dayone-headless:security-smoke
```

Pin a stable device ID in a small, non-secret `.env`:

```dotenv
DAYONE_DEVICE_ID=00112233445566778899aabbccddeeff
DAYONE_SYNC_INTERVAL=3600
```

Use your own random 32-hex device ID; the value above is synthetic documentation
only. Then:

```bash
docker compose config --quiet
docker compose up -d sync
docker compose logs -f sync
```

Use `config --quiet`, not a rendered `docker compose config` dump. A rendered
configuration can expose direct environment values supplied by an operator,
even though this repository's default Compose file keeps credentials in secret
files.

To mint API tokens from account credentials instead, create
`secrets/dayone_email` and `secrets/dayone_password`, then apply the override:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.password.yml \
  config --quiet
docker compose \
  -f docker-compose.yml \
  -f docker-compose.password.yml \
  up -d
```

Do not grant the email/password secrets in addition to an API-token secret. The
override removes the token-file setting so configuration remains unambiguous.
It uses Compose's `!reset` and `!override` merge tags and therefore requires a
current Docker Compose release.

## HTTP security boundary

The origin accepts only **`POST /mcp`**. It rejects requests whose exact `Host`
is not in `DAYONE_MCP_ALLOWED_HOSTS`, rejects browser origins not in
`DAYONE_MCP_ALLOWED_ORIGINS`, caps request bodies at 256 KiB, and bounds active
requests with `DAYONE_MCP_MAX_CONCURRENCY` (default 8). Cheap Host/Origin checks
run first; static authentication and Cloudflare JWT/JWKS verification consume
the same bounded slot as MCP handling. Overload returns `429` with
`Retry-After: 1`. All responses carry `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`.

Set the Host allowlist to the values the application actually receives,
including the port when non-default. Compose defaults to
`127.0.0.1:8477,localhost:8477`; a public proxy hostname must be added
explicitly. This allowlist prevents Host-header confusion but is **not
authentication**. The Origin allowlist is not a CORS feature: empty means every
browser-origin request is rejected, while ordinary non-browser MCP clients
usually omit `Origin`.

Authentication is explicit through `DAYONE_MCP_AUTH_MODE`:

| Mode | Use |
|---|---|
| `none` | Literal loopback bind only (`127.0.0.0/8`, `::1`, or `localhost`). Startup fails on wildcard, LAN, container-network, or public binds. |
| `static` | A minimum-32-byte bearer checked by the origin. This is a private shared-secret scheme, **not MCP OAuth**. |
| `cloudflare-access` | Validate the `Cf-Access-Jwt-Assertion` injected by Cloudflare Access, including issuer, audience, signature, and expiry. |

Publishing a wildcard-bound container port only on host loopback does not relax
this rule: the application process itself is still reachable on the container
network. Use `static` or `cloudflare-access` for the Compose MCP service.

### Static bearer

Create `secrets/dayone_mcp_token` with at least 32 random bytes and start with:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.static-auth.yml \
  up -d
```

The client must send `Authorization: Bearer <token>`. This mode deliberately
does not implement OAuth discovery, protected-resource metadata, token issuance,
or audience negotiation. Do not describe it as OAuth. It also occupies the
`Authorization` header, so it is unsuitable when an upstream MCP OAuth flow
needs that header for its own access token.

### Cloudflare Access assertion validation

For an Access-protected hostname, set:

```dotenv
DAYONE_MCP_AUTH_MODE=cloudflare-access
DAYONE_MCP_HOST=0.0.0.0
DAYONE_CF_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com
DAYONE_CF_ACCESS_AUD=your-application-audience-tag
DAYONE_MCP_ALLOWED_HOSTS=journal.example.com
```

The origin retrieves Cloudflare's JWKS and validates the assertion from the
`Cf-Access-Jwt-Assertion` header. It does not trust the header merely because it
exists. Client OAuth `Authorization` headers are left untouched in this mode.
Only use it where untrusted clients cannot bypass Cloudflare and reach the
origin directly.

This origin does not itself implement the MCP OAuth authorization-server
protocol. If Cloudflare Managed OAuth is used at the edge, Cloudflare owns that
client-facing OAuth exchange and this mode validates the resulting Access
identity at the origin.

## Tunnel topology

Never publish port 8477 on a public interface.

- If `cloudflared` runs on the host, its origin URL can be
  `http://127.0.0.1:8477`.
- If `cloudflared` runs in another Compose container, put it on the same private
  network and use `http://mcp:8477`. Inside that container, `localhost` means the
  tunnel container itself, not the MCP service.

The proxy terminates TLS and can see plaintext journal responses. Disable
request/response body logging and caching there. Preserve the original Host or
add the actual forwarded value to `DAYONE_MCP_ALLOWED_HOSTS`. Restrict direct
origin reachability so proxy authentication cannot be bypassed.

## Operations

- Container restart policy supplies process **liveness**. The `sync` healthcheck
  is separate **outcome/freshness readiness**: the latest attempt must not be
  degraded/failed/unknown and the last complete mirror must be within
  `DAYONE_SYNC_MAX_STALENESS_SECONDS` (default 86400). It evaluates recorded
  local outcomes; it does not claim that upstream credentials or Day One's API
  are currently reachable.
- The `mcp` healthcheck performs a synthetic `tools/list` request against the
  canonical `POST /mcp` path with an allowed Host. In `none`/`static` mode it
  expects a successful request. In Cloudflare Access mode it expects the origin
  to reject a probe without an assertion, proving the local route and auth gate
  without claiming a live JWKS/signature check.
- `DAYONE_HTTP_TIMEOUT_MS` bounds each upstream REST request (default 60000;
  range 1000–300000).
- Every upstream body is consumed through a streaming decoded-byte ceiling:
  login 64 KiB, journal manifest and user-key responses 4 MiB, an entries feed
  32 MiB, one encrypted entry 4 MiB, and one encrypted attachment 64 MiB.
  A manifest is additionally capped at 1,024 journals, a feed at 25,000 items,
  a whole sync at 100,000 observed entry references, retained mapped source at
  64 MiB per journal, and a media worklist at 100,000 rows. Feed lines are
  counted and parsed incrementally; malformed JSON fails closed. Decrypted D1
  entry plaintext is capped at 16 MiB at every gzip layer with at most three
  nested layers. Exceeding a boundary fails or degrades the attempt rather than
  aggregating unbounded memory.
- `DAYONE_SYNC_INTERVAL` accepts integer seconds from 60–86400 (default 3600);
  `DAYONE_MIRROR_WAIT` accepts 1–3600 (default 300).
- `DAYONE_SYNC_CONCURRENCY` accepts 1–64 (default 8);
  `DAYONE_MEDIA_CONCURRENCY` accepts 1–32 (default 6); and
  `DAYONE_MCP_MAX_CONCURRENCY` accepts 1–256 (default 8). Malformed, fractional,
  non-positive, or excessive values fail closed.
- Every read result carries `synced_at`; `daytwo doctor` warns after 24 hours
  without a complete sync.
- A degraded sync does not advance last-complete freshness and retries failed
  entries next run.
- Unattended sync/media progress logs contain only synthetic-safe categories and
  counts, never decrypted journal names or entry/media identifiers.
- `docker compose run --rm sync doctor` reports secret presence/shape and local
  plaintext permissions without printing values.
- `doctor --fix-permissions` is an explicit repair operation; normal health
  checks never broaden permissions.

The `@hono/node-server` transitive dependency is overridden to a patched
release. `test/hono-node-server-compat.test.ts` starts that exact adapter under
Node and makes a real HTTP request so future dependency changes cannot silently
break the wrapper boundary.

## Backups

The mirror contains decrypted journal text and metadata; `/data/media` contains
decrypted attachment bytes. Back up both. For a live SQLite backup, snapshot the
whole volume (including `-wal` and `-shm`) or checkpoint before copying the main
database. Encrypt backups and apply the same access controls as the journal.

## Releases

Tagging `v*` triggers the release workflow: it builds and pushes the image to
GHCR, generates an SBOM and build provenance, and signs the image with keyless
[cosign](https://github.com/sigstore/cosign).
