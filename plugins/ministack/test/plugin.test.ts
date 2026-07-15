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
    "configure", "deploy", "status", "test", "logs", "debug", "down", "capabilities", "cache",
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
