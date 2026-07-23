import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import { assertSyncAttempt, recordSyncOutcome, recordSyncStart } from "../src/sync-status.ts";
import type { DayOneExport } from "../src/types.ts";

function textPayload(result: unknown): Record<string, unknown> {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content[0];
  if (content?.type !== "text") throw new Error("expected text tool result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

test("official stdio client follows sample_entries into guarded and ordinary get_entries reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dayone-mcp-evidence-"));
  const mirrorPath = join(dir, "mirror.db");
  const writer = openMirror(mirrorPath, { writable: true });
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const attempt = recordSyncStart(writer, attemptedAt, "synthetic");
  writer.transaction(() => {
    assertSyncAttempt(writer, attempt.sync_generation);
    importExport(
      writer,
      {
        metadata: { version: "synthetic" },
        entries: Array.from({ length: 8 }, (_, index) => ({
          uuid: `MCP-EVIDENCE-${index}`,
          creationDate: `202${index % 3}-0${(index % 8) + 1}-01T00:00:00Z`,
          timeZone: "UTC",
          text: `SYNTHETIC_MCP_BODY_${index}`,
        })),
      } as DayOneExport,
      "synthetic-mcp",
    );
  })();
  recordSyncOutcome(
    writer,
    { status: "complete", attemptedAt, failedEntries: 0, source: "synthetic" },
    attempt.sync_generation,
  );
  writer.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", fileURLToPath(new URL("../src/serve/mcp.ts", import.meta.url))],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...getDefaultEnvironment(),
      DAYONE_MIRROR: mirrorPath,
      DAYONE_MIRROR_WAIT: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "evidence-protocol-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("sample_entries");

    const sampleCall = await client.callTool({
      name: "sample_entries",
      arguments: { target: 8 },
    });
    const sample = textPayload(sampleCall);
    const snapshot = sample.snapshot as { token: string };
    const readPlan = sample.read_plan as {
      batches: Array<{ uuids: string[]; snapshot_token: string }>;
    };
    expect(sampleCall.isError).not.toBe(true);
    expect(readPlan.batches[0]!.snapshot_token).toBe(snapshot.token);

    const filteredCall = await client.callTool({
      name: "sample_entries",
      arguments: {
        target: 8,
        journal: "synthetic-mcp",
        from: "2021-01-01",
        to: "2021-12-31",
      },
    });
    const filtered = textPayload(filteredCall);
    expect(filtered.population).toMatchObject({ matched_entries: 3, eligible_text_entries: 3 });
    expect(
      (
        filtered.coverage as {
          journals: { buckets: Array<{ key: string }> };
        }
      ).journals.buckets.map((bucket) => bucket.key),
    ).toEqual(["synthetic-mcp"]);
    expect(JSON.stringify(filtered)).not.toContain("SYNTHETIC_MCP_BODY");

    const guardedCall = await client.callTool({
      name: "get_entries",
      arguments: {
        uuids: readPlan.batches[0]!.uuids,
        snapshot_token: snapshot.token,
        max_chars: 8,
        max_total_chars: 24,
      },
    });
    const guarded = textPayload(guardedCall);
    expect(guardedCall.isError).not.toBe(true);
    expect((guarded.snapshot as { token: string }).token).toBe(snapshot.token);

    const ordinaryCall = await client.callTool({
      name: "get_entries",
      arguments: { uuids: [readPlan.batches[0]!.uuids[0]] },
    });
    const ordinary = textPayload(ordinaryCall);
    expect(ordinaryCall.isError).not.toBe(true);
    expect(ordinary.snapshot).toBeNull();
    expect(ordinary.snapshot_guarantee).toBe("none");

    const nextWriter = openMirror(mirrorPath, { writable: true });
    recordSyncStart(nextWriter, "2026-01-02T00:00:00.000Z", "synthetic");
    nextWriter.close();
    const staleCall = await client.callTool({
      name: "get_entries",
      arguments: {
        uuids: readPlan.batches[0]!.uuids,
        snapshot_token: snapshot.token,
      },
    });
    expect(staleCall.isError).toBe(true);
    expect(textPayload(staleCall)).toMatchObject({ error: "snapshot_stale" });
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
