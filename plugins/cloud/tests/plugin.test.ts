import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PluginEventV1, TargetRequestV1 } from "@getanbo/plugin-sdk";
import plugin, { descriptor } from "../src/index.js";

test("descriptor and package metadata identify a target plugin without a binary", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(await readFile(new URL("../anbo.plugin.json", import.meta.url), "utf8")) as Record<string, unknown>;

  assert.equal(packageJson["name"], "@getanbo/plugin-cloud");
  assert.equal(packageJson["bin"], undefined);
  assert.equal(manifest["id"], descriptor.id);
  assert.equal(manifest["plugin_api"], 1);
  assert.deepEqual(descriptor.targets, ["cloud"]);
});

test("capabilities execute through the plugin event contract", async () => {
  const events: PluginEventV1[] = [];
  const runtime = await plugin.activate({
    signal: new AbortController().signal,
    events: {
      emit: async (event) => { events.push(event); },
      startPhase: async () => ({ finish: async () => undefined, fail: async () => undefined })
    },
    process: { run: async () => ({ command: "", args: [], exit_code: 0, stdout: "", stderr: "", duration_ms: 0 }) },
    http: { request: async () => new Response() },
    state: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    credentials: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    secrets: { resolve: async () => "" },
    adapters: { invoke: async () => undefined },
    paths: { state: "", cache: "", data: "" }
  });
  const request: TargetRequestV1 = {
    api_version: 1,
    action: "capabilities",
    project: { root: process.cwd(), logical_id: "test", runtime_id: "test-1" },
    config: {},
    args: [],
    flags: {}
  };
  const result = await runtime.targets?.find((target) => target.id === "cloud")?.execute(request);

  assert.equal(result?.status, "succeeded");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "capabilities");
  assert.deepEqual((events[0]?.fields?.["capabilities"] as string[]).includes("anbo.cloud"), true);
});

test("plugin only exposes namespaced commands", async () => {
  const runtime = await plugin.activate({
    signal: new AbortController().signal,
    events: {
      emit: async () => undefined,
      startPhase: async () => ({ finish: async () => undefined, fail: async () => undefined })
    },
    process: { run: async () => ({ command: "", args: [], exit_code: 0, stdout: "", stderr: "", duration_ms: 0 }) },
    http: { request: async () => new Response() },
    state: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    credentials: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    secrets: { resolve: async () => "" },
    adapters: { invoke: async () => undefined },
    paths: { state: "", cache: "", data: "" }
  });
  const names = runtime.commands?.map((command) => command.name) ?? [];
  assert.ok(names.length > 0);
  assert.ok(names.every((name) => name.startsWith("cloud.")));
});
