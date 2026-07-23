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

test("entries feed counts every non-empty line and rejects malformed or excessive input", async () => {
  await expect(readEntriesFeed(new Response("{not-json}\n"))).rejects.toThrow(/malformed JSON/);

  const overLimit = `${"{}\n".repeat(MAX_FEED_ITEMS_PER_JOURNAL + 1)}`;
  await expect(readEntriesFeed(new Response(overLimit))).rejects.toThrow(/item safety limit/);
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
