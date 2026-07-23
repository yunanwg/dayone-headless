import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMirror } from "../src/serve/db/open.ts";
import { assessSyncReadiness, mcpHttpReadiness } from "../src/serve/health.ts";
import type { SyncStatus } from "../src/sync-status.ts";

const complete: SyncStatus = {
  status: "complete",
  last_attempt_at: "2026-01-01T00:00:00.000Z",
  last_complete_at: "2026-01-01T00:00:00.000Z",
  failed_entries: 0,
  sync_generation: 1,
};

test("sync readiness separates latest outcome from last-complete freshness", () => {
  const now = Date.parse("2026-01-01T01:00:00.000Z");
  expect(assessSyncReadiness(complete, now, 7200).ready).toBe(true);
  expect(assessSyncReadiness({ ...complete, status: "running" }, now, 7200)).toEqual({
    ready: true,
    detail: "sync in progress; prior complete mirror is fresh",
  });
  expect(assessSyncReadiness({ ...complete, status: "degraded" }, now, 7200).ready).toBe(false);
  expect(assessSyncReadiness({ ...complete, status: "failed" }, now, 7200).ready).toBe(false);
  expect(assessSyncReadiness(complete, now, 1800).detail).toBe("last complete sync is stale");
});

test("MCP readiness exercises canonical path, Host, and static authentication", async () => {
  let seen: Request | undefined;
  const token = "synthetic-token-".repeat(3);
  const result = await mcpHttpReadiness(
    {
      DAYONE_MCP_PORT: "8477",
      DAYONE_MCP_AUTH_MODE: "static",
      DAYONE_MCP_TOKEN: token,
      DAYONE_MCP_ALLOWED_HOSTS: "mcp.synthetic.test",
    },
    async (input, init) => {
      seen = new Request(input, init);
      return new Response("ok", { status: 200 });
    },
  );

  expect(result.ready).toBe(true);
  expect(new URL(seen!.url).pathname).toBe("/mcp");
  expect(seen!.method).toBe("POST");
  expect(seen!.headers.get("host")).toBe("mcp.synthetic.test");
  expect(seen!.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(await seen!.json()).toMatchObject({ method: "tools/list" });
});

test("Cloudflare readiness proves the unsigned origin boundary without claiming JWKS validation", async () => {
  const result = await mcpHttpReadiness(
    {
      DAYONE_MCP_PORT: "8477",
      DAYONE_MCP_AUTH_MODE: "cloudflare-access",
      DAYONE_CF_ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
      DAYONE_CF_ACCESS_AUD: "synthetic-audience",
      DAYONE_MCP_ALLOWED_HOSTS: "mcp.synthetic.test",
    },
    async () =>
      new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="cloudflare-access"' },
      }),
  );

  expect(result).toEqual({
    ready: true,
    detail: "canonical HTTP and Cloudflare Access boundary reachable",
  });
});

test("MCP readiness succeeds against the real Bun listener with an exact Host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dayone-health-"));
  const mirrorPath = join(dir, "mirror.db");
  openMirror(mirrorPath, { writable: true }).close();
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  reservation.stop(true);

  const token = "synthetic-health-token-".repeat(2);
  const env = {
    ...process.env,
    DAYONE_MIRROR: mirrorPath,
    DAYONE_MIRROR_WAIT: "1",
    DAYONE_MCP_PORT: String(port),
    DAYONE_MCP_HOST: "127.0.0.1",
    DAYONE_MCP_AUTH_MODE: "static",
    DAYONE_MCP_TOKEN: token,
    DAYONE_MCP_ALLOWED_HOSTS: `health.synthetic.test:${port}`,
  };
  const child = Bun.spawn(
    [process.execPath, "run", fileURLToPath(new URL("../src/serve/cli.ts", import.meta.url)), "mcp"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  try {
    let result = { ready: false, detail: "not attempted" };
    for (let attempt = 0; attempt < 50 && !result.ready; attempt++) {
      await Bun.sleep(20);
      result = await mcpHttpReadiness(env);
    }
    expect(result).toEqual({
      ready: true,
      detail: "canonical authenticated MCP request succeeded",
    });
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
