import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

import {
  CERTIFIED_MINISTACK_COMPATIBILITY,
  CERTIFIED_MINISTACK_DIGEST,
  CERTIFIED_MINISTACK_IMAGE,
  CERTIFIED_MINISTACK_PLATFORMS,
  type CertifiedMiniStackPlatform,
} from "../distribution.js";
import { Redactor } from "../redaction.js";

export interface RuntimeCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
  /** Run only the teardown command even when the enclosing operation was cancelled. */
  cleanup?: boolean;
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
}

export interface MiniStackRuntime {
  containerName: string;
  /** Docker generation identity. Missing identities are never eligible for incremental reuse. */
  containerId?: string;
  /** Docker process generation. A restart keeps the container ID but changes this value. */
  runtimeGeneration?: string;
  /** True only when the exact healthy running container was reused without a restart. */
  reused: boolean;
  /** Internal network used only by the isolated Terraform worker. */
  networkName: string;
  /** Egress-capable network used by MiniStack's Lambda and ECS containers. */
  runtimeNetworkName: string;
  volumeName?: string;
  hostEndpoint: string;
  containerEndpoint: string;
  /** Stable endpoint injected into Lambda worker containers on the runtime network. */
  lambdaEndpoint: string;
  image: string;
  /** Native Docker server platform selected from the pinned image index. */
  platform: CertifiedMiniStackPlatform;
  /** Platform reported by the Docker server. */
  serverPlatform: CertifiedMiniStackPlatform;
  /** Deterministic platform workaround and certification result, when required. */
  compatibility?: MiniStackCompatibilityMetadata;
  edition: "full";
}

export interface MiniStackCompatibilityMetadata {
  id: string;
  fingerprint: `sha256:${string}`;
  certification: string;
  certificationCacheHit: boolean;
}

