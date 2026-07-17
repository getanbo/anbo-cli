import { createHash } from "node:crypto";
import { AnboError, ExitCode, type ServiceConfig, type TestConfig } from "../types.js";
import type { AdapterBinding } from "../adapters.js";
import type { BuildResult } from "./cache.js";
import { cloneEndpointForContainer, type CloneLease } from "./clones.js";
import type { CommandExecutor } from "./ministack.js";
import { ProcessCommandExecutor, safeProjectId } from "./ministack.js";
import {
  JsonlV1TestEventDecoder,
  type JsonlV1DecodeResult,
  type JsonlV1ProtocolIssue,
  type JsonlV1TestEvent,
} from "./test-events.js";

export interface ServiceRuntimeContext {
  /** Active CLI operation. Production deploy/test paths always supply this. */
  runId?: string;
  projectId: string;
  networkName: string;
  miniStackEndpoint: string;
  terraformOutputs: Readonly<Record<string, unknown>>;
  clones: Readonly<Partial<Record<"postgres" | "dynamodb", CloneLease>>>;
  builds: Readonly<Record<string, BuildResult>>;
  environment: Readonly<NodeJS.ProcessEnv>;
  adapterBindings?: Readonly<Record<string, readonly AdapterBinding[]>>;
  signal?: AbortSignal;
}

export interface RunningService {
  name: string;
  containerName: string;
  containerId?: string;
  image: string;
  ports: Record<number, number>;
}

export interface RefreshedServices {
  running: Record<string, RunningService>;
  restarted: string[];
}

interface ReconciledService {
  running: RunningService;
  restarted: boolean;
  healthVerified: boolean;
}

interface ServiceInspection {
  id?: string;
  running: boolean;
  reusable: boolean;
  fingerprint?: string;
}

const SERVICE_FINGERPRINT_LABEL = "anbo.dev/service-fingerprint";
const SERVICE_FINGERPRINT_VERSION = 1;

export async function ensureApplicationNetwork(
  projectIdValue: string,
  miniStackContainer: string,
  commands: CommandExecutor = new ProcessCommandExecutor(),
): Promise<string> {
  const projectId = safeProjectId(projectIdValue);
  const network = `anbo-${projectId}-app`;
  const inspect = await commands.run("docker", ["network", "inspect", network]);
  if (inspect.code !== 0) {
    const create = await commands.run("docker", [
      "network", "create", "--label", "anbo.dev/managed=true", "--label", `anbo.dev/project=${projectId}`, network,
    ]);
    if (create.code !== 0) throw new Error(`could not create application network: ${create.stderr.trim()}`);
  }
  await commands.run("docker", ["network", "connect", network, miniStackContainer]);
  return network;
}

export async function startDeclaredServices(
  services: Readonly<Record<string, ServiceConfig>>,
  context: ServiceRuntimeContext,
  dependencies: {
    commands?: CommandExecutor;
    fetch?: typeof globalThis.fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    onStatus?: (service: string, status: string) => void;
  } = {},
): Promise<Record<string, RunningService>> {
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  const running: Record<string, RunningService> = {};
  const restarted = new Set<string>();
  const pending = new Set(Object.keys(services));
  while (pending.size > 0) {
    const ready = [...pending].filter((name) => (services[name]?.depends_on ?? []).every((dependency) => dependency in running));
    if (ready.length === 0) throw new Error(`service dependency cycle or missing dependency: ${[...pending].join(", ")}`);
    await Promise.all(ready.map(async (name) => {
      const config = services[name];
      if (config === undefined) return;
      const result = await reconcileService(
        name,
        config,
        context,
        commands,
        (config.depends_on ?? []).some((dependency) => restarted.has(dependency)),
        dependencies.fetch,
      );
      dependencies.onStatus?.(name, result.restarted ? "starting" : "reusing");
      running[name] = result.running;
      if (result.restarted) restarted.add(name);
      if (!result.healthVerified) {
        await waitForServiceHealth(running[name]!, config, context, commands, dependencies.fetch, dependencies.sleep);
      }
      dependencies.onStatus?.(name, "ready");
      pending.delete(name);
    }));
  }
  return running;
}

