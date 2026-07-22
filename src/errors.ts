/**
 * Typed error taxonomy — so callers (and agents) can distinguish *why* something
 * failed and react, rather than string-matching messages. Messages are actionable
 * and never contain secret values.
 */

/** Missing or malformed configuration (env vars, master key format). */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Login / token minting failed (bad credentials, device gating, etc.). */
export class AuthError extends Error {
  override name = "AuthError";
}

/** A Day One API request failed. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Decryption failed (wrong key, unexpected envelope, corrupt blob). */
export class DecryptError extends Error {
  override name = "DecryptError";
}
