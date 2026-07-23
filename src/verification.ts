/**
 * Persisted verification generations. Increment a value whenever previously
 * accepted bytes must pass stronger checks before being treated as current.
 */

export const REST_CONTENT_VERIFICATION_VERSION = 1;
export const MEDIA_CACHE_VERIFICATION_VERSION = 1;

export type VerificationPolicy = "compatible" | "strict";

export function isVerificationPolicy(value: unknown): value is VerificationPolicy {
  return value === "compatible" || value === "strict";
}

/** A strict verification result may satisfy compatible readers, never vice versa. */
export function verificationPolicySatisfies(
  stored: VerificationPolicy | undefined,
  required: VerificationPolicy,
): boolean {
  return stored === "strict" || (stored === "compatible" && required === "compatible");
}
