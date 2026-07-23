import { expect, test } from "bun:test";
import { readSecret, requireSecret, SecretConfigError } from "../src/secret-config.ts";

const synthetic = "synthetic-secret-value";

test("readSecret accepts a direct value without changing it", () => {
  expect(readSecret("DAYONE_API_TOKEN", { DAYONE_API_TOKEN: synthetic })).toBe(synthetic);
});

test("readSecret accepts a file value and strips one final line ending", () => {
  expect(
    readSecret("DAYONE_PASSWORD", { DAYONE_PASSWORD_FILE: "/synthetic/secret" }, () => `${synthetic}\r\n`),
  ).toBe(synthetic);
});

test("secret configuration fails closed on conflicts, empty values, and read failures", () => {
  expect(() =>
    readSecret(
      "DAYONE_EMAIL",
      { DAYONE_EMAIL: synthetic, DAYONE_EMAIL_FILE: "/synthetic/secret" },
      () => synthetic,
    ),
  ).toThrow(SecretConfigError);
  expect(() => readSecret("DAYONE_EMAIL", { DAYONE_EMAIL: "" })).toThrow(SecretConfigError);
  expect(() =>
    readSecret("DAYONE_EMAIL", { DAYONE_EMAIL_FILE: "/synthetic/secret" }, () => {
      throw new Error("sensitive local path detail");
    }),
  ).toThrow(SecretConfigError);
  expect(() => readSecret("DAYONE_EMAIL", { DAYONE_EMAIL_FILE: "/synthetic/secret" }, () => "\n")).toThrow(
    SecretConfigError,
  );
  expect(() => requireSecret("DAYONE_ENCRYPTION_KEY", {})).toThrow(SecretConfigError);
});

test("secret errors name only the variable and never echo values or file paths", () => {
  try {
    readSecret("DAYONE_MCP_TOKEN", { DAYONE_MCP_TOKEN_FILE: "/private/synthetic/token" }, () => {
      throw new Error(`failed with ${synthetic}`);
    });
  } catch (error) {
    const message = String((error as Error).message);
    expect(message).toContain("DAYONE_MCP_TOKEN");
    expect(message).not.toContain(synthetic);
    expect(message).not.toContain("/private/synthetic/token");
  }
});
