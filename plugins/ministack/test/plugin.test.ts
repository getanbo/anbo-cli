import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PluginContextV1, PluginEventV1, PluginRuntimeV1, TargetProviderV1 } from "@getanbo/plugin-sdk";

import plugin, { descriptor } from "../src/plugin.js";

function context(root: string, events: PluginEventV1[]): PluginContextV1 {
  return {
    signal: new AbortController().signal,
    events: {
      emit: async (event) => { events.push(event); },
      startPhase: async () => ({ finish: async () => {}, fail: async () => {} }),
    },
    process: { run: async () => { throw new Error("unexpected process"); } },
    http: { request: globalThis.fetch },
    state: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    credentials: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    secrets: { resolve: async (reference) => process.env[reference.slice("env://".length)] ?? "" },
    adapters: { invoke: async () => ({}) },
    paths: { state: join(root, "state"), cache: join(root, "cache"), data: join(root, "data") },
  };
}

function ministackTarget(runtime: PluginRuntimeV1): TargetProviderV1 {
  const targets = runtime.targets as readonly TargetProviderV1[] | undefined;
  const target = targets?.find((candidate) => candidate.id === "ministack");
  assert.ok(target);
  return target;
}

test("exports the complete MiniStack target without owning a CLI binary", () => {
  assert.equal(descriptor.id, "anbo.ministack");
  assert.deepEqual(descriptor.targets, ["ministack"]);
  assert.deepEqual(descriptor.actions, [
    "configure", "deploy", "status", "test", "logs", "debug", "run", "reset", "down", "capabilities", "cache",
  ]);
});

test("configure deterministically discovers Terraform through typed host events", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-ministack-plugin-"));
  const events: PluginEventV1[] = [];
  try {
    await mkdir(join(root, "infra"), { recursive: true });
    await writeFile(join(root, "infra", "main.tf"), 'resource "aws_s3_bucket" "notes" {}\n');
    const runtime = await plugin.activate(context(root, events));
    const target = ministackTarget(runtime);
    const request = {
      api_version: 1 as const,
      action: "configure" as const,
      project: { root, logical_id: "notes", runtime_id: "notes-test" },
      config: { manifest: ".anbo/sandbox.json" },
      args: [],
      flags: {},
    };
    const first = await target.execute(request);
    const contents = await readFile(join(root, ".anbo", "sandbox.json"), "utf8");
    const second = await target.execute(request);
    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "succeeded");
    const firstData = first.data as Record<string, unknown>;
    const secondData = second.data as Record<string, unknown>;
    assert.deepEqual(firstData["discovery"], secondData["discovery"]);
    assert.deepEqual(JSON.parse(contents).terraform.roots, ["infra"]);
    assert.ok(events.some((event) => event.kind === "phase.started"));
    assert.equal(events.some((event) => event.kind === "run.finished"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy repairs root-level topology discovered after empty-project configure", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-ministack-plugin-refresh-"));
  const events: PluginEventV1[] = [];
  try {
    const runtime = await plugin.activate(context(root, events));
    const target = ministackTarget(runtime);
    const request = {
      api_version: 1 as const,
      project: { root, logical_id: "notes", runtime_id: "notes-refresh-test" },
      config: { manifest: ".anbo/sandbox.json" },
      args: [],
      flags: {},
    };
    const configured = await target.execute({ ...request, action: "configure" });
    assert.equal(configured.status, "succeeded");
    await writeFile(join(root, "main.tf"), 'resource "aws_s3_bucket" "notes" {}\n');
    await writeFile(join(root, "terraform.tfvars"), 'stage = "local"\n');
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");

    const deployed = await target.execute({ ...request, action: "deploy" });
    assert.equal(deployed.status, "failed", "the mocked process boundary should stop the deploy after repair");
    const manifest = JSON.parse(await readFile(join(root, ".anbo", "sandbox.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual((manifest["terraform"] as Record<string, unknown>)["variable_files"], ["terraform.tfvars"]);
    assert.equal(Object.values(manifest["builds"] as Record<string, { context?: string; dockerfile?: string }>).some((build) =>
      build.context === "." && build.dockerfile === "Dockerfile"), true);
    assert.ok(events.some((event) => event.phase === "configure.refresh"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an incompatible host API before touching the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-ministack-plugin-"));
  try {
    const runtime = await plugin.activate(context(root, []));
    const result = await ministackTarget(runtime).execute({
      api_version: 2 as 1,
      action: "status",
      project: { root, logical_id: "notes", runtime_id: "notes-test" },
      config: {},
      args: [],
      flags: {},
    });
    assert.equal(result?.status, "failed");
    assert.equal(result?.diagnostics?.[0]?.code, "ANBO_PLUGIN_API_MISMATCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ignored or user-owned lifecycle flags with a typed failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-ministack-plugin-flags-"));
  try {
    const target = ministackTarget(await plugin.activate(context(root, [])));
    const request = {
      api_version: 1 as const,
      action: "status" as const,
      project: { root, logical_id: "notes", runtime_id: "notes-test" },
      config: {},
      args: [],
    };
    const timeout = await target.execute({ ...request, flags: { timeout: "900" } });
    assert.equal(timeout.failure?.code, "ANBO_UNSUPPORTED_FLAG");
    assert.match(timeout.failure?.message ?? "", /--timeout.*status/);
    const runId = await target.execute({ ...request, flags: { "run-id": "invented" } });
    assert.equal(runId.failure?.code, "ANBO_RUN_ID_HOST_OWNED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical failures redact plugin-known secrets before crossing the host boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-ministack-plugin-redaction-"));
  const opaqueSecret = "opaque-value-that-default-patterns-do-not-recognize";
  const previous = process.env["PLUGIN_FAILURE_SECRET"];
  process.env["PLUGIN_FAILURE_SECRET"] = opaqueSecret;
  try {
    await mkdir(join(root, ".anbo"), { recursive: true });
    await writeFile(join(root, ".anbo", "sandbox.json"), JSON.stringify({
      schema_version: 2,
      project: { name: "notes" },
      terraform: { roots: ["."], variable_files: [] },
      data: {},
      services: {
        api: { image: "api:test", environment: { FAILURE_VALUE: "env://PLUGIN_FAILURE_SECRET" } },
      },
      builds: {},
      tests: {},
      ministack: {
        image: "ministackorg/ministack:1.4.2-full",
        digest: `sha256:${"a".repeat(64)}`,
        profile: "full",
        persistence: true,
      },
      network: { allow_hosts: [], clone_egress: false },
      adapters: {},
    }));
    const stateDirectory = join(root, "state", "anbo", "projects", "notes-test");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "state.json"), JSON.stringify({
      schema_version: 1,
      project_id: "notes-test",
      project_root: opaqueSecret,
      updated_at: new Date().toISOString(),
    }));
    const runtime = await plugin.activate(context(root, []));
    const result = await ministackTarget(runtime).execute({
      api_version: 1,
      action: "status",
      project: { root, logical_id: "notes", runtime_id: "notes-test" },
      config: { manifest: ".anbo/sandbox.json" },
      args: [],
      flags: {},
    });
    assert.equal(result.status, "failed");
    const rendered = JSON.stringify(result);
    assert.doesNotMatch(rendered, new RegExp(opaqueSecret));
    assert.match(rendered, /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env["PLUGIN_FAILURE_SECRET"];
    else process.env["PLUGIN_FAILURE_SECRET"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
