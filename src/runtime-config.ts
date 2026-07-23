/**
 * Shared fail-closed parsing for positive integer runtime controls. Empty
 * values use the documented default; malformed or out-of-range values abort
 * startup instead of silently becoming an unbounded pool or rapid retry loop.
 */

export interface PositiveIntegerBounds {
  defaultValue: number;
  minimum: number;
  maximum: number;
}

export function boundedPositiveInteger(
  name: string,
  raw: string | number | undefined,
  bounds: PositiveIntegerBounds,
): number {
  if (
    !Number.isSafeInteger(bounds.defaultValue) ||
    !Number.isSafeInteger(bounds.minimum) ||
    !Number.isSafeInteger(bounds.maximum) ||
    bounds.minimum < 1 ||
    bounds.minimum > bounds.defaultValue ||
    bounds.defaultValue > bounds.maximum
  ) {
    throw new RangeError(`invalid bounds for ${name}`);
  }

  if (raw === undefined || raw === "") return bounds.defaultValue;

  const value = typeof raw === "number" ? raw : /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new RangeError(`${name} must be an integer from ${bounds.minimum} to ${bounds.maximum}`);
  }
  return value;
}

export const SYNC_INTERVAL_BOUNDS = {
  defaultValue: 3600,
  minimum: 60,
  maximum: 86_400,
} as const;
export const MIRROR_WAIT_BOUNDS = {
  defaultValue: 300,
  minimum: 1,
  maximum: 3600,
} as const;
export const SYNC_CONCURRENCY_BOUNDS = {
  defaultValue: 8,
  minimum: 1,
  maximum: 64,
} as const;
export const MEDIA_CONCURRENCY_BOUNDS = {
  defaultValue: 6,
  minimum: 1,
  maximum: 32,
} as const;
export const SYNC_STALENESS_BOUNDS = {
  defaultValue: 86_400,
  minimum: 60,
  maximum: 604_800,
} as const;
export const MCP_CONCURRENCY_BOUNDS = {
  defaultValue: 8,
  minimum: 1,
  maximum: 256,
} as const;