/**
 * Restarts only containers whose manifest bindings may resolve differently for
 * each CLI invocation. The persisted image is authoritative: standalone tests
 * never rebuild or silently switch the image that was deployed.
 */
export async function refreshRuntimeBoundServices(
  services: Readonly<Record<string, ServiceConfig>>,
  context: ServiceRuntimeContext,
  existing: Readonly<Record<string, RunningService>>,
  dependencies: {
    commands?: CommandExecutor;
    fetch?: typeof globalThis.fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    onStatus?: (service: string, status: string) => void;
  } = {},
): Promise<RefreshedServices> {
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  const running: Record<string, RunningService> = { ...existing };
  const directlyRefreshable = new Set(runtimeBoundServiceNames(services));
  const pending = new Set(Object.keys(services));
  const restarted: string[] = [];
  const restartedSet = new Set<string>();

  while (pending.size > 0) {
    const ready = [...pending].filter((name) => (services[name]?.depends_on ?? []).every(
      (dependency) => !pending.has(dependency) && dependency in running,
    ));
    if (ready.length === 0) {
      throw new Error(`refreshable service dependency cycle or missing deployed dependency: ${[...pending].join(", ")}`);
    }
    await Promise.all(ready.map(async (name) => {
      const config = services[name];
      const deployed = existing[name];
      if (config === undefined) return;
      const dependencyRestarted = (config.depends_on ?? []).some((dependency) => restartedSet.has(dependency));
      if (!directlyRefreshable.has(name) && !dependencyRestarted) {
        pending.delete(name);
        return;
      }
      if (deployed === undefined) throw new Error(`service ${name} needs refresh but has no deployed image; run anbo deploy first`);
      const result = await reconcileService(
        name,
        config,
        context,
        commands,
        dependencyRestarted,
        dependencies.fetch,
        deployed.image,
      );
      dependencies.onStatus?.(name, result.restarted ? "refreshing" : "reusing");
      running[name] = result.running;
      if (!result.healthVerified) {
        await waitForServiceHealth(running[name]!, config, context, commands, dependencies.fetch, dependencies.sleep);
      }
      dependencies.onStatus?.(name, "ready");
      if (result.restarted) {
        restarted.push(name);
        restartedSet.add(name);
      }
      pending.delete(name);
    }));
  }

  return { running, restarted };
}

export function runtimeBoundServiceNames(
  services: Readonly<Record<string, ServiceConfig>>,
): string[] {
  return Object.entries(services)
    .filter(([, config]) => serviceHasMutableRuntimeBinding(config))
    .map(([name]) => name);
}

export async function validateDeclaredServices(
  services: Readonly<Record<string, ServiceConfig>>,
  context: ServiceRuntimeContext,
  persisted: Readonly<Record<string, RunningService>>,
  dependencies: {
    commands?: CommandExecutor;
    fetch?: typeof globalThis.fetch;
  } = {},
): Promise<boolean> {
  if (!sameStringSet(Object.keys(services), Object.keys(persisted))) return false;
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  const projectId = safeProjectId(context.projectId);
  for (const [name, config] of Object.entries(services)) {
    const service = persisted[name];
    if (service === undefined || service.containerId === undefined ||
        service.containerName !== `anbo-${projectId}-${safeProjectId(name)}`) return false;
    const environment = resolveRuntimeEnvironment(name, config, context);
    const fingerprintEnvironment = Object.fromEntries(
      Object.entries(environment).filter(([key]) => key !== "ANBO_RUN_ID"),
    );
    const imageIdentity = await resolveImageIdentity(service.image, commands);
    const fingerprint = serviceFingerprint(config, context.networkName, imageIdentity, fingerprintEnvironment);
    const inspection = await inspectService(service.containerName, commands, projectId);
    if (inspection?.reusable !== true || inspection.fingerprint !== fingerprint) return false;
    if (inspection.id !== service.containerId) return false;
    if (!await probeServiceHealth(service, config, context, commands, dependencies.fetch ?? globalThis.fetch)) return false;
  }
  return true;
}

