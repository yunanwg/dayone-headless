/**
 * Authentication, Host, and Origin boundary for the streamable-HTTP transport.
 *
 * Auth modes are deliberately explicit:
 * - none: literal loopback binds only
 * - static: one high-entropy bearer; this is NOT MCP OAuth
 * - cloudflare-access: verify the JWT assertion injected by Cloudflare Access
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { readSecret } from "../secret-config.ts";

export const MCP_TOKEN_MIN_BYTES = 32;
export type HttpAuthMode = "none" | "static" | "cloudflare-access";

export interface AccessJwtVerifier {
  verify(assertion: string): Promise<void>;
}

type HttpAuthentication =
  | { mode: "none" }
  | { mode: "static"; token: string }
  | { mode: "cloudflare-access"; verifier: AccessJwtVerifier };

export interface HttpGateConfig {
  authentication: HttpAuthentication;
  /** Exact `Origin` values a browser request may carry (empty = reject all origins). */
  allowedOrigins: Set<string>;
  /** Exact lower-case Host header values, including a port when non-default. */
  allowedHosts: Set<string>;
}

function parseCommaSeparated(value: string | undefined, lowerCase = false): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (lowerCase ? item.toLowerCase() : item)),
  );
}

export const parseAllowedOrigins = (value: string | undefined): Set<string> => parseCommaSeparated(value);
export const parseAllowedHosts = (value: string | undefined): Set<string> => parseCommaSeparated(value, true);

export function isLoopbackBindHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

class CloudflareAccessJwtVerifier implements AccessJwtVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;

  constructor(
    teamDomain: string,
    private readonly audience: string,
  ) {
    if (!/^[a-z0-9.-]+$/i.test(teamDomain) || !teamDomain.toLowerCase().endsWith(".cloudflareaccess.com")) {
      throw new Error("DAYONE_CF_ACCESS_TEAM_DOMAIN must end in .cloudflareaccess.com");
    }
    this.issuer = `https://${teamDomain}`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`));
  }

  async verify(assertion: string): Promise<void> {
    await jwtVerify(assertion, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
    });
  }
}

export function httpGateConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { accessVerifier?: AccessJwtVerifier } = {},
): HttpGateConfig {
  const configuredMode = env.DAYONE_MCP_AUTH_MODE as HttpAuthMode | undefined;
  if (
    configuredMode !== undefined &&
    configuredMode !== "none" &&
    configuredMode !== "static" &&
    configuredMode !== "cloudflare-access"
  ) {
    throw new Error("DAYONE_MCP_AUTH_MODE must be none, static, or cloudflare-access");
  }

  const hasStaticConfig = env.DAYONE_MCP_TOKEN !== undefined || env.DAYONE_MCP_TOKEN_FILE !== undefined;
  const mode = configuredMode ?? (hasStaticConfig ? "static" : "none");
  const bindHost = env.DAYONE_MCP_HOST?.trim() || "127.0.0.1";
  const hasAccessConfig = Boolean(env.DAYONE_CF_ACCESS_TEAM_DOMAIN || env.DAYONE_CF_ACCESS_AUD);
  if (
    (mode === "none" && (hasStaticConfig || hasAccessConfig)) ||
    (mode === "static" && hasAccessConfig) ||
    (mode === "cloudflare-access" && hasStaticConfig)
  ) {
    throw new Error(`authentication variables conflict with DAYONE_MCP_AUTH_MODE=${mode}`);
  }
  if (mode === "none" && !isLoopbackBindHost(bindHost)) {
    throw new Error("DAYONE_MCP_AUTH_MODE=none requires a loopback DAYONE_MCP_HOST");
  }

  let authentication: HttpAuthentication;
  if (mode === "static") {
    const token = readSecret("DAYONE_MCP_TOKEN", env);
    if (!token || Buffer.byteLength(token) < MCP_TOKEN_MIN_BYTES) {
      throw new Error(`DAYONE_MCP_TOKEN must contain at least ${MCP_TOKEN_MIN_BYTES} bytes`);
    }
    authentication = { mode, token };
  } else if (mode === "cloudflare-access") {
    const teamDomain = env.DAYONE_CF_ACCESS_TEAM_DOMAIN;
    const audience = env.DAYONE_CF_ACCESS_AUD;
    if (!teamDomain || !audience) {
      throw new Error(
        "cloudflare-access mode requires DAYONE_CF_ACCESS_TEAM_DOMAIN and DAYONE_CF_ACCESS_AUD",
      );
    }
    authentication = {
      mode,
      verifier: options.accessVerifier ?? new CloudflareAccessJwtVerifier(teamDomain, audience),
    };
  } else {
    authentication = { mode };
  }

  return {
    authentication,
    allowedOrigins: parseAllowedOrigins(env.DAYONE_MCP_ALLOWED_ORIGINS),
    allowedHosts: parseAllowedHosts(env.DAYONE_MCP_ALLOWED_HOSTS),
  };
}

/** Hash first so the secret comparison has fixed-size inputs for every length. */
function safeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function checkHttpRequestMetadata(req: Request, config: HttpGateConfig): Response | null {
  const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
  if (config.allowedHosts.size === 0 || !config.allowedHosts.has(host)) {
    return errorResponse(421, "misdirected request");
  }

  const origin = req.headers.get("origin");
  if (origin !== null && !config.allowedOrigins.has(origin)) {
    return errorResponse(403, "forbidden origin");
  }

  return null;
}

export async function checkHttpAuthentication(
  req: Request,
  config: HttpGateConfig,
): Promise<Response | null> {
  if (config.authentication.mode === "static") {
    const provided = req.headers.get("authorization") ?? "";
    if (!safeEqual(provided, `Bearer ${config.authentication.token}`)) {
      return errorResponse(401, "unauthorized", {
        "www-authenticate": 'Bearer realm="dayone-headless"',
      });
    }
  } else if (config.authentication.mode === "cloudflare-access") {
    const assertion = req.headers.get("cf-access-jwt-assertion");
    if (!assertion) {
      return errorResponse(401, "unauthorized", {
        "www-authenticate": 'Bearer realm="cloudflare-access"',
      });
    }
    try {
      await config.authentication.verifier.verify(assertion);
    } catch {
      return errorResponse(401, "unauthorized", {
        "www-authenticate": 'Bearer realm="cloudflare-access", error="invalid_token"',
      });
    }
  }

  return null;
}

export async function checkHttpGate(req: Request, config: HttpGateConfig): Promise<Response | null> {
  return checkHttpRequestMetadata(req, config) ?? (await checkHttpAuthentication(req, config));
}
