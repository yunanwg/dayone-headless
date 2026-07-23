import { expect, test } from "bun:test";
import {
  boundedPositiveInteger,
  MEDIA_CONCURRENCY_BOUNDS,
  MIRROR_WAIT_BOUNDS,
  SYNC_CONCURRENCY_BOUNDS,
  SYNC_INTERVAL_BOUNDS,
} from "../src/runtime-config.ts";

test("bounded positive integer uses defaults only for unset or empty values", () => {
  expect(boundedPositiveInteger("TEST", undefined, SYNC_CONCURRENCY_BOUNDS)).toBe(8);
  expect(boundedPositiveInteger("TEST", "", MEDIA_CONCURRENCY_BOUNDS)).toBe(6);
});

test("bounded positive integer accepts inclusive bounds", () => {
  expect(boundedPositiveInteger("TEST", "60", SYNC_INTERVAL_BOUNDS)).toBe(60);
  expect(boundedPositiveInteger("TEST", 86_400, SYNC_INTERVAL_BOUNDS)).toBe(86_400);
  expect(boundedPositiveInteger("TEST", "3600", MIRROR_WAIT_BOUNDS)).toBe(3600);
});

test("bounded positive integer rejects malformed, fractional, zero, and excessive values", () => {
  for (const value of ["0", "-1", "1.5", "1e3", "NaN", " 8", "8 ", 1.5, 65]) {
    expect(() => boundedPositiveInteger("TEST", value, SYNC_CONCURRENCY_BOUNDS)).toThrow(
      "TEST must be an integer from 1 to 64",
    );
  }
});