function serviceHasMutableRuntimeBinding(config: ServiceConfig): boolean {
  if (config.dynamodb_plane === "clone") return true;
  return Object.values(config.environment ?? {}).some((value) =>
    /^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    || /^\$\{clone\.[^}]+\}$/.test(value)
    || /^\$\{adapter\.[^}]+\}$/.test(value),
  );
}

export async function runConfiguredTests(
  tests: Readonly<Record<string, TestConfig>>,
  selected: readonly string[],
  context: ServiceRuntimeContext,
  running: Readonly<Record<string, RunningService>>,
  dependencies: {
    commands?: CommandExecutor;
    onOutput?: (test: string, stream: "stdout" | "stderr", text: string) => void | Promise<void>;
    onTestEvent?: (test: string, event: JsonlV1TestEvent) => void | Promise<void>;
    onProtocolIssue?: (test: string, issue: JsonlV1ProtocolIssue) => void | Promise<void>;
    onResult?: (test: string, result: { passed: boolean; code: number }) => void | Promise<void>;
  } = {},
): Promise<Record<string, { passed: boolean; code: number }>> {
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  const names = selected.length > 0 ? selected : Object.entries(tests).filter(([, test]) => test.default === true).map(([name]) => name);
  const results: Record<string, { passed: boolean; code: number }> = {};
  for (const name of names) {
    const test = tests[name];
    if (test === undefined) throw new Error(`unknown test suite ${name}`);
    if (test.service === undefined) throw new Error(`test ${name} must select a service runner`);
    const service = running[test.service];
    if (service === undefined) throw new Error(`test ${name} references service ${test.service}, which is not running`);
    const environment = resolveServiceEnvironment(test.environment ?? {}, context);
    if (context.runId !== undefined) environment["ANBO_TEST_RUN_ID"] ??= `${context.runId}:${name}`;
    environment["ANBO_TEST_ID"] = name;
    const decoder = environment["ANBO_TEST_PROTOCOL"] === "jsonl-v1" ? new JsonlV1TestEventDecoder() : undefined;
    let lastTestEvent: JsonlV1TestEvent | undefined;
    const publishDecoded = async (decoded: JsonlV1DecodeResult | undefined): Promise<void> => {
      if (decoded === undefined) return;
      for (const event of decoded.events) {
        lastTestEvent = event;
        await dependencies.onTestEvent?.(name, event);
      }
      for (const issue of decoded.issues) await dependencies.onProtocolIssue?.(name, issue);
    };
    const args = [
      "exec",
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      service.containerName,
      ...test.command,
    ];
    const timeoutSignal = AbortSignal.timeout((test.timeout_seconds ?? 300) * 1_000);
    const testSignal = context.signal === undefined ? timeoutSignal : AbortSignal.any([context.signal, timeoutSignal]);
    const shouldStream = dependencies.onOutput !== undefined || decoder !== undefined;
    const commandOptions = {
      signal: testSignal,
      ...(shouldStream ? { onOutput: async (stream: "stdout" | "stderr", text: string) => {
        await dependencies.onOutput?.(name, stream, text);
        if (stream === "stdout") await publishDecoded(decoder?.push(text));
      } } : {}),
    };
    let result;
    try {
      result = await commands.run("docker", args, commandOptions);
    } catch (cause) {
      await publishDecoded(decoder?.finish());
      if (timeoutSignal.aborted && context.signal?.aborted !== true) {
        throw new AnboError(`test ${name} timed out after ${test.timeout_seconds ?? 300} seconds`, {
          exitCode: ExitCode.Deadline,
          code: "ANBO_TEST_TIMEOUT",
          details: { remediation: `Inspect anbo logs for ${test.service}, then retry the test or raise timeout_seconds.` },
          cause,
        });
      }
      throw cause;
    }
    await publishDecoded(decoder?.finish());
    results[name] = { passed: result.code === 0, code: result.code };
    await dependencies.onResult?.(name, results[name]!);
    if (result.code !== 0) {
      throw new AnboError(`test ${name} failed with exit code ${result.code}`, {
        exitCode: ExitCode.Test,
        code: "ANBO_TEST_FAILED",
        details: {
          phase: "test",
          remediation: `Run anbo test ${name} --target ministack after correcting the failing assertion.`,
          retryable: true,
          safe_to_retry: true,
          evidence: {
            test_id: name,
            service: test.service,
            exit_code: result.code,
            rerun: `anbo test ${name} --target ministack`,
            ...(lastTestEvent === undefined ? {} : {
              last_event: lastTestEvent,
              ...(typeof lastTestEvent.correlation_id === "string"
                ? { correlation_id: lastTestEvent.correlation_id }
                : {}),
            }),
            stdout_tail: boundedOutputTail(result.stdout),
            stderr_tail: boundedOutputTail(result.stderr),
          },
        },
      });
    }
  }
  return results;
}

