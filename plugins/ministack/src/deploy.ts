import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getCapabilityReport } from "./capabilities.js";
import { invokeAdapter, type AdapterResponse } from "./adapters.js";
import type { PluginEventSink } from "./event-sink.js";
import { spawnStreaming } from "./process.js";
import {
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
import { runTerraform, type TerraformRunResult } from "./runtime/terraform.js";
import { injectLambdaCloneBindings } from "./runtime/lambda-overlays.js";

interface PersistedRuntimeState extends SupervisorState {
  status?: string;
  last_run_id?: string;
  ministack?: {
    container_name: string;
    network_name: string;
    runtime_network_name?: string;
    host_endpoint: string;
    container_endpoint: string;
    image: string;
  };
  terraform?: { outputs: Record<string, unknown>; roots: string[] };
  services?: Record<string, RunningService>;
  clones?: Record<string, unknown>;
  last_failure?: {
    code: string;
    message: string;
    remediation: string;
    phase: string;
  };
}

const defaultCommands = new ProcessCommandExecutor();
const DEFAULT_TERRAFORM_WORKER = "hashicorp/terraform:1.15.7@sha256:40e61a86763083ea987ded0ffa15f6d75e0df48ed16275811f949b3ecbcd8aae";

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
          return await debugRun(request, supervisor, sink);
        case "capabilities":
          return { action: "capabilities", status: "succeeded", capabilities: getCapabilityReport() } satisfies RunSummary;
        case "cache":
          return await cacheCommand(request, projectId, cacheHome, operation.signal);
      }
    });
    return summary;
  } catch (cause) {
    const error = classifyRuntimeError(cause, phase, request.signal);
    await sink.diagnostic({
      code: error.code,
      cause: error.message,
      evidence: { phase },
      remediation: error.details?.remediation ?? remediationForPhase(phase),
      retryable: error.details?.retryable ?? true,
      safe_to_retry: error.details?.safe_to_retry ?? true,
      phase,
    }).catch(() => undefined);
    const current = await supervisor.readState<PersistedRuntimeState>().catch(() => undefined);
    await supervisor.writeState({
      ...(current ?? {}),
      last_run_id: sink.runId,
      last_failure: {
        code: error.code,
        message: sink.redactor.redactString(error.message),
        remediation: error.details?.remediation ?? remediationForPhase(phase),
        phase,
      },
    }).catch(() => undefined);
    throw error;
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
  const miniStackPromise = startMiniStack({
    projectId,
    image: request.manifest.ministack.image,
    ...(request.manifest.ministack.digest === undefined ? {} : { digest: request.manifest.ministack.digest }),
    persistence: request.manifest.ministack.persistence,
    stateRoot: supervisor.stateDirectory,
    environment: request.manifest.ministack.environment,
    ...(signal === undefined ? {} : {}),
  }, {
    signal,
    commands: request.commands ?? defaultCommands,
    ...(request.fetch === undefined ? {} : { fetch: request.fetch }),
  });
  const clonePromise = acquireRequestClones(request, supervisor, sink, signal);
  const buildPromise = buildDeclaredImages({
    projectId,
    root: request.root,
    builds: request.manifest.builds,
    cacheRoot: join(cacheHome, "anbo", "v2", "buildkit"),
    signal,
  }, {
    commands: request.commands ?? defaultCommands,
    onOutput: async (build, stream, text) => { await sink.processOutput({ phase: "build", source: "buildkit", service: build, stream, chunk: text }); },
  });
  const infrastructure = await Promise.allSettled([miniStackPromise, clonePromise, buildPromise]);
  const failedInfrastructureIndex = infrastructure.findIndex((result) => result.status === "rejected");
  if (failedInfrastructureIndex >= 0) {
    const failed = infrastructure[failedInfrastructureIndex];
    const failurePhase = (["ministack", "clone", "build"] as const)[failedInfrastructureIndex] ?? "infrastructure";
    reportPhase(failurePhase);
    if (failed?.status === "rejected") throw classifyRuntimeError(failed.reason, failurePhase, signal);
  }
  const miniStack = infrastructure[0].status === "fulfilled" ? infrastructure[0].value : neverReached();
  const clones = infrastructure[1].status === "fulfilled" ? infrastructure[1].value : neverReached();
  const builds = infrastructure[2].status === "fulfilled" ? infrastructure[2].value : neverReached();
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
    clone_count: Object.keys(clones).length,
    build_cache_hits: Object.fromEntries(Object.entries(builds).map(([name, result]) => [name, result.cacheHit])),
  });

  reportPhase("terraform");
  const terraformPhase = await sink.startPhase("Terraform deploy", "terraform");
  const terraform = await applyTerraformRoots(request, supervisor, miniStack, signal, sink, cacheHome);
  await terraformPhase.finish("Terraform applied", { changes: terraform.changes });

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
    terraform: { outputs: terraform.outputs, roots: [...request.manifest.terraform.roots] },
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
): Promise<TerraformRunResult> {
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
  const aggregate: TerraformRunResult = {
    privateDirectory: "",
    planPath: "",
    statePath: "",
    changes: { create: 0, update: 0, delete: 0, replace: 0, noOp: 0 },
    outputs: {},
  };
  for (let index = 0; index < request.manifest.terraform.roots.length; index += 1) {
    const root = request.manifest.terraform.roots[index];
    if (root === undefined) continue;
    const result = await runTerraform({
      sourceDirectory: resolve(request.root, root),
      privateDirectory: join(supervisor.stateDirectory, "terraform", String(index), "workspace"),
      statePath: join(supervisor.stateDirectory, "terraform", String(index), "terraform.tfstate"),
      pluginCacheDirectory: join(cacheHome, "anbo", "v2", "terraform", "plugins"),
      workerImage,
      networkName: miniStack.networkName,
      miniStackEndpoint: miniStack.containerEndpoint,
      variableFiles: variableFilesByRoot.get(root) ?? [],
      environment: request.env,
      signal,
    }, {
      commands: request.commands ?? defaultCommands,
      onOutput: async (stream, text, outputPhase) => { await sink.processOutput({ phase: outputPhase, source: "terraform", stream, chunk: text }); },
    });
    aggregate.privateDirectory = result.privateDirectory;
    aggregate.planPath = result.planPath;
    aggregate.statePath = result.statePath;
    aggregate.outputs = { ...aggregate.outputs, ...result.outputs };
    for (const key of Object.keys(aggregate.changes) as Array<keyof typeof aggregate.changes>) aggregate.changes[key] += result.changes[key];
  }
  return aggregate;
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
  const purgeClones = request.flags["purge-clones"] === true
    || request.manifest.data.postgres?.retain_on_down === false
    || request.manifest.data.dynamodb?.retain_on_down === false;
  const purgeLocal = request.flags["purge"] === true;
  await invokeAdaptersForAction(request, sink, signal, "release", {});
  await invokeAdaptersForAction(request, sink, signal, "teardown", {});
  await stopDeclaredServices(supervisor.projectId, request.commands ?? defaultCommands, signal);
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
  await supervisor.writeState({ status: "stopped", last_run_id: sink.runId });
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
  const runtimeProjectId = deriveRuntimeProjectId(logicalProjectId, request.root);
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
    for (const diagnostic of response.diagnostics) {
      await sink.diagnostic({
        code: diagnostic.code,
        cause: diagnostic.message,
        remediation: diagnostic.remediation ?? `Inspect adapter ${name} configuration.`,
        retryable: diagnostic.retryable ?? false,
        safe_to_retry: diagnostic.retryable ?? false,
        phase: `adapter.${action}`,
        source: name,
        level: diagnostic.level === "error" ? "error" : "warn",
      });
    }
    if (response.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
      throw new Error(`adapter ${name} reported an error during ${action}`);
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
  const state = await requireReadyState(supervisor);
  const requestedService = typeof request.flags["service"] === "string" ? request.flags["service"] : undefined;
  const services = Object.values(state.services ?? {}).filter((service) => requestedService === undefined || service.name === requestedService);
  if (requestedService !== undefined && services.length === 0) throw new Error(`unknown running service ${requestedService}`);
  if (services.length === 0) throw new Error("sandbox has no running services");
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
      await (request.commands ?? defaultCommands).run("docker", args, {
        signal,
        onOutput: async (stream, chunk) => { await sink.processOutput({ phase: "logs", source: "docker.logs", service: service.name, stream, chunk }); },
      });
    }
  }));
  return { action: "logs", status: "succeeded", services: services.map((service) => service.name), follow };
}

