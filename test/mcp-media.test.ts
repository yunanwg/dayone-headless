import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_INLINE_MEDIA_BYTES,
  MEDIA_IDENTIFIER_MAX_CHARS,
  type MediaFileAccess,
  mediaNotFoundResult,
  presentCachedMedia,
  publicMediaMetadata,
} from "../src/serve/mcp-media.ts";
import type { MediaFile } from "../src/serve/queries.ts";

const dir = mkdtempSync(join(tmpdir(), "mcp-media-"));
const md5 = "0123456789abcdef0123456789abcdef";

function cachedMedia(path: string, kind = "photo", type = "jpeg"): MediaFile {
  return {
    identifier: "SYNTHETIC-MEDIA",
    md5,
    kind,
    type,
    cached: true,
    path,
  };
}

function spyingAccess() {
  let reads = 0;
  const access: MediaFileAccess = {
    size: (path) => Bun.file(path).size,
    read: async (path, maxBytes) => {
      reads++;
      return new Uint8Array(await Bun.file(path).slice(0, maxBytes).arrayBuffer());
    },
  };
  return { access, reads: () => reads };
}

function textPayload(result: Awaited<ReturnType<typeof presentCachedMedia>>) {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("expected text media result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

test("small photos remain inline and are read once", async () => {
  const path = join(dir, "small-photo");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await Bun.write(path, bytes);
  const spy = spyingAccess();

  const result = await presentCachedMedia(cachedMedia(path), spy.access);

  expect(spy.reads()).toBe(1);
  expect(result).toEqual({
    content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" }],
  });
});

test("oversized photos return metadata without reading bytes or exposing path", async () => {
  const path = join(dir, "large-photo");
  await Bun.write(path, new Uint8Array(MAX_INLINE_MEDIA_BYTES + 1));
  const spy = spyingAccess();

  const result = await presentCachedMedia(cachedMedia(path), spy.access);
  const payload = textPayload(result);

  expect(spy.reads()).toBe(0);
  expect(payload).toMatchObject({
    identifier: "SYNTHETIC-MEDIA",
    cached: true,
    inline: false,
    size: MAX_INLINE_MEDIA_BYTES + 1,
    mimeType: "image/jpeg",
    reason: "inline_size_limit_exceeded",
  });
  expect(payload).not.toHaveProperty("path");
});

test("non-photo media returns metadata without reading bytes or exposing path", async () => {
  const path = join(dir, "synthetic-video");
  await Bun.write(path, new Uint8Array([5, 6, 7]));
  const spy = spyingAccess();

  const result = await presentCachedMedia(cachedMedia(path, "video", "mp4"), spy.access);
  const payload = textPayload(result);

  expect(spy.reads()).toBe(0);
  expect(payload).toMatchObject({
    identifier: "SYNTHETIC-MEDIA",
    cached: true,
    inline: false,
    size: 3,
    mimeType: "video/mp4",
    reason: "unsupported_media_kind",
  });
  expect(payload).not.toHaveProperty("path");
});

test("public MCP metadata strips cached and uncached local paths", () => {
  expect(publicMediaMetadata(cachedMedia("/private/cache/media"))).not.toHaveProperty("path");
  expect(
    publicMediaMetadata({ ...cachedMedia("/private/cache/media"), cached: false, path: null }),
  ).not.toHaveProperty("path");
});

test("a stale small stat cannot make a larger photo read more than the bounded probe", async () => {
  const path = join(dir, "photo-that-grew");
  await Bun.write(path, new Uint8Array(MAX_INLINE_MEDIA_BYTES + 2));
  let requestedBytes = 0;
  let returnedBytes = 0;
  const access: MediaFileAccess = {
    size: () => 1,
    read: async (filePath, maxBytes) => {
      requestedBytes = maxBytes;
      const bytes = new Uint8Array(await Bun.file(filePath).slice(0, maxBytes).arrayBuffer());
      returnedBytes = bytes.length;
      return bytes;
    },
  };

  const payload = textPayload(await presentCachedMedia(cachedMedia(path), access));

  expect(requestedBytes).toBe(MAX_INLINE_MEDIA_BYTES + 1);
  expect(returnedBytes).toBe(MAX_INLINE_MEDIA_BYTES + 1);
  expect(payload).toMatchObject({
    inline: false,
    size: MAX_INLINE_MEDIA_BYTES + 1,
    reason: "inline_size_limit_exceeded",
  });
  expect(payload).not.toHaveProperty("path");
});

test("stat and read failures become generic path-stripped MCP errors", async () => {
  const path = join(dir, "private-cache-name");
  await Bun.write(path, new Uint8Array([1]));
  const failures: MediaFileAccess[] = [
    {
      size: () => {
        throw new Error(`stat failed for ${path}`);
      },
      read: () => {
        throw new Error("unreachable");
      },
    },
    {
      size: () => 1,
      read: () => {
        throw new Error(`read failed for ${path}`);
      },
    },
  ];

  for (const access of failures) {
    const result = await presentCachedMedia(cachedMedia(path), access);
    const payload = textPayload(result);
    expect(result.isError).toBe(true);
    expect(payload.reason).toBe("cache_read_error");
    expect(payload).not.toHaveProperty("path");
    expect(JSON.stringify(result)).not.toContain(path);
    expect(JSON.stringify(result)).not.toContain("failed for");
  }
});

test("unknown-media errors do not echo identifiers and the input limit is finite", () => {
  const identifier = "x".repeat(MEDIA_IDENTIFIER_MAX_CHARS);
  const result = mediaNotFoundResult();

  expect(MEDIA_IDENTIFIER_MAX_CHARS).toBe(128);
  expect(JSON.stringify(result)).not.toContain(identifier);
  expect(result).toEqual({
    content: [{ type: "text", text: "no media for that identifier" }],
    isError: true,
  });
});
