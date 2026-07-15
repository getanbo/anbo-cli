import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

import { CERTIFIED_MINISTACK_DIGEST, CERTIFIED_MINISTACK_IMAGE } from "../distribution.js";

export interface RuntimeCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

export interface RuntimeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  run(command: string, args: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
}

export class ProcessCommandExecutor implements CommandExecutor {
  async run(command: string, args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputChain = Promise.resolve();
      let childError: Error | undefined;
      const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        (stream === "stdout" ? stdout : stderr).push(chunk);
        if (options.onOutput !== undefined) {
          outputChain = outputChain.then(async () => options.onOutput?.(stream, chunk.toString("utf8")));
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
      // AbortSignal and spawn failures emit "error" before "close". Waiting for
      // close keeps late stdout/stderr callbacks from racing the run summary.
      child.on("error", (error) => { childError = error; });
      child.on("close", (code) => { void outputChain.then(() => {
        if (childError !== undefined) {
          reject(childError);
          return;
        }
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }, reject); });
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    });
  }
}

export interface MiniStackRuntimeConfig {
  projectId: string;
  image: string;
  digest?: string;
  persistence: boolean;
  stateRoot: string;
  region?: string;
  accountId?: string;
  environment?: Readonly<Record<string, string>>;
  dockerSocket?: string;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  platform?: string;
}

export interface MiniStackRuntime {
  containerName: string;
  /** Internal network used only by the isolated Terraform worker. */
  networkName: string;
  /** Egress-capable network used by MiniStack's Lambda and ECS containers. */
  runtimeNetworkName: string;
  volumeName?: string;
  hostEndpoint: string;
  containerEndpoint: string;
  image: string;
  edition: "full";
}

export interface MiniStackDependencies {
  commands?: CommandExecutor;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const RUNTIME_CONFIG_LABEL = "anbo.dev/runtime-config";

export function safeProjectId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length === 0) throw new Error("project id must contain at least one letter or number");
  return normalized.slice(0, 48);
}

export function resolveMiniStackImage(image: string, digest?: string): string {
  const trimmed = image.trim();
  const embeddedDigest = trimmed.match(/@(sha256:[a-f0-9]{64})$/i)?.[1];
  if (digest !== undefined && embeddedDigest !== undefined && digest.toLowerCase() !== embeddedDigest.toLowerCase()) {
    throw new Error("MiniStack image digest does not match its embedded digest");
  }
  const selectedDigest = digest ?? embeddedDigest;
  if (selectedDigest === undefined || !DIGEST_PATTERN.test(selectedDigest)) {
    throw new Error("MiniStack full image must be pinned with a sha256 digest");
  }
  const withoutDigest = trimmed.replace(/@sha256:[a-f0-9]{64}$/i, "");
  const isFullTag = /(?:^|\/)(?:anbo-)?ministack:(?:full|[A-Za-z0-9._-]+-full)$/i.test(withoutDigest);
  const isCertifiedDigestReference = trimmed.toLowerCase() === CERTIFIED_MINISTACK_IMAGE.toLowerCase()
    && selectedDigest.toLowerCase() === CERTIFIED_MINISTACK_DIGEST.toLowerCase();
  if (!isFullTag && !isCertifiedDigestReference) {
    throw new Error("MiniStack image must use a full tag or the certified immutable Anbo MiniStack reference");
  }
  return `${withoutDigest}@${selectedDigest.toLowerCase()}`;
}

