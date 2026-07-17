import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultManifest, parseManifest } from "../src/config.js";
import {
  createImpactGraph,
  createProjectImpactGraph,
  emptyImpactLedger,
  fingerprintImpactNode,
  fingerprintInputs,
  fingerprintValue,
  impactNodeId,
  impactPlanDocument,
  planImpact,
  readImpactLedger,
  updateImpactLedger,
  writeImpactLedger,
  type ImpactGraph,
  type ImpactLedger,
  type ImpactNode,
  type ImpactPlan,
} from "../src/impact/index.js";
import { fingerprintDeclaredBuild } from "../src/runtime/cache.js";
import type { DiscoveryReport, SandboxManifest } from "../src/types.js";

function digest(value: unknown) {
  return fingerprintValue(value, "anbo.test.impact");
}

function node(
  kind: ImpactNode["kind"],
  name: string,
  value: unknown,
  dependencies: readonly string[] = [],
  extra: Partial<ImpactNode> = {},
): ImpactNode {
  return {
    id: impactNodeId(kind, name),
    kind,
    fingerprint: digest(value),
    dependencies,
    ...extra,
  };
}

function standardGraph(values: { build?: number; service?: number; test?: number } = {}): ImpactGraph {
  return createImpactGraph([
    node("runtime", "ministack", 1),
    node("build", "api", values.build ?? 1, ["runtime:ministack"]),
    node("service", "api", values.service ?? 1, ["runtime:ministack", "build:api"]),
    node("test", "api-smoke", values.test ?? 1, ["service:api"]),
  ]);
}

function successfulResults(plan: ImpactPlan) {
  return plan.executionOrder.map((id) => ({
    id,
    status: "succeeded" as const,
    effectiveFingerprint: plan.items.get(id)!.effectiveFingerprint,
  }));
}

function successfulLedger(graph: ImpactGraph): ImpactLedger {
  const plan = planImpact(graph, emptyImpactLedger(), { mode: "cold" });
  return updateImpactLedger(emptyImpactLedger(), graph, successfulResults(plan), {
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
}

test("filesystem fingerprints are checkout-independent, content-addressed, and glob-aware", async (t) => {
  const left = await mkdtemp(join(tmpdir(), "anbo-impact-left-"));
  const right = await mkdtemp(join(tmpdir(), "anbo-impact-right-"));
  t.after(async () => {
    await Promise.all([rm(left, { recursive: true, force: true }), rm(right, { recursive: true, force: true })]);
  });
  for (const root of [left, right]) {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "src", "api.ts"), "export const api = 1;\n");
    await writeFile(join(root, "src", "nested", "worker.ts"), "export const worker = 1;\n");
    await writeFile(join(root, "src", "notes.md"), "ignored by the input glob\n");
    await writeFile(join(root, "generated", "build.ts"), "not an input\n");
  }

  const options = {
    inputs: ["src/**/*.ts"],
    definition: { command: ["npm", "test"] },
  };
  const baseline = await fingerprintInputs({ root: left, ...options });
  const copied = await fingerprintInputs({ root: right, ...options });
  assert.equal(baseline.certainty, "exact");
  assert.equal(copied.digest, baseline.digest);
  assert.deepEqual(baseline.records.map((entry) => entry.path), ["src/api.ts", "src/nested/worker.ts"]);

  await writeFile(join(right, "src", "notes.md"), "still ignored\n");
  assert.equal((await fingerprintInputs({ root: right, ...options })).digest, baseline.digest);
  await writeFile(join(right, "src", "nested", "worker.ts"), "export const worker = 2;\n");
  assert.notEqual((await fingerprintInputs({ root: right, ...options })).digest, baseline.digest);
});

test("fingerprints represent deletions and symlink target changes without following links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-impact-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "present.txt"), "present\n");
  await symlink("present.txt", join(root, "current"));

  const present = await fingerprintInputs({ root, inputs: ["present.txt", "current"] });
  await rm(join(root, "present.txt"));
  await rm(join(root, "current"));
  await symlink("missing.txt", join(root, "current"));
  const removed = await fingerprintInputs({ root, inputs: ["present.txt", "current"] });

  assert.notEqual(removed.digest, present.digest);
  assert.deepEqual(
    removed.records.map(({ mode: _mode, ...record }) => record),
    [
      { path: "current", type: "symlink", target: "missing.txt" },
      { path: "present.txt", type: "missing" },
    ],
  );
});

