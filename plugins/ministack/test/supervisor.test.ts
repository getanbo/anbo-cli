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

test("recovers dead, zombie, and reused-PID operation leases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anbo-supervisor-leases-"));
  const now = new Date();
  const future = new Date(now.getTime() + 60_000).toISOString();
  const cases = [
    {
      name: "dead owner",
      processStartTime: "owner-start",
      leaseExpiresAt: future,
      inspection: { alive: false, zombie: false },
    },
    {
      name: "zombie owner",
      processStartTime: "owner-start",
      leaseExpiresAt: future,
      inspection: { alive: true, zombie: true, processStartTime: "owner-start" },
    },
    {
      name: "reused PID",
      processStartTime: "previous-process-start",
      leaseExpiresAt: future,
      inspection: { alive: true, zombie: false, processStartTime: "replacement-process-start" },
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const lockPath = join(root, `operation-${index}.lock`);
      await writeFile(
        lockPath,
        `${JSON.stringify({
          schema_version: 2,
          operation_id: `op_abandoned_${index}`,
          kind: "deploy",
          pid: 424_242,
          project_root: root,
          created_at: now.toISOString(),
          heartbeat_at: now.toISOString(),
          process_start_time: scenario.processStartTime,
          lease_expires_at: scenario.leaseExpiresAt,
        })}\n`,
      );

      const recovered = await FileOperationLock.acquire(lockPath, {
        operationId: `op_recovered_${index}`,
        kind: "deploy",
        projectRoot: root,
        inspectProcess: async () => scenario.inspection,
      });
      assert.equal(recovered.metadata.schema_version, 2);
      assert.equal(recovered.metadata.operation_id, `op_recovered_${index}`);
      assert.equal(typeof recovered.metadata.process_start_time, "string");
      assert.equal(typeof recovered.metadata.lease_expires_at, "string");
      await recovered.release();
    });
  }
});

test("does not steal an expired lease from the same live process generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-supervisor-live-lease-"));
  const lockPath = join(root, "operation.lock");
  const now = new Date();
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schema_version: 2,
      operation_id: "op_live",
      kind: "deploy",
      pid: 424_242,
      project_root: root,
      created_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      process_start_time: "owner-start",
      lease_expires_at: new Date(now.getTime() - 1_000).toISOString(),
    })}\n`,
  );

  await assert.rejects(
    FileOperationLock.acquire(lockPath, {
      operationId: "op_contender",
      kind: "deploy",
      projectRoot: root,
      inspectProcess: async () => ({
        alive: true,
        zombie: false,
        processStartTime: "owner-start",
      }),
    }),
    OperationLockedError,
  );
});

test("observational operations remain available while a mutation owns the project lease", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "anbo-supervisor-observe-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "anbo-project-observe-"));
  const supervisor = new ProjectSupervisor({ projectRoot, stateHome });
  let notifyStarted!: () => void;
  let finishMutation!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  const held = new Promise<void>((resolveHeld) => {
    finishMutation = resolveHeld;
  });
  const mutation = supervisor.runOperation(
    { kind: "deploy", operationId: "op_mutation" },
    async () => {
      notifyStarted();
      await held;
      return "deployed";
    },
  );

  await started;
  try {
    for (const kind of ["status", "logs", "debug", "capabilities", "impact"]) {
      const observed = await supervisor.runOperation(
        { kind, operationId: `op_${kind}` },
        async () => kind,
      );
      assert.equal(observed, kind);
      assert.equal((await supervisor.readState())?.active_operation?.operation_id, "op_mutation");
    }

    const cacheInspection = await supervisor.runOperation(
      { kind: "cache", operationId: "op_cache_inspect", lockMode: "observational" },
      async () => "cache",
    );
    assert.equal(cacheInspection, "cache");
    assert.equal((await supervisor.readState())?.active_operation?.operation_id, "op_mutation");

    await assert.rejects(
      supervisor.runOperation({ kind: "test", operationId: "op_second_mutation" }, async () => undefined),
      OperationLockedError,
    );
    await assert.rejects(
      supervisor.runOperation({ kind: "cache", operationId: "op_cache_prune" }, async () => undefined),
      OperationLockedError,
    );
    await assert.rejects(
      supervisor.runOperation(
        { kind: "status", operationId: "op_forced_exclusive", lockMode: "exclusive" },
        async () => undefined,
      ),
      OperationLockedError,
    );
  } finally {
    finishMutation();
  }

  assert.equal(await mutation, "deployed");
  assert.equal((await supervisor.readState())?.active_operation, undefined);
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

  await supervisor.writeState({
    clone_id: "clone-123",
    credential_ref: "env://ANBO_TOKEN",
    resource_ids: {
      secret: "arn:aws:secretsmanager:us-east-1:000000000000:secret:notes-application-123456",
    },
  });
  const state = await supervisor.readState();
  assert.equal(state?.clone_id, "clone-123");
  assert.equal(
    (state?.resource_ids as { secret?: string } | undefined)?.secret,
    "arn:aws:secretsmanager:us-east-1:000000000000:secret:notes-application-123456",
  );
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
