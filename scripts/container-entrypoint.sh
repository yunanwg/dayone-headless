#!/bin/sh
set -eu

# Compose file-backed secrets are bind mounts and retain the host file's numeric
# ownership. A 0600 secret owned by an arbitrary Linux host UID is therefore not
# reliably readable by the image's `bun` user. This short root-only init copies
# the known secret files into a private tmpfs, then drops every capability before
# the application starts.

secret_dir=/run/dayone-secrets

stage_secret() {
  secret_name=$1
  mount_name=$2
  source_path=$3
  destination_path=$4
  temporary_path="${destination_path}.tmp.$$"
  expected_source="/run/secrets/$mount_name"

  [ -n "$source_path" ] || return 0
  if [ "$source_path" != "$expected_source" ]; then
    echo "$secret_name file must use its fixed container secret mount" >&2
    exit 1
  fi
  # The container boundary accepts only the exact read-only secret mount. Local
  # non-container callers still retain the runtime's general *_FILE support.
  if [ ! -f "$source_path" ] || [ -L "$source_path" ]; then
    echo "$secret_name file mount must be a non-symlink regular file" >&2
    exit 1
  fi
  if [ ! -d "$secret_dir" ]; then
    echo "$secret_name file staging requires a tmpfs at $secret_dir" >&2
    exit 1
  fi
  if ! cp -- "$source_path" "$temporary_path"; then
    echo "unable to stage $secret_name from its configured file" >&2
    exit 1
  fi
  chmod 0400 "$temporary_path"
  chown bun:bun "$temporary_path"
  mv -f "$temporary_path" "$destination_path"
}

umask 077
stage_secret DAYONE_ENCRYPTION_KEY dayone_encryption_key "${DAYONE_ENCRYPTION_KEY_FILE:-}" \
  "$secret_dir/dayone_encryption_key"
stage_secret DAYONE_API_TOKEN dayone_api_token "${DAYONE_API_TOKEN_FILE:-}" \
  "$secret_dir/dayone_api_token"
stage_secret DAYONE_EMAIL dayone_email "${DAYONE_EMAIL_FILE:-}" \
  "$secret_dir/dayone_email"
stage_secret DAYONE_PASSWORD dayone_password "${DAYONE_PASSWORD_FILE:-}" \
  "$secret_dir/dayone_password"
stage_secret DAYONE_MCP_TOKEN dayone_mcp_token "${DAYONE_MCP_TOKEN_FILE:-}" \
  "$secret_dir/dayone_mcp_token"

if [ -n "${DAYONE_ENCRYPTION_KEY_FILE:-}" ]; then
  export DAYONE_ENCRYPTION_KEY_FILE="$secret_dir/dayone_encryption_key"
fi
if [ -n "${DAYONE_API_TOKEN_FILE:-}" ]; then
  export DAYONE_API_TOKEN_FILE="$secret_dir/dayone_api_token"
fi
if [ -n "${DAYONE_EMAIL_FILE:-}" ]; then
  export DAYONE_EMAIL_FILE="$secret_dir/dayone_email"
fi
if [ -n "${DAYONE_PASSWORD_FILE:-}" ]; then
  export DAYONE_PASSWORD_FILE="$secret_dir/dayone_password"
fi
if [ -n "${DAYONE_MCP_TOKEN_FILE:-}" ]; then
  export DAYONE_MCP_TOKEN_FILE="$secret_dir/dayone_mcp_token"
fi

# Keep the directory root-owned and non-listable. `bun` can traverse to the
# explicitly configured 0400 files, while later healthcheck entrypoints can
# atomically replace a staged copy without needing write-bypass capabilities.
if [ -d "$secret_dir" ]; then
  chmod 0711 "$secret_dir"
fi

exec setpriv \
  --reuid=bun \
  --regid=bun \
  --init-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  --no-new-privs \
  bun run /app/src/serve/cli.ts "$@"