async function debugRun(request: DeployRequest, supervisor: ProjectSupervisor, _sink: PluginEventSink): Promise<RunSummary> {
  const state = await supervisor.readState<PersistedRuntimeState>();
  const runId = request.args[0] ?? state?.last_run_id;
  if (runId === undefined) throw new Error("no previous run is available to debug");
  const failure = state?.last_failure;
  return {
    action: "debug",
    status: "succeeded",
    inspected_run_id: runId,
    runtime_status: state?.status ?? "not-deployed",
    diagnostics: failure === undefined ? [] : [{ code: failure.code, message: failure.message, remediation: failure.remediation }],
    evidence: failure === undefined ? {} : { phase: failure.phase },
    remediation: failure?.remediation ?? "No MiniStack runtime failure is recorded. Inspect the core run events for this run ID.",
  };
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
  const environments = [
    ...Object.values(request.manifest.services).map((service) => service.environment ?? {}),
    ...Object.values(request.manifest.tests).map((test) => test.environment ?? {}),
  ];
  for (const environment of environments) {
    for (const reference of Object.values(environment)) {
      const name = reference.match(/^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
      const value = name === undefined ? undefined : request.env[name];
      if (value !== undefined && value.length > 0) sink.redactor.registerSecret(value);
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
  if (signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError")) {
    if (signal?.reason instanceof Error && signal.reason.name === "TimeoutError") {
      return new AnboError("operation exceeded its deadline", { exitCode: ExitCode.Deadline, code: "ANBO_DEADLINE", cause });
    }
    return new AnboError("operation cancelled", { exitCode: ExitCode.Cancelled, code: "ANBO_CANCELLED", cause });
  }
  if (isDockerPrerequisiteFailure(cause)) {
    return new AnboError(cause instanceof Error ? cause.message : String(cause), {
      exitCode: ExitCode.Prerequisite,
      code: "ANBO_DOCKER_UNAVAILABLE",
      details: {
        remediation: "Install and start Docker, then verify `docker info` and `docker buildx version` succeed before retrying.",
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

function neverReached(): never {
  throw new Error("parallel infrastructure setup ended without a result");
}
