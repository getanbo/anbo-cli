import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeAdapter, type AdapterRequest } from "../src/adapters.js";

test("adapter v2 receives only declared secrets and returns validated capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-adapter-"));
  const adapter = join(root, "adapter.mjs");
  try {
    await writeFile(adapter, `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks));
process.stdout.write(JSON.stringify({
  schema_version: 2,
  adapter: "fixture",
  capabilities: ["clone.fixture"],
  bindings: [{ name: "fixture", kind: "postgres", secret_handle: process.env.ADAPTER_SECRET }],
  diagnostics: [],
  state: { action: request.action, inherited: process.env.DO_NOT_INHERIT ?? null }
}));
`);
    await chmod(adapter, 0o755);
    const request: AdapterRequest = {
      schema_version: 2,
      action: "handshake",
      project_id: "project",
      project_root: root,
      run_id: "run",
      payload: {},
    };
    const response = await invokeAdapter("fixture", {
      executable: adapter,
      protocol: 2,
      capabilities: ["clone.fixture"],
      environment: { ADAPTER_SECRET: "env://FIXTURE_SECRET" },
    }, request, {
      root,
      parentEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME, FIXTURE_SECRET: "secret", DO_NOT_INHERIT: "unsafe" },
      resolveSecret: async (reference) => reference === "env://FIXTURE_SECRET" ? "secret" : "",
    });
    assert.deepEqual(response.capabilities, ["clone.fixture"]);
    assert.equal(response.bindings[0]?.secret_handle, "secret");
    assert.equal(response.state?.inherited, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
