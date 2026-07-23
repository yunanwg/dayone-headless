/**
 * Stateless Streamable HTTP boundary for the read-only MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { checkHttpAuthentication, checkHttpRequestMetadata, type HttpGateConfig } from "./http-auth.ts";

export const MCP_HTTP_PATH = "/mcp";
export const MCP_HTTP_MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const MCP_HTTP_DEFAULT_MAX_CONCURRENCY = 8;

export class RequestConcurrencyLimiter {
  private active = 0;

  constructor(public readonly maximum: number = MCP_HTTP_DEFAULT_MAX_CONCURRENCY) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 256) {
      throw new RangeError("HTTP concurrency must be an integer from 1 to 256");
    }
  }

  acquire(): (() => void) | null {
    if (this.active >= this.maximum) return null;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}

export interface StatelessMcpHttpOptions {
  gate: HttpGateConfig;
  buildServer: () => McpServer;
  limiter?: RequestConcurrencyLimiter;
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonRpcError(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return secure(
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

export async function handleStatelessMcpHttpRequest(
  req: Request,
  options: StatelessMcpHttpOptions,
): Promise<Response> {
  const rejectedMetadata = checkHttpRequestMetadata(req, options.gate);
  if (rejectedMetadata) return secure(rejectedMetadata);

  const release = options.limiter ? options.limiter.acquire() : () => {};
  if (release === null) {
    return jsonRpcError(429, -32000, "Server busy", { "retry-after": "1" });
  }
  try {
    // Cloudflare JWT/JWKS verification is networked and potentially expensive,
    // so it must consume the same bounded request slot as MCP handling.
    const rejectedAuthentication = await checkHttpAuthentication(req, options.gate);
    if (rejectedAuthentication) return secure(rejectedAuthentication);

    if (new URL(req.url).pathname !== MCP_HTTP_PATH) {
      return jsonRpcError(404, -32000, "Not found");
    }
    if (req.method !== "POST") {
      return jsonRpcError(405, -32000, "Method not allowed", { allow: "POST" });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await options.buildServer().connect(transport);
    return secure(await transport.handleRequest(req));
  } catch {
    return jsonRpcError(500, -32603, "Internal server error");
  } finally {
    release();
  }
}
