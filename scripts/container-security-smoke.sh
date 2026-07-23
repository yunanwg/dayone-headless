#!/bin/sh
set -eu

# Linux-oriented, synthetic smoke for file-secret UID portability and the final
# application privilege state. Build the image first, then optionally pass its
# tag as argv[1].

image=${1:-dayone-headless:security-smoke}
suffix=$$
volume="dayone_security_smoke_${suffix}"
container="dayone-security-smoke-${suffix}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker volume create "$volume" >/dev/null
docker run --rm --user 0 --entrypoint /bin/sh -v "$volume:/synthetic" "$image" -c '
  umask 077
  printf "%s" "D1-synthetic-user-synthetic-code" > /synthetic/dayone_encryption_key
  printf "%s" "synthetic-api-token" > /synthetic/dayone_api_token
  ln -s /etc/passwd /synthetic/dayone_email
  mkdir /synthetic/dayone_password
  chown 2000:2000 /synthetic/dayone_encryption_key /synthetic/dayone_api_token
  chmod 0600 /synthetic/dayone_encryption_key /synthetic/dayone_api_token
'

docker run -d --name "$container" \
  --init \
  --user 0 \
  --read-only \
  --cap-drop ALL \
  --cap-add DAC_READ_SEARCH \
  --cap-add CHOWN \
  --cap-add SETUID \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m \
  --tmpfs /run/dayone-secrets:rw,noexec,nosuid,nodev,mode=0700,size=16k \
  -v "$volume:/run/secrets:ro" \
  -e DAYONE_ENCRYPTION_KEY_FILE=/run/secrets/dayone_encryption_key \
  -e DAYONE_API_TOKEN_FILE=/run/secrets/dayone_api_token \
  -e DAYONE_MIRROR_WAIT=3600 \
  -e DAYONE_MCP_PORT=8477 \
  -e DAYONE_MCP_ALLOWED_HOSTS=localhost:8477 \
  "$image" mcp >/dev/null

docker exec --user bun "$container" /bin/sh -c '
  test -r /run/dayone-secrets/dayone_encryption_key
  test -r /run/dayone-secrets/dayone_api_token
  test ! -r /run/secrets/dayone_encryption_key
  test ! -r /run/secrets/dayone_api_token
  app_pid=
  for status_path in /proc/[0-9]*/status; do
    pid=${status_path#/proc/}
    pid=${pid%/status}
    [ -r "/proc/$pid/cmdline" ] || continue
    command_line=$(tr "\000" " " < "/proc/$pid/cmdline")
    case "$command_line" in
      *"bun run /app/src/serve/cli.ts mcp"*) app_pid=$pid; break ;;
    esac
  done
  test -n "$app_pid"
  test "$app_pid" != 1
  grep -Eq "^Uid:[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000$" "/proc/$app_pid/status"
  grep -Eq "^Gid:[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000$" "/proc/$app_pid/status"
  grep -Eq "^Cap(Inh|Prm|Eff|Bnd|Amb):[[:space:]]+0+$" "/proc/$app_pid/status"
  test "$(grep -Ec "^Cap(Inh|Prm|Eff|Bnd|Amb):[[:space:]]+0+$" "/proc/$app_pid/status")" -eq 5
  grep -Eq "^NoNewPrivs:[[:space:]]+1$" "/proc/$app_pid/status"
'

if docker run --rm --user bun --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --entrypoint /usr/local/bin/bun \
  -e DAYONE_MCP_HOST=0.0.0.0 \
  -e DAYONE_MCP_AUTH_MODE=none \
  "$image" -e '
    const { httpGateConfigFromEnv } = await import("/app/src/serve/http-auth.ts");
    httpGateConfigFromEnv();
  ' >/dev/null 2>&1; then
  echo "HTTP gate accepted auth=none on a wildcard bind" >&2
  exit 1
fi

if docker run --rm --init --user 0 --read-only \
  --cap-drop ALL --cap-add DAC_READ_SEARCH --cap-add CHOWN \
  --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
  --security-opt no-new-privileges \
  --tmpfs /run/dayone-secrets:rw,noexec,nosuid,nodev,mode=0700,size=16k \
  -e DAYONE_API_TOKEN_FILE=/etc/passwd \
  "$image" health-sync >/dev/null 2>&1; then
  echo "entrypoint accepted an arbitrary secret source path" >&2
  exit 1
fi

for invalid_secret in dayone_email dayone_password; do
  variable=DAYONE_EMAIL_FILE
  [ "$invalid_secret" = dayone_password ] && variable=DAYONE_PASSWORD_FILE
  if docker run --rm --init --user 0 --read-only \
    --cap-drop ALL --cap-add DAC_READ_SEARCH --cap-add CHOWN \
    --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
    --security-opt no-new-privileges \
    --tmpfs /run/dayone-secrets:rw,noexec,nosuid,nodev,mode=0700,size=16k \
    -v "$volume:/run/secrets:ro" \
    -e "$variable=/run/secrets/$invalid_secret" \
    "$image" health-sync >/dev/null 2>&1; then
    echo "entrypoint accepted a symlink or non-regular secret mount" >&2
    exit 1
  fi
done

if docker exec "$container" /usr/local/bin/dayone-entrypoint health-mcp 2>&1 |
  grep -q "MCP HTTP listener is unreachable"; then
  :
else
  echo "repeated secret staging did not reach the MCP readiness probe" >&2
  exit 1
fi

echo "container security smoke passed"
