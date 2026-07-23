import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  handleStatelessMcpHttpRequest,
  MCP_HTTP_MAX_REQUEST_BODY_BYTES,
  type StatelessMcpHttpOptions,
} from "../src/serve/mcp-http.ts";

const openGate = { token: undefined, allowedOrigins: new Set<string>() };
const mcpHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

function testServer() {
  const server = new McpServer({ name: "stateless-test", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a synthetic value",
      inputSchema: { value: z.string() },
    },
    async ({ value }) => ({ content: [{ type: "text", text: value }] }),
  );
  return server;
}

function textContent(result: unknown): string {
  const content = CallToolResultSchema.parse(result).content[0];
  if (content?.type !== "text") throw new Error("expected text tool result");
  return content.text;
}

test("official client initializes, lists tools, and calls tools over independent stateless POSTs", async () => {
  let builds = 0;
  const requests: Array<{ method: string; sessionId: string | null }> = [];
  const responseSessionIds: Array<string | null> = [];
  const options: StatelessMcpHttpOptions = {
    gate: openGate,
    buildServer: () => {
      builds++;
      return testServer();
    },
  };
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    requests.push({ method: req.method, sessionId: req.headers.get("mcp-session-id") });
    const response = await handleStatelessMcpHttpRequest(req, options);
    responseSessionIds.push(response.headers.get("mcp-session-id"));
    return response;
  };

  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), { fetch: fetcher });
  const client = new Client({ name: "stateless-test-client", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const first = await client.callTool({ name: "echo", arguments: { value: "first" } });
  const second = await client.callTool({ name: "echo", arguments: { value: "second" } });
  await client.close();

  expect(tools.tools.map((tool) => tool.name)).toContain("echo");
  expect(textContent(first)).toBe("first");
  expect(textContent(second)).toBe("second");
  const posts = requests.filter((request) => request.method === "POST");
  expect(builds).toBe(posts.length);
  expect(builds).toBeGreaterThanOrEqual(5);
  expect(requests.some((request) => request.method === "GET")).toBe(true);
  expect(requests.every((request) => request.sessionId === null)).toBe(true);
  expect(responseSessionIds.every((sessionId) => sessionId === null)).toBe(true);
});

test("a non-initialize request works independently while malformed JSON returns a protocol error", async () => {
  let builds = 0;
  const options: StatelessMcpHttpOptions = {
    gate: openGate,
    buildServer: () => {
      builds++;
      return testServer();
    },
  };
  const toolsResponse = await handleStatelessMcpHttpRequest(
    new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    options,
  );
  const malformedResponse = await handleStatelessMcpHttpRequest(
    new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: "{not-json",
    }),
    options,
  );

  expect(toolsResponse.status).toBe(200);
  expect(toolsResponse.headers.get("mcp-session-id")).toBeNull();
  expect(await toolsResponse.text()).toContain('"tools"');
  expect(malformedResponse.status).toBe(400);
  expect(await malformedResponse.text()).toContain("Parse error");
  expect(builds).toBe(2);
});

test("auth runs before parsing and does not construct a server for rejected JSON", async () => {
  let builds = 0;
  const response = await handleStatelessMcpHttpRequest(
    new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: "{not-json",
    }),
    {
      gate: { token: "synthetic-token", allowedOrigins: new Set<string>() },
      buildServer: () => {
        builds++;
        return testServer();
      },
    },
  );

  expect(response.status).toBe(401);
  expect(builds).toBe(0);
  expect(await response.text()).toContain("unauthorized");
});

test("GET and DELETE are authenticated but unsupported without stateless sessions", async () => {
  let builds = 0;
  const options: StatelessMcpHttpOptions = {
    gate: openGate,
    buildServer: () => {
      builds++;
      return testServer();
    },
  };

  for (const method of ["GET", "DELETE"]) {
    const response = await handleStatelessMcpHttpRequest(
      new Request("http://mcp.test/mcp", { method }),
      options,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.text()).toContain("Method not allowed");
  }
  expect(builds).toBe(0);
});

test("Bun rejects a body over 256 KiB before invoking the MCP handler", async () => {
  let handlerCalls = 0;
  const server = Bun.serve({
    port: 0,
    maxRequestBodySize: MCP_HTTP_MAX_REQUEST_BODY_BYTES,
    fetch: () => {
      handlerCalls++;
      return new Response("unexpected");
    },
  });

  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(MCP_HTTP_MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
    expect(handlerCalls).toBe(0);
  } finally {
    server.stop(true);
  }
});