function boundedOutputTail(value: string, maxBytes = 8 * 1024): string {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes ? value.trim() : bytes.subarray(bytes.length - maxBytes).toString("utf8").trim();
}

export async function stopDeclaredServices(
  projectIdValue: string,
  commands: CommandExecutor = new ProcessCommandExecutor(),
  signal?: AbortSignal,
): Promise<void> {
  const projectId = safeProjectId(projectIdValue);
  const options = signal === undefined ? {} : { signal };
  const containers = await commands.run("docker", ["ps", "-aq", "--filter", `label=anbo.dev/project=${projectId}`, "--filter", "label=anbo.dev/component=service"], options);
  assertCleanupResult(containers, "inspect declared service containers");
  const ids = containers.stdout.split(/\s+/).filter(Boolean);
  if (ids.length > 0) {
    const removed = await commands.run("docker", ["rm", "-f", ...ids], options);
    assertCleanupResult(removed, "remove declared service containers");
  }
  const network = `anbo-${projectId}-app`;
  const inspected = await commands.run("docker", ["network", "inspect", network], options);
  if (inspected.code !== 0) {
    assertCleanupResult(inspected, "inspect application network", true);
    return;
  }
  const disconnected = await commands.run("docker", ["network", "disconnect", "--force", network, `anbo-${projectId}-ministack`], options);
  assertCleanupResult(disconnected, "disconnect MiniStack from application network", true);
  const removedNetwork = await commands.run("docker", ["network", "rm", network], options);
  assertCleanupResult(removedNetwork, "remove application network", true);
}

export async function stopDeclaredService(
  projectIdValue: string,
  serviceName: string,
  commands: CommandExecutor = new ProcessCommandExecutor(),
  signal?: AbortSignal,
): Promise<void> {
  const projectId = safeProjectId(projectIdValue);
  const containerName = `anbo-${projectId}-${safeProjectId(serviceName)}`;
  const result = await commands.run(
    "docker",
    ["rm", "-f", containerName],
    signal === undefined ? {} : { signal },
  );
  assertCleanupResult(result, `remove declared service ${serviceName}`, true);
}

function assertCleanupResult(
  result: { code: number; stdout: string; stderr: string },
  action: string,
  allowAbsent = false,
): void {
  if (result.code === 0) return;
  const evidence = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  if (allowAbsent && /(?:no such|not found|is not connected)/i.test(evidence)) return;
  throw new Error(`could not ${action}: ${evidence}`);
}

export function resolveServiceEnvironment(
  declared: Readonly<Record<string, string>>,
  context: ServiceRuntimeContext,
): Record<string, string> {
  const result: Record<string, string> = {
    AWS_ACCESS_KEY_ID: "000000000000",
    AWS_SECRET_ACCESS_KEY: "anbo-local",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_ENDPOINT_URL: context.miniStackEndpoint,
    ANBO_MINISTACK_ENDPOINT: context.miniStackEndpoint,
    ANBO_PROJECT_ID: context.projectId,
  };
  for (const [name, value] of Object.entries(context.terraformOutputs)) {
    result[`ANBO_TERRAFORM_OUTPUT_${toUpperSnake(name)}`] = stringifyEnvironmentValue(value);
  }
  for (const [key, value] of Object.entries(declared)) {
    result[key] = resolveEnvironmentValue(value, context);
  }
  if (context.runId !== undefined) result["ANBO_RUN_ID"] = context.runId;
  return result;
}

