/**
 * Unit tests for the HTTP transport gate (bearer-token auth + Origin allowlist).
 * Pure request-in / Response-or-null-out; no server is booted.
 */

import { expect, test } from "bun:test";
import { checkHttpGate, parseAllowedOrigins } from "../src/serve/http-auth.ts";

const req = (headers: Record<string, string> = {}) => new Request("http://localhost:8477/", { headers });

test("parseAllowedOrigins splits, trims, and drops empties", () => {
  expect([...parseAllowedOrigins(undefined)]).toEqual([]);
  expect([...parseAllowedOrigins("")]).toEqual([]);
  expect([...parseAllowedOrigins(" https://a.example , https://b.example ,")]).toEqual([
    "https://a.example",
    "https://b.example",
  ]);
});

test("no token, no Origin → request passes (unchanged behavior)", () => {
  const cfg = { token: undefined, allowedOrigins: new Set<string>() };
  expect(checkHttpGate(req(), cfg)).toBeNull();
  expect(checkHttpGate(req({ authorization: "Bearer whatever" }), cfg)).toBeNull();
});

test("token set: correct bearer passes, wrong/missing → 401", () => {
  const cfg = { token: "s3cret-token", allowedOrigins: new Set<string>() };
  expect(checkHttpGate(req({ authorization: "Bearer s3cret-token" }), cfg)).toBeNull();
  expect(checkHttpGate(req(), cfg)?.status).toBe(401);
  expect(checkHttpGate(req({ authorization: "Bearer wrong" }), cfg)?.status).toBe(401);
  // Length-mismatched token must not throw (constant-time compare handles it).
  expect(checkHttpGate(req({ authorization: "Bearer " }), cfg)?.status).toBe(401);
});

test("Origin allowlist: unlisted browser Origin → 403, before auth", () => {
  const cfg = { token: "s3cret-token", allowedOrigins: new Set(["https://ok.example"]) };
  // Bad origin is rejected even with a valid token (origin is checked first).
  expect(
    checkHttpGate(req({ origin: "https://evil.example", authorization: "Bearer s3cret-token" }), cfg)?.status,
  ).toBe(403);
  // Allowlisted origin + valid token passes.
  expect(
    checkHttpGate(req({ origin: "https://ok.example", authorization: "Bearer s3cret-token" }), cfg),
  ).toBeNull();
  // No Origin (a non-browser MCP client) is unaffected by the allowlist.
  expect(checkHttpGate(req({ authorization: "Bearer s3cret-token" }), cfg)).toBeNull();
});

test("empty allowlist rejects any browser Origin", () => {
  const cfg = { token: undefined, allowedOrigins: new Set<string>() };
  expect(checkHttpGate(req({ origin: "https://any.example" }), cfg)?.status).toBe(403);
  expect(checkHttpGate(req(), cfg)).toBeNull();
});
