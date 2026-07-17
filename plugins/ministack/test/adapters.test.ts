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
    assert.equal(response.impact, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter v2 impact action returns strictly validated selective execution nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-adapter-impact-"));
  const adapter = join(root, "impact-adapter.mjs");
  try {
    await writeFile(adapter, `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks));
process.stdout.write(JSON.stringify({
  schema_version: 2,
  adapter: "fixture",
  capabilities: ["impact.graph.v1"],
  bindings: [],
  diagnostics: [],
  state: { action: request.action },
  impact: {
    nodes: [
      {
        id: "adapter:fixture",
        kind: "adapter",
        fingerprint: "sha256:${"1".repeat(64)}",
        dependencies: ["runtime:ministack"],
        certainty: "exact",
        cacheable: true,
        always_run: false,
        metadata: { provider: "fixture" }
      },
      {
        id: "service:fixture/api",
        kind: "service",
        fingerprint: "sha256:${"2".repeat(64)}",
        dependencies: ["adapter:fixture"],
        certainty: "unknown",
        issues: ["The remote service version could not be observed."],
        cacheable: false,
        always_run: true
      }
    ]
  }
}));
`);
    await chmod(adapter, 0o755);
    const response = await invokeAdapter("fixture", {
      executable: adapter,
      protocol: 2,
    }, adapterRequest(root, "impact"), invocationOptions(root));

    assert.equal(response.state?.action, "impact");
    assert.deepEqual(response.impact, {
      nodes: [
        {
          id: "adapter:fixture",
          kind: "adapter",
          fingerprint: `sha256:${"1".repeat(64)}`,
          dependencies: ["runtime:ministack"],
          certainty: "exact",
          cacheable: true,
          always_run: false,
          metadata: { provider: "fixture" },
        },
        {
          id: "service:fixture/api",
          kind: "service",
          fingerprint: `sha256:${"2".repeat(64)}`,
          dependencies: ["adapter:fixture"],
          certainty: "unknown",
          issues: ["The remote service version could not be observed."],
          cacheable: false,
          always_run: true,
        },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter impact metadata rejects ambiguous or unsafe graph contributions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-adapter-invalid-impact-"));
  const adapter = join(root, "response-adapter.mjs");
  try {
    await writeFile(adapter, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
process.stdout.write(Buffer.from(process.argv[2], "base64"));
`);
    await chmod(adapter, 0o755);

    const validNode = {
      id: "test:fixture/smoke",
      kind: "test",
      fingerprint: `sha256:${"a".repeat(64)}`,
    };
    const invalidCases: Array<{ name: string; impact: unknown; error: RegExp }> = [
      {
        name: "unknown impact envelope field",
        impact: { nodes: [], extra: true },
        error: /invalid impact metadata/,
      },
      {
        name: "unknown node field",
        impact: { nodes: [{ ...validNode, input_paths: ["src"] }] },
        error: /invalid impact node/,
      },
      {
        name: "id and kind mismatch",
        impact: { nodes: [{ ...validNode, id: "service:fixture/smoke" }] },
        error: /invalid namespaced id or kind/,
      },
      {
        name: "unsupported node kind",
        impact: { nodes: [{ ...validNode, id: "runtime:fixture", kind: "runtime" }] },
        error: /invalid namespaced id or kind/,
      },
      {
        name: "malformed digest",
        impact: { nodes: [{ ...validNode, fingerprint: "sha256:abc" }] },
        error: /invalid sha256 fingerprint/,
      },
      {
        name: "unknown certainty without issue",
        impact: { nodes: [{ ...validNode, certainty: "unknown" }] },
        error: /without an issue explaining unknown certainty/,
      },
      {
        name: "invalid dependency namespace",
        impact: { nodes: [{ ...validNode, dependencies: ["database:fixture"] }] },
        error: /invalid dependency database:fixture/,
      },
      {
        name: "duplicate dependencies",
        impact: { nodes: [{ ...validNode, dependencies: ["service:api", "service:api"] }] },
        error: /invalid dependencies/,
      },
      {
        name: "duplicate node ids",
        impact: { nodes: [validNode, { ...validNode }] },
        error: /duplicate impact node test:fixture\/smoke/,
      },
      {
        name: "invalid execution metadata",
        impact: { nodes: [{ ...validNode, always_run: "yes" }] },
        error: /invalid always_run metadata/,
      },
    ];

    for (const invalid of invalidCases) {
      await t.test(invalid.name, async () => {
        const response = {
          schema_version: 2,
          adapter: "fixture",
          capabilities: [],
          bindings: [],
          diagnostics: [],
          impact: invalid.impact,
        };
        await assert.rejects(
          invokeFixtureResponse(adapter, root, response),
          invalid.error,
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function adapterRequest(root: string, action: AdapterRequest["action"]): AdapterRequest {
  return {
    schema_version: 2,
    action,
    project_id: "project",
    project_root: root,
    run_id: "run",
    payload: {},
  };
}

function invocationOptions(root: string) {
  return {
    root,
    parentEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME },
    resolveSecret: async (_reference: string) => "",
  };
}

async function invokeFixtureResponse(
  adapter: string,
  root: string,
  response: Record<string, unknown>,
) {
  return await invokeAdapter("fixture", {
    executable: adapter,
    protocol: 2,
    args: [Buffer.from(JSON.stringify(response)).toString("base64")],
  }, adapterRequest(root, "impact"), invocationOptions(root));
}
