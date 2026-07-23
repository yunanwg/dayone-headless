import { expect, test } from "bun:test";
import {
  checkHttpGate,
  httpGateConfigFromEnv,
  isLoopbackBindHost,
  MCP_TOKEN_MIN_BYTES,
  parseAllowedHosts,
  parseAllowedOrigins,
} from "../src/serve/http-auth.ts";

const host = "mcp.synthetic.test";
const request = (headers: Record<string, string> = {}) => new Request(`https://${host}/mcp`, { headers });
const base = {
  allowedOrigins: new Set<string>(),
  allowedHosts: new Set([host]),
};
const strongToken = "s".repeat(MCP_TOKEN_MIN_BYTES);

test("allowlists split, trim, and normalize hosts only", () => {
  expect([...parseAllowedOrigins(" https://A.example , https://b.example ,")]).toEqual([
    "https://A.example",
    "https://b.example",
  ]);
  expect([...parseAllowedHosts(" MCP.Example:443,localhost:8477")]).toEqual([
    "mcp.example:443",
    "localhost:8477",
  ]);
});

test("none mode permits IPv4 and IPv6 loopback binds but rejects wildcard or remote binds", () => {
  for (const bindHost of ["127.0.0.1", "127.42.0.9", "::1", "[::1]", "localhost"]) {
    expect(isLoopbackBindHost(bindHost)).toBe(true);
    expect(
      httpGateConfigFromEnv({
        DAYONE_MCP_HOST: bindHost,
        DAYONE_MCP_AUTH_MODE: "none",
        DAYONE_MCP_ALLOWED_HOSTS: host,
      }).authentication.mode,
    ).toBe("none");
  }

  for (const bindHost of ["0.0.0.0", "::", "[::]", "192.168.1.2", "mcp.internal"]) {
    expect(isLoopbackBindHost(bindHost)).toBe(false);
    expect(() =>
      httpGateConfigFromEnv({
        DAYONE_MCP_HOST: bindHost,
        DAYONE_MCP_AUTH_MODE: "none",
        DAYONE_MCP_ALLOWED_HOSTS: host,
      }),
    ).toThrow(/requires a loopback/);
  }

  expect(
    httpGateConfigFromEnv({
      DAYONE_MCP_HOST: "0.0.0.0",
      DAYONE_MCP_AUTH_MODE: "static",
      DAYONE_MCP_TOKEN: strongToken,
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }).authentication.mode,
  ).toBe("static");
});

test("Host is mandatory and exact before Origin or authentication", async () => {
  const config = { ...base, authentication: { mode: "none" as const } };
  expect(await checkHttpGate(request(), config)).toBeNull();
  expect(
    (
      await checkHttpGate(
        new Request("https://other.synthetic.test/mcp", { headers: { host: "other.synthetic.test" } }),
        config,
      )
    )?.status,
  ).toBe(421);
  expect((await checkHttpGate(request(), { ...config, allowedHosts: new Set<string>() }))?.status).toBe(421);
});

test("static mode accepts only a strong configured bearer and emits a challenge", async () => {
  const config = { ...base, authentication: { mode: "static" as const, token: strongToken } };
  expect(await checkHttpGate(request({ authorization: `Bearer ${strongToken}` }), config)).toBeNull();
  const rejected = await checkHttpGate(request({ authorization: "Bearer wrong" }), config);
  expect(rejected?.status).toBe(401);
  expect(rejected?.headers.get("www-authenticate")).toBe('Bearer realm="dayone-headless"');

  expect(() =>
    httpGateConfigFromEnv({
      DAYONE_MCP_AUTH_MODE: "static",
      DAYONE_MCP_TOKEN: "too-short",
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }),
  ).toThrow(/at least/);
});

test("Origin allowlist rejects unlisted browser origins before auth", async () => {
  const config = {
    ...base,
    authentication: { mode: "static" as const, token: strongToken },
    allowedOrigins: new Set(["https://ok.synthetic.test"]),
  };
  expect(
    (
      await checkHttpGate(
        request({
          origin: "https://bad.synthetic.test",
          authorization: `Bearer ${strongToken}`,
        }),
        config,
      )
    )?.status,
  ).toBe(403);
  expect(
    await checkHttpGate(
      request({
        origin: "https://ok.synthetic.test",
        authorization: `Bearer ${strongToken}`,
      }),
      config,
    ),
  ).toBeNull();
});

test("Cloudflare Access mode verifies the assertion and ignores the OAuth Authorization header", async () => {
  const seen: string[] = [];
  const config = httpGateConfigFromEnv(
    {
      DAYONE_MCP_AUTH_MODE: "cloudflare-access",
      DAYONE_CF_ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
      DAYONE_CF_ACCESS_AUD: "synthetic-audience",
      DAYONE_MCP_ALLOWED_HOSTS: host,
    },
    {
      accessVerifier: {
        verify: async (assertion) => {
          seen.push(assertion);
          if (assertion !== "valid-assertion") throw new Error("invalid");
        },
      },
    },
  );
  expect(
    await checkHttpGate(
      request({
        "cf-access-jwt-assertion": "valid-assertion",
        authorization: "Bearer client-oauth-token",
      }),
      config,
    ),
  ).toBeNull();
  expect(seen).toEqual(["valid-assertion"]);
  expect((await checkHttpGate(request({ "cf-access-jwt-assertion": "invalid" }), config))?.status).toBe(401);
  expect((await checkHttpGate(request(), config))?.status).toBe(401);
});

test("auth modes fail closed on missing, conflicting, and unknown configuration", () => {
  expect(() =>
    httpGateConfigFromEnv({
      DAYONE_MCP_AUTH_MODE: "static",
      DAYONE_MCP_TOKEN: strongToken,
      DAYONE_MCP_TOKEN_FILE: "/synthetic/token",
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }),
  ).toThrow(/either/);
  expect(() =>
    httpGateConfigFromEnv({
      DAYONE_MCP_AUTH_MODE: "cloudflare-access",
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }),
  ).toThrow(/requires/);
  expect(() =>
    httpGateConfigFromEnv({
      DAYONE_MCP_AUTH_MODE: "none",
      DAYONE_MCP_TOKEN: strongToken,
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }),
  ).toThrow(/conflict/);
  expect(() =>
    httpGateConfigFromEnv({
      DAYONE_MCP_AUTH_MODE: "static",
      DAYONE_MCP_TOKEN: strongToken,
      DAYONE_CF_ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }),
  ).toThrow(/conflict/);
  expect(() =>
    httpGateConfigFromEnv({
      DAYONE_MCP_AUTH_MODE: "cloudflare-access",
      DAYONE_CF_ACCESS_TEAM_DOMAIN: "not-cloudflare.synthetic.test",
      DAYONE_CF_ACCESS_AUD: "synthetic-audience",
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }),
  ).toThrow(/cloudflareaccess/);
  expect(() =>
    httpGateConfigFromEnv({
      DAYONE_MCP_AUTH_MODE: "unexpected",
      DAYONE_MCP_ALLOWED_HOSTS: host,
    }),
  ).toThrow(/must be/);
});