async function reconcileService(
  name: string,
  config: ServiceConfig,
  context: ServiceRuntimeContext,
  commands: CommandExecutor,
  forceRestart: boolean,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  persistedImage?: string,
): Promise<ReconciledService> {
  const projectId = safeProjectId(context.projectId);
  const containerName = `anbo-${projectId}-${safeProjectId(name)}`;
  const image = persistedImage ?? config.image ?? (config.build === undefined ? undefined : context.builds[config.build]?.image);
  if (image === undefined) throw new Error(`service ${name} must specify image or build`);
  const environment = resolveRuntimeEnvironment(name, config, context);
  const imageIdentity = await resolveImageIdentity(image, commands);
  const fingerprintEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key !== "ANBO_RUN_ID"),
  );
  const fingerprint = serviceFingerprint(config, context.networkName, imageIdentity, fingerprintEnvironment);
  const inspection = await inspectService(containerName, commands, projectId);
  if (!forceRestart && inspection?.reusable === true && inspection.fingerprint === fingerprint) {
    const reused = await runningService(name, containerName, image, config, commands, inspection.id);
    if (await probeServiceHealth(reused, config, context, commands, fetcher)) {
      return { running: reused, restarted: false, healthVerified: true };
    }
  }
  throwIfServiceCancelled(context.signal);
  if (inspection !== undefined) {
    throwIfServiceCancelled(context.signal);
    const removed = await commands.run(
      "docker",
      ["rm", "-f", containerName],
      context.signal === undefined ? {} : { signal: context.signal },
    );
    if (removed.code !== 0) throw new Error(`service ${name} could not replace its container: ${removed.stderr.trim()}`);
  }
  throwIfServiceCancelled(context.signal);
  const args = [
    "run", "--detach", "--name", containerName,
    "--label", "anbo.dev/managed=true", "--label", `anbo.dev/project=${projectId}`, "--label", "anbo.dev/component=service",
    "--label", `${SERVICE_FINGERPRINT_LABEL}=${fingerprint}`,
    "--network", context.networkName,
    "--add-host", "host.docker.internal:host-gateway",
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...(config.working_directory === undefined ? [] : ["--workdir", config.working_directory]),
    ...(config.ports ?? []).flatMap((port) => ["--publish", `127.0.0.1:${port.host ?? ""}:${port.container}/${port.protocol ?? "tcp"}`]),
    image,
    ...(config.command ?? []),
  ];
  const commandOptions = context.signal === undefined ? {} : { signal: context.signal };
  const started = await commands.run("docker", args, commandOptions);
  if (started.code !== 0) throw new Error(`service ${name} failed to start: ${started.stderr.trim()}`);
  const containerId = started.stdout.trim().split(/\s+/)[0] || undefined;
  return {
    running: await runningService(name, containerName, image, config, commands, containerId),
    restarted: true,
    healthVerified: false,
  };
}

function resolveRuntimeEnvironment(name: string, config: ServiceConfig, context: ServiceRuntimeContext): Record<string, string> {
  const environment = resolveServiceEnvironment(config.environment ?? {}, context);
  if (config.dynamodb_plane === "clone") {
    const lease = context.clones.dynamodb;
    if (lease?.engine !== "dynamodb") throw new Error(`service ${name} requests DynamoDB clone but no clone is configured`);
    const endpoint = cloneEndpointForContainer(lease);
    environment["AWS_ENDPOINT_URL_DYNAMODB"] = endpoint;
    environment["AWS_REGION"] = lease.region;
    environment["AWS_ACCESS_KEY_ID"] = lease.accessKeyId;
    environment["AWS_SECRET_ACCESS_KEY"] = lease.secretAccessKey;
    environment["AWS_SESSION_TOKEN"] = lease.sessionToken;
    environment["ANBO_DYNAMODB_CLONE_ENDPOINT"] = endpoint;
    environment["ANBO_DYNAMODB_CLONE_REGION"] = lease.region;
    environment["ANBO_DYNAMODB_CLONE_ACCESS_KEY_ID"] = lease.accessKeyId;
    environment["ANBO_DYNAMODB_CLONE_SECRET_ACCESS_KEY"] = lease.secretAccessKey;
    environment["ANBO_DYNAMODB_CLONE_SESSION_TOKEN"] = lease.sessionToken;
  }
  return environment;
}

