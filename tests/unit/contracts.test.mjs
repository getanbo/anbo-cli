import assert from "node:assert/strict";
import test from "node:test";

import { validateDescriptor } from "../../packages/cli/dist/index.js";
import { redactObject, redactText } from "../../packages/cli/dist/redaction.js";

const descriptor = {
  schema_version: 1,
  plugin_api: 1,
  id: "anbo.fixture",
  package: "@getanbo/plugin-fixture",
  version: "0.1.0",
  engines: { anbo: ">=0.2.0 <0.3.0", node: ">=20.0.0" },
  targets: [{ id: "fixture", actions: ["deploy"] }],
};

test("descriptor v1 accepts rich static manifests", () => {
  assert.doesNotThrow(() => validateDescriptor(descriptor, "fixture", descriptor.package));
});

test("descriptor v1 rejects undeclared targets", () => {
  assert.throws(() => validateDescriptor(descriptor, "other", descriptor.package), /does not declare target/u);
});

test("redaction covers structured and textual credentials", () => {
  assert.equal(redactText("Bearer abc.def.ghi"), "Bearer [REDACTED]");
  assert.deepEqual(redactObject({ token: "secret-value", nested: { password: "password" } }), {
    token: "[REDACTED]",
    nested: { password: "[REDACTED]" },
  });
});
