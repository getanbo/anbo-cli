import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { getCapabilityReport } from "./capabilities.js";
import { invokeAdapter, type AdapterResponse } from "./adapters.js";
import type { PluginEventSink } from "./event-sink.js";
import { spawnStreaming } from "./process.js";
import {
  assertSecretFree,
  deriveRuntimeProjectId,
  OperationLockedError,
  ProjectSupervisor,
  type SupervisorState,
} from "./supervisor.js";
import { routeTerraformVariableFiles } from "./terraform-layout.js";
import {
  AnboError,
  ExitCode,
  type DeployRequest,
  type RunSummary,
} from "./types.js";
import { buildDeclaredImages, pruneBuildCache, type BuildResult } from "./runtime/cache.js";
import {
  AmbiguousCloneCreateError,
  acquireConfiguredClones,
  purgeOwnedClones,
  readCloneState,
  resetOwnedClones,
  resolveSecretReference,
  type CloneLease,
} from "./runtime/clones.js";
import {
  ProcessCommandExecutor,
  safeProjectId,
  startMiniStack,
  stopMiniStack,
  type MiniStackRuntime,
} from "./runtime/ministack.js";
import {
  ensureApplicationNetwork,
  refreshRuntimeBoundServices,
  resolveServiceEnvironment,
  runConfiguredTests,
  runtimeBoundServiceNames,
  startDeclaredServices,
  stopDeclaredServices,
  type RunningService,
  type ServiceRuntimeContext,
} from "./runtime/services.js";
import {
  removeProjectTerraformWorkers,
  runTerraform,
  TerraformPhaseError,
  type TerraformChangeSummary,
  type TerraformLifecycleEvent,
  type TerraformRunResult,
} from "./runtime/terraform.js";
import {
  TERRAFORM_RECONCILIATION_SCHEMA_VERSION,
  aggregateTerraformReconciliationFingerprint,
  stableJson,
  terraformReconciliationFingerprint,
  terraformRootStateKey,
  terraformStateMetadata,
  type TerraformStateMetadata,
} from "./runtime/terraform-reconciliation.js";
import { injectLambdaCloneBindings } from "./runtime/lambda-overlays.js";
import { isSensitiveKey } from "./redaction.js";

interface PersistedRuntimeState extends SupervisorState {
  status?: string;
  last_run_id?: string;
  ministack?: {
    container_name: string;
    container_id?: string;
    runtime_generation?: string;
    network_name: string;
    runtime_network_name?: string;
    host_endpoint: string;
    container_endpoint: string;
    image: string;
  };
  terraform?: {
    outputs: Record<string, unknown>;
    roots: string[];
    pending_roots?: string[];
    reconciliation?: PersistedTerraformReconciliation;
  };
  services?: Record<string, RunningService>;
  clones?: Record<string, unknown>;
  last_failure?: {
    code: string;
    message: string;
    remediation: string;
    phase: string;
  };
}

interface PersistedTerraformRootReconciliation {
  index: number;
  root: string;
  state_key: string;
  fingerprint: string;
  state?: TerraformStateMetadata;
  outputs: Record<string, unknown>;
}

interface PersistedTerraformReconciliation {
  schema_version: typeof TERRAFORM_RECONCILIATION_SCHEMA_VERSION;
  fingerprint: string;
  runtime_container_id?: string;
  runtime_generation?: string;
  roots: PersistedTerraformRootReconciliation[];
}

interface TerraformRootDecision extends PersistedTerraformRootReconciliation {
  skipped: boolean;
  reconciled: boolean;
  reason: string;
}

interface TerraformDeployResult extends TerraformRunResult {
  skipped: boolean;
  reconciled: boolean;
  reason: string;
  fingerprint: string;
  reconciliation: PersistedTerraformReconciliation;
  rootDecisions: TerraformRootDecision[];
}

const defaultCommands = new ProcessCommandExecutor();
const DEFAULT_TERRAFORM_WORKER = "hashicorp/terraform:1.15.7@sha256:40e61a86763083ea987ded0ffa15f6d75e0df48ed16275811f949b3ecbcd8aae";
const TERRAFORM_FINGERPRINT_MATCH = "terraform_reconciliation_fingerprint_match";
const TERRAFORM_RECONCILE_REQUESTED = "terraform_reconcile_requested";

