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
  image: string;
  ports: Record<number, number>;
}

export interface RefreshedServices {
  running: Record<string, RunningService>;
  restarted: string[];
}

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
  const pending = new Set(Object.keys(services));
  while (pending.size > 0) {
    const ready = [...pending].filter((name) => (services[name]?.depends_on ?? []).every((dependency) => dependency in running));
    if (ready.length === 0) throw new Error(`service dependency cycle or missing dependency: ${[...pending].join(", ")}`);
    await Promise.all(ready.map(async (name) => {
      const config = services[name];
      if (config === undefined) return;
      dependencies.onStatus?.(name, "starting");
      running[name] = await startService(name, config, context, commands);
      await waitForServiceHealth(running[name]!, config, context, commands, dependencies.fetch, dependencies.sleep);
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
  const pending = new Set(runtimeBoundServiceNames(services));
  const restarted: string[] = [];

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
      if (deployed === undefined) {
        throw new Error(`service ${name} has mutable runtime bindings but no deployed image; run anbo deploy first`);
      }
      dependencies.onStatus?.(name, "refreshing");
      running[name] = await startService(name, config, context, commands, deployed.image);
      await waitForServiceHealth(running[name]!, config, context, commands, dependencies.fetch, dependencies.sleep);
      dependencies.onStatus?.(name, "ready");
      restarted.push(name);
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
    const publishDecoded = async (decoded: JsonlV1DecodeResult | undefined): Promise<void> => {
      if (decoded === undefined) return;
      for (const event of decoded.events) await dependencies.onTestEvent?.(name, event);
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
    if (result.code !== 0) throw new Error(`test ${name} failed with exit code ${result.code}`);
  }
  return results;
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

async function startService(
  name: string,
  config: ServiceConfig,
  context: ServiceRuntimeContext,
  commands: CommandExecutor,
  persistedImage?: string,
): Promise<RunningService> {
  const projectId = safeProjectId(context.projectId);
  const containerName = `anbo-${projectId}-${safeProjectId(name)}`;
  const image = persistedImage ?? config.image ?? (config.build === undefined ? undefined : context.builds[config.build]?.image);
  if (image === undefined) throw new Error(`service ${name} must specify image or build`);
  await commands.run("docker", ["rm", "-f", containerName]);
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
  const args = [
    "run", "--detach", "--name", containerName,
    "--label", "anbo.dev/managed=true", "--label", `anbo.dev/project=${projectId}`, "--label", "anbo.dev/component=service",
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
  const ports: Record<number, number> = {};
  for (const port of config.ports ?? []) {
    const output = await commands.run("docker", ["port", containerName, `${port.container}/${port.protocol ?? "tcp"}`]);
    const match = output.stdout.match(/:(\d+)\s*$/m);
    if (match?.[1] !== undefined) ports[port.container] = Number(match[1]);
  }
  return { name, containerName, image, ports };
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
    try {
      if (health.type === "http") {
        const url = resolveEnvironmentValue(health.url, context);
        const response = await fetcher(url, { signal: context.signal });
        if (response.ok) return;
        last = `HTTP ${response.status}`;
      } else if (health.type === "command") {
        const result = await commands.run("docker", ["exec", service.containerName, ...health.command]);
        if (result.code === 0) return;
        last = result.stderr.trim() || `exit ${result.code}`;
      } else {
        const port = service.ports[health.port];
        if (port !== undefined) return; // Docker has successfully bound the requested TCP listener.
      }
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await sleep(interval);
  }
  throw new Error(`service ${service.name} health check failed: ${last}`);
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
