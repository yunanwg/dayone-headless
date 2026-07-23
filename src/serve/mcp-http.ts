/**
 * Stateless Streamable HTTP boundary for the read-only MCP server.
 *
 * Every POST gets a fresh server and transport. The tools carry no client state,
 * issue no server-to-client requests, and need no resumability, so retaining MCP
 * sessions would only create process-lifetime resource state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { checkHttpGate, type HttpGateConfig } from "./http-auth.ts";

/** Normal MCP requests are tiny; this still leaves ample room for bounded batches. */
export const MCP_HTTP_MAX_REQUEST_BODY_BYTES = 256 * 1024;

export interface StatelessMcpHttpOptions {
  gate: HttpGateConfig;
  buildServer: () => McpServer;
}

function jsonRpcError(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Handle one MCP HTTP request. Authentication and Origin checks happen before
 * any request-body parsing. GET/DELETE are intentionally unavailable because a
 * stateless server has no standalone SSE stream or session to terminate.
 */
export async function handleStatelessMcpHttpRequest(
  req: Request,
  options: StatelessMcpHttpOptions,
): Promise<Response> {
  const gated = checkHttpGate(req, options.gate);
  if (gated) return gated;

  if (req.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed", { allow: "POST" });
  }

  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await options.buildServer().connect(transport);
    return await transport.handleRequest(req);
  } catch {
    return jsonRpcError(500, -32603, "Internal server error");
  }
}