test("fingerprinted nodes expose uncertainty and deterministic policy metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-impact-node-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "test.ts"), "ok\n");
  const first = await fingerprintImpactNode({
    root,
    id: "test:smoke",
    kind: "test",
    inputs: ["test.ts"],
    definition: { command: ["node", "test.ts"] },
    dependencies: ["service:api"],
    cacheable: false,
    alwaysRun: true,
    metadata: { tag: "smoke" },
  });
  const second = await fingerprintImpactNode({
    root,
    id: "test:smoke",
    kind: "test",
    inputs: ["test.ts"],
    definition: { command: ["node", "test.ts"] },
    dependencies: ["service:api"],
    cacheable: false,
    alwaysRun: true,
    metadata: { tag: "smoke" },
  });
  assert.deepEqual(second, first);
  assert.equal(first.certainty, "exact");
});

test("impact graph is deterministic and rejects missing dependencies and cycles", () => {
  const unsorted = [
    node("test", "smoke", 1, ["service:api"]),
    node("runtime", "ministack", 1),
    node("service", "api", 1, ["runtime:ministack"]),
  ];
  const graph = createImpactGraph(unsorted);
  assert.deepEqual(graph.topologicalOrder, ["runtime:ministack", "service:api", "test:smoke"]);
  assert.equal(createImpactGraph([...unsorted].reverse()).fingerprint, graph.fingerprint);
  assert.throws(
    () => createImpactGraph([node("service", "api", 1, ["build:missing"])]),
    /references missing dependency build:missing/,
  );
  assert.throws(
    () => createImpactGraph([
      node("service", "api", 1, ["test:smoke"]),
      node("test", "smoke", 1, ["service:api"]),
    ]),
    /dependency cycle/,
  );
});

test("warm planning reuses every successful node and an app change selects only its subtree", () => {
  const initial = standardGraph();
  const ledger = successfulLedger(initial);
  const warm = planImpact(initial, ledger);
  assert.deepEqual(warm.executionOrder, []);
  assert.equal(warm.summary.reuse, 4);
  assert.deepEqual([...warm.items.values()].map((item) => item.reasons[0]?.code), [
    "cache_hit", "cache_hit", "cache_hit", "cache_hit",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(impactPlanDocument(warm))).execution_order, []);

  const changed = standardGraph({ build: 2 });
  const affected = planImpact(changed, ledger);
  assert.deepEqual(affected.executionOrder, ["build:api", "service:api", "test:api-smoke"]);
  assert.equal(affected.items.get("runtime:ministack")?.action, "reuse");
  assert.equal(affected.items.get("build:api")?.reasons[0]?.code, "fingerprint_changed");
  assert.ok(affected.items.get("service:api")?.reasons.some((entry) => entry.code === "dependency_fingerprint_changed"));
});

test("a failed test retries independently while full verification forces tests only", () => {
  const graph = standardGraph();
  let ledger = successfulLedger(graph);
  const baseline = planImpact(graph, ledger);
  ledger = updateImpactLedger(ledger, graph, [{
    id: "test:api-smoke",
    status: "failed",
    effectiveFingerprint: baseline.items.get("test:api-smoke")!.effectiveFingerprint,
  }], { updatedAt: "2026-07-17T00:01:00.000Z" });

  const retry = planImpact(graph, ledger);
  assert.deepEqual(retry.executionOrder, ["test:api-smoke"]);
  assert.equal(retry.items.get("service:api")?.action, "reuse");
  assert.equal(retry.items.get("test:api-smoke")?.reasons[0]?.code, "previous_failed");

  const verified = planImpact(graph, successfulLedger(graph), { mode: "full" });
  assert.deepEqual(verified.executionOrder, ["test:api-smoke"]);
  assert.equal(verified.items.get("build:api")?.action, "reuse");
});

test("unknown inputs and non-cacheable nodes conservatively select dependents", () => {
  const baseline = standardGraph();
  const ledger = successfulLedger(baseline);
  const graph = createImpactGraph([
    node("runtime", "ministack", 1),
    node("build", "api", 1, ["runtime:ministack"], {
      certainty: "unknown",
      issues: ["src: permission denied"],
    }),
    node("service", "api", 1, ["runtime:ministack", "build:api"]),
    node("test", "api-smoke", 1, ["service:api"], { cacheable: false }),
  ]);
  const plan = planImpact(graph, ledger);
  assert.deepEqual(plan.executionOrder, ["build:api", "service:api", "test:api-smoke"]);
  assert.ok(plan.items.get("build:api")?.reasons.some((entry) => entry.code === "unknown_inputs"));
  assert.ok(plan.items.get("test:api-smoke")?.reasons.some((entry) => entry.code === "cache_disabled"));
});

test("deleted nodes are removed in dependent-first order", () => {
  const previous = standardGraph();
  const ledger = successfulLedger(previous);
  const current = createImpactGraph([node("runtime", "ministack", 1)]);
  const plan = planImpact(current, ledger);
  assert.deepEqual(plan.removalOrder, ["test:api-smoke", "service:api", "build:api"]);
  assert.equal(plan.summary.remove, 3);
});

