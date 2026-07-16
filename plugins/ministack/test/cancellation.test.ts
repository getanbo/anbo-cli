import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginContextV1 } from "@getanbo/plugin-sdk";

import { runDeploy } from "../src/deploy.js";
import { PluginEventSink } from "../src/event-sink.js";
import type { CommandExecutor, RuntimeCommandOptions, RuntimeCommandResult } from "../src/runtime/ministack.js";
import { ProjectSupervisor } from "../src/supervisor.js";
import { AnboError, ExitCode, type SandboxManifest } from "../src/types.js";

const manifest: SandboxManifest = {
  schema_version: 2,
  project: { name: "cancellation" },
  terraform: { roots: ["."], variable_files: [] },
  data: {},
  services: {},
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
};

class BlockingExecutor implements CommandExecutor {
  async run(_command: string, _args: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
    return await new Promise<RuntimeCommandResult>((_resolve, reject) => {
      const rejectCancellation = () => reject(options?.signal?.reason ?? new Error("cancelled"));
      if (options?.signal?.aborted === true) {
        rejectCancellation();
        return;
      }
      options?.signal?.addEventListener("abort", rejectCancellation, { once: true });
    });
  }
}

async function waitForOperation(supervisor: ProjectSupervisor): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await supervisor.readState();
    const operationId = state?.active_operation?.operation_id;
    if (operationId !== undefined) return operationId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("deploy did not publish an active operation");
}

test("supervisor cancellation is classified as ANBO_CANCELLED with exit 130", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-supervisor-cancel-"));
  const stateHome = join(directory, "state");
  const runtimeProjectId = "supervisor-cancel-runtime";
  const supervisor = new ProjectSupervisor({
    projectRoot: directory,
    projectId: runtimeProjectId,
    logicalProjectId: manifest.project.name,
    projectName: manifest.project.name,
    stateHome,
  });
  await supervisor.writeState({
    status: "ready",
    services: {
      app: { name: "app", containerName: "anbo-cancellation-app", image: "app:test", ports: {} },
    },
  });
  const context = {
    signal: new AbortController().signal,
    events: { emit: async () => undefined },
  } as unknown as PluginContextV1;

  const deployment = runDeploy({
    root: directory,
    runtimeProjectId,
    manifestPath: join(directory, ".anbo", "sandbox.json"),
    manifest,
    action: "run",
    args: ["sleep", "forever"],
    flags: {},
    env: {},
    stateHome,
    commands: new BlockingExecutor(),
  }, new PluginEventSink(context, "run-supervisor-cancel"));

  const operationId = await waitForOperation(supervisor);
  assert.equal(await supervisor.cancelOperation(operationId, "cancel from CLI"), true);
  await assert.rejects(deployment, (error: unknown) => {
    assert.ok(error instanceof AnboError);
    assert.equal(error.code, "ANBO_CANCELLED");
    assert.equal(error.exitCode, ExitCode.Cancelled);
    return true;
  });

  const state = await supervisor.readState();
  assert.equal(state?.active_operation, undefined);
  assert.equal((state?.last_failure as Record<string, unknown> | undefined)?.["code"], "ANBO_CANCELLED");
});
