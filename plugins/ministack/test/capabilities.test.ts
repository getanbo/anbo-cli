import assert from "node:assert/strict";
import test from "node:test";

import {
  CERTIFIED_MINISTACK_DIGEST,
  CERTIFIED_MINISTACK_IMAGE,
  CERTIFIED_MINISTACK_SOURCE,
  SERVICE_CAPABILITIES,
  getCapabilityReport,
} from "../src/capabilities.js";

test("capability matrix covers the certified full MiniStack surface", () => {
  assert.match(CERTIFIED_MINISTACK_DIGEST, /^sha256:[a-f0-9]{64}$/);
  assert.equal(CERTIFIED_MINISTACK_IMAGE, `ministackorg/ministack@${CERTIFIED_MINISTACK_DIGEST}`);
  assert.equal(CERTIFIED_MINISTACK_SOURCE, "ministackorg/ministack");
  assert.ok(SERVICE_CAPABILITIES.length >= 60);
  assert.equal(new Set(SERVICE_CAPABILITIES.map((entry) => entry.service)).size, SERVICE_CAPABILITIES.length);
  assert.equal(SERVICE_CAPABILITIES.find((entry) => entry.service === "EC2")?.fidelity, "control-plane-only");
  assert.equal(SERVICE_CAPABILITIES.find((entry) => entry.service === "Lambda")?.fidelity, "real-data-plane");
  assert.equal(SERVICE_CAPABILITIES.find((entry) => entry.service === "RDS")?.fidelity, "conditional-data-plane");
  assert.equal((getCapabilityReport().counts as { total: number }).total, SERVICE_CAPABILITIES.length);
});