export async function startMiniStack(
  config: MiniStackRuntimeConfig,
  dependencies: MiniStackDependencies = {},
): Promise<MiniStackRuntime> {
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const projectId = safeProjectId(config.projectId);
  const image = resolveMiniStackImage(config.image, config.digest);
  const platform = config.platform ?? (process.platform === "darwin" && process.arch === "arm64" ? "linux/amd64" : undefined);
  const containerName = `anbo-${projectId}-ministack`;
  const networkName = `anbo-${projectId}-control`;
  const runtimeNetworkName = `anbo-${projectId}-runtime`;
  const volumeName = config.persistence ? `anbo-${projectId}-ministack-data` : undefined;
  const label = `anbo.dev/project=${projectId}`;
  const lambdaDockerFlags = lambdaContainerFlags(config.environment?.["LAMBDA_DOCKER_FLAGS"]);
  const runtimeConfigFingerprint = miniStackRuntimeConfigFingerprint({
    config,
    image,
    platform,
    projectId,
    networkName,
    runtimeNetworkName,
    volumeName,
    lambdaDockerFlags,
  });
  let hostPort: number | undefined;

  await ensureDockerNetwork(commands, networkName, label, true, dependencies.signal);
  await ensureDockerNetwork(commands, runtimeNetworkName, label, false, dependencies.signal);
  if (volumeName !== undefined) {
    await ensureDockerVolume(commands, volumeName, label, dependencies.signal);
  }

  const existing = await commands.run("docker", ["inspect", containerName], signalOptions(dependencies.signal));
  if (existing.code === 0) {
    const inspected = parseDockerInspection(existing.stdout);
    const actualImage = inspected.Config?.Image;
    const requestedDigest = image.slice(image.indexOf("@") + 1);
    const digestMatches = inspected.RepoDigests?.some((repoDigest) => repoDigest.endsWith(`@${requestedDigest}`)) === true;
    const networks = inspected.NetworkSettings?.Networks ?? {};
    const hasRequiredNetworks = networks[networkName] !== undefined && networks[runtimeNetworkName] !== undefined;
    if ((actualImage !== image && !digestMatches) || !hasUsablePortBinding(inspected) || !hasRequiredNetworks ||
        inspected.Config?.Labels?.[RUNTIME_CONFIG_LABEL] !== runtimeConfigFingerprint ||
        !hasContainerHostRouting(inspected, lambdaDockerFlags)) {
      await checked(commands, "docker", ["rm", "-f", containerName], signalOptions(dependencies.signal));
    } else if (!inspected.State?.Running && (inspected.State?.ExitCode ?? 0) !== 0) {
      await checked(commands, "docker", ["rm", "-f", containerName], signalOptions(dependencies.signal));
    } else {
      hostPort = configuredHostPort(inspected);
      if (!inspected.State?.Running) {
        await checked(commands, "docker", ["start", containerName], signalOptions(dependencies.signal));
      }
    }
  }

  const afterInspect = await commands.run("docker", ["inspect", containerName], signalOptions(dependencies.signal));
  if (afterInspect.code !== 0) {
    const dockerSocket = config.dockerSocket ?? "/var/run/docker.sock";
    hostPort = await reserveLoopbackPort();
    const args = [
      "run", "--detach", "--name", containerName,
      ...(platform === undefined ? [] : ["--platform", platform]),
      "--label", "anbo.dev/managed=true", "--label", label, "--label", "anbo.dev/component=ministack",
      "--label", `${RUNTIME_CONFIG_LABEL}=${runtimeConfigFingerprint}`,
      "--network", runtimeNetworkName,
      "--add-host", "host.docker.internal:host-gateway",
      "--publish", `127.0.0.1:${hostPort}:4566`,
      "--volume", `${dockerSocket}:/var/run/docker.sock`,
      "--env", "DOCKER_NETWORK=" + runtimeNetworkName,
      "--env", "LAMBDA_EXECUTOR=docker",
      "--env", `LAMBDA_DOCKER_FLAGS=${lambdaDockerFlags}`,
      "--env", `MINISTACK_REGION=${config.region ?? "us-east-1"}`,
      "--env", `MINISTACK_ACCOUNT_ID=${config.accountId ?? "000000000000"}`,
      ...(config.persistence
        ? [
            "--volume", `${volumeName ?? ""}:/var/lib/anbo/ministack`,
            "--env", "PERSIST_STATE=1",
            "--env", "STATE_DIR=/var/lib/anbo/ministack/state",
            "--env", "S3_PERSIST=1",
            "--env", "S3_DATA_DIR=/var/lib/anbo/ministack/s3",
            "--env", "RDS_PERSIST=1",
          ]
        : []),
      ...environmentArguments(config.environment, new Set(["LAMBDA_DOCKER_FLAGS"])),
      image,
    ];
    await checked(commands, "docker", args, signalOptions(dependencies.signal));
    await checked(
      commands,
      "docker",
      ["network", "connect", networkName, containerName],
      signalOptions(dependencies.signal),
    );
  }

  if (hostPort === undefined) {
    const inspection = await checked(commands, "docker", ["inspect", containerName], signalOptions(dependencies.signal));
    hostPort = configuredHostPort(parseDockerInspection(inspection.stdout));
  }
  const hostEndpoint = `http://127.0.0.1:${hostPort}`;
  const deadline = now() + (config.healthTimeoutMs ?? 60_000);
  let lastFailure = "health endpoint did not respond";
  while (now() < deadline) {
    if (dependencies.signal?.aborted === true) throw dependencies.signal.reason;
    try {
      const response = await fetcher(`${hostEndpoint}/_ministack/health`, { signal: dependencies.signal });
      const body = await response.json() as Record<string, unknown>;
      if (response.ok && body["edition"] === "full") {
        return {
          containerName,
          networkName,
          runtimeNetworkName,
          ...(volumeName === undefined ? {} : { volumeName }),
          hostEndpoint,
          containerEndpoint: `http://${containerName}:4566`,
          image,
          edition: "full",
        };
      }
      lastFailure = response.ok
        ? `health endpoint reported edition ${String(body["edition"] ?? "unknown")}, expected full`
        : `health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(config.healthIntervalMs ?? 500);
  }
  throw new Error(`MiniStack did not become ready: ${lastFailure}`);
}

export async function stopMiniStack(
  projectIdValue: string,
  options: { purge?: boolean; commands?: CommandExecutor; signal?: AbortSignal } = {},
): Promise<void> {
  const projectId = safeProjectId(projectIdValue);
  const commands = options.commands ?? new ProcessCommandExecutor();
  const containerName = `anbo-${projectId}-ministack`;
  const networkName = `anbo-${projectId}-control`;
  const runtimeNetworkName = `anbo-${projectId}-runtime`;
  const volumeName = `anbo-${projectId}-ministack-data`;
  if (options.purge !== true) {
    await cleanupDocker(commands, ["stop", containerName], options.signal, true);
    return;
  }
  await cleanupDocker(commands, ["rm", "-f", containerName], options.signal, true);
  // Remove labelled children before the network. MiniStack-created containers inherit
  // the project network even when their image does not support Anbo labels.
  const children = await Promise.all([networkName, runtimeNetworkName].map(async (network) => await checked(
    commands, "docker", ["ps", "-aq", "--filter", `network=${network}`], signalOptions(options.signal),
  )));
  const childIds = [...new Set(children.flatMap((result) => result.stdout.split(/\s+/).filter(Boolean)))];
  if (childIds.length > 0) await checked(commands, "docker", ["rm", "-f", ...childIds], signalOptions(options.signal));
  await cleanupDocker(commands, ["network", "rm", networkName], options.signal, true);
  await cleanupDocker(commands, ["network", "rm", runtimeNetworkName], options.signal, true);
  if (options.purge === true) {
    await cleanupDocker(commands, ["volume", "rm", "-f", volumeName], options.signal, true);
  }
}

async function cleanupDocker(
  commands: CommandExecutor,
  args: readonly string[],
  signal: AbortSignal | undefined,
  allowAbsent: boolean,
): Promise<void> {
  const result = await commands.run("docker", args, signalOptions(signal));
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  if (allowAbsent && /(?:no such|not found|is not connected)/i.test(detail)) return;
  throw new Error(`docker ${args[0] ?? "cleanup"} failed: ${detail}`);
}

async function ensureDockerNetwork(
  commands: CommandExecutor,
  networkName: string,
  projectLabel: string,
  internal: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const inspected = await commands.run("docker", ["network", "inspect", networkName], signalOptions(signal));
  if (inspected.code === 0) {
    const networks = JSON.parse(inspected.stdout) as Array<{ Internal?: boolean }>;
    if (networks[0]?.Internal !== internal) {
      throw new Error(`Docker network ${networkName} has the wrong isolation mode; run anbo down --purge and retry`);
    }
    return;
  }
  await checked(commands, "docker", [
    "network", "create", ...(internal ? ["--internal"] : []),
    "--label", "anbo.dev/managed=true", "--label", projectLabel,
    networkName,
  ], signalOptions(signal));
}

async function ensureDockerVolume(
  commands: CommandExecutor,
  volumeName: string,
  projectLabel: string,
  signal?: AbortSignal,
): Promise<void> {
  const inspected = await commands.run("docker", ["volume", "inspect", volumeName], signalOptions(signal));
  if (inspected.code === 0) return;
  await checked(commands, "docker", [
    "volume", "create", "--label", "anbo.dev/managed=true", "--label", projectLabel, volumeName,
  ], signalOptions(signal));
}

function environmentArguments(
  environment: Readonly<Record<string, string>> | undefined,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  if (environment === undefined) return [];
  return Object.entries(environment)
    .filter(([key]) => !excluded.has(key))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function lambdaContainerFlags(configured: string | undefined): string {
  return [configured?.trim(), "--add-host host.docker.internal:host-gateway"].filter(Boolean).join(" ");
}

function parseDockerInspection(value: string): {
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  State?: { Running?: boolean; ExitCode?: number };
  RepoDigests?: string[];
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
    ExtraHosts?: string[];
  };
  NetworkSettings?: { Networks?: Record<string, unknown> };
} {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new Error("docker inspect returned an unexpected response");
  }
  return parsed[0] as {
    Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
    State?: { Running?: boolean; ExitCode?: number };
    RepoDigests?: string[];
    HostConfig?: {
      PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
      ExtraHosts?: string[];
    };
    NetworkSettings?: { Networks?: Record<string, unknown> };
  };
}

function hasContainerHostRouting(
  inspected: ReturnType<typeof parseDockerInspection>,
  lambdaDockerFlags: string,
): boolean {
  const parentMapping = inspected.HostConfig?.ExtraHosts?.includes("host.docker.internal:host-gateway") === true;
  const lambdaMapping = inspected.Config?.Env?.includes(`LAMBDA_DOCKER_FLAGS=${lambdaDockerFlags}`) === true;
  return parentMapping && lambdaMapping;
}

function hasUsablePortBinding(inspected: ReturnType<typeof parseDockerInspection>): boolean {
  try {
    configuredHostPort(inspected);
    return true;
  } catch {
    return false;
  }
}

function configuredHostPort(inspected: ReturnType<typeof parseDockerInspection>): number {
  const binding = inspected.HostConfig?.PortBindings?.["4566/tcp"]?.[0];
  const port = Number(binding?.HostPort);
  if (binding?.HostIp !== "127.0.0.1" || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("MiniStack container does not have a usable loopback port binding");
  }
  return port;
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port for MiniStack"));
        return;
      }
      const port = address.port;
      server.close((error) => error === undefined ? resolvePort(port) : reject(error));
    });
  });
}

function miniStackRuntimeConfigFingerprint(options: {
  config: MiniStackRuntimeConfig;
  image: string;
  platform: string | undefined;
  projectId: string;
  networkName: string;
  runtimeNetworkName: string;
  volumeName: string | undefined;
  lambdaDockerFlags: string;
}): string {
  const effectiveEnvironment: Record<string, string> = {
    DOCKER_NETWORK: options.runtimeNetworkName,
    LAMBDA_EXECUTOR: "docker",
    LAMBDA_DOCKER_FLAGS: options.lambdaDockerFlags,
    MINISTACK_REGION: options.config.region ?? "us-east-1",
    MINISTACK_ACCOUNT_ID: options.config.accountId ?? "000000000000",
    ...(options.config.persistence
      ? {
          PERSIST_STATE: "1",
          STATE_DIR: "/var/lib/anbo/ministack/state",
          S3_PERSIST: "1",
          S3_DATA_DIR: "/var/lib/anbo/ministack/s3",
          RDS_PERSIST: "1",
        }
      : {}),
    ...Object.fromEntries(
      Object.entries(options.config.environment ?? {})
        .filter(([key]) => key !== "LAMBDA_DOCKER_FLAGS"),
    ),
  };
  const stableEnvironment = Object.fromEntries(
    Object.entries(effectiveEnvironment).sort(([left], [right]) => left.localeCompare(right)),
  );
  const createTimeConfiguration = {
    version: 1,
    project_id: options.projectId,
    image: options.image,
    platform: options.platform ?? null,
    docker_socket: options.config.dockerSocket ?? "/var/run/docker.sock",
    persistence: options.config.persistence,
    volume_name: options.volumeName ?? null,
    networks: {
      control: options.networkName,
      runtime: options.runtimeNetworkName,
    },
    port_binding: "127.0.0.1:dynamic:4566",
    host_gateway: "host.docker.internal:host-gateway",
    environment: stableEnvironment,
  };
  return createHash("sha256").update(JSON.stringify(createTimeConfiguration)).digest("hex");
}

export async function checked(
  commands: CommandExecutor,
  command: string,
  args: readonly string[],
  options: RuntimeCommandOptions = {},
): Promise<RuntimeCommandResult> {
  const result = await commands.run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`${command} ${args[0] ?? ""} failed: ${detail}`);
  }
  return result;
}

function signalOptions(signal: AbortSignal | undefined): RuntimeCommandOptions {
  return signal === undefined ? {} : { signal };
}