test("ledger writes atomically and invalid state degrades to a conservative empty ledger", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-impact-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "impact.json");
  const graph = standardGraph();
  const ledger = successfulLedger(graph);
  await writeImpactLedger(path, ledger);
  const loaded = await readImpactLedger(path);
  assert.equal(loaded.status, "loaded");
  assert.deepEqual(loaded.ledger, ledger);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);

  await writeFile(path, '{"schema_version":999,"nodes":{}}\n');
  const invalid = await readImpactLedger(path);
  assert.equal(invalid.status, "invalid");
  assert.deepEqual(invalid.ledger, emptyImpactLedger());
  assert.match(invalid.issues[0] ?? "", /impact ledger is invalid/);
});

function discovery(root: string): DiscoveryReport {
  return {
    root,
    terraform: [{ path: "infra", files: ["infra/main.tf"], variable_files: [] }],
    sdk: [],
    dockerfiles: [],
  };
}

function manifestWithService(): SandboxManifest {
  const manifest = createDefaultManifest(discovery("/tmp/selective"));
  manifest.builds.api = { context: ".", dockerfile: "Dockerfile" };
  manifest.services.api = { build: "api" };
  return manifest;
}

test("manifest test metadata is optional, backward-compatible, and strictly validated", () => {
  const legacy = manifestWithService();
  legacy.tests.legacy = { command: ["npm", "test"], service: "api", default: true };
  assert.equal(parseManifest(legacy), legacy);

  const selective = structuredClone(legacy);
  selective.tests.selective = {
    command: ["npm", "test", "--", "reminders"],
    service: "api",
    inputs: ["src/reminders/**", "test/reminders.test.ts"],
    requires: ["service:api", "terraform:infra"],
    tags: ["smoke", "reminders"],
    cache: true,
    always_run: false,
    default: true,
  };
  assert.equal(parseManifest(selective), selective);

  const traversal = structuredClone(selective);
  traversal.tests.selective!.inputs = ["../secrets"];
  assert.throws(() => parseManifest(traversal), /must remain inside the project root/);
  const requirement = structuredClone(selective);
  requirement.tests.selective!.requires = ["api"];
  assert.throws(() => parseManifest(requirement), /namespaced impact node/);
  const duplicate = structuredClone(selective);
  duplicate.tests.selective!.tags = ["smoke", "smoke"];
  assert.throws(() => parseManifest(duplicate), /must not contain duplicate values/);
  const missingService = structuredClone(selective) as unknown as Record<string, unknown>;
  delete ((missingService["tests"] as Record<string, Record<string, unknown>>)["selective"]!)["service"];
  assert.throws(() => parseManifest(missingService), /service must be a non-empty string/);
});

test("project build nodes use the exact effective Docker build context fingerprint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-impact-docker-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "app", "node_modules"), { recursive: true });
  await writeFile(join(root, "app", "Dockerfile"), "FROM scratch\nCOPY . /app\n");
  await writeFile(join(root, "app", ".dockerignore"), "ignored.txt\n");
  await writeFile(join(root, "app", "source.txt"), "source one\n");
  await writeFile(join(root, "app", "other.txt"), "other one\n");
  await writeFile(join(root, "app", "ignored.txt"), "ignored one\n");
  await writeFile(join(root, "app", "node_modules", "dependency.js"), "dependency one\n");

  const manifest = createDefaultManifest({
    root,
    terraform: [],
    sdk: [],
    dockerfiles: [],
  });
  const build = {
    context: "app",
    dockerfile: "Dockerfile",
    // Docker builds still hash every file transmitted to Docker. Declared
    // inputs cannot hide other effective context files.
    inputs: ["source.txt"],
  };
  manifest.builds.api = build;
  const buildFingerprint = async () =>
    (await createProjectImpactGraph({ root, manifest })).nodes.get("build:api")!.fingerprint;

  const baseline = await buildFingerprint();
  assert.equal(baseline, `sha256:${await fingerprintDeclaredBuild(root, build)}`);

  await writeFile(join(root, "app", "ignored.txt"), "ignored two\n");
  await writeFile(join(root, "app", "node_modules", "dependency.js"), "dependency two\n");
  assert.equal(await buildFingerprint(), baseline);

  await writeFile(join(root, "app", "other.txt"), "other two\n");
  assert.notEqual(await buildFingerprint(), baseline);
});