async function runningService(
  name: string,
  containerName: string,
  image: string,
  config: ServiceConfig,
  commands: CommandExecutor,
  containerId?: string,
): Promise<RunningService> {
  const ports: Record<number, number> = {};
  for (const port of config.ports ?? []) {
    const output = await commands.run("docker", ["port", containerName, `${port.container}/${port.protocol ?? "tcp"}`]);
    const match = output.stdout.match(/:(\d+)\s*$/m);
    if (match?.[1] !== undefined) ports[port.container] = Number(match[1]);
  }
  return { name, containerName, ...(containerId === undefined ? {} : { containerId }), image, ports };
}

async function resolveImageIdentity(
  image: string,
  commands: CommandExecutor,
): Promise<string> {
  const digest = image.match(/@sha256:([a-f0-9]{64})$/i)?.[1];
  if (digest !== undefined) return `digest:${digest.toLowerCase()}`;
  const inspected = await commands.run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  const identity = inspected.code === 0 ? inspected.stdout.trim() : "";
  return identity.length > 0 ? `image:${identity}` : `reference:${image}`;
}

function serviceFingerprint(
  config: ServiceConfig,
  networkName: string,
  imageIdentity: string,
  environment: Readonly<Record<string, string>>,
): string {
  return createHash("sha256").update(stableJson({
    version: SERVICE_FINGERPRINT_VERSION,
    image: imageIdentity,
    network: networkName,
    command: config.command ?? [],
    working_directory: config.working_directory ?? null,
    environment,
    ports: config.ports ?? [],
    depends_on: config.depends_on ?? [],
    healthcheck: config.healthcheck ?? null,
    dynamodb_plane: config.dynamodb_plane ?? "ministack",
  })).digest("hex");
}

