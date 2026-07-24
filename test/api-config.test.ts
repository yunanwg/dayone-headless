import { expect, test } from "bun:test";
import {
  apiConfigFromEnv,
  DayOneApi,
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_FEED_ITEMS_PER_JOURNAL,
  readEntriesFeed,
  readUpstreamBytes,
  UPSTREAM_RESPONSE_LIMITS,
  UpstreamResponseLimitError,
} from "../src/ingest/rest/api.ts";

const baseEnvironment = {
  DAYONE_API_TOKEN: "synthetic-api-token",
  DAYONE_DEVICE_ID: "00112233445566778899aabbccddeeff",
};

test("REST API config applies a finite default request timeout", () => {
  expect(apiConfigFromEnv(baseEnvironment).requestTimeoutMs).toBe(DEFAULT_HTTP_TIMEOUT_MS);
});

test("REST API config accepts a bounded request timeout", () => {
  expect(
    apiConfigFromEnv({
      ...baseEnvironment,
      DAYONE_HTTP_TIMEOUT_MS: "15000",
    }).requestTimeoutMs,
  ).toBe(15_000);
});

test("REST API config rejects invalid request timeouts", () => {
  for (const value of ["0", "999", "300001", "1.5", "invalid"]) {
    expect(() =>
      apiConfigFromEnv({
        ...baseEnvironment,
        DAYONE_HTTP_TIMEOUT_MS: value,
      }),
    ).toThrow("DAYONE_HTTP_TIMEOUT_MS");
  }
});

test("upstream response reader accepts an exact cap and rejects a declared overflow", async () => {
  const exact = new Uint8Array(UPSTREAM_RESPONSE_LIMITS.login);
  const accepted = await readUpstreamBytes(new Response(exact), "login");
  expect(accepted.byteLength).toBe(UPSTREAM_RESPONSE_LIMITS.login);

  const rejected = readUpstreamBytes(
    new Response("synthetic", {
      headers: { "content-length": String(UPSTREAM_RESPONSE_LIMITS.login + 1) },
    }),
    "login",
  );
  await expect(rejected).rejects.toBeInstanceOf(UpstreamResponseLimitError);
});

test("upstream response reader counts streamed bytes when Content-Length is absent or false", async () => {
  const half = Math.floor(UPSTREAM_RESPONSE_LIMITS.login / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(half));
      controller.enqueue(new Uint8Array(UPSTREAM_RESPONSE_LIMITS.login - half + 1));
      controller.close();
    },
  });
  await expect(readUpstreamBytes(new Response(body), "login")).rejects.toBeInstanceOf(
    UpstreamResponseLimitError,
  );
});

test("entries feed parses across chunks without split/filter/map amplification", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"framing":true}\n{"revision":{"entry'));
      controller.enqueue(new TextEncoder().encode('Id":"synthetic-entry"}}\n'));
      controller.close();
    },
  });
  const items = await readEntriesFeed(new Response(body));
  expect(items).toHaveLength(1);
  expect(items[0]?.revision.entryId).toBe("synthetic-entry");
});

test("entries feed skips non-JSON lines and counts only real feed items", async () => {
  // The feed is length-delimited: JSON header lines are interleaved with inline
  // binary entry content that carries embedded 0x0a. Non-JSON fragments and JSON
  // lines without a feed item are tolerated (skipped), never fatal.
  const skipped = await readEntriesFeed(new Response('{not-json}\n{"framing":true}\n'));
  expect(skipped).toHaveLength(0);

  // Only lines that parse into a real feed item (revision.entryId) count toward
  // the safety limit, so JSON noise cannot exhaust it by itself.
  const noise = `${"{}\n".repeat(MAX_FEED_ITEMS_PER_JOURNAL + 1)}`;
  expect(await readEntriesFeed(new Response(noise))).toHaveLength(0);

  const feedItem = '{"revision":{"entryId":"synthetic"}}\n';
  const overLimit = feedItem.repeat(MAX_FEED_ITEMS_PER_JOURNAL + 1);
  await expect(readEntriesFeed(new Response(overLimit))).rejects.toThrow(/item safety limit/);
});

test("entries feed tolerates inline binary D1 content with embedded newlines", async () => {
  // Reproduce the real length-delimited framing: each record is a JSON header
  // line, then `\n`, then contentLength bytes of BINARY D1 content that itself
  // contains 0x0a bytes. A naive 0x0a splitter shreds that binary into non-JSON
  // fragments; the parser must skip them and still recover the two real items.
  const enc = new TextEncoder();
  // A synthetic D1-shaped blob: "D1" magic, a version/type byte, and payload
  // bytes deliberately including 0x0a so the splitter cuts through it.
  const binaryBody = new Uint8Array([
    0x44, 0x31, 0x01, 0x02, 0xef, 0xbf, 0xbd, 0x0a, 0x7b, 0x0a, 0xde, 0xad, 0x0a, 0xbe, 0xef,
  ]);
  const record = (entryId: string): Uint8Array => {
    const header = enc.encode(`{"revision":{"entryId":"${entryId}"},"contentLength":${binaryBody.length}}\n`);
    const trailer = enc.encode("\n");
    const out = new Uint8Array(header.length + binaryBody.length + trailer.length);
    out.set(header, 0);
    out.set(binaryBody, header.length);
    out.set(trailer, header.length + binaryBody.length);
    return out;
  };
  const first = record("synthetic-1");
  const second = record("synthetic-2");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split a chunk boundary mid-binary to exercise cross-chunk assembly too.
      const midpoint = first.length + 5;
      const all = new Uint8Array(first.length + second.length);
      all.set(first, 0);
      all.set(second, first.length);
      controller.enqueue(all.subarray(0, midpoint));
      controller.enqueue(all.subarray(midpoint));
      controller.close();
    },
  });
  const items = await readEntriesFeed(new Response(body));
  expect(items.map((i) => i.revision.entryId)).toEqual(["synthetic-1", "synthetic-2"]);
});

test("entries feed status and transport errors never echo a journal identifier", async () => {
  const journalId = "private-journal-identifier";
  const api = new DayOneApi({
    token: "synthetic-api-token",
    xUserAgent: "synthetic-agent",
    deviceInfo: "synthetic-device",
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    try {
      await api.getEntriesFeed(journalId);
      throw new Error("expected status failure");
    } catch (error) {
      expect(String(error)).not.toContain(journalId);
      expect(String(error)).toContain("GET entries feed");
    }

    globalThis.fetch = (async () => {
      throw new Error(`transport failed for ${journalId}`);
    }) as unknown as typeof fetch;
    try {
      await api.getEntriesFeed(journalId);
      throw new Error("expected transport failure");
    } catch (error) {
      expect(String(error)).toBe("ApiError: upstream request failed");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