test("project command build nodes honor context-relative inputs and exclude their outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-impact-command-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tools", "src"), { recursive: true });
  await mkdir(join(root, "tools", "dist"), { recursive: true });
  await writeFile(join(root, "tools", "src", "compiler.ts"), "compiler one\n");
  await writeFile(join(root, "tools", "notes.txt"), "notes one\n");
  await writeFile(join(root, "tools", "dist", "generated.js"), "generated one\n");

  const manifest = createDefaultManifest({
    root,
    terraform: [],
    sdk: [],
    dockerfiles: [],
  });
  manifest.builds.scoped = {
    context: "tools",
    inputs: ["src"],
    command: ["node", "build.mjs"],
    outputs: ["tools/dist/generated.js"],
  };
  manifest.builds.wide = {
    context: "tools",
    command: ["node", "build.mjs"],
    outputs: ["tools/dist/generated.js"],
  };
  const fingerprints = async () => {
    const graph = await createProjectImpactGraph({ root, manifest });
    return {
      scoped: graph.nodes.get("build:scoped")!.fingerprint,
      wide: graph.nodes.get("build:wide")!.fingerprint,
    };
  };

  const baseline = await fingerprints();
  await writeFile(join(root, "tools", "dist", "generated.js"), "generated two\n");
  assert.deepEqual(await fingerprints(), baseline);

  await writeFile(join(root, "tools", "notes.txt"), "notes two\n");
  const unrelated = await fingerprints();
  assert.equal(unrelated.scoped, baseline.scoped);
  assert.notEqual(unrelated.wide, baseline.wide);

  await writeFile(join(root, "tools", "src", "compiler.ts"), "compiler two\n");
  const sourceChanged = await fingerprints();
  assert.notEqual(sourceChanged.scoped, unrelated.scoped);
  assert.notEqual(sourceChanged.wide, unrelated.wide);
});

test("missing generated build inputs conservatively invalidate impact preview", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-impact-generated-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source.txt"), "source\n");

  const manifest = createDefaultManifest({
    root,
    terraform: [],
    sdk: [],
    dockerfiles: [],
  });
  manifest.builds.producer = {
    context: ".",
    inputs: ["source.txt"],
    command: ["node", "produce.mjs"],
    outputs: ["generated.txt"],
  };
  manifest.builds.consumer = {
    context: ".",
    inputs: ["generated.txt"],
    command: ["node", "consume.mjs"],
    outputs: ["consumed.txt"],
  };

  const missing = await createProjectImpactGraph({ root, manifest });
  const missingConsumer = missing.nodes.get("build:consumer");
  assert.equal(missingConsumer?.certainty, "unknown");
  assert.match(missingConsumer?.issues[0] ?? "", /generated\.txt is missing/);
  const warmPlan = planImpact(missing, successfulLedger(missing));
  assert.ok(warmPlan.executionOrder.includes("build:consumer"));
  assert.equal(warmPlan.items.get("build:consumer")?.reasons[0]?.code, "unknown_inputs");

  await writeFile(join(root, "generated.txt"), "generated\n");
  const generated = await createProjectImpactGraph({ root, manifest });
  assert.equal(generated.nodes.get("build:consumer")?.certainty, "exact");
  assert.notEqual(
    generated.nodes.get("build:consumer")?.fingerprint,
    missingConsumer?.fingerprint,
  );
});

test("test default policy and adapter environment references participate in project fingerprints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-impact-definitions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tools"), { recursive: true });
  await writeFile(join(root, "tools", "adapter.mjs"), "process.exit(0);\n");

  const manifest = createDefaultManifest({
    root,
    terraform: [],
    sdk: [],
    dockerfiles: [],
  });
  manifest.services.runner = { image: "busybox:latest" };
  manifest.tests.smoke = {
    command: ["node", "--test"],
    service: "runner",
    default: false,
  };
  manifest.adapters.data = {
    executable: "tools/adapter.mjs",
    environment: {
      TOKEN: "env://FIRST_TOKEN",
      USER: "env://FIRST_USER",
    },
  };
  const fingerprints = async (candidate: SandboxManifest) => {
    const graph = await createProjectImpactGraph({ root, manifest: candidate });
    return {
      test: graph.nodes.get("test:smoke")!.fingerprint,
      adapter: graph.nodes.get("adapter:data")!.fingerprint,
    };
  };

  const baseline = await fingerprints(manifest);
  const defaultEnabled = structuredClone(manifest);
  defaultEnabled.tests.smoke!.default = true;
  const withDefault = await fingerprints(defaultEnabled);
  assert.notEqual(withDefault.test, baseline.test);
  assert.equal(withDefault.adapter, baseline.adapter);

  const environmentChanged = structuredClone(manifest);
  environmentChanged.adapters.data!.environment!.TOKEN = "env://SECOND_TOKEN";
  const withEnvironment = await fingerprints(environmentChanged);
  assert.equal(withEnvironment.test, baseline.test);
  assert.notEqual(withEnvironment.adapter, baseline.adapter);

  const reorderedEnvironment = structuredClone(manifest);
  reorderedEnvironment.adapters.data!.environment = {
    USER: "env://FIRST_USER",
    TOKEN: "env://FIRST_TOKEN",
  };
  assert.deepEqual(await fingerprints(reorderedEnvironment), baseline);
});