export async function runDeploy(request: DeployRequest, sink: PluginEventSink): Promise<RunSummary> {
  const logicalProjectId = request.manifest.project.id ?? request.manifest.project.name;
  const projectId = request.runtimeProjectId ?? deriveRuntimeProjectId(logicalProjectId, request.root);
  const stateHome = request.stateHome ?? request.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  const cacheHome = request.cacheHome ?? request.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  const supervisor = new ProjectSupervisor({
    projectRoot: request.root,
    projectId,
    logicalProjectId,
    projectName: request.manifest.project.name,
    stateHome,
  });
  registerDeclaredEnvironmentSecrets(request, sink);
  const stopHeartbeat = sink.startHeartbeat({ phase: request.action, source: "anbo.supervisor", intervalMs: 5_000 });
  let phase = "startup";
  try {
    const summary = await supervisor.runOperation({
      kind: request.action,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, async (operation) => {
      try {
        phase = request.action;
        switch (request.action) {
          case "deploy":
            return await deploySandbox(request, supervisor, sink, operation.signal, cacheHome, false, (next) => { phase = next; });
          case "reset":
            return await deploySandbox(request, supervisor, sink, operation.signal, cacheHome, true, (next) => { phase = next; });
          case "test":
            return await testExistingSandbox(request, supervisor, sink, operation.signal, (next) => { phase = next; });
          case "run":
            return await runInSandbox(request, supervisor, sink, operation.signal);
          case "down":
            return await downSandbox(request, supervisor, sink, operation.signal);
          case "status":
            return await statusSandbox(supervisor, sink);
          case "logs":
            return await logsSandbox(request, supervisor, sink, operation.signal);
          case "debug":
            return await debugRun(request, supervisor, sink, operation.signal);
          case "capabilities":
            return { action: "capabilities", status: "succeeded", capabilities: getCapabilityReport() } satisfies RunSummary;
          case "cache":
            return await cacheCommand(request, projectId, cacheHome, operation.signal);
        }
      } catch (cause) {
        const classified = classifyRuntimeError(cause, phase, operation.signal);
        const failurePhase = classified.details?.phase ?? phase;
        const error = new AnboError(classified.message, {
          exitCode: classified.exitCode,
          code: classified.code,
          cause: classified,
          details: {
            ...classified.details,
            phase: failurePhase,
            evidence: classified.details?.evidence ?? { phase: failurePhase },
          },
        });
        const observational = request.action === "status" || request.action === "logs" || request.action === "debug" ||
          request.action === "capabilities" || request.action === "cache";
        if (!observational) {
          const current = await supervisor.readState<PersistedRuntimeState>().catch(() => undefined);
          const runtimeInvalidated = request.action === "deploy" || request.action === "reset" || request.action === "down";
          await supervisor.writeState({
            ...(current ?? {}),
            ...(runtimeInvalidated ? { status: "failed" } : {}),
            last_operation: { action: request.action, status: "failed", phase: failurePhase },
            last_run_id: sink.runId,
            last_failure: {
              code: error.code,
              message: sink.redactor.redactString(error.message),
              remediation: error.details?.remediation ?? remediationForPhase(phase),
              phase: failurePhase,
            },
          }).catch(() => undefined);
        }
        throw error;
      }
    });
    return summary;
  } catch (cause) {
    throw classifyRuntimeError(cause, phase, request.signal);
  } finally {
    stopHeartbeat();
  }
}

async function deploySandbox(
  request: DeployRequest,
  supervisor: ProjectSupervisor,
  sink: PluginEventSink,
  signal: AbortSignal,
  cacheHome: string,
  resetting: boolean,
  reportPhase: (phase: string) => void,
): Promise<RunSummary> {
  const projectId = supervisor.projectId;
  if (resetting) {
    reportPhase("reset");
    const phase = await sink.startPhase("reset runtime", "anbo.runtime");
    await invokeAdaptersForAction(request, sink, signal, "reset", {});
    await stopDeclaredServices(projectId, request.commands ?? defaultCommands, signal);
    if (request.flags["fresh-clones"] === true && (request.manifest.data.postgres?.provider === "anbo-cloud" || request.manifest.data.dynamodb?.provider === "anbo-cloud")) {
      const apiUrl = requiredEnvironment(request.env, "ANBO_API_URL");
      await resetOwnedClones({
        projectId,
        statePath: join(supervisor.stateDirectory, "clones.json"),
        environment: request.env,
        apiUrl,
        tokenReference: "env://ANBO_TOKEN",
        ...(request.manifest.data.postgres === undefined ? {} : { postgres: request.manifest.data.postgres }),
        ...(request.manifest.data.dynamodb === undefined ? {} : { dynamodb: request.manifest.data.dynamodb }),
        signal,
      }, {
        ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
        registerSecret: (secret) => sink.redactor.registerSecret(secret),
        ...(request.resolveSecret === undefined ? {} : { resolveSecret: request.resolveSecret }),
      });
    }
    await phase.finish();
  }

  reportPhase("infrastructure");
  const infrastructurePhase = await sink.startPhase("local infrastructure", "ministack");
  const infrastructureAbort = new AbortController();
  const infrastructureSignal = AbortSignal.any([signal, infrastructureAbort.signal]);
  let firstInfrastructureFailure: { phase: "ministack" | "clone" | "build"; cause: unknown } | undefined;
  const branch = <T>(phase: "ministack" | "clone" | "build", run: () => Promise<T>): Promise<T> => run().catch((cause: unknown) => {
    if (firstInfrastructureFailure === undefined && !signal.aborted) {
      firstInfrastructureFailure = { phase, cause };
      infrastructureAbort.abort(cause);
    }
    throw cause;
  });
  const miniStackPromise = branch("ministack", async () => await startMiniStack({
    projectId,
    image: request.manifest.ministack.image,
    ...(request.manifest.ministack.digest === undefined ? {} : { digest: request.manifest.ministack.digest }),
    persistence: request.manifest.ministack.persistence,
    stateRoot: supervisor.stateDirectory,
    environment: request.manifest.ministack.environment,
  }, {
    signal: infrastructureSignal,
    commands: request.commands ?? defaultCommands,
    redact: (text) => sink.redactor.redactString(text),
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
  }));
  // Cloud clone creation cannot be safely interrupted by a sibling failure: a
  // POST may succeed after its client is aborted. The clone runtime persists
  // branch ownership first, then the infrastructure signal can stop polling.
  const clonePromise = branch("clone", async () => await acquireRequestClones(
    request,
    supervisor,
    sink,
    signal,
    infrastructureSignal,
  ));
  const buildPromise = branch("build", async () => await buildDeclaredImages({
    projectId,
    root: request.root,
    builds: request.manifest.builds,
    cacheRoot: join(cacheHome, "anbo", "v2", "buildkit"),
    signal: infrastructureSignal,
  }, {
    commands: request.commands ?? defaultCommands,
    onOutput: async (build, stream, text) => { await sink.processOutput({ phase: "build", source: "buildkit", service: build, stream, chunk: text }); },
  }));
  let miniStack: MiniStackRuntime;
  let clones: Record<string, CloneLease>;
  let builds: Record<string, BuildResult>;
  try {
    [miniStack, clones, builds] = await Promise.all([miniStackPromise, clonePromise, buildPromise]);
  } catch (cause) {
    infrastructureAbort.abort(cause);
    await Promise.allSettled([miniStackPromise, clonePromise, buildPromise]);
    const failure = firstInfrastructureFailure ?? { phase: "infrastructure" as const, cause };
    reportPhase(failure.phase);
    throw classifyRuntimeError(failure.cause, failure.phase, signal);
  }
  if (resetting) {
    const response = await (request.fetch ?? globalThis.fetch)(`${miniStack.hostEndpoint}/_ministack/reset`, { method: "POST", signal });
    if (!response.ok) throw new Error(`MiniStack reset failed with HTTP ${response.status}`);
    await rm(join(supervisor.stateDirectory, "terraform"), { recursive: true, force: true });
    await sink.emit({
      kind: "progress",
      phase: "ministack.reset",
      source: "ministack",
      level: "info",
      message: "MiniStack state reset",
      redacted: true,
    });
  }
  await infrastructurePhase.finish("local infrastructure ready", {
    endpoint: miniStack.hostEndpoint,
    selected_platform: miniStack.platform,
    server_platform: miniStack.serverPlatform ?? "explicit",
    clone_count: Object.keys(clones).length,
    build_cache_hits: Object.fromEntries(Object.entries(builds).map(([name, result]) => [name, result.cacheHit])),
    build_engines: Object.fromEntries(Object.entries(builds).map(([name, result]) => [
      name,
      result.cacheHit ? "cache" : result.metadata["build_engine"] ?? "command",
    ])),
  });

  reportPhase("terraform");
  const terraformPhase = await sink.startPhase("Terraform deploy", "terraform");
  const terraform = await applyTerraformRoots(request, supervisor, miniStack, signal, sink, cacheHome);
  await terraformPhase.finish(terraform.skipped ? "Terraform unchanged" : "Terraform reconciled", {
    changes: terraform.changes,
    skipped: terraform.skipped,
    reconciled: terraform.reconciled,
    reason: terraform.reason,
    roots: terraform.rootDecisions.map(terraformRootDecisionSummary),
  });

  reportPhase("lambda");
  const lambdaPhase = await sink.startPhase("Lambda clone bindings", "ministack.lambda");
  const lambdaOverlays = await injectLambdaCloneBindings(miniStack.hostEndpoint, clones, {
    signal,
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
  });
  await lambdaPhase.finish("Lambda clone bindings ready", {
    inspected: lambdaOverlays.inspected,
    updated: lambdaOverlays.updated,
  });

  reportPhase("adapter");
  const adapterPhase = await sink.startPhase("extension adapters", "adapter");
  const adapters = await acquireAdapters(request, sink, signal, {
    ministack_endpoint: miniStack.hostEndpoint,
    terraform_outputs: terraform.outputs,
    clone_engines: Object.keys(clones),
  });
  await adapterPhase.finish("extension adapters ready", { adapters: Object.keys(adapters) });

  reportPhase("service");
  const servicesPhase = await sink.startPhase("application services", "docker");
  const appNetwork = await ensureApplicationNetwork(projectId, miniStack.containerName, request.commands ?? defaultCommands);
  const serviceContext: ServiceRuntimeContext = {
    runId: sink.runId,
    projectId,
    networkName: appNetwork,
    miniStackEndpoint: miniStack.containerEndpoint,
    terraformOutputs: terraform.outputs,
    clones,
    builds,
    environment: request.env,
    adapterBindings: Object.fromEntries(Object.entries(adapters).map(([name, response]) => [name, response.bindings])),
    signal,
  };
  const services = await startDeclaredServices(request.manifest.services, serviceContext, {
    commands: request.commands ?? defaultCommands,
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
    onStatus: (service, status) => void sink.emit({ kind: "service.status", phase: "services", source: "docker", service, level: "info", message: `${service} ${status}`, fields: { status } }),
  });
  await servicesPhase.finish("application services ready", { services: Object.keys(services) });

  let tests: Record<string, { passed: boolean; code: number }> = {};
  if (request.flags.test !== false && request.flags["no-test"] !== true) {
    reportPhase("test");
    const testPhase = await sink.startPhase("default smoke tests", "smoke");
    tests = await runConfiguredTests(request.manifest.tests, [], serviceContext, services, {
      commands: request.commands ?? defaultCommands,
      ...configuredTestFeedback(sink),
    });
    for (const [name, result] of Object.entries(tests)) await sink.assertion({ name, passed: result.passed, actual: result.code }, { testId: name });
    await testPhase.finish("default smoke tests passed", { tests: Object.keys(tests) });
  }

  reportPhase("state");
  const cloneState = await readCloneState(join(supervisor.stateDirectory, "clones.json"));
  await supervisor.writeState({
    status: "ready",
    last_run_id: sink.runId,
    ministack: persistedMiniStack(miniStack),
    terraform: {
      outputs: terraform.outputs,
      roots: [...request.manifest.terraform.roots],
      reconciliation: terraform.reconciliation,
    },
    services,
    clones: cloneState?.clones ?? {},
  });
  return {
    action: resetting ? "reset" : "deploy",
    status: "succeeded",
    project: {
      name: request.manifest.project.name,
      logical_id: request.manifest.project.id ?? request.manifest.project.name,
      runtime_id: projectId,
    },
    topology: "hybrid",
    ministack: persistedMiniStack(miniStack),
    endpoints: {
      aws: miniStack.hostEndpoint,
      terraform: terraform.outputs,
      services: Object.fromEntries(Object.entries(services).map(([name, service]) => [name, {
        ports: Object.fromEntries(Object.entries(service.ports).map(([containerPort, hostPort]) => [
          containerPort,
          { host: "127.0.0.1", host_port: hostPort, address: `127.0.0.1:${hostPort}` },
        ])),
      }])),
    },
    clones: cloneState?.clones ?? {},
    builds: Object.fromEntries(Object.entries(builds).map(([name, result]) => [name, {
      cache_hit: result.cacheHit,
      fingerprint: result.fingerprint,
      ...(result.image === undefined ? {} : { image: result.image }),
    }])),
    terraform_changes: terraform.changes,
    terraform_reconciliation: {
      skipped: terraform.skipped,
      reconciled: terraform.reconciled,
      reason: terraform.reason,
      roots: terraform.rootDecisions.map(terraformRootDecisionSummary),
    },
    lambda_clone_bindings: lambdaOverlays,
    adapters: safeAdapterSummary(adapters),
    services: Object.keys(services),
    tests,
  };
}

async function applyTerraformRoots(
  request: DeployRequest,
  supervisor: ProjectSupervisor,
  miniStack: MiniStackRuntime,
  signal: AbortSignal,
  sink: PluginEventSink,
  cacheHome: string,
): Promise<TerraformDeployResult> {
  const variableFilesByRoot = routeTerraformVariableFiles(
    request.root,
    request.manifest.terraform.roots,
    request.manifest.terraform.variable_files,
  );
  const workerImage = await resolveTerraformWorkerImage(
    request.env["ANBO_TERRAFORM_IMAGE"] ?? DEFAULT_TERRAFORM_WORKER,
    signal,
    request.commands ?? defaultCommands,
  );
  const previousState = await supervisor.readState<PersistedRuntimeState>();
  assertTerraformRootTopologyPreserved(request.root, request.manifest.terraform.roots, previousState);
  const pendingRoots = [...(previousState?.terraform?.pending_roots ?? [])];
  const ownedStateKeys = new Set(
    [...(previousState?.terraform?.roots ?? []), ...pendingRoots]
      .map((root) => terraformRootStateKey(request.root, root)),
  );
  await migrateLegacyTerraformStateDirectories(request.root, supervisor.stateDirectory, previousState);
  const previousReconciliation = parsePersistedTerraformReconciliation(
    previousState,
    request.root,
    request.manifest.terraform.roots,
  );
  const reconcileRequested = request.flags["reconcile"] === true;
  const aggregate: TerraformRunResult = {
    privateDirectory: "",
    planPath: "",
    statePath: "",
    changes: { create: 0, update: 0, delete: 0, replace: 0, noOp: 0 },
    outputs: {},
  };
  const rootDecisions: TerraformRootDecision[] = [];
  for (let index = 0; index < request.manifest.terraform.roots.length; index += 1) {
    const root = request.manifest.terraform.roots[index];
    if (root === undefined) continue;
    const sourceDirectory = resolve(request.root, root);
    const stateKey = terraformRootStateKey(request.root, root);
    const rootStateDirectory = join(supervisor.stateDirectory, "terraform", "roots", stateKey);
    const privateDirectory = join(rootStateDirectory, "workspace");
    const statePath = join(rootStateDirectory, "terraform.tfstate");
    const variableFiles = variableFilesByRoot.get(root) ?? [];
    await emitTerraformLifecycle(sink, root, index, { phase: "terraform.fingerprint", status: "started" });
    const fingerprintStarted = performance.now();
    let fingerprint: string;
    try {
      fingerprint = await terraformReconciliationFingerprint({
        projectDirectory: request.root,
        sourceDirectory,
        excludedPaths: [supervisor.stateDirectory, join(cacheHome, "anbo", "v2")],
        root,
        variableFiles,
        workerImage,
        stateIdentity: { key: stateKey, filename: basename(statePath) },
        miniStack: {
          containerName: miniStack.containerName,
          ...(miniStack.containerId === undefined ? {} : { containerId: miniStack.containerId }),
          ...(miniStack.runtimeGeneration === undefined ? {} : { runtimeGeneration: miniStack.runtimeGeneration }),
          networkName: miniStack.networkName,
          containerEndpoint: miniStack.containerEndpoint,
          image: miniStack.image,
          profile: request.manifest.ministack.profile,
          persistence: request.manifest.ministack.persistence,
          ...(request.manifest.ministack.environment === undefined
            ? {}
            : { environment: request.manifest.ministack.environment }),
        },
        terraform: { region: "us-east-1", accountId: "000000000000" },
      }, {
        treeHashCachePath: join(
          cacheHome,
          "anbo",
          "v2",
          "terraform",
          "fingerprints",
          supervisor.projectId,
          stateKey,
          "tree-v1.json",
        ),
      });
      await emitTerraformLifecycle(sink, root, index, {
        phase: "terraform.fingerprint",
        status: "succeeded",
        durationMs: Math.max(0, Math.round(performance.now() - fingerprintStarted)),
      });
    } catch (cause) {
      await emitTerraformLifecycle(sink, root, index, {
        phase: "terraform.fingerprint",
        status: "failed",
        durationMs: Math.max(0, Math.round(performance.now() - fingerprintStarted)),
      });
      throw cause;
    }
    const currentState = await terraformStateMetadata(statePath);
    const previousRoot = previousReconciliation?.roots[index];
    const skipReason = terraformSkipReason({
      request,
      miniStack,
      reconcileRequested,
      previousReconciliation,
      previousRoot,
      root,
      index,
      fingerprint,
      currentState,
    });

    aggregate.privateDirectory = privateDirectory;
    aggregate.planPath = join(privateDirectory, ".anbo.plan");
    aggregate.statePath = statePath;
    if (skipReason === TERRAFORM_FINGERPRINT_MATCH && previousRoot !== undefined && currentState !== undefined) {
      aggregate.outputs = { ...aggregate.outputs, ...previousRoot.outputs };
      const decision: TerraformRootDecision = {
        ...previousRoot,
        state: currentState,
        fingerprint,
        skipped: true,
        reconciled: false,
        reason: skipReason,
      };
      rootDecisions.push(decision);
      await emitTerraformRootDecision(sink, decision);
      continue;
    }

    if (!ownedStateKeys.has(stateKey)) {
      pendingRoots.push(root);
      ownedStateKeys.add(stateKey);
      await persistPendingTerraformRootOwnership(supervisor, pendingRoots);
    }

    const result = await runTerraform({
      projectId: supervisor.projectId,
      projectDirectory: request.root,
      sourceDirectory,
      privateDirectory,
      statePath,
      pluginCacheDirectory: join(cacheHome, "anbo", "v2", "terraform", "plugins"),
      lockCacheDirectory: join(cacheHome, "anbo", "v2", "terraform", "locks", supervisor.projectId, stateKey),
      excludedPaths: [supervisor.stateDirectory, join(cacheHome, "anbo", "v2")],
      workerImage,
      networkName: miniStack.networkName,
      miniStackEndpoint: miniStack.containerEndpoint,
      variableFiles,
      environment: request.env,
      signal,
    }, {
      commands: request.commands ?? defaultCommands,
      onOutput: async (stream, text, outputPhase) => { await sink.processOutput({ phase: outputPhase, source: "terraform", stream, chunk: text }); },
      onLifecycle: async (event) => { await emitTerraformLifecycle(sink, root, index, event); },
    });
    aggregate.privateDirectory = result.privateDirectory;
    aggregate.planPath = result.planPath;
    aggregate.statePath = result.statePath;
    aggregate.outputs = { ...aggregate.outputs, ...result.outputs };
    for (const key of Object.keys(aggregate.changes) as Array<keyof typeof aggregate.changes>) aggregate.changes[key] += result.changes[key];
    const state = await terraformStateMetadata(statePath);
    const decision: TerraformRootDecision = {
      index,
      root,
      state_key: stateKey,
      fingerprint,
      ...(state === undefined ? {} : { state }),
      outputs: result.outputs,
      skipped: false,
      reconciled: true,
      reason: skipReason,
    };
    rootDecisions.push(decision);
    await emitTerraformRootDecision(sink, decision);
  }
  const reconciliationRoots = rootDecisions.map(persistedTerraformRootDecision);
  const fingerprint = aggregateTerraformReconciliationFingerprint(reconciliationRoots);
  const skipped = rootDecisions.length > 0 && rootDecisions.every((decision) => decision.skipped);
  const reconciled = rootDecisions.some((decision) => decision.reconciled);
  const reason = skipped
    ? TERRAFORM_FINGERPRINT_MATCH
    : reconcileRequested
      ? TERRAFORM_RECONCILE_REQUESTED
      : commonTerraformDecisionReason(rootDecisions);
  return {
    ...aggregate,
    skipped,
    reconciled,
    reason,
    fingerprint,
    reconciliation: {
      schema_version: TERRAFORM_RECONCILIATION_SCHEMA_VERSION,
      fingerprint,
      ...(miniStack.containerId === undefined ? {} : { runtime_container_id: miniStack.containerId }),
      ...(miniStack.runtimeGeneration === undefined ? {} : { runtime_generation: miniStack.runtimeGeneration }),
      roots: reconciliationRoots,
    },
    rootDecisions,
  };
}

function assertTerraformRootTopologyPreserved(
  projectRoot: string,
  configuredRoots: readonly string[],
  previousState: PersistedRuntimeState | undefined,
): void {
  const currentKeys = new Set<string>();
  for (const root of configuredRoots) {
    const key = terraformRootStateKey(projectRoot, root);
    if (currentKeys.has(key)) throw terraformRootTopologyError("the current Terraform root mapping is ambiguous");
    currentKeys.add(key);
  }
  if (previousState?.terraform === undefined) return;
  const previousKeys = new Set<string>();
  for (const [field, roots] of [
    ["roots", previousState.terraform.roots],
    ["pending_roots", previousState.terraform.pending_roots ?? []],
  ] as const) {
    if (!Array.isArray(roots) || !roots.every((root): root is string => typeof root === "string")) {
      throw terraformRootTopologyError(`the previous Terraform ${field} mapping is malformed`);
    }
    for (const root of roots) {
      const key = terraformRootStateKey(projectRoot, root);
      if (previousKeys.has(key)) throw terraformRootTopologyError("the previous Terraform root mapping is ambiguous");
      previousKeys.add(key);
      if (!currentKeys.has(key)) {
        throw terraformRootTopologyError(`previously managed root ${JSON.stringify(root)} is absent from the current configuration`);
      }
    }
  }
}

async function persistPendingTerraformRootOwnership(
  supervisor: ProjectSupervisor,
  pendingRoots: readonly string[],
): Promise<void> {
  const current = await supervisor.readState<PersistedRuntimeState>();
  const terraform = current?.terraform;
  await supervisor.writeState({
    ...(current ?? {}),
    status: current?.status ?? "deploying",
    terraform: {
      ...(terraform ?? {}),
      outputs: terraform?.outputs ?? {},
      roots: terraform?.roots ?? [],
      pending_roots: [...pendingRoots],
    },
  });
}

function terraformRootTopologyError(cause: string): Error {
  return new Error(
    `Cannot safely change the Terraform root topology because ${cause}. ` +
    "Run anbo down --purge, then anbo deploy so removed roots cannot leave unmanaged resources behind.",
  );
}

function terraformSkipReason(input: {
  request: DeployRequest;
  miniStack: MiniStackRuntime;
  reconcileRequested: boolean;
  previousReconciliation: PersistedTerraformReconciliation | undefined;
  previousRoot: PersistedTerraformRootReconciliation | undefined;
  root: string;
  index: number;
  fingerprint: string;
  currentState: TerraformStateMetadata | undefined;
}): string {
  if (input.reconcileRequested) return TERRAFORM_RECONCILE_REQUESTED;
  if (input.request.action !== "deploy") return "terraform_non_deploy_action";
  if (!input.miniStack.reused) return "ministack_runtime_not_reused";
  if (input.miniStack.containerId === undefined) return "ministack_runtime_identity_missing";
  if (input.miniStack.runtimeGeneration === undefined) return "ministack_runtime_generation_missing";
  if (input.previousReconciliation === undefined || input.previousRoot === undefined) {
    return "terraform_reconciliation_metadata_missing";
  }
  if (input.previousReconciliation.runtime_container_id !== input.miniStack.containerId) {
    return "ministack_runtime_identity_changed";
  }
  if (input.previousReconciliation.runtime_generation !== input.miniStack.runtimeGeneration) {
    return "ministack_runtime_generation_changed";
  }
  if (input.previousRoot.index !== input.index || input.previousRoot.root !== input.root) {
    return "terraform_root_identity_changed";
  }
  if (input.previousRoot.fingerprint !== input.fingerprint) return "terraform_reconciliation_fingerprint_changed";
  if (input.previousRoot.state === undefined) return "terraform_state_metadata_missing";
  if (input.currentState === undefined) return "terraform_state_missing";
  if (stableJson(input.previousRoot.state) !== stableJson(input.currentState)) return "terraform_state_metadata_changed";
  return TERRAFORM_FINGERPRINT_MATCH;
}

async function migrateLegacyTerraformStateDirectories(
  projectRoot: string,
  stateDirectory: string,
  previousState: PersistedRuntimeState | undefined,
): Promise<void> {
  const terraformDirectory = join(stateDirectory, "terraform");
  let entries;
  try { entries = await readdir(terraformDirectory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const legacy = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
  if (legacy.length === 0) return;
  const nonCanonical = legacy.find((entry) => !/^(?:0|[1-9]\d*)$/.test(entry.name) || !Number.isSafeInteger(Number(entry.name)));
  if (nonCanonical !== undefined) {
    throw legacyTerraformStateError(`legacy root index ${JSON.stringify(nonCanonical.name)} is not canonical`);
  }
  const previousRoots = previousState?.terraform?.roots;
  if (!Array.isArray(previousRoots) || !previousRoots.every((root): root is string => typeof root === "string")) {
    throw legacyTerraformStateError("the previous Terraform root mapping is missing");
  }
  const stateKeys = new Map<string, number>();
  for (let index = 0; index < previousRoots.length; index += 1) {
    const root = previousRoots[index];
    if (root === undefined) continue;
    const stateKey = terraformRootStateKey(projectRoot, root);
    if (stateKeys.has(stateKey)) throw legacyTerraformStateError("the previous Terraform root mapping is ambiguous");
    stateKeys.set(stateKey, index);
  }
  await mkdir(join(terraformDirectory, "roots"), { recursive: true, mode: 0o700 });
  const moves: Array<{ source: string; destination: string; legacyIndex: number }> = [];
  const destinations = new Set<string>();
  for (const entry of legacy.sort((left, right) => Number(left.name) - Number(right.name))) {
    const legacyIndex = Number(entry.name);
    const root = previousRoots[legacyIndex];
    if (root === undefined) throw legacyTerraformStateError(`legacy root index ${legacyIndex} has no trusted mapping`);
    const destination = join(terraformDirectory, "roots", terraformRootStateKey(projectRoot, root));
    if (destinations.has(destination)) {
      throw legacyTerraformStateError(`legacy root index ${legacyIndex} aliases another state directory`);
    }
    destinations.add(destination);
    if (await pathExists(destination)) {
      throw legacyTerraformStateError(`legacy root index ${legacyIndex} conflicts with an existing stable state directory`);
    }
    moves.push({ source: join(terraformDirectory, entry.name), destination, legacyIndex });
  }
  const completedMoves: Array<{ source: string; destination: string }> = [];
  for (const move of moves) {
    try {
      await rename(move.source, move.destination);
      completedMoves.push(move);
    } catch (cause) {
      for (const completed of completedMoves.reverse()) {
        if (await pathExists(completed.destination)) {
          await rename(completed.destination, completed.source).catch(() => undefined);
        }
      }
      throw cause;
    }
  }
}

function legacyTerraformStateError(cause: string): Error {
  return new Error(
    `Cannot safely migrate legacy Terraform state because ${cause}. ` +
    "Run anbo down --purge, then anbo deploy to create unambiguous state.",
  );
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parsePersistedTerraformReconciliation(
  state: PersistedRuntimeState | undefined,
  projectRoot: string,
  configuredRoots: readonly string[],
): PersistedTerraformReconciliation | undefined {
  if (state?.status !== "ready") return undefined;
  const terraform = state.terraform as unknown;
  if (!isRecord(terraform) || !isRecord(terraform["outputs"]) || !Array.isArray(terraform["roots"])) return undefined;
  if (!sameStringArray(terraform["roots"], configuredRoots)) return undefined;
  const raw = terraform["reconciliation"];
  if (!isRecord(raw) || raw["schema_version"] !== TERRAFORM_RECONCILIATION_SCHEMA_VERSION) return undefined;
  if (!isSha256(raw["fingerprint"]) || typeof raw["runtime_container_id"] !== "string" || raw["runtime_container_id"].length === 0 ||
      typeof raw["runtime_generation"] !== "string" || raw["runtime_generation"].length === 0) {
    return undefined;
  }
  if (state.ministack?.container_id !== raw["runtime_container_id"] ||
      state.ministack?.runtime_generation !== raw["runtime_generation"] ||
      !Array.isArray(raw["roots"]) || raw["roots"].length !== configuredRoots.length) {
    return undefined;
  }
  const roots: PersistedTerraformRootReconciliation[] = [];
  for (let index = 0; index < configuredRoots.length; index += 1) {
    const entry = raw["roots"][index];
    const root = configuredRoots[index];
    if (root === undefined) return undefined;
    const stateKey = terraformRootStateKey(projectRoot, root);
    if (!isRecord(entry) || entry["index"] !== index || entry["root"] !== root ||
        entry["state_key"] !== stateKey || !isSha256(entry["fingerprint"]) || !isRecord(entry["outputs"])) return undefined;
    const stateMetadata = parseTerraformStateMetadata(entry["state"]);
    if (entry["state"] !== undefined && stateMetadata === undefined) return undefined;
    try { assertSecretFree(entry["outputs"]); } catch { return undefined; }
    roots.push({
      index,
      root,
      state_key: stateKey,
      fingerprint: entry["fingerprint"],
      ...(stateMetadata === undefined ? {} : { state: stateMetadata }),
      outputs: entry["outputs"],
    });
  }
  const fingerprint = aggregateTerraformReconciliationFingerprint(roots);
  if (fingerprint !== raw["fingerprint"]) return undefined;
  const outputs = roots.reduce<Record<string, unknown>>((aggregate, root) => ({ ...aggregate, ...root.outputs }), {});
  if (stableJson(outputs) !== stableJson(terraform["outputs"])) return undefined;
  return {
    schema_version: TERRAFORM_RECONCILIATION_SCHEMA_VERSION,
    fingerprint,
    runtime_container_id: raw["runtime_container_id"],
    runtime_generation: raw["runtime_generation"],
    roots,
  };
}

function parseTerraformStateMetadata(value: unknown): TerraformStateMetadata | undefined {
  if (!isRecord(value) || typeof value["size"] !== "number" || !isSha256(value["sha256"])) return undefined;
  if (!Number.isSafeInteger(value["size"]) || value["size"] < 0) {
    return undefined;
  }
  return { size: value["size"], sha256: value["sha256"] };
}

async function emitTerraformLifecycle(
  sink: PluginEventSink,
  root: string,
  index: number,
  event: TerraformLifecycleEvent,
): Promise<void> {
  await sink.emit({
    kind: "progress",
    phase: event.phase,
    source: "terraform",
    level: event.status === "failed" ? "error" : "info",
    message: `${event.phase} ${event.status}`,
    fields: {
      status: event.status,
      root,
      root_index: index,
      ...(event.durationMs === undefined ? {} : { duration_ms: event.durationMs }),
      ...(event.exitCode === undefined ? {} : { exit_code: event.exitCode }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    },
    redacted: true,
  });
}

async function emitTerraformRootDecision(sink: PluginEventSink, decision: TerraformRootDecision): Promise<void> {
  await sink.emit({
    kind: "progress",
    phase: "terraform.reconciliation",
    source: "terraform",
    level: "info",
    message: decision.skipped ? "Terraform root unchanged" : "Terraform root reconciled",
    fields: { status: "succeeded", ...terraformRootDecisionSummary(decision) },
    redacted: true,
  });
}

function persistedTerraformRootDecision(decision: TerraformRootDecision): PersistedTerraformRootReconciliation {
  return {
    index: decision.index,
    root: decision.root,
    state_key: decision.state_key,
    fingerprint: decision.fingerprint,
    ...(decision.state === undefined ? {} : { state: decision.state }),
    outputs: decision.outputs,
  };
}

function terraformRootDecisionSummary(decision: TerraformRootDecision): Record<string, unknown> {
  return {
    root: decision.root,
    root_index: decision.index,
    skipped: decision.skipped,
    reconciled: decision.reconciled,
    reason: decision.reason,
  };
}

function commonTerraformDecisionReason(decisions: readonly TerraformRootDecision[]): string {
  const reasons = new Set(decisions.filter((decision) => decision.reconciled).map((decision) => decision.reason));
  return reasons.size === 1 ? [...reasons][0] ?? "terraform_reconciliation_required" : "terraform_reconciliation_required";
}

function sameStringArray(value: unknown[], expected: readonly string[]): boolean {
  return value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function testExistingSandbox(
  request: DeployRequest,
  supervisor: ProjectSupervisor,
  sink: PluginEventSink,
  signal: AbortSignal,
  reportPhase: (phase: string) => void,
): Promise<RunSummary> {
  const state = await requireReadyState(supervisor);
  const miniStack = state.ministack;
  if (miniStack === undefined) throw new Error("sandbox MiniStack runtime metadata is missing");

  reportPhase("clone");
  const clonePhase = await sink.startPhase("refresh clone credentials", "clone");
  const clones = await acquireRequestClones(request, supervisor, sink, signal);
  await clonePhase.finish("clone credentials refreshed", { clone_engines: Object.keys(clones) });
  const cloneState = await readCloneState(join(supervisor.stateDirectory, "clones.json"));

  reportPhase("lambda");
  const lambdaPhase = await sink.startPhase("refresh Lambda clone bindings", "ministack.lambda");
  const lambdaOverlays = await injectLambdaCloneBindings(miniStack.host_endpoint, clones, {
    signal,
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
  });
  await lambdaPhase.finish("Lambda clone bindings refreshed", {
    inspected: lambdaOverlays.inspected,
    updated: lambdaOverlays.updated,
  });

  reportPhase("adapter");
  const adapters = await invokeAdaptersForAction(request, sink, signal, "test", { selected_test: request.args[0] ?? null });
  let context = runtimeContextFromState(request, state, clones, adapters, signal, sink.runId);
  let services = { ...(state.services ?? {}) };
  let refreshedServices: string[] = [];
  const refreshableServices = runtimeBoundServiceNames(request.manifest.services);
  if (refreshableServices.length > 0) {
    reportPhase("service");
    const servicePhase = await sink.startPhase("refresh runtime-bound services", "docker");
    const appNetwork = await ensureApplicationNetwork(state.project_id, miniStack.container_name, request.commands ?? defaultCommands);
    context = { ...context, networkName: appNetwork };
    const refreshed = await refreshRuntimeBoundServices(request.manifest.services, context, services, {
      commands: request.commands ?? defaultCommands,
      ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
      onStatus: (service, status) => void sink.emit({
        kind: "service.status",
        phase: "services.refresh",
        source: "docker",
        service,
        level: "info",
        message: `${service} ${status}`,
        fields: { status },
      }),
    });
    services = refreshed.running;
    refreshedServices = refreshed.restarted;
    await servicePhase.finish("runtime-bound services refreshed", { services: refreshedServices });
  }
  await supervisor.writeState({
    ...state,
    last_run_id: sink.runId,
    last_failure: undefined,
    services,
    clones: cloneState?.clones ?? {},
  });
  const selected = request.args.length === 0 ? [] : [request.args[0]!];
  reportPhase("test");
  const testPhase = await sink.startPhase("smoke tests", "smoke");
  const tests = await runConfiguredTests(request.manifest.tests, selected, context, services, {
    commands: request.commands ?? defaultCommands,
    ...configuredTestFeedback(sink),
  });
  for (const [name, result] of Object.entries(tests)) {
    await sink.assertion({ name, passed: result.passed, actual: result.code }, { testId: name });
  }
  await testPhase.finish("smoke tests passed", { tests: Object.keys(tests) });
  return {
    action: "test",
    status: "succeeded",
    clone_engines: Object.keys(clones),
    lambda_clone_bindings: lambdaOverlays,
    adapters: safeAdapterSummary(adapters),
    refreshed_services: refreshedServices,
    tests,
  };
}

async function acquireRequestClones(
  request: DeployRequest,
  supervisor: ProjectSupervisor,
  sink: PluginEventSink,
  signal: AbortSignal,
  readinessSignal?: AbortSignal,
): Promise<Partial<Record<"postgres" | "dynamodb", CloneLease>>> {
  const statusEvents: Array<Promise<unknown>> = [];
  try {
    const clones = await acquireConfiguredClones({
      projectId: supervisor.projectId,
      statePath: join(supervisor.stateDirectory, "clones.json"),
      environment: request.env,
      ...(request.manifest.data.postgres === undefined ? {} : { postgres: request.manifest.data.postgres }),
      ...(request.manifest.data.dynamodb === undefined ? {} : { dynamodb: request.manifest.data.dynamodb }),
      ...(request.env["ANBO_API_URL"] === undefined ? {} : { apiUrl: request.env["ANBO_API_URL"] }),
      tokenReference: "env://ANBO_TOKEN",
      signal,
      ...(readinessSignal === undefined ? {} : { readinessSignal }),
    }, {
      ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
      registerSecret: (secret) => sink.redactor.registerSecret(secret),
      ...(request.resolveSecret === undefined ? {} : { resolveSecret: request.resolveSecret }),
      onStatus: (status, metadata) => { statusEvents.push(sink.emit({
        kind: "clone.status", phase: "clones", source: "clone", level: "info", message: `clone ${status}`,
        ...(metadata === undefined ? {} : { service: metadata.engine, fields: { ...metadata } }),
      })); },
    });
    await Promise.all(statusEvents);
    return clones;
  } catch (error) {
    await Promise.allSettled(statusEvents);
    throw error;
  }
}

async function runInSandbox(
  request: DeployRequest,
  supervisor: ProjectSupervisor,
  sink: PluginEventSink,
  signal: AbortSignal,
): Promise<RunSummary> {
  const state = await requireReadyState(supervisor);
  const service = Object.values(state.services ?? {})[0];
  if (service === undefined) throw new Error("sandbox has no service runner; declare at least one service");
  const result = await (request.commands ?? defaultCommands).run("docker", ["exec", service.containerName, ...request.args], { signal });
  if (result.stdout.length > 0) await sink.processOutput({ phase: "run", source: "command", service: service.name, stream: "stdout", chunk: result.stdout });
  if (result.stderr.length > 0) await sink.processOutput({ phase: "run", source: "command", service: service.name, stream: "stderr", chunk: result.stderr });
  if (result.code !== 0) throw new AnboError(`command exited with code ${result.code}`, { exitCode: ExitCode.ChildProcess, code: "ANBO_CHILD_FAILED" });
  return { action: "run", status: "succeeded", exit_code: result.code };
}

async function downSandbox(request: DeployRequest, supervisor: ProjectSupervisor, sink: PluginEventSink, signal: AbortSignal): Promise<RunSummary> {
  const currentState = await supervisor.readState<PersistedRuntimeState>();
  const purgeClones = request.flags["purge-clones"] === true
    || request.manifest.data.postgres?.retain_on_down === false
    || request.manifest.data.dynamodb?.retain_on_down === false;
  const purgeLocal = request.flags["purge"] === true;
  await invokeAdaptersForAction(request, sink, signal, "release", {});
  await invokeAdaptersForAction(request, sink, signal, "teardown", {});
  await stopDeclaredServices(supervisor.projectId, request.commands ?? defaultCommands, signal);
  await removeProjectTerraformWorkers(supervisor.projectId, request.commands ?? defaultCommands, signal);
  // Clone retention is independent from the reusable local MiniStack snapshot.
  await stopMiniStack(supervisor.projectId, { purge: purgeLocal, commands: request.commands ?? defaultCommands, signal });
  if (purgeLocal) await rm(join(supervisor.stateDirectory, "terraform"), { recursive: true, force: true });
  if (purgeClones && (request.manifest.data.postgres?.provider === "anbo-cloud" || request.manifest.data.dynamodb?.provider === "anbo-cloud")) {
    const apiUrl = requiredEnvironment(request.env, "ANBO_API_URL");
    const token = request.resolveSecret === undefined
      ? await resolveSecretReference("env://ANBO_TOKEN", request.env)
      : await request.resolveSecret("env://ANBO_TOKEN");
    sink.redactor.registerSecret(token);
    await purgeOwnedClones(
      { statePath: join(supervisor.stateDirectory, "clones.json"), apiUrl, token, signal },
      request.fetch === undefined ? {} : { fetch: request.fetch },
    );
  }
  await supervisor.writeState({
    status: "stopped",
    last_run_id: sink.runId,
    ...(purgeLocal || currentState?.terraform === undefined ? {} : { terraform: currentState.terraform }),
  });
  return { action: "down", status: "succeeded", local_state_purged: purgeLocal, clone_purge_requested: purgeClones };
}

async function acquireAdapters(
  request: DeployRequest,
  sink: PluginEventSink,
  signal: AbortSignal,
  payload: Record<string, unknown>,
): Promise<Record<string, AdapterResponse>> {
  await invokeAdaptersForAction(request, sink, signal, "handshake", payload);
  return await invokeAdaptersForAction(request, sink, signal, "acquire", payload);
}

async function invokeAdaptersForAction(
  request: DeployRequest,
  sink: PluginEventSink,
  signal: AbortSignal,
  action: "handshake" | "acquire" | "reset" | "release" | "test" | "teardown",
  payload: Record<string, unknown>,
): Promise<Record<string, AdapterResponse>> {
  const responses: Record<string, AdapterResponse> = {};
  const logicalProjectId = request.manifest.project.id ?? request.manifest.project.name;
  const runtimeProjectId = request.runtimeProjectId ?? deriveRuntimeProjectId(logicalProjectId, request.root);
  for (const [name, config] of Object.entries(request.manifest.adapters)) {
    const response = await invokeAdapter(name, config, {
      schema_version: 2,
      action,
      project_id: safeProjectId(logicalProjectId),
      project_root: request.root,
      run_id: sink.runId,
      payload: { ...payload, logical_project_id: logicalProjectId, runtime_project_id: runtimeProjectId },
    }, {
      root: request.root,
      parentEnvironment: { ...request.env },
      signal,
      resolveSecret: async (reference) => {
        const value = request.resolveSecret === undefined
          ? await resolveSecretReference(reference, request.env)
          : await request.resolveSecret(reference);
        sink.redactor.registerSecret(value);
        return value;
      },
      onOutput: async (stream, chunk) => {
        if (stream === "stderr") await sink.processOutput({ phase: `adapter.${action}`, source: "adapter", service: name, stream, chunk });
      },
    });
    for (const binding of response.bindings) {
      if (binding.endpoint !== undefined) sink.redactor.registerSecret(binding.endpoint);
      if (binding.secret_handle !== undefined) sink.redactor.registerSecret(binding.secret_handle);
    }
    const missing = (config.capabilities ?? []).filter((capability) => !response.capabilities.includes(capability));
    if (missing.length > 0) throw new Error(`adapter ${name} did not provide declared capabilities: ${missing.join(", ")}`);
    const adapterError = response.diagnostics.find((diagnostic) => diagnostic.level === "error");
    for (const diagnostic of response.diagnostics.filter((entry) => entry.level !== "error")) {
      await sink.diagnostic({
        code: diagnostic.code,
        cause: diagnostic.message,
        remediation: diagnostic.remediation ?? `Inspect adapter ${name} configuration.`,
        retryable: diagnostic.retryable ?? false,
        safe_to_retry: diagnostic.retryable ?? false,
        phase: `adapter.${action}`,
        source: name,
        level: "warn",
      });
    }
    if (adapterError !== undefined) {
      throw new AnboError(adapterError.message, {
        exitCode: ExitCode.Runtime,
        code: adapterError.code,
        details: {
          remediation: adapterError.remediation ?? `Inspect adapter ${name} configuration.`,
          retryable: adapterError.retryable ?? false,
          safe_to_retry: adapterError.retryable ?? false,
          phase: `adapter.${action}`,
          evidence: { adapter: name, action },
        },
      });
    }
    responses[name] = response;
  }
  return responses;
}

async function statusSandbox(supervisor: ProjectSupervisor, _sink: PluginEventSink): Promise<RunSummary> {
  const state = await supervisor.readState<PersistedRuntimeState>();
  return { action: "status", status: "succeeded", sandbox: state ?? { status: "not-deployed" } };
}

async function logsSandbox(request: DeployRequest, supervisor: ProjectSupervisor, sink: PluginEventSink, signal: AbortSignal): Promise<RunSummary> {
  const state = await supervisor.readState<PersistedRuntimeState>();
  const requestedService = typeof request.flags["service"] === "string" ? request.flags["service"] : undefined;
  const persistedServices = Object.values(state?.services ?? {}).map((service) => ({
    name: service.name,
    containerName: service.containerName,
  }));
  const discovered = await inspectProjectContainers(
    supervisor.projectId,
    request.commands ?? defaultCommands,
    signal,
    false,
    (value) => sink.redactor.redactString(value),
    (value) => sink.redactor.registerSecret(value),
  );
  const candidates = [...new Map([
    ...persistedServices,
    ...discovered.map((container) => ({ name: container.service, containerName: container.name })),
  ].map((service) => [service.containerName, service])).values()];
  const services = candidates.filter((service) => requestedService === undefined ||
    service.name === requestedService || service.containerName === requestedService);
  if (requestedService !== undefined && services.length === 0) {
    throw new Error(`unknown project container or running service ${requestedService}`);
  }
  if (services.length === 0) {
    throw new Error("sandbox has no project containers; run `anbo debug --target ministack --output json` for the recorded failure");
  }
  const follow = request.flags["follow"] === true;
  await Promise.all(services.map(async (service) => {
    const args = ["logs", "--timestamps", "--tail", "all", ...(follow ? ["--follow"] : []), service.containerName];
    if (follow) {
      await spawnStreaming("docker", args, {
        signal,
        eventSink: sink,
        phase: "logs",
        source: "docker.logs",
        service: service.name,
        commandLabel: `logs ${service.name}`,
      });
    } else {
      const result = await (request.commands ?? defaultCommands).run("docker", args, {
        signal,
        onOutput: async (stream, chunk) => { await sink.processOutput({ phase: "logs", source: "docker.logs", service: service.name, stream, chunk }); },
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
        throw new Error(`could not read logs for ${service.name}: ${sink.redactor.redactString(detail)}`);
      }
    }
  }));
  return { action: "logs", status: "succeeded", services: services.map((service) => service.name), follow };
}

interface ProjectContainerEvidence {
  id: string;
  name: string;
  service: string;
  component: string;
  image?: string;
  running?: boolean;
  status?: string;
  exit_code?: number;
  error?: string;
  health?: string;
  logs?: string;
}

async function debugRun(
  request: DeployRequest,
  supervisor: ProjectSupervisor,
  sink: PluginEventSink,
  signal: AbortSignal,
): Promise<RunSummary> {
  const state = await supervisor.readState<PersistedRuntimeState>();
  const requestedRunId = request.args[0];
  if (requestedRunId !== undefined && requestedRunId !== state?.last_run_id) {
    throw new AnboError(`debug evidence for run ${requestedRunId} is unavailable`, {
      exitCode: ExitCode.Configuration,
      code: "ANBO_DEBUG_RUN_NOT_FOUND",
      details: {
        remediation: state?.last_run_id === undefined
          ? "Run anbo deploy first, then pass the run ID reported by that operation."
          : `Retry anbo debug with the latest recorded run ID: ${state.last_run_id}`,
        retryable: false,
        safe_to_retry: false,
        evidence: {
          requested_run_id: requestedRunId,
          ...(state?.last_run_id === undefined ? {} : { latest_run_id: state.last_run_id }),
        },
      },
    });
  }
  const runId = requestedRunId ?? state?.last_run_id;
  if (runId === undefined) throw new Error("no previous run is available to debug");
  const failure = state?.last_failure;
  const containers = await inspectProjectContainers(
    supervisor.projectId,
    request.commands ?? defaultCommands,
    signal,
    true,
    (value) => sink.redactor.redactString(value),
    (value) => sink.redactor.registerSecret(value),
  );
  return {
    action: "debug",
    status: "succeeded",
    inspected_run_id: runId,
    runtime_status: state?.status ?? "not-deployed",
    diagnostics: failure === undefined ? [] : [{ code: failure.code, message: failure.message, remediation: failure.remediation }],
    evidence: {
      ...(failure === undefined ? {} : { phase: failure.phase }),
      containers,
    },
    remediation: failure?.remediation ?? "No MiniStack runtime failure is recorded. Inspect the core run events for this run ID.",
  };
}

async function inspectProjectContainers(
  projectId: string,
  commands: import("./runtime/ministack.js").CommandExecutor,
  signal: AbortSignal,
  includeLogs: boolean,
  redact: (value: string) => string = (value) => value,
  registerSecret: (value: string) => void = () => undefined,
): Promise<ProjectContainerEvidence[]> {
  const listed = await commands.run("docker", [
    "ps", "-aq", "--filter", `label=anbo.dev/project=${projectId}`,
  ], { signal });
  if (listed.code !== 0) {
    const detail = listed.stderr.trim() || listed.stdout.trim() || `exit code ${listed.code}`;
    throw new Error(`could not inspect project containers: ${redact(detail)}`);
  }
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  const inspectedContainers = await Promise.all(ids.map(async (id): Promise<{
    id: string;
    evidence: ProjectContainerEvidence;
    rawError?: string;
  } | undefined> => {
    const inspected = await commands.run("docker", ["inspect", id], { signal });
    if (inspected.code !== 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(inspected.stdout);
    } catch {
      return undefined;
    }
    const record = Array.isArray(parsed) && isRecord(parsed[0]) ? parsed[0] : undefined;
    if (record === undefined) return undefined;
    const config = isRecord(record["Config"]) ? record["Config"] : {};
    registerSensitiveEnvironment(config["Env"], registerSecret);
    const labels = isRecord(config["Labels"]) ? config["Labels"] : {};
    const state = isRecord(record["State"]) ? record["State"] : {};
    const health = isRecord(state["Health"]) ? state["Health"] : {};
    const rawName = typeof record["Name"] === "string" ? record["Name"].replace(/^\//, "") : id;
    const component = typeof labels["anbo.dev/component"] === "string"
      ? labels["anbo.dev/component"]
      : "container";
    const prefix = `anbo-${projectId}-`;
    const service = component === "service" && rawName.startsWith(prefix)
      ? rawName.slice(prefix.length)
      : component;
    return {
      id,
      evidence: {
        id: typeof record["Id"] === "string" ? record["Id"] : id,
        name: rawName,
        service,
        component,
        ...(typeof config["Image"] === "string" ? { image: config["Image"] } : {}),
        ...(typeof state["Running"] === "boolean" ? { running: state["Running"] } : {}),
        ...(typeof state["Status"] === "string" ? { status: state["Status"] } : {}),
        ...(typeof state["ExitCode"] === "number" ? { exit_code: state["ExitCode"] } : {}),
        ...(typeof health["Status"] === "string" ? { health: health["Status"] } : {}),
      },
      ...(typeof state["Error"] === "string" && state["Error"].length > 0 ? { rawError: state["Error"] } : {}),
    };
  }));
  // Inspection is deliberately a separate pass: every container secret must
  // be registered before any sibling's error or log tail is rendered.
  const available = inspectedContainers.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return await Promise.all(available.map(async ({ id, evidence, rawError }) => {
    let logs: string | undefined;
    if (includeLogs) {
      const logged = await commands.run("docker", ["logs", "--timestamps", "--tail", "80", id], { signal });
      const combined = [logged.stdout, logged.stderr].filter((value) => value.trim().length > 0).join("\n");
      if (combined.length > 0) logs = boundedDebugTail(redact(combined), 8_192);
    }
    return {
      ...evidence,
      ...(rawError === undefined ? {} : { error: redact(rawError) }),
      ...(logs === undefined ? {} : { logs }),
    };
  }));
}

function registerSensitiveEnvironment(value: unknown, registerSecret: (value: string) => void): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (isSensitiveKey(name) || /(?:^|[_-])(?:dsn|uri|url|endpoint)(?:$|[_-])/i.test(name)) {
      registerSecret(secret);
    }
  }
}

function boundedDebugTail(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `[...truncated...]\n${value.slice(-maximumLength)}`;
}

async function cacheCommand(request: DeployRequest, projectId: string, cacheHome: string, signal: AbortSignal): Promise<RunSummary> {
  const action = request.args[0];
  const cachePath = join(cacheHome, "anbo", "v2");
  if (action === "prune") {
    await pruneBuildCache(projectId, request.commands ?? defaultCommands, signal);
    await rm(cachePath, { recursive: true, force: true });
    return { action: "cache", status: "succeeded", cache_action: "prune", path: cachePath };
  }
  let entries: string[] = [];
  try { entries = await readdir(cachePath); } catch { /* Empty cache. */ }
  return { action: "cache", status: "succeeded", cache_action: "inspect", path: cachePath, entries };
}

function runtimeContextFromState(
  request: DeployRequest,
  state: PersistedRuntimeState,
  clones: Readonly<Partial<Record<"postgres" | "dynamodb", CloneLease>>>,
  adapters: Readonly<Record<string, AdapterResponse>>,
  signal: AbortSignal,
  runId: string,
): ServiceRuntimeContext {
  const miniStack = state.ministack;
  if (miniStack === undefined) throw new Error("sandbox MiniStack runtime metadata is missing");
  return {
    runId,
    projectId: state.project_id,
    networkName: `anbo-${state.project_id}-app`,
    miniStackEndpoint: miniStack.container_endpoint,
    terraformOutputs: state.terraform?.outputs ?? {},
    clones,
    builds: {},
    environment: request.env,
    adapterBindings: Object.fromEntries(Object.entries(adapters).map(([name, response]) => [name, response.bindings])),
    signal,
  };
}

function configuredTestFeedback(sink: PluginEventSink) {
  return {
    onOutput: async (test: string, stream: "stdout" | "stderr", text: string) => {
      await sink.processOutput({ phase: "test", source: "smoke", service: test, stream, chunk: text });
    },
    onTestEvent: async (test: string, event: Parameters<PluginEventSink["testProtocolEvent"]>[1]) => {
      await sink.testProtocolEvent(test, event);
    },
    onProtocolIssue: async (test: string, issue: { line: number; reason: string }) => {
      await sink.diagnostic({
        code: "ANBO_TEST_EVENT_INVALID",
        cause: `${test} emitted an invalid jsonl-v1 event on line ${issue.line}: ${issue.reason}`,
        remediation: "Emit one schema_version 1 test event per stdout line, or remove ANBO_TEST_PROTOCOL when using unstructured output.",
        retryable: false,
        safe_to_retry: true,
        phase: "test",
        source: "smoke",
        level: "warn",
      });
    },
  };
}

function safeAdapterSummary(adapters: Readonly<Record<string, AdapterResponse>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(adapters).map(([name, response]) => [name, {
    capabilities: response.capabilities,
    bindings: response.bindings.map((binding) => ({ name: binding.name, kind: binding.kind })),
  }]));
}

function registerDeclaredEnvironmentSecrets(request: DeployRequest, sink: PluginEventSink): void {
  for (const [name, value] of Object.entries(request.env)) {
    if (isSensitiveKey(name)) sink.redactor.registerSecret(value);
  }
  const environments = [
    request.manifest.ministack.environment ?? {},
    ...Object.values(request.manifest.services).map((service) => service.environment ?? {}),
    ...Object.values(request.manifest.tests).map((test) => test.environment ?? {}),
  ];
  for (const environment of environments) {
    for (const [key, reference] of Object.entries(environment)) {
      const name = reference.match(/^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
      const value = name === undefined ? undefined : request.env[name];
      if (value !== undefined && value.length > 0) sink.redactor.registerSecret(value);
      if (isSensitiveKey(key) && name === undefined) sink.redactor.registerSecret(reference);
    }
  }
  for (const build of Object.values(request.manifest.builds)) {
    for (const [key, value] of Object.entries(build.args ?? {})) {
      if (isSensitiveKey(key)) sink.redactor.registerSecret(value);
    }
  }
}

async function requireReadyState(supervisor: ProjectSupervisor): Promise<PersistedRuntimeState> {
  const state = await supervisor.readState<PersistedRuntimeState>();
  if (state?.status !== "ready") throw new Error("sandbox is not ready; run anbo deploy first");
  return state;
}

async function resolveTerraformWorkerImage(
  image: string,
  signal: AbortSignal,
  commands: NonNullable<DeployRequest["commands"]>,
): Promise<string> {
  if (/@sha256:[a-f0-9]{64}$/i.test(image)) return image;
  const pull = await commands.run("docker", ["pull", image], { signal });
  if (pull.code !== 0) throw new Error(`could not pull Terraform worker image: ${pull.stderr.trim()}`);
  const inspect = await commands.run("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", image], { signal });
  if (inspect.code !== 0) throw new Error(`could not inspect Terraform worker image: ${inspect.stderr.trim()}`);
  const digests = JSON.parse(inspect.stdout) as unknown;
  if (!Array.isArray(digests) || typeof digests[0] !== "string" || !/@sha256:[a-f0-9]{64}$/i.test(digests[0])) {
    throw new Error("Terraform worker image did not resolve to an immutable digest");
  }
  return digests[0];
}

function persistedMiniStack(runtime: MiniStackRuntime): NonNullable<PersistedRuntimeState["ministack"]> {
  return {
    container_name: runtime.containerName,
    ...(runtime.containerId === undefined ? {} : { container_id: runtime.containerId }),
    ...(runtime.runtimeGeneration === undefined ? {} : { runtime_generation: runtime.runtimeGeneration }),
    network_name: runtime.networkName,
    runtime_network_name: runtime.runtimeNetworkName,
    host_endpoint: runtime.hostEndpoint,
    container_endpoint: runtime.containerEndpoint,
    image: runtime.image,
  };
}

function requiredEnvironment(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required for cloud clone operations`);
  return value;
}

export function classifyRuntimeError(cause: unknown, phase: string, signal?: AbortSignal): AnboError {
  if (cause instanceof AnboError) return cause;
  if (cause instanceof TerraformPhaseError) {
    const classified = classifyRuntimeError(cause.cause ?? cause.message, cause.phase, signal);
    return new AnboError(classified.message, {
      exitCode: classified.exitCode,
      code: classified.code,
      details: { ...classified.details, phase: cause.phase },
      cause,
    });
  }
  if (cause instanceof OperationLockedError) {
    return new AnboError(cause.message, {
      exitCode: ExitCode.LockConflict,
      code: "ANBO_PROJECT_LOCKED",
      details: {
        remediation: "Wait for the active Anbo operation to finish, or stop its owning process before retrying the same command.",
        retryable: true,
        safe_to_retry: true,
        evidence: cause.owner,
      },
      cause,
    });
  }
  if (cause instanceof AmbiguousCloneCreateError) {
    return new AnboError(cause.message, {
      exitCode: signal?.aborted === true ? ExitCode.Cancelled : ExitCode.Clone,
      code: "ANBO_CLONE_CREATE_UNCERTAIN",
      details: {
        remediation: `Inspect the cloning service for branch ${cause.branchName}; reconcile or remove that branch before retrying the deploy.`,
        retryable: true,
        safe_to_retry: false,
        evidence: { branch_name: cause.branchName },
      },
      cause,
    });
  }
  if (signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError")) {
    if (signal?.reason instanceof Error && signal.reason.name === "TimeoutError") {
      return new AnboError("operation exceeded its deadline", {
        exitCode: ExitCode.Deadline,
        code: "ANBO_DEADLINE",
        details: { retryable: true, safe_to_retry: true, remediation: remediationForPhase(phase) },
        cause,
      });
    }
    return new AnboError("operation cancelled", {
      exitCode: ExitCode.Cancelled,
      code: "ANBO_CANCELLED",
      details: { retryable: true, safe_to_retry: true, remediation: "Retry the command when cancellation is no longer requested." },
      cause,
    });
  }
  if (isDockerPrerequisiteFailure(cause)) {
    return new AnboError(cause instanceof Error ? cause.message : String(cause), {
      exitCode: ExitCode.Prerequisite,
      code: "ANBO_DOCKER_UNAVAILABLE",
      details: {
        remediation: "Install and start Docker, then verify `docker info` succeeds before retrying. Buildx is optional because Anbo can safely fall back to the classic Docker builder.",
        retryable: true,
        safe_to_retry: true,
      },
      cause,
    });
  }
  const exitCode = phase.includes("terraform") ? ExitCode.Terraform : phase.includes("clone") ? ExitCode.Clone : phase === "test" ? ExitCode.Test : ExitCode.Runtime;
  return new AnboError(cause instanceof Error ? cause.message : String(cause), {
    exitCode,
    code: `ANBO_${phase.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_FAILED`,
    details: {
      remediation: remediationForPhase(phase),
      retryable: false,
      safe_to_retry: true,
    },
    cause,
  });
}

function remediationForPhase(phase: string): string {
  if (phase.includes("terraform")) return "Run anbo debug for the failed run, correct the reported Terraform configuration, and retry anbo deploy.";
  if (phase.includes("clone")) return "For Anbo Cloud, verify ANBO_API_URL, ANBO_TOKEN, and the source alias. For external clones, verify each env:// or exec:// endpoint and credential reference, then retry.";
  return "Run anbo debug for the failed run and retry after correcting the reported prerequisite.";
}

function isDockerPrerequisiteFailure(cause: unknown): boolean {
  let current = cause;
  for (let depth = 0; depth < 6 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const error = current as NodeJS.ErrnoException;
      const executable = error.path ?? "";
      const syscall = error.syscall ?? "";
      if ((error.code === "ENOENT" || error.code === "EACCES") &&
          (executable === "docker" || /spawn\s+docker\b/i.test(syscall) || /spawn\s+docker\b/i.test(error.message))) {
        return true;
      }
      if (/cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect|permission denied[^\n]*docker|docker[^\n]*permission denied|dockerdesktoplinuxengine[^\n]*(?:cannot find|not found)|buildx[^\n]*(?:not a docker command|not found|unknown command)/i.test(error.message)) {
        return true;
      }
      current = error.cause;
      continue;
    }
    break;
  }
  return false;
}
