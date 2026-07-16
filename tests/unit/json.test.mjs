import assert from "node:assert/strict";
import test from "node:test";

import { safeJsonObject, safeJsonValue } from "../../packages/cli/dist/json.js";

test("safe JSON normalization stops before eagerly reading oversized objects", () => {
  const input = {};
  let propertyReads = 0;
  for (let index = 0; index < 1_001; index += 1) {
    Object.defineProperty(input, `field-${String(index).padStart(4, "0")}`, {
      enumerable: true,
      get() {
        propertyReads += 1;
        return index;
      },
    });
  }

  const normalized = safeJsonObject(input);
  assert.equal(propertyReads, 1_000);
  assert.equal(normalized.__truncated_entries__, true);
});

test("safe JSON normalization preserves prototype-shaped keys as data", () => {
  const input = {};
  Object.defineProperty(input, "__proto__", { enumerable: true, value: { safe: true } });

  const normalized = safeJsonObject(input);
  assert.equal(normalized.__proto__.safe, true);
  assert.equal(Object.getPrototypeOf(normalized), null);
});

test("safe JSON normalization enforces a global string budget", () => {
  const largeValue = "x".repeat(64 * 1024);
  const normalized = safeJsonValue(Array.from({ length: 100 }, () => largeValue));
  assert.ok(JSON.stringify(normalized).length < 1_100_000);
  assert.match(normalized.at(-1), /truncated/u);
});
