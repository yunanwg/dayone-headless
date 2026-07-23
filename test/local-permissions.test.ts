import { afterAll, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLocalPermissions,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  prepareMirrorStorage,
} from "../src/local-permissions.ts";

const originalUmask = process.umask();
afterAll(() => process.umask(originalUmask));

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function touch(path: string, requestedMode: number): void {
  closeSync(openSync(path, "w", requestedMode));
  // Test the hardener independently of the runner's ambient umask.
  chmodSync(path, requestedMode);
}

test("prepareMirrorStorage tightens an existing directory, database, WAL, and SHM", () => {
  const root = mkdtempSync(join(tmpdir(), "permissions-mirror-"));
  const dir = join(root, "data");
  const mirror = join(dir, "mirror.db");
  try {
    prepareMirrorStorage(mirror, { createParent: true });
    chmodSync(dir, 0o755);
    for (const path of [mirror, `${mirror}-wal`, `${mirror}-shm`]) touch(path, 0o644);

    const report = prepareMirrorStorage(mirror, { createParent: true });
    expect(report.issues).toEqual([]);
    expect(report.fixed).toBe(4);
    expect(mode(dir)).toBe(PRIVATE_DIR_MODE);
    expect(mode(mirror)).toBe(PRIVATE_FILE_MODE);
    expect(mode(`${mirror}-wal`)).toBe(PRIVATE_FILE_MODE);
    expect(mode(`${mirror}-shm`)).toBe(PRIVATE_FILE_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission diagnosis is non-mutating until repair is explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "permissions-check-"));
  const mirrorDir = join(root, "mirror");
  const mediaDir = join(root, "media");
  const mirror = join(mirrorDir, "mirror.db");
  const media = join(mediaDir, "0123456789abcdef0123456789abcdef");
  const envFile = join(root, ".env");
  const adjacentEnvFile = join(root, ".env.local");
  try {
    prepareMirrorStorage(mirror, { createParent: true });
    prepareMirrorStorage(join(mediaDir, "placeholder"), { createParent: true });
    touch(mirror, 0o644);
    touch(media, 0o664);
    touch(envFile, 0o644);
    touch(adjacentEnvFile, 0o644);
    chmodSync(mirrorDir, 0o755);
    chmodSync(mediaDir, 0o775);

    const diagnosed = checkLocalPermissions(mirror, mediaDir, { envFilePath: envFile });
    expect(diagnosed.fixed).toBe(0);
    expect(diagnosed.issues).toHaveLength(5);
    expect(diagnosed.issues.some((issue) => issue.path === adjacentEnvFile)).toBe(false);
    expect(mode(mirror)).toBe(0o644);
    expect(mode(media)).toBe(0o664);
    expect(mode(envFile)).toBe(0o644);

    const repaired = checkLocalPermissions(mirror, mediaDir, { fix: true, envFilePath: envFile });
    expect(repaired.issues).toEqual([]);
    expect(repaired.fixed).toBe(5);
    expect(mode(mirrorDir)).toBe(PRIVATE_DIR_MODE);
    expect(mode(mediaDir)).toBe(PRIVATE_DIR_MODE);
    expect(mode(mirror)).toBe(PRIVATE_FILE_MODE);
    expect(mode(media)).toBe(PRIVATE_FILE_MODE);
    expect(mode(envFile)).toBe(PRIVATE_FILE_MODE);
    expect(mode(adjacentEnvFile)).toBe(0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission diagnosis treats absent WAL, SHM, and media cache as normal", () => {
  const root = mkdtempSync(join(tmpdir(), "permissions-absent-"));
  const mirror = join(root, "mirror.db");
  try {
    touch(mirror, PRIVATE_FILE_MODE);
    const report = checkLocalPermissions(mirror, join(root, "missing-media"));
    expect(report.issues).toEqual([]);
    expect(report.checked).toBe(2);
    expect(existsSync(`${mirror}-wal`)).toBe(false);
    expect(existsSync(`${mirror}-shm`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
