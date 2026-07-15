import assert from "node:assert/strict";
import { test } from "node:test";

import { REDACTED, Redactor } from "../src/redaction.js";

test("redacts registered secrets, patterns, and sensitive fields without mutation", () => {
  const redactor = new Redactor({ useDefaultPatterns: false });
  redactor.registerSecret("very-secret-value");
  redactor.registerPattern(/ticket-[0-9]+/g);
  const input = {
    message: "value=very-secret-value ticket-42",
    nested: { session_token: "otherwise-invisible", safe: "unchanged" },
  };

  const output = redactor.redact(input);

  assert.deepEqual(output, {
    message: `value=${REDACTED} ${REDACTED}`,
    nested: { session_token: REDACTED, safe: "unchanged" },
  });
  assert.equal(input.nested.session_token, "otherwise-invisible");
});

test("default patterns hide cloud keys, private keys, and credential URLs", () => {
  const redactor = new Redactor();
  const text = [
    ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
    "postgres://alice:password@example.test/database",
    ["-----BEGIN ", "PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"].join(""),
  ].join(" ");

  const output = redactor.redactString(text);

  assert.doesNotMatch(output, /AKIA/);
  assert.doesNotMatch(output, /password/);
  assert.doesNotMatch(output, /BEGIN PRIVATE KEY/);
});

test("handles circular values safely", () => {
  const value: { child?: unknown; password?: string } = { password: "secret" };
  value.child = value;
  assert.deepEqual(new Redactor().redact(value), { password: REDACTED, child: "[CIRCULAR]" });
});
