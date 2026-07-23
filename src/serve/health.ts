/**
 * Container readiness checks with deliberately separate semantics:
 * - sync readiness evaluates recorded outcome + last-complete freshness only.
 * - MCP readiness exercises the canonical HTTP path, Host allowlist, and the
 *   feasible authentication boundary without claiming upstream validation.
 *
 * Process liveness is owned by the container runtime/restart policy.
 */

import { existsSync } from "node:fs";
import { boundedPositiveInteger, SYNC_STALENESS_BOUNDS } from "../runtime-config.ts";
import { readSecret } from "../secret-config.ts";
import type { SyncStatus } from "../sync-status.ts";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import { httpGateConfigFromEnv } from "./http-auth.ts";
import { MCP_HTTP_PATH } from "./mcp-http.ts";
import { getSyncStatus } from "./queries.ts";

export interface ReadinessResult {
  ready: boolean;
  detail: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function assessSyncReadiness(
  status: SyncStatus,
  nowMs: number,
  maximumStalenessSeconds: number,
): ReadinessResult {
  if (status.status === "failed" || status.status === "degraded" || status.status === "unknown") {
    return { ready: false, detail: `latest sync status is ${status.status}` };
  }
  if (!status.last_complete_at) {
    return { ready: false, detail: "no complete sync has been recorded" };
  }
  const completedAt = Date.parse(status.last_complete_at);
  const ageMs = nowMs - completedAt;
  if (!Number.isFinite(completedAt) || ageMs < 0) {
    return { ready: false, detail: "last complete timestamp is invalid" };
  }
  if (ageMs > maximumStalenessSeconds * 1000) {
    return { ready: false, detail: "last complete sync is stale" };
  }
  return {
    ready: true,
    detail:
      status.status === "running"
        ? "sync in progress; prior complete mirror is fresh"
        : "fresh complete mirror",
  };
}

export function syncReadiness(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): ReadinessResult {
  if (!existsSync(DEFAULT_MIRROR)) {
    return { ready: false, detail: "mirror is not present" };
  }
  const maximumStalenessSeconds = boundedPositiveInteger(
    "DAYONE_SYNC_MAX_STALENESS_SECONDS",
    env.DAYONE_SYNC_MAX_STALENESS_SECONDS,
    SYNC_STALENESS_BOUNDS,
  );
  const db = openMirror();
  try {
    return assessSyncReadiness(getSyncStatus(db), nowMs, maximumStalenessSeconds);
  } finally {
    db.close();
  }
}

export async function mcpHttpReadiness(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<ReadinessResult> {
  const port = boundedPositiveInteger("DAYONE_MCP_PORT", env.DAYONE_MCP_PORT, {
    defaultValue: 8477,
    minimum: 1,
    maximum: 65_535,
  });
  const gate = httpGateConfigFromEnv(env);
  const allowedHost = gate.allowedHosts.values().next().value;
  if (!allowedHost) return { ready: false, detail: "Host allowlist is empty" };

  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    host: allowedHost,
  });
  if (gate.authentication.mode === "static") {
    const token = readSecret("DAYONE_MCP_TOKEN", env);
    if (!token) return { ready: false, detail: "static authentication secret is unavailable" };
    headers.set("authorization", `Bearer ${token}`);
  }

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "health", method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(5000),
    });
    if (gate.authentication.mode === "cloudflare-access") {
      const challenge = response.headers.get("www-authenticate") ?? "";
      return response.status === 401 && challenge.includes("cloudflare-access")
        ? { ready: true, detail: "canonical HTTP and Cloudflare Access boundary reachable" }
        : { ready: false, detail: "Cloudflare Access boundary did not reject an unsigned probe" };
    }
    return response.status === 200
      ? { ready: true, detail: "canonical authenticated MCP request succeeded" }
      : { ready: false, detail: `canonical MCP request returned HTTP ${response.status}` };
  } catch {
    return { ready: false, detail: "MCP HTTP listener is unreachable" };
  }
}
