/**
 * Filesystem protections for decrypted local state.
 *
 * Linux and macOS both create files subject to the process umask. We install a
 * private umask before opening SQLite or writing media, then explicitly remove
 * group/other permission bits from existing paths. Existing owner bits are
 * preserved so a read-only bind mount stays read-only.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, type Stats, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

const GROUP_OTHER_MASK = 0o077;
const PERMISSION_MASK = 0o777;

export interface PermissionIssue {
  kind: "file" | "directory";
  path: string;
  actualMode?: number;
  error?: string;
}

export interface PermissionReport {
  checked: number;
  fixed: number;
  issues: PermissionIssue[];
}

/** Keep every subsequently-created local-state path private by default. */
export function installPrivateUmask(): void {
  const current = process.umask();
  process.umask(current | GROUP_OTHER_MASK);
}

function privateMode(mode: number): number {
  return mode & PERMISSION_MASK & ~GROUP_OTHER_MASK;
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) return String(err.code);
  return "unknown error";
}

function inspect(
  path: string,
  kind: PermissionIssue["kind"],
  fix: boolean,
): { checked: boolean; fixed: boolean; issue?: PermissionIssue } {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (err) {
    return {
      checked: true,
      fixed: false,
      issue: { kind, path, error: errorCode(err) },
    };
  }

  const actualKind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
  if (actualKind !== kind) {
    return {
      checked: true,
      fixed: false,
      issue: { kind, path, actualMode: stat.mode & PERMISSION_MASK, error: `not a ${kind}` },
    };
  }

  const actualMode = stat.mode & PERMISSION_MASK;
  if ((actualMode & GROUP_OTHER_MASK) === 0) return { checked: true, fixed: false };
  if (!fix) {
    return { checked: true, fixed: false, issue: { kind, path, actualMode } };
  }

  try {
    chmodSync(path, privateMode(actualMode));
    const after = statSync(path).mode & PERMISSION_MASK;
    if ((after & GROUP_OTHER_MASK) === 0) return { checked: true, fixed: true };
    return { checked: true, fixed: false, issue: { kind, path, actualMode: after } };
  } catch (err) {
    return {
      checked: true,
      fixed: false,
      issue: { kind, path, actualMode, error: errorCode(err) },
    };
  }
}

function addResult(report: PermissionReport, result: ReturnType<typeof inspect>): void {
  if (result.checked) report.checked++;
  if (result.fixed) report.fixed++;
  if (result.issue) report.issues.push(result.issue);
}

function blankReport(): PermissionReport {
  return { checked: 0, fixed: 0, issues: [] };
}

function mergeReports(...reports: PermissionReport[]): PermissionReport {
  return reports.reduce(
    (all, report) => ({
      checked: all.checked + report.checked,
      fixed: all.fixed + report.fixed,
      issues: [...all.issues, ...report.issues],
    }),
    blankReport(),
  );
}

/**
 * A configured storage directory is safe to chmod unless it resolves to the
 * process working directory or filesystem root. That guard prevents
 * `DAYONE_MIRROR=mirror.db` from unexpectedly changing the whole checkout.
 */
function mayHardenDirectory(path: string): boolean {
  const absolute = resolve(path);
  return absolute !== resolve(".") && absolute !== parse(absolute).root;
}

/** Create a sensitive directory privately and tighten it when it already exists. */
export function preparePrivateDirectory(path: string): PermissionReport {
  installPrivateUmask();
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });

  const report = blankReport();
  if (!existed || mayHardenDirectory(path)) {
    addResult(report, inspect(path, "directory", true));
  } else {
    report.issues.push({
      kind: "directory",
      path,
      error: "refusing to chmod the working directory or filesystem root",
    });
  }
  return report;
}

/** Tighten one existing plaintext file without changing its owner permissions. */
export function hardenPrivateFile(path: string): PermissionReport {
  const report = blankReport();
  if (existsSync(path)) addResult(report, inspect(path, "file", true));
  return report;
}

/** Prepare the mirror directory and tighten the database plus live sidecars. */
export function prepareMirrorStorage(path: string, opts: { createParent?: boolean } = {}): PermissionReport {
  installPrivateUmask();
  const parent = blankReport();
  const parentPath = dirname(path);
  if (opts.createParent) {
    const prepared = preparePrivateDirectory(parentPath);
    parent.checked += prepared.checked;
    parent.fixed += prepared.fixed;
    parent.issues.push(...prepared.issues);
  } else if (existsSync(parentPath) && mayHardenDirectory(parentPath)) {
    addResult(parent, inspect(parentPath, "directory", true));
  }
  return mergeReports(
    parent,
    hardenPrivateFile(path),
    hardenPrivateFile(`${path}-wal`),
    hardenPrivateFile(`${path}-shm`),
  );
}

/**
 * Inspect or repair all known decrypted local-state paths. Missing mirror
 * sidecars/cache paths are normal and omitted. Media identifiers are deliberately
 * not returned: doctor only needs aggregate issue counts.
 */
export function checkLocalPermissions(
  mirrorPath: string,
  mediaDir: string,
  opts: { fix?: boolean; envFilePath?: string } = {},
): PermissionReport {
  const report = blankReport();
  const fix = opts.fix === true;

  if (opts.envFilePath && existsSync(opts.envFilePath)) {
    addResult(report, inspect(opts.envFilePath, "file", fix));
  }

  const mirrorParent = dirname(mirrorPath);
  if (existsSync(mirrorParent) && mayHardenDirectory(mirrorParent)) {
    addResult(report, inspect(mirrorParent, "directory", fix));
  }
  for (const path of [mirrorPath, `${mirrorPath}-wal`, `${mirrorPath}-shm`]) {
    if (existsSync(path)) addResult(report, inspect(path, "file", fix));
  }

  if (existsSync(mediaDir) && !mayHardenDirectory(mediaDir)) {
    report.issues.push({
      kind: "directory",
      path: mediaDir,
      error: "cache directory is the working directory or filesystem root",
    });
  } else if (existsSync(mediaDir)) {
    addResult(report, inspect(mediaDir, "directory", fix));
    try {
      for (const entry of readdirSync(mediaDir, { withFileTypes: true })) {
        if (entry.isFile()) addResult(report, inspect(resolve(mediaDir, entry.name), "file", fix));
      }
    } catch (err) {
      report.issues.push({ kind: "directory", path: mediaDir, error: errorCode(err) });
    }
  }

  return report;
}

export function formatMode(mode: number | undefined): string {
  return mode === undefined ? "unknown" : mode.toString(8).padStart(3, "0");
}
