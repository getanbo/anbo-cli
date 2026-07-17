import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginContextV1 } from "@getanbo/plugin-sdk";

import { runDeploy } from "../src/deploy.js";
import { PluginEventSink } from "../src/event-sink.js";
import {
  createProjectImpactGraph,
  emptyImpactLedger,
  fingerprintValue,
  planImpact,
  updateImpactLedger,
  writeImpactLedger,
} from "../src/impact/index.js";
import type {
  CommandExecutor,
  RuntimeCommandOptions,
  RuntimeCommandResult,
} from "../src/runtime/ministack.js";
import { ProjectSupervisor } from "../src/supervisor.js";
import type { SandboxManifest } from "../src/types.js";

const DIGEST_A: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const DIGEST_B: `sha256:${string}` = `sha256:${"b".repeat(64)}`;
const ATTESTATION_DOMAIN = "anbo.verification.attestation.v1";

class FailingTestExecutor implements CommandExecutor {
  async run(
    _command: string,
    args: readonly string[],
    _options?: RuntimeCommandOptions,
  ): Promise<RuntimeCommandResult> {
    if (args[0] === "exec") {
      return { code: 1, stdout: "assertion failed\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

function eventSink(): PluginEventSink {
  return new PluginEventSink({
    signal: new AbortController().signal,
    events: { emit: async () => undefined },
  } as unknown as PluginContextV1, `test_${Math.random().toString(36).slice(2)}`);
}

function manifest(): SandboxManifest {
  return {
    schema_version: 2,
    project: { name: "attestation-test" },
    terraform: { roots: ["."], variable_files: [] },
    data: {},
    services: {
      runner: { image: "runner:test" },
    },
    builds: {},
    tests: {
      smoke: {
        command: ["node", "smoke.mjs"],
        service: "runner",
        default: true,
        inputs: ["smoke.mjs"],
      },
    },
    ministack: {
      image: "ministackorg/ministack:1.4.2-full",
      digest: DIGEST_A,
      profile: "full",
      persistence: true,
    },
    network: { allow_hosts: [], clone_egress: false },
    adapters: {},
  };
}

function runtimeState(attestation: Record<string, unknown>) {
  return {
    status: "ready",
    deployment: {
      status: "ready",
      phase: "complete",
      completed_at: "2026-07-17T00:00:00.000Z",
      run_id: "deploy-run",
    },
    verification: {
      status: "passed",
      mode: "full",
      run_id: "verify-run",
      completed_at: "2026-07-17T00:01:00.000Z",
      tests: { smoke: { passed: true, code: 0 } },
      attestation,
    },
    ministack: {
      container_name: "anbo-attestation-runtime-ministack",
      runtime_generation: "generation-1",
      network_name: "anbo-attestation-runtime-control",
      runtime_network_name: "anbo-attestation-runtime-runtime",
      host_endpoint: "http://127.0.0.1:4566",
      container_endpoint: "http://anbo-attestation-runtime-ministack:4566",
      image: "ministackorg/ministack:1.4.2-full",
    },
    terraform: {
      outputs: {},
      roots: ["."],
      reconciliation: { fingerprint: DIGEST_B },
    },
    services: {
      runner: {
        name: "runner",
        containerName: "anbo-attestation-runtime-runner",
        image: "runner:test",
        ports: {},
      },
    },
    clones: {},
  };
}

test("a failed test purges a prior full-verification attestation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-attestation-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const stateHome = join(directory, "state");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "main.tf"), "output \"ready\" { value = true }\n");
  await writeFile(join(project, "smoke.mjs"), "process.exit(1);\n");
  const projectManifest = manifest();
  const supervisor = new ProjectSupervisor({
    projectRoot: project,
    projectId: "attestation-runtime",
    logicalProjectId: projectManifest.project.name,
    projectName: projectManifest.project.name,
    stateHome,
  });
  await supervisor.writeState(runtimeState({
    schema_version: 1,
    mode: "full",
    run_id: "verify-run",
    completed_at: "2026-07-17T00:01:00.000Z",
    graph_fingerprint: DIGEST_A,
    plan_fingerprint: DIGEST_A,
    tests: ["smoke"],
    digest: DIGEST_A,
  }));

  await assert.rejects(runDeploy({
    root: project,
    runtimeProjectId: "attestation-runtime",
    manifestPath: join(project, ".anbo", "sandbox.json"),
    manifest: projectManifest,
    action: "test",
    args: ["smoke"],
    flags: {},
    env: {},
    stateHome,
    commands: new FailingTestExecutor(),
  }, eventSink()), /test smoke failed/);

  const state = await supervisor.readState() as Record<string, unknown>;
  const verification = state["verification"] as Record<string, unknown>;
  assert.equal(state["status"], "ready");
  assert.equal((state["deployment"] as Record<string, unknown>)["status"], "ready");
  assert.equal(verification["status"], "failed");
  assert.equal("attestation" in verification, false);
  assert.equal("completed_at" in verification, false);
  assert.equal((verification["failed_tests"] as string[]).includes("smoke"), true);
  assert.equal((await readFile(supervisor.statePath, "utf8")).includes("\"attestation\""), false);
});

test("impact validates passed state, graph, digest, and successful ledger evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-attestation-validity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const stateHome = join(directory, "state");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "main.tf"), "output \"ready\" { value = true }\n");
  await writeFile(join(project, "smoke.mjs"), "process.exit(0);\n");
  const projectManifest = manifest();
  const graph = await createProjectImpactGraph({
    root: project,
    manifest: projectManifest,
    runtimeGeneration: "generation-1",
  });
  const coldPlan = planImpact(graph, emptyImpactLedger(), { mode: "cold" });
  const ledger = updateImpactLedger(
    emptyImpactLedger(),
    graph,
    coldPlan.executionOrder.map((id) => ({
      id,
      status: "succeeded" as const,
      effectiveFingerprint: coldPlan.items.get(id)!.effectiveFingerprint,
    })),
    { updatedAt: "2026-07-17T00:00:00.000Z" },
  );
  const fullPlan = planImpact(graph, ledger, { mode: "full" });
  const attestationBody = {
    schema_version: 1,
    mode: "full",
    run_id: "verify-run",
    completed_at: "2026-07-17T00:01:00.000Z",
    graph_fingerprint: graph.fingerprint,
    plan_fingerprint: fullPlan.fingerprint,
    runtime_generation: "generation-1",
    terraform_fingerprint: DIGEST_B,
    tests: ["smoke"],
  } as const;
  const attestation = {
    ...attestationBody,
    digest: fingerprintValue(attestationBody, ATTESTATION_DOMAIN),
  };
  const supervisor = new ProjectSupervisor({
    projectRoot: project,
    projectId: "attestation-runtime",
    logicalProjectId: projectManifest.project.name,
    projectName: projectManifest.project.name,
    stateHome,
  });
  await supervisor.writeState(runtimeState(attestation));
  await writeImpactLedger(join(supervisor.stateDirectory, "impact-v1.json"), ledger);

  const impact = async () => await runDeploy({
    root: project,
    runtimeProjectId: "attestation-runtime",
    manifestPath: join(project, ".anbo", "sandbox.json"),
    manifest: projectManifest,
    action: "impact",
    args: [],
    flags: {},
    env: {},
    stateHome,
  }, eventSink());

  const valid = (await impact())["attestation"] as Record<string, unknown>;
  assert.equal(valid["valid"], true);
  assert.equal("invalid_reasons" in valid, false);

  await supervisor.writeState({
    ...runtimeState(attestation),
    verification: {
      ...(runtimeState(attestation).verification as Record<string, unknown>),
      status: "failed",
    },
  });
  const failed = (await impact())["attestation"] as Record<string, unknown>;
  assert.equal(failed["valid"], false);
  assert.ok((failed["invalid_reasons"] as string[]).includes("verification_not_passed"));

  await supervisor.writeState(runtimeState({ ...attestation, digest: DIGEST_A }));
  const corrupted = (await impact())["attestation"] as Record<string, unknown>;
  assert.equal(corrupted["valid"], false);
  assert.ok((corrupted["invalid_reasons"] as string[]).includes("attestation_digest_mismatch"));

  await supervisor.writeState(runtimeState(attestation));
  const failedLedger = updateImpactLedger(ledger, graph, [{
    id: "test:smoke",
    status: "failed",
    effectiveFingerprint: fullPlan.items.get("test:smoke")!.effectiveFingerprint,
  }], { updatedAt: "2026-07-17T00:02:00.000Z" });
  await writeImpactLedger(join(supervisor.stateDirectory, "impact-v1.json"), failedLedger);
  const ledgerFailure = (await impact())["attestation"] as Record<string, unknown>;
  assert.equal(ledgerFailure["valid"], false);
  assert.ok((ledgerFailure["invalid_reasons"] as string[]).includes("impact_test_not_succeeded:smoke"));

  await writeImpactLedger(join(supervisor.stateDirectory, "impact-v1.json"), ledger);
  await writeFile(join(project, "main.tf"), "output \"ready\" { value = false }\n");
  const changed = (await impact())["attestation"] as Record<string, unknown>;
  assert.equal(changed["valid"], false);
  assert.ok((changed["invalid_reasons"] as string[]).includes("graph_fingerprint_mismatch"));
});