async function inspectService(
  containerName: string,
  commands: CommandExecutor,
  expectedProjectId: string,
): Promise<ServiceInspection | undefined> {
  const result = await commands.run("docker", ["inspect", containerName]);
  if (result.code !== 0) {
    const evidence = result.stderr.trim() || result.stdout.trim();
    if (/(?:no such|not found)/i.test(evidence)) return undefined;
    throw new Error(`could not inspect service container ${containerName}: ${evidence || `exit code ${result.code}`}`);
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const value = Array.isArray(parsed) ? parsed[0] : undefined;
    if (!isRecord(value)) return { running: false, reusable: false };
    const state = isRecord(value["State"]) ? value["State"] : undefined;
    const config = value["Config"];
    const labels = isRecord(config) && isRecord(config["Labels"]) ? config["Labels"] : undefined;
    const fingerprint = labels?.[SERVICE_FINGERPRINT_LABEL];
    const id = typeof value["Id"] === "string" ? value["Id"] : undefined;
    const running = state?.["Running"] === true;
    const status = typeof state?.["Status"] === "string" ? state["Status"] : undefined;
    const health = isRecord(state?.["Health"]) && typeof state["Health"]["Status"] === "string"
      ? state["Health"]["Status"]
      : undefined;
    const reusable = running
      && state?.["Paused"] !== true
      && state?.["Restarting"] !== true
      && state?.["Dead"] !== true
      && (status === undefined || status === "running")
      && (health === undefined || health === "healthy")
      && labels?.["anbo.dev/managed"] === "true"
      && labels?.["anbo.dev/project"] === expectedProjectId
      && labels?.["anbo.dev/component"] === "service";
    return {
      ...(id === undefined ? {} : { id }),
      running,
      reusable,
      ...(typeof fingerprint === "string" ? { fingerprint } : {}),
    };
  } catch {
    return { running: false, reusable: false };
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

async function probeServiceHealth(
  service: RunningService,
  config: ServiceConfig,
  context: ServiceRuntimeContext,
  commands: CommandExecutor,
  fetcher: typeof globalThis.fetch,
): Promise<boolean> {
  const health = config.healthcheck;
  if (health === undefined) return true;
  try {
    if (health.type === "http") {
      return (await fetcher(resolveEnvironmentValue(health.url, context), { signal: context.signal })).ok;
    }
    if (health.type === "command") {
      return (await commands.run(
        "docker",
        ["exec", service.containerName, ...health.command],
        context.signal === undefined ? {} : { signal: context.signal },
      )).code === 0;
    }
    return service.ports[health.port] !== undefined;
  } catch {
    throwIfServiceCancelled(context.signal);
    return false;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForServiceHealth(
  service: RunningService,
  config: ServiceConfig,
  context: ServiceRuntimeContext,
  commands: CommandExecutor,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  const health = config.healthcheck;
  if (health === undefined) return;
  const timeout = health.timeout_seconds ?? 60;
  const interval = (health.interval_seconds ?? 1) * 1_000;
  const deadline = Date.now() + timeout * 1_000;
  let last = "not ready";
  while (Date.now() < deadline) {
    throwIfServiceCancelled(context.signal);
    try {
      if (health.type === "http") {
        const url = resolveEnvironmentValue(health.url, context);
        const response = await fetcher(url, { signal: context.signal });
        if (response.ok) return;
        last = `HTTP ${response.status}`;
      } else if (health.type === "command") {
        const result = await commands.run(
          "docker",
          ["exec", service.containerName, ...health.command],
          context.signal === undefined ? {} : { signal: context.signal },
        );
        if (result.code === 0) return;
        last = result.stderr.trim() || `exit ${result.code}`;
      } else {
        const port = service.ports[health.port];
        if (port !== undefined) return; // Docker has successfully bound the requested TCP listener.
      }
    } catch (error) {
      throwIfServiceCancelled(context.signal, error);
      last = error instanceof Error ? error.message : String(error);
    }
    await abortableServiceSleep(interval, sleep, context.signal);
  }
  throw new Error(`service ${service.name} health check failed: ${last}`);
}

function throwIfServiceCancelled(signal: AbortSignal | undefined, fallback?: unknown): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? fallback ?? new DOMException("The operation was aborted", "AbortError");
  }
}

async function abortableServiceSleep(
  milliseconds: number,
  sleep: (milliseconds: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await sleep(milliseconds);
    return;
  }
  throwIfServiceCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function resolveEnvironmentValue(value: string, context: ServiceRuntimeContext): string {
  const terraform = value.match(/^\$\{terraform\.([^}]+)\}$/)?.[1];
  if (terraform !== undefined) {
    if (!(terraform in context.terraformOutputs)) throw new Error(`unknown Terraform output ${terraform}`);
    return stringifyEnvironmentValue(context.terraformOutputs[terraform]);
  }
  const environment = value.match(/^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  if (environment !== undefined) {
    const resolved = context.environment[environment];
    if (resolved === undefined) throw new Error(`environment variable ${environment} is not set`);
    return resolved;
  }
  if (value === "${clone.postgres.database_url}") {
    const lease = context.clones.postgres;
    if (lease?.engine !== "postgres") throw new Error("PostgreSQL clone is not configured");
    return cloneEndpointForContainer(lease);
  }
  const adapter = value.match(/^\$\{adapter\.([A-Za-z0-9_.-]+)\.([A-Za-z0-9_.-]+)\.(endpoint|secret_handle)\}$/);
  if (adapter !== null) {
    const [, adapterName, bindingName, field] = adapter;
    const binding = context.adapterBindings?.[adapterName!]?.find((entry) => entry.name === bindingName);
    const resolved = field === "endpoint" ? binding?.endpoint : binding?.secret_handle;
    if (resolved === undefined) throw new Error(`adapter binding ${adapterName}.${bindingName}.${field} is unavailable`);
    return resolved;
  }
  if (value === "${ministack.endpoint}") return context.miniStackEndpoint;
  return value;
}

function stringifyEnvironmentValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toUpperSnake(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}
