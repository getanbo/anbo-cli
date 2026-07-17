import assert from "node:assert/strict";
import test from "node:test";

import {
  CERTIFIED_MINISTACK_DIGEST,
  CERTIFIED_MINISTACK_IMAGE,
  CERTIFIED_MINISTACK_SOURCE,
  SERVICE_CAPABILITIES,
  getCapabilityReport,
} from "../src/capabilities.js";
import {
  CERTIFIED_MINISTACK_DOWNSTREAM,
  CERTIFIED_MINISTACK_INSTANCE_ISOLATION,
} from "../src/distribution.js";

test("capability matrix covers the certified full MiniStack surface", () => {
  assert.match(CERTIFIED_MINISTACK_DIGEST, /^sha256:[a-f0-9]{64}$/);
  if (CERTIFIED_MINISTACK_SOURCE === "getanbo/anbo-ministack") {
    assert.equal(CERTIFIED_MINISTACK_IMAGE, `ghcr.io/getanbo/anbo-ministack@${CERTIFIED_MINISTACK_DIGEST}`);
    assert.match(CERTIFIED_MINISTACK_DOWNSTREAM?.version ?? "", /^\d+\.\d+\.\d+-anbo\.[1-9]\d*$/);
    assert.match(CERTIFIED_MINISTACK_DOWNSTREAM?.commit ?? "", /^[a-f0-9]{40}$/);
    assert.deepEqual(CERTIFIED_MINISTACK_INSTANCE_ISOLATION, {
      contractVersion: 1,
      environment: "MINISTACK_INSTANCE_ID",
      healthField: "instance_isolation",
    });
  } else {
    assert.equal(CERTIFIED_MINISTACK_IMAGE, `ministackorg/ministack@${CERTIFIED_MINISTACK_DIGEST}`);
    assert.equal(CERTIFIED_MINISTACK_SOURCE, "ministackorg/ministack");
    assert.equal(CERTIFIED_MINISTACK_DOWNSTREAM, undefined);
    assert.equal(CERTIFIED_MINISTACK_INSTANCE_ISOLATION, undefined);
  }
  assert.ok(SERVICE_CAPABILITIES.length >= 60);
  assert.equal(new Set(SERVICE_CAPABILITIES.map((entry) => entry.service)).size, SERVICE_CAPABILITIES.length);
  assert.equal(SERVICE_CAPABILITIES.find((entry) => entry.service === "EC2")?.fidelity, "control-plane-only");
  assert.equal(SERVICE_CAPABILITIES.find((entry) => entry.service === "Lambda")?.fidelity, "real-data-plane");
  assert.equal(SERVICE_CAPABILITIES.find((entry) => entry.service === "RDS")?.fidelity, "conditional-data-plane");
  assert.equal((getCapabilityReport().counts as { total: number }).total, SERVICE_CAPABILITIES.length);
});
