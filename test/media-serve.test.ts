/**
 * Serving-side media resolution: identifier → cached bytes path. Pure (no crypto,
 * no fetch); the cache dir is a temp dir so no real data is needed.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importExport } from "../src/ingest/json-export/import.ts";
import { prepareMediaPath } from "../src/media-cache.ts";
import { openMirror } from "../src/serve/db/open.ts";
import { resolveMedia } from "../src/serve/queries.ts";
import type { DayOneExport } from "../src/types.ts";

// One entry with one photo (identifier PHOTO-1, md5 "cafebabecafebabecafebabecafebabe").
const fixture = {
  metadata: { version: "1.0" },
  entries: [
    {
      uuid: "M1",
      creationDate: "2024-01-01T00:00:00Z",
      text: "has a photo",
      photos: [
        { identifier: "PHOTO-1", md5: "cafebabecafebabecafebabecafebabe", type: "jpeg", orderInEntry: 0 },
      ],
    },
  ],
} as DayOneExport;

let db: Database;
const cacheDir = mkdtempSync(join(tmpdir(), "mediacache-"));

beforeAll(() => {
  db = openMirror(":memory:", { writable: true });
  importExport(db, fixture, "j");
});

test("resolveMedia returns null for an unknown identifier", () => {
  expect(resolveMedia(db, "nope", cacheDir)).toBeNull();
});

test("resolveMedia reports not-cached when bytes are absent", () => {
  const m = resolveMedia(db, "PHOTO-1", cacheDir);
  expect(m).not.toBeNull();
  expect(m).toMatchObject({
    identifier: "PHOTO-1",
    md5: "cafebabecafebabecafebabecafebabe",
    kind: "photo",
    type: "jpeg",
  });
  expect(m!.cached).toBe(false);
  expect(m!.path).toBeNull();
});

test("resolveMedia reports cached + path once bytes exist", async () => {
  await Bun.write(prepareMediaPath("cafebabecafebabecafebabecafebabe", cacheDir), new Uint8Array([1, 2, 3]));
  const m = resolveMedia(db, "PHOTO-1", cacheDir);
  expect(m!.cached).toBe(true);
  expect(m!.path).toBe(join(cacheDir, "cafebabecafebabecafebabecafebabe"));
});
