/**
 * MCP-specific media presentation.
 *
 * The CLI may resolve cached media to a local path, but an MCP client must never
 * receive that server-local filesystem detail. This helper also checks file size
 * before reading bytes so unsupported or oversized media cannot force a
 * whole-file allocation.
 */

import { stat } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MediaFile } from "./queries.ts";

/** Keep inline MCP images bounded before base64 adds roughly 33% overhead. */
export const MAX_INLINE_MEDIA_BYTES = 4 * 1024 * 1024;
/** Media identifiers are opaque but never need to be unbounded request input. */
export const MEDIA_IDENTIFIER_MAX_CHARS = 128;

export interface MediaFileAccess {
  size(path: string): number | Promise<number>;
  /** Read at most maxBytes, even if the file changes after size() returns. */
  read(path: string, maxBytes: number): Uint8Array | Promise<Uint8Array>;
}

const defaultFileAccess: MediaFileAccess = {
  size: async (path) => (await stat(path)).size,
  read: async (path, maxBytes) => new Uint8Array(await Bun.file(path).slice(0, maxBytes).arrayBuffer()),
};

export function mediaMimeType(media: MediaFile): string {
  if (media.kind === "pdf") return "application/pdf";
  return `${media.kind === "photo" ? "image" : media.kind}/${media.type ?? "octet-stream"}`;
}

/** Strip the path that is useful to the local CLI but private to the MCP host. */
export function publicMediaMetadata(media: MediaFile): Omit<MediaFile, "path"> {
  const { path: _path, ...metadata } = media;
  return metadata;
}

function metadataResult(
  media: MediaFile,
  size: number | null,
  mimeType: string,
  reason: "unsupported_media_kind" | "inline_size_limit_exceeded" | "cache_read_error",
  note: string,
  isError = false,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ...publicMediaMetadata(media),
            inline: false,
            size,
            mimeType,
            reason,
            note,
          },
          null,
          2,
        ),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

/** Do not reflect an attacker-controlled identifier in an MCP error response. */
export function mediaNotFoundResult(): CallToolResult {
  return {
    content: [{ type: "text", text: "no media for that identifier" }],
    isError: true,
  };
}

/**
 * Return a small cached photo inline. Other media and oversized photos return
 * metadata only, without reading any file bytes or exposing the cache path.
 */
export async function presentCachedMedia(
  media: MediaFile,
  access: MediaFileAccess = defaultFileAccess,
): Promise<CallToolResult> {
  if (!media.cached || !media.path) {
    throw new Error("presentCachedMedia requires a cached media path");
  }

  const mimeType = mediaMimeType(media);
  let size: number;
  try {
    size = await access.size(media.path);
  } catch {
    return metadataResult(
      media,
      null,
      mimeType,
      "cache_read_error",
      "cached media metadata could not be read on the MCP host",
      true,
    );
  }

  if (media.kind !== "photo") {
    return metadataResult(
      media,
      size,
      mimeType,
      "unsupported_media_kind",
      "MCP only returns photo bytes inline; use `daytwo media-file` locally for this attachment",
    );
  }

  if (size > MAX_INLINE_MEDIA_BYTES) {
    return metadataResult(
      media,
      size,
      mimeType,
      "inline_size_limit_exceeded",
      `photo exceeds the ${MAX_INLINE_MEDIA_BYTES}-byte inline limit; use \`daytwo media-file\` locally`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await access.read(media.path, MAX_INLINE_MEDIA_BYTES + 1);
  } catch {
    return metadataResult(
      media,
      size,
      mimeType,
      "cache_read_error",
      "cached media bytes could not be read on the MCP host",
      true,
    );
  }
  if (bytes.length > MAX_INLINE_MEDIA_BYTES) {
    return metadataResult(
      media,
      bytes.length,
      mimeType,
      "inline_size_limit_exceeded",
      `photo exceeds the ${MAX_INLINE_MEDIA_BYTES}-byte inline limit; use \`daytwo media-file\` locally`,
    );
  }

  return {
    content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }],
  };
}
