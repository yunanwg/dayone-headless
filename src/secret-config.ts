/**
 * Read sensitive configuration from either an environment variable or its
 * Docker-style `*_FILE` companion. Values are never included in errors.
 */

import { readFileSync } from "node:fs";

export const SECRET_NAMES = [
  "DAYONE_ENCRYPTION_KEY",
  "DAYONE_API_TOKEN",
  "DAYONE_EMAIL",
  "DAYONE_PASSWORD",
  "DAYONE_MCP_TOKEN",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];
type SecretEnvironment = Record<string, string | undefined>;
type SecretFileReader = (path: string) => string;

export class SecretConfigError extends Error {
  constructor(
    public readonly secretName: SecretName,
    reason: "conflict" | "empty" | "unreadable",
  ) {
    const detail = {
      conflict: "set either the environment variable or its _FILE companion, not both",
      empty: "configured secret is empty",
      unreadable: "configured secret file could not be read",
    }[reason];
    super(`${secretName}: ${detail}`);
    this.name = "SecretConfigError";
  }
}

const defaultReadFile: SecretFileReader = (path) => readFileSync(path, "utf8");

/** Remove the one line ending normally added to a mounted secret file. */
function stripFinalLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

export function readSecret(
  name: SecretName,
  env: SecretEnvironment = process.env,
  readFile: SecretFileReader = defaultReadFile,
): string | undefined {
  const direct = env[name];
  const fileVariable = `${name}_FILE`;
  const filePath = env[fileVariable];

  if (direct !== undefined && filePath !== undefined) {
    throw new SecretConfigError(name, "conflict");
  }
  if (direct !== undefined) {
    if (direct.length === 0) throw new SecretConfigError(name, "empty");
    return direct;
  }
  if (filePath !== undefined) {
    if (filePath.length === 0) throw new SecretConfigError(name, "empty");
    let value: string;
    try {
      value = stripFinalLineEnding(readFile(filePath));
    } catch {
      throw new SecretConfigError(name, "unreadable");
    }
    if (value.length === 0) throw new SecretConfigError(name, "empty");
    return value;
  }
  return undefined;
}

export function requireSecret(
  name: SecretName,
  env: SecretEnvironment = process.env,
  readFile: SecretFileReader = defaultReadFile,
): string {
  const value = readSecret(name, env, readFile);
  if (value === undefined) {
    throw new SecretConfigError(name, "empty");
  }
  return value;
}
