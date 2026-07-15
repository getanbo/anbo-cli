import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  deriveRuntimeProjectId,
  FileOperationLock,
  OperationLockedError,
  ProjectSupervisor,
  SecretStateError,
} from "../src/supervisor.js";

test("derives readable checkout-isolated runtime project IDs", () => {
  const first = deriveRuntimeProjectId("OrderFlow", "/worktrees/first/orderflow");
  const repeated = deriveRuntimeProjectId("OrderFlow", "/worktrees/first/orderflow");
  const second = deriveRuntimeProjectId("OrderFlow", "/worktrees/second/orderflow");
  const long = deriveRuntimeProjectId("a".repeat(128), "/worktrees/first/orderflow");

  assert.match(first, /^orderflow-[a-f0-9]{12}$/);
  assert.equal(repeated, first);
  assert.notEqual(second, first);
  assert.equal(long.length, 48);
});

test("enforces one operation lock and recovers a stale dead-owner lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-supervisor-"));
  const lockPath = join(root, "operation.lock");
  const first = await FileOperationLock.acquire(lockPath, {
    operationId: "op_first",
    kind: "deploy",
    projectRoot: root,
  });
  await assert.rejects(
    FileOperationLock.acquire(lockPath, {
      operationId: "op_second",
      kind: "deploy",
      projectRoot: root,
      staleLockMs: 250,
    }),
    OperationLockedError,
  );
  await first.release();

  const old = new Date(Date.now() - 5_000);
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schema_version: 1,
      operation_id: "op_dead",
      kind: "deploy",
      pid: 999_999_999,
      project_root: root,
      created_at: old.toISOString(),
      heartbeat_at: old.toISOString(),
    })}\n`,
  );
  await utimes(lockPath, old, old);
  const recovered = await FileOperationLock.acquire(lockPath, {
    operationId: "op_recovered",
    kind: "deploy",
    projectRoot: root,
    staleLockMs: 250,
  });
  await recovered.release();
});

test("persists secret-free state and rejects credential material", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "anbo-supervisor-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "anbo-project-"));
  const supervisor = new ProjectSupervisor({
    projectRoot,
    stateHome,
    logicalProjectId: "notes",
    projectName: "Notes",
  });

  await supervisor.writeState({ clone_id: "clone-123", credential_ref: "env://ANBO_TOKEN" });
  const state = await supervisor.readState();
  assert.equal(state?.clone_id, "clone-123");
  assert.equal(state?.logical_project_id, "notes");
  assert.equal(state?.project_name, "Notes");
  await assert.rejects(
    supervisor.writeState({ password: "plaintext" }),
    SecretStateError,
  );
});

test("rejects state that belongs to another checkout", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "anbo-supervisor-"));
  const firstRoot = await mkdtemp(join(tmpdir(), "anbo-project-first-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "anbo-project-second-"));
  const first = new ProjectSupervisor({ projectRoot: firstRoot, projectId: "shared-runtime", stateHome });
  const second = new ProjectSupervisor({ projectRoot: secondRoot, projectId: "shared-runtime", stateHome });

  await first.writeState({ status: "ready" });
  await assert.rejects(second.readState(), /belongs to shared-runtime at .* not shared-runtime at/);
});

test("supports persisted operation cancellation", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "anbo-supervisor-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "anbo-project-"));
  const supervisor = new ProjectSupervisor({ projectRoot, stateHome });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  const operation = supervisor.runOperation({ kind: "deploy", operationId: "op_cancel" }, async ({ signal }) => {
    notifyStarted();
    await new Promise<void>((resolveAborted) => signal.addEventListener("abort", () => resolveAborted(), { once: true }));
    return signal.aborted;
  });
  await started;
  assert.equal(await supervisor.cancelOperation("op_cancel", "test cancellation"), true);
  assert.equal(await operation, true);
  assert.equal((await supervisor.readState())?.active_operation, undefined);
});

test("replays and filters structured service logs", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "anbo-supervisor-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "anbo-project-"));
  await mkdir(projectRoot, { recursive: true });
  const supervisor = new ProjectSupervisor({ projectRoot, stateHome });
  supervisor.redactor.registerSecret("lease-secret");
  await supervisor.appendServiceLog("api", "started lease-secret");
  await supervisor.appendServiceLog("worker", "ready");

  const entries = [];
  for await (const entry of supervisor.followServiceLogs({ service: "api", from: "start", follow: false })) {
    entries.push(entry);
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.service, "api");
  assert.doesNotMatch(entries[0]?.message ?? "", /lease-secret/);
});
