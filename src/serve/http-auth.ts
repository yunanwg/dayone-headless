/**
 * Defense-in-depth gate for the streamable-HTTP MCP transport. The primary control
 * is still an authenticating proxy in front of the process (loopback bind +
 * Cloudflare Access — see SECURITY.md / docs/deployment.md); these two checks harden
 * the process itself:
 *
 *   1. Origin allowlist (DNS-rebinding protection) — a request carrying a browser
 *      `Origin` header that is not explicitly allowed is rejected with 403 before
 *      any MCP handling. Non-browser MCP clients send no `Origin` and are unaffected.
 *   2. Optional bearer token — when `DAYONE_MCP_TOKEN` is set, every request must
 *      carry `Authorization: Bearer <token>` (constant-time compared) or gets 401.
 *      When unset, auth is off and behavior is unchanged.
 *
 * Pure and side-effect-free so it can be unit-tested without booting the server.
 */

import { timingSafeEqual } from "node:crypto";

export interface HttpGateConfig {
  /** Bearer token required on every request, or undefined to disable auth. */
  token?: string;
  /** Exact `Origin` values a browser request may carry (empty = reject all origins). */
  allowedOrigins: Set<string>;
}

/** Parse the comma-separated `DAYONE_MCP_ALLOWED_ORIGINS` env into an exact-match set. */
export function parseAllowedOrigins(env: string | undefined): Set<string> {
  return new Set(
    (env ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Build the gate config from the environment. */
export function httpGateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpGateConfig {
  return {
    token: env.DAYONE_MCP_TOKEN || undefined,
    allowedOrigins: parseAllowedOrigins(env.DAYONE_MCP_ALLOWED_ORIGINS),
  };
}

/** Constant-time string equality that also tolerates unequal lengths safely. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual requires equal lengths; a length mismatch is an early, safe no.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Apply the origin + auth gate to one request. Returns a `Response` to short-circuit
 * with (403/401), or `null` when the request may proceed to MCP handling.
 */
export function checkHttpGate(req: Request, config: HttpGateConfig): Response | null {
  // 1. DNS-rebinding protection: a present Origin must be allowlisted.
  const origin = req.headers.get("origin");
  if (origin !== null && !config.allowedOrigins.has(origin)) {
    return errorResponse(403, "forbidden origin");
  }

  // 2. Optional bearer-token auth.
  if (config.token) {
    const provided = req.headers.get("authorization") ?? "";
    if (!safeEqual(provided, `Bearer ${config.token}`)) {
      return errorResponse(401, "unauthorized");
    }
  }

  return null;
}
