import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../dist/src/plugin.js";

const temporary = await mkdtemp(join(tmpdir(), "anbo-ministack-conformance-"));
const project = join(temporary, "project");
const events = [];
await mkdir(project, { recursive: true });
await writeFile(join(project, "main.tf"), 'resource "aws_s3_bucket" "notes" { bucket = "notes-local" }\n');

const context = {
  signal: new AbortController().signal,
  events: {
    emit: async (event) => { events.push(event); },
    startPhase: async () => ({ finish: async () => {}, fail: async () => {} }),
  },
  process: { run: async () => { throw new Error("configure conformance must not start a process"); } },
  http: { request: globalThis.fetch },
  state: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  credentials: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  secrets: { resolve: async (reference) => { throw new Error(`unexpected secret ${reference}`); } },
  adapters: { invoke: async () => { throw new Error("unexpected adapter invocation"); } },
  paths: {
    state: join(temporary, "state"),
    cache: join(temporary, "cache"),
    data: join(temporary, "data"),
  },
};

try {
  assert.equal(plugin.descriptor.id, "anbo.ministack");
  assert.deepEqual(plugin.descriptor.targets, ["ministack"]);
  const runtime = await plugin.activate(context);
  const target = runtime.targets?.find((candidate) => candidate.id === "ministack");
  assert.ok(target, "activate() must register the ministack target");
  const result = await target.execute({
    api_version: 1,
    action: "configure",
    project: { root: project, logical_id: "notes", runtime_id: "notes-conformance" },
    config: { manifest: ".anbo/sandbox.json" },
    args: [],
    flags: {},
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.data?.discovery.terraform.map((entry) => entry.path), ["."]);
  assert.ok(events.some((event) => event.kind === "phase.started"));
  assert.equal(events.some((event) => event.kind === "run.started" || event.kind === "run.finished"), false,
    "the canonical CLI, not the plugin, owns run envelopes");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