export interface MiniStackDependencies {
  commands?: CommandExecutor;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  redact?: (text: string) => string;
  onCompatibility?: (metadata: MiniStackCompatibilityMetadata) => void | Promise<void>;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const RUNTIME_CONFIG_LABEL = "anbo.dev/runtime-config";
const COMPATIBILITY_LABEL = "anbo.dev/ministack-compatibility";
const CERTIFICATION_IMAGE_REPOSITORY = "anbo/ministack-certification";
const MINISTACK_RUNTIME_ALIAS = "ministack";
const LAMBDA_CERTIFICATION_VERSION = "lambda-callback-v6-lifecycle-cleanup";
const MANAGED_RUNTIME_ENVIRONMENT = new Set([
  "DOCKER_NETWORK",
  "LAMBDA_DOCKER_NETWORK",
  "LAMBDA_EXECUTOR",
  "LAMBDA_STRICT",
  "LAMBDA_REMOTE_DOCKER_VOLUME_MOUNT",
  "MINISTACK_ACCOUNT_ID",
  "MINISTACK_REGION",
]);

class MiniStackCompatibilityCertificationError extends Error {}

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
  const defaultRedactor = new Redactor();
  const redact = dependencies.redact ?? ((text: string) => defaultRedactor.redactString(text));
  const projectId = safeProjectId(config.projectId);
  const image = resolveMiniStackImage(config.image, config.digest);
  const serverPlatform = await dockerServerPlatform(commands, dependencies.signal);
  const platform = selectMiniStackPlatform(image, serverPlatform);
  const compatibility = selectedCompatibility(image, platform);
  const containerName = `anbo-${projectId}-ministack`;
  const networkName = `anbo-${projectId}-control`;
  const runtimeNetworkName = `anbo-${projectId}-runtime`;
  const volumeName = config.persistence ? `anbo-${projectId}-ministack-data` : undefined;
  const lambdaEndpoint = `http://${MINISTACK_RUNTIME_ALIAS}:4566`;
  const label = `anbo.dev/project=${projectId}`;
  const lambdaDockerFlags = lambdaContainerFlags(
    config.environment?.["LAMBDA_DOCKER_FLAGS"],
    lambdaEndpoint,
    runtimeNetworkName,
  );
  const runtimeConfigFingerprint = miniStackRuntimeConfigFingerprint({
    config,
    image,
    platform,
    projectId,
    networkName,
    runtimeNetworkName,
    volumeName,
    lambdaEndpoint,
    lambdaDockerFlags,
    compatibility,
  });
  let hostPort: number | undefined;
  let containerId: string | undefined;
  let runtimeGeneration: string | undefined;
  let reused = false;
  let createRequired = false;

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
      createRequired = true;
    } else if (!inspected.State?.Running && (inspected.State?.ExitCode ?? 0) !== 0) {
      await checked(commands, "docker", ["rm", "-f", containerName], signalOptions(dependencies.signal));
      createRequired = true;
    } else {
      hostPort = configuredHostPort(inspected);
      containerId = inspected.Id;
      runtimeGeneration = inspected.State?.StartedAt;
      if (!inspected.State?.Running) {
        await checked(commands, "docker", ["start", containerName], signalOptions(dependencies.signal));
      } else {
        reused = hasRuntimeIdentity(containerId, runtimeGeneration);
      }
    }
  } else {
    createRequired = true;
  }

  if (createRequired) {
    const dockerSocket = config.dockerSocket ?? "/var/run/docker.sock";
    hostPort = await reserveLoopbackPort();
    const args = [
      "run", "--detach", "--name", containerName,
      "--platform", platform,
      "--label", "anbo.dev/managed=true", "--label", label, "--label", "anbo.dev/component=ministack",
      ...(compatibility === undefined ? [] : ["--label", `${COMPATIBILITY_LABEL}=${compatibility.fingerprint}`]),
      "--label", `${RUNTIME_CONFIG_LABEL}=${runtimeConfigFingerprint}`,
      "--network", runtimeNetworkName,
      "--network-alias", MINISTACK_RUNTIME_ALIAS,
      "--add-host", "host.docker.internal:host-gateway",
      "--publish", `127.0.0.1:${hostPort}:4566`,
      "--volume", `${dockerSocket}:/var/run/docker.sock`,
      "--env", "DOCKER_NETWORK=" + runtimeNetworkName,
      "--env", "LAMBDA_EXECUTOR=docker",
      "--env", "LAMBDA_STRICT=1",
      "--env", `LAMBDA_DOCKER_FLAGS=${lambdaDockerFlags}`,
      "--env", `MINISTACK_REGION=${config.region ?? "us-east-1"}`,
      "--env", `MINISTACK_ACCOUNT_ID=${config.accountId ?? "000000000000"}`,
      ...environmentArguments(compatibility?.environment),
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
      ...environmentArguments(config.environment, new Set([
        "LAMBDA_DOCKER_FLAGS",
        ...MANAGED_RUNTIME_ENVIRONMENT,
        ...(isCertifiedMiniStackImage(image)
          ? Object.values(CERTIFIED_MINISTACK_COMPATIBILITY).flatMap((recipe) => Object.keys(recipe.environment))
          : []),
      ])),
      image,
    ];
    const created = await checked(commands, "docker", args, signalOptions(dependencies.signal));
    containerId = created.stdout.trim().split(/\s+/)[0] || undefined;
    await checked(
      commands,
      "docker",
      ["network", "connect", networkName, containerName],
      signalOptions(dependencies.signal),
    );
  }

  if (hostPort === undefined) throw new Error("MiniStack container has no loopback port binding");
  const hostEndpoint = `http://127.0.0.1:${hostPort}`;
  const deadline = now() + (config.healthTimeoutMs ?? 60_000);
  let lastFailure = "health endpoint did not respond";
  while (now() < deadline) {
    if (dependencies.signal?.aborted === true) throw dependencies.signal.reason;
    try {
      const response = await fetcher(`${hostEndpoint}/_ministack/health`, { signal: dependencies.signal });
      const body = await response.json() as Record<string, unknown>;
      if (response.ok && body["edition"] === "full") {
        const healthyInspection = parseDockerInspection((await checked(
          commands,
          "docker",
          ["inspect", containerName],
          signalOptions(dependencies.signal),
        )).stdout);
        if (healthyInspection.State?.Running !== true) throw new Error("MiniStack container stopped during its health check");
        if (reused && (healthyInspection.Id !== containerId || healthyInspection.State.StartedAt !== runtimeGeneration)) {
          reused = false;
        }
        containerId = healthyInspection.Id ?? containerId;
        runtimeGeneration = healthyInspection.State.StartedAt;
        let compatibilityMetadata: MiniStackCompatibilityMetadata | undefined;
        if (compatibility !== undefined) {
          const runtimeImageId = healthyInspection.Image;
          if (runtimeImageId === undefined || !DIGEST_PATTERN.test(runtimeImageId)) {
            throw new MiniStackCompatibilityCertificationError(
              "MiniStack ARM64 compatibility certification could not identify the running image",
            );
          }
          let certificationCacheHit: boolean;
          try {
            certificationCacheHit = await certifyArm64Compatibility({
              commands,
              containerName,
              image,
              runtimeImageId,
              compatibility,
              runtimeNetworkName,
              lambdaEndpoint,
              signal: dependencies.signal,
              redact,
            });
          } catch (error) {
            throw new MiniStackCompatibilityCertificationError(
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
          }
          compatibilityMetadata = {
            id: compatibility.id,
            fingerprint: compatibility.fingerprint,
            certification: compatibility.certification,
            certificationCacheHit,
          };
          try {
            await dependencies.onCompatibility?.(compatibilityMetadata);
          } catch (error) {
            throw new MiniStackCompatibilityCertificationError(
              `MiniStack ARM64 compatibility event failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return {
          containerName,
          ...(containerId === undefined ? {} : { containerId }),
          ...(runtimeGeneration === undefined ? {} : { runtimeGeneration }),
          reused,
          networkName,
          runtimeNetworkName,
          ...(volumeName === undefined ? {} : { volumeName }),
          hostEndpoint,
          containerEndpoint: `http://${containerName}:4566`,
          lambdaEndpoint,
          image,
          platform,
          serverPlatform,
          ...(compatibilityMetadata === undefined ? {} : { compatibility: compatibilityMetadata }),
          edition: "full",
        };
      }
      lastFailure = response.ok
        ? `health endpoint reported edition ${String(body["edition"] ?? "unknown")}, expected full`
        : `health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      rethrowIfAborted(dependencies.signal, error);
      if (error instanceof MiniStackCompatibilityCertificationError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    const stopped = await stoppedContainerEvidence(
      commands,
      containerName,
      dependencies.signal,
      redact,
      platform,
      serverPlatform,
    );
    if (stopped !== undefined) throw new Error(stopped);
    await abortableSleep(config.healthIntervalMs ?? 500, sleep, dependencies.signal);
  }
  throw new Error(`MiniStack did not become ready: ${lastFailure}`);
}

function rethrowIfAborted(signal: AbortSignal | undefined, fallback: unknown): void {
  if (signal?.aborted === true) throw signal.reason ?? fallback;
}

async function abortableSleep(
  milliseconds: number,
  sleep: (milliseconds: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await sleep(milliseconds);
    return;
  }
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function isCertifiedMiniStackImage(image: string): boolean {
  return image.toLowerCase() === CERTIFIED_MINISTACK_IMAGE.toLowerCase();
}

interface SelectedMiniStackCompatibility {
  id: string;
  environment: Readonly<Record<string, string>>;
  certification: string;
  fingerprint: `sha256:${string}`;
  certificationImage: string;
}

function selectedCompatibility(
  image: string,
  platform: CertifiedMiniStackPlatform,
): SelectedMiniStackCompatibility | undefined {
  if (!isCertifiedMiniStackImage(image)) return undefined;
  const recipe = CERTIFIED_MINISTACK_COMPATIBILITY[platform];
  if (recipe === undefined) return undefined;
  const environment = Object.fromEntries(
    Object.entries(recipe.environment).sort(([left], [right]) => left.localeCompare(right)),
  );
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    version: 2,
    image,
    platform,
    id: recipe.id,
    environment,
    certification: recipe.certification,
    lambda_certification: {
      version: LAMBDA_CERTIFICATION_VERSION,
      script_sha256: createHash("sha256")
        .update(arm64CertificationScript(`http://${MINISTACK_RUNTIME_ALIAS}:4566`))
        .digest("hex"),
    },
  })).digest("hex")}` as const;
  return {
    id: recipe.id,
    environment,
    certification: recipe.certification,
    fingerprint,
    certificationImage: `${CERTIFICATION_IMAGE_REPOSITORY}:${fingerprint.slice("sha256:".length)}`,
  };
}

function arm64CertificationScript(lambdaEndpoint: string): string {
  const handler = [
    "import json, os",
    "import boto3",
    "def handler(event, _context):",
    "    endpoint = os.environ['AWS_ENDPOINT_URL']",
    "    common = {'endpoint_url': endpoint, 'region_name': 'us-east-1', 'aws_access_key_id': '999999999997', 'aws_secret_access_key': 'test'}",
    "    boto3.client('dynamodb', **common).put_item(TableName=event['table'], Item={'pk': {'S': 'lambda'}})",
    "    boto3.client('sqs', **common).send_message(QueueUrl=event['queue_url'], MessageBody='lambda')",
    "    return {'endpoint': endpoint, 'callback': True}",
  ].join("\n");
  return [
    "import io, json, platform, uuid, zipfile",
    "import asyncssh, boto3",
    "from botocore.config import Config",
    "from botocore.exceptions import ClientError",
    "from cryptography.hazmat.primitives.asymmetric import ed25519",
    "architecture = platform.machine().lower()",
    "assert architecture in ('aarch64', 'arm64'), architecture",
    "message = b'anbo-ministack-arm64-certification'",
    "private_key = ed25519.Ed25519PrivateKey.generate()",
    "private_key.public_key().verify(private_key.sign(message), message)",
    "common = {'endpoint_url': " + JSON.stringify(lambdaEndpoint) + ", 'region_name': 'us-east-1', 'aws_access_key_id': '999999999997', 'aws_secret_access_key': 'test'}",
    "suffix = uuid.uuid4().hex[:12]",
    "table_name = 'anbo-lambda-canary-' + suffix",
    "queue_name = table_name",
    "function_name = 'anbo-lambda-canary-' + suffix",
    "kms = boto3.client('kms', **common)",
    "ddb = boto3.client('dynamodb', **common)",
    "sqs = boto3.client('sqs', **common)",
    "lambdas = boto3.client('lambda', config=Config(connect_timeout=5, read_timeout=20, retries={'max_attempts': 0}), **common)",
    "not_found_codes = {'NotFoundException', 'ResourceNotFoundException', 'QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'}",
    "cleanup_errors = []",
    "def cleanup_resource(label, operation):",
    "    try:",
    "        operation()",
    "    except ClientError as error:",
    "        code = error.response.get('Error', {}).get('Code', '')",
    "        if code not in not_found_codes:",
    "            cleanup_errors.append(label + ': ' + (code + ': ' if code else '') + str(error))",
    "    except Exception as error:",
    "        cleanup_errors.append(label + ': ' + str(error))",
    "key_id = None",
    "queue_url = None",
    "probe_failure = None",
    "try:",
    "    key_id = kms.create_key(KeyUsage='ENCRYPT_DECRYPT', Description='anbo-ministack-arm64-certification-' + suffix)['KeyMetadata']['KeyId']",
    "    data_key = kms.generate_data_key(KeyId=key_id, KeySpec='AES_256')",
    "    assert len(data_key['Plaintext']) == 32 and len(data_key['CiphertextBlob']) > 0",
    "    ciphertext = kms.encrypt(KeyId=key_id, Plaintext=message)['CiphertextBlob']",
    "    assert kms.decrypt(CiphertextBlob=ciphertext)['Plaintext'] == message",
    "    ddb.create_table(TableName=table_name, KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}], AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'}], BillingMode='PAY_PER_REQUEST')",
    "    queue_url = sqs.create_queue(QueueName=queue_name)['QueueUrl']",
    "    archive = io.BytesIO()",
    "    with zipfile.ZipFile(archive, 'w') as bundle:",
    `        bundle.writestr('handler.py', ${JSON.stringify(handler)})`,
    "    lambdas.create_function(FunctionName=function_name, Runtime='python3.12', Role='arn:aws:iam::000000000000:role/anbo-lambda-canary', Handler='handler.handler', Code={'ZipFile': archive.getvalue()}, Environment={'Variables': {'AWS_ENDPOINT_URL': " + JSON.stringify(lambdaEndpoint) + ", 'ANBO_MINISTACK_ENDPOINT': " + JSON.stringify(lambdaEndpoint) + "}})",
    "    response = lambdas.invoke(FunctionName=function_name, InvocationType='RequestResponse', Payload=json.dumps({'table': table_name, 'queue_url': queue_url}).encode())",
    "    payload = json.loads(response['Payload'].read())",
    "    assert response['StatusCode'] == 200 and 'FunctionError' not in response, (response, payload)",
    "    assert payload == {'endpoint': " + JSON.stringify(lambdaEndpoint) + ", 'callback': True}, payload",
    "    assert ddb.get_item(TableName=table_name, Key={'pk': {'S': 'lambda'}}).get('Item') is not None",
    "    assert len(sqs.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=1).get('Messages', [])) == 1",
    "except Exception as error:",
    "    probe_failure = error",
    "finally:",
    "    cleanup_resource('lambda function', lambda: lambdas.delete_function(FunctionName=function_name))",
    "    if queue_url is None:",
    "        try:",
    "            queue_url = sqs.get_queue_url(QueueName=queue_name)['QueueUrl']",
    "        except ClientError as error:",
    "            code = error.response.get('Error', {}).get('Code', '')",
    "            if code not in not_found_codes:",
    "                cleanup_errors.append('SQS queue lookup: ' + (code + ': ' if code else '') + str(error))",
    "        except Exception as error:",
    "            cleanup_errors.append('SQS queue lookup: ' + str(error))",
    "    if queue_url is not None:",
    "        cleanup_resource('SQS queue', lambda: sqs.delete_queue(QueueUrl=queue_url))",
    "    cleanup_resource('DynamoDB table', lambda: ddb.delete_table(TableName=table_name))",
    "    if key_id is not None:",
    "        cleanup_resource('KMS key', lambda: kms.schedule_key_deletion(KeyId=key_id, PendingWindowInDays=7))",
    "if probe_failure is not None:",
    "    if cleanup_errors and hasattr(probe_failure, 'add_note'):",
    "        probe_failure.add_note('cleanup failures: ' + '; '.join(cleanup_errors))",
    "    raise probe_failure",
    "if cleanup_errors:",
    "    raise RuntimeError('certification cleanup failed: ' + '; '.join(cleanup_errors))",
    "print(json.dumps({'architecture': architecture, 'asyncssh': asyncssh.__version__, 'ed25519': True, 'kms': True, 'lambda_reentrant': True}, sort_keys=True))",
  ].join("\n");
}

async function certifyArm64Compatibility(options: {
  commands: CommandExecutor;
  containerName: string;
  image: string;
  runtimeImageId: string;
  compatibility: SelectedMiniStackCompatibility;
  runtimeNetworkName: string;
  lambdaEndpoint: string;
  signal: AbortSignal | undefined;
  redact: (text: string) => string;
}): Promise<boolean> {
  const cached = await options.commands.run(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", options.compatibility.certificationImage],
    signalOptions(options.signal),
  );
  if (cached.code === 0 && cached.stdout.trim() === options.runtimeImageId) return true;
  if (cached.code === 0) {
    await checked(
      options.commands,
      "docker",
      ["image", "rm", "--force", options.compatibility.certificationImage],
      signalOptions(options.signal),
    );
  } else {
    const detail = cached.stderr.trim() || cached.stdout.trim() || `exit code ${cached.code}`;
    if (!/(?:no such|not found)/i.test(detail)) {
      throw new Error(`could not inspect the MiniStack ARM64 certification cache: ${options.redact(detail)}`);
    }
  }

  const probeContainerName = `${options.containerName}-certification`;
  let probeFailure: unknown;
  try {
    const probe = await options.commands.run(
      "docker",
      [
        "run", "--rm", "--name", probeContainerName,
        "--platform", "linux/arm64",
        "--network", options.runtimeNetworkName,
        ...environmentArguments(options.compatibility.environment),
        "--entrypoint", "python",
        options.image,
        "-c", arm64CertificationScript(options.lambdaEndpoint),
      ],
      signalOptions(options.signal),
    );
    if (probe.code !== 0) {
      const detail = probe.stderr.trim() || probe.stdout.trim() || `exit code ${probe.code}`;
      throw new Error(
        `MiniStack ARM64 compatibility certification failed: ${boundedTail(options.redact(detail), 8_192)}`,
      );
    }
    const line = probe.stdout.trim().split("\n").filter(Boolean).at(-1);
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(line ?? "") as Record<string, unknown>;
    } catch {
      throw new Error("MiniStack ARM64 compatibility certification returned malformed evidence");
    }
    if ((result["architecture"] !== "aarch64" && result["architecture"] !== "arm64") ||
        typeof result["asyncssh"] !== "string" || result["ed25519"] !== true ||
        result["kms"] !== true || result["lambda_reentrant"] !== true) {
      throw new Error("MiniStack ARM64 compatibility certification returned incomplete evidence");
    }
  } catch (error) {
    probeFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    const cleanup = await options.commands.run(
      "docker",
      ["rm", "-f", probeContainerName],
      { cleanup: true },
    );
    const detail = cleanup.stderr.trim() || cleanup.stdout.trim() || `exit code ${cleanup.code}`;
    if (cleanup.code !== 0 && !/(?:no such|not found)/i.test(detail)) {
      throw new Error(`MiniStack ARM64 compatibility certification cleanup failed: ${options.redact(detail)}`);
    }
  } catch (error) {
    cleanupFailure = error;
  }
  if (probeFailure !== undefined) {
    if (cleanupFailure !== undefined && probeFailure instanceof Error) {
      Object.defineProperty(probeFailure, "cleanupFailure", {
        configurable: true,
        value: cleanupFailure,
      });
    }
    throw probeFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;

  await checked(
    options.commands,
    "docker",
    ["image", "tag", options.image, options.compatibility.certificationImage],
    signalOptions(options.signal),
  );
  const tagged = await checked(
    options.commands,
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", options.compatibility.certificationImage],
    signalOptions(options.signal),
  );
  if (tagged.stdout.trim() !== options.runtimeImageId) {
    await cleanupDocker(
      options.commands,
      ["image", "rm", "--force", options.compatibility.certificationImage],
      options.signal,
      true,
    );
    throw new Error("MiniStack ARM64 compatibility certification cache did not preserve the pinned image identity");
  }
  return false;
}

export async function pruneMiniStackCertification(
  commands: CommandExecutor = new ProcessCommandExecutor(),
  signal?: AbortSignal,
): Promise<void> {
  const compatibility = selectedCompatibility(CERTIFIED_MINISTACK_IMAGE, "linux/arm64");
  if (compatibility === undefined) return;
  await cleanupDocker(commands, ["image", "rm", "--force", compatibility.certificationImage], signal, true);
}

function selectMiniStackPlatform(
  image: string,
  serverPlatform: CertifiedMiniStackPlatform,
): CertifiedMiniStackPlatform {
  if (!isCertifiedMiniStackImage(image)) return serverPlatform;
  if (!CERTIFIED_MINISTACK_PLATFORMS.includes(serverPlatform)) {
    throw new Error(
      `The pinned MiniStack image index does not certify Docker server platform ${serverPlatform}; ` +
      `certified platforms: ${CERTIFIED_MINISTACK_PLATFORMS.join(", ")}`,
    );
  }
  return serverPlatform;
}

async function dockerServerPlatform(
  commands: CommandExecutor,
  signal?: AbortSignal,
): Promise<CertifiedMiniStackPlatform> {
  const result = await commands.run(
    "docker",
    ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
    signalOptions(signal),
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`could not determine Docker server platform: ${detail}`);
  }
  const reported = result.stdout.trim().toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    "linux/x86_64": "linux/amd64",
    "linux/aarch64": "linux/arm64",
  };
  const normalized = aliases[reported] ?? reported;
  if (!reported || reported.split("/").length !== 2) {
    throw new Error(
      `Docker server reported malformed platform ${reported || "<empty>"}; expected os/architecture`,
    );
  }
  if (normalized !== "linux/amd64" && normalized !== "linux/arm64") {
    throw new Error(
      `Docker server reported unsupported platform ${reported}; MiniStack requires linux/amd64 or linux/arm64`,
    );
  }
  return normalized;
}

async function stoppedContainerEvidence(
  commands: CommandExecutor,
  containerName: string,
  signal: AbortSignal | undefined,
  redact: (text: string) => string,
  selectedPlatform: CertifiedMiniStackPlatform,
  serverPlatform: CertifiedMiniStackPlatform,
): Promise<string | undefined> {
  const inspection = await commands.run("docker", ["inspect", containerName], signalOptions(signal));
  if (inspection.code !== 0) {
    const detail = inspection.stderr.trim() || inspection.stdout.trim() || `exit code ${inspection.code}`;
    if (/(?:no such|not found)/i.test(detail)) {
      return `MiniStack container disappeared before becoming ready: ${redact(detail)}`;
    }
    return undefined;
  }
  const inspected = parseDockerInspection(inspection.stdout);
  if (inspected.State?.Running !== false) return undefined;

  const exitCode = inspected.State.ExitCode ?? "unknown";
  const logs = await commands.run("docker", ["logs", "--tail", "80", containerName], signalOptions(signal));
  const rawLogs = [logs.stdout, logs.stderr].filter((value) => value.trim().length > 0).join("\n");
  const evidence = boundedTail(redact(rawLogs || "Docker returned no container logs."), 8_192);
  const stateError = inspected.State.Error?.trim();
  return [
    `MiniStack container exited before becoming ready (exit code ${exitCode}).`,
    `Container platform: selected=${selectedPlatform}, docker_server=${serverPlatform}.`,
    ...(stateError === undefined || stateError.length === 0 ? [] : [`Docker state: ${redact(stateError)}`]),
    `Recent container logs:\n${evidence}`,
  ].join("\n");
}

function boundedTail(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `[...truncated...]\n${value.slice(-maximumLength)}`;
}

function hasRuntimeIdentity(containerId: string | undefined, runtimeGeneration: string | undefined): boolean {
  return containerId !== undefined && containerId.trim().length > 0 &&
    runtimeGeneration !== undefined && runtimeGeneration.trim().length > 0;
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

function lambdaContainerFlags(
  configured: string | undefined,
  lambdaEndpoint: string,
  runtimeNetworkName: string,
): string {
  if (configured !== undefined && /(?:^|\s)--?(?:net|network)(?:=|\s|$)/i.test(configured)) {
    throw new Error("LAMBDA_DOCKER_FLAGS cannot override the Anbo-managed Docker network");
  }
  return [
    configured?.trim(),
    "--add-host host.docker.internal:host-gateway",
    `--env AWS_ENDPOINT_URL=${lambdaEndpoint}`,
    `--env ANBO_MINISTACK_ENDPOINT=${lambdaEndpoint}`,
    `--network ${runtimeNetworkName}`,
  ].filter(Boolean).join(" ");
}

function parseDockerInspection(value: string): {
  Id?: string;
  Image?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  State?: { Running?: boolean; ExitCode?: number; StartedAt?: string; Error?: string };
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
    Id?: string;
    Image?: string;
    Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
    State?: { Running?: boolean; ExitCode?: number; StartedAt?: string; Error?: string };
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
  platform: string;
  projectId: string;
  networkName: string;
  runtimeNetworkName: string;
  volumeName: string | undefined;
  lambdaEndpoint: string;
  lambdaDockerFlags: string;
  compatibility: SelectedMiniStackCompatibility | undefined;
}): string {
  const effectiveEnvironment: Record<string, string> = {
    DOCKER_NETWORK: options.runtimeNetworkName,
    LAMBDA_EXECUTOR: "docker",
    LAMBDA_STRICT: "1",
    LAMBDA_DOCKER_FLAGS: options.lambdaDockerFlags,
    MINISTACK_REGION: options.config.region ?? "us-east-1",
    MINISTACK_ACCOUNT_ID: options.config.accountId ?? "000000000000",
    ...(options.compatibility?.environment ?? {}),
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
        .filter(([key]) => key !== "LAMBDA_DOCKER_FLAGS" &&
          !MANAGED_RUNTIME_ENVIRONMENT.has(key) &&
          !(isCertifiedMiniStackImage(options.image) && Object.values(CERTIFIED_MINISTACK_COMPATIBILITY)
            .some((recipe) => Object.prototype.hasOwnProperty.call(recipe.environment, key)))),
    ),
  };
  const stableEnvironment = Object.fromEntries(
    Object.entries(effectiveEnvironment).sort(([left], [right]) => left.localeCompare(right)),
  );
  const createTimeConfiguration = {
    version: 3,
    project_id: options.projectId,
    image: options.image,
    platform: options.platform,
    compatibility_fingerprint: options.compatibility?.fingerprint ?? null,
    docker_socket: options.config.dockerSocket ?? "/var/run/docker.sock",
    persistence: options.config.persistence,
    volume_name: options.volumeName ?? null,
    networks: {
      control: options.networkName,
      runtime: options.runtimeNetworkName,
      runtime_alias: MINISTACK_RUNTIME_ALIAS,
    },
    port_binding: "127.0.0.1:dynamic:4566",
    host_gateway: "host.docker.internal:host-gateway",
    lambda_code_delivery: "docker-cp",
    lambda_endpoint: options.lambdaEndpoint,
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
