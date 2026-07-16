import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { CommandExecutor, RuntimeCommandOptions, RuntimeCommandResult } from "./ministack.js";
import { ProcessCommandExecutor, safeProjectId } from "./ministack.js";
import { assertTerraformTreeRoot, terraformLockCacheKey, terraformTreePathExcluded } from "./terraform-reconciliation.js";

/** Endpoint names published by MiniStack's Terraform v5/v6 configuration. */
export const MINISTACK_TERRAFORM_ENDPOINTS = [
  "acm", "apigateway", "appsync", "athena", "bedrock", "bedrockagent",
  "cloudformation", "cloudfront", "cloudwatch", "codebuild", "cognitoidentity",
  "cognitoidp", "dynamodb", "ec2", "ecr", "ecs", "efs", "elasticache", "elbv2",
  "emr", "events", "firehose", "glue", "iam", "kafka", "kinesis", "kms",
  "lambda", "logs", "rds", "route53", "s3", "s3control", "secretsmanager",
  "ses", "sesv2", "sns", "sqs", "ssm", "stepfunctions", "sts", "wafv2",
] as const;

export interface TerraformRunConfig {
  projectId?: string;
  projectDirectory: string;
  sourceDirectory: string;
  privateDirectory: string;
  statePath: string;
  pluginCacheDirectory: string;
  lockCacheDirectory?: string;
  excludedPaths?: readonly string[];
  cachedLockPath?: string;
  workerImage: string;
  networkName: string;
  miniStackEndpoint: string;
  region?: string;
  accountId?: string;
  variableFiles?: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  allowHostFallback?: boolean;
  signal?: AbortSignal;
}

export interface TerraformChangeSummary {
  create: number;
  update: number;
  delete: number;
  replace: number;
  noOp: number;
}

export interface TerraformRunResult {
  privateDirectory: string;
  planPath: string;
  statePath: string;
  changes: TerraformChangeSummary;
  outputs: Record<string, unknown>;
}

export interface TerraformDependencies {
  commands?: CommandExecutor;
  onOutput?: (stream: "stdout" | "stderr", text: string, phase: string) => void | Promise<void>;
  onLifecycle?: (event: TerraformLifecycleEvent) => void | Promise<void>;
}

export type TerraformLifecyclePhase =
  | "terraform.fingerprint"
  | "terraform.workspace.prepare"
  | "terraform.init"
  | "terraform.validate"
  | "terraform.plan"
  | "terraform.show"
  | "terraform.apply"
  | "terraform.output"
  | "terraform.cleanup";

export interface TerraformLifecycleEvent {
  phase: TerraformLifecyclePhase;
  status: "started" | "succeeded" | "failed" | "skipped";
  durationMs?: number;
  exitCode?: number;
  reason?: string;
}

export class TerraformPhaseError extends Error {
  constructor(readonly phase: TerraformLifecyclePhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TerraformPhaseError";
  }
}

interface HostIdentity {
  uid?: number;
  gid?: number;
}

interface TerraformWorkerSession {
  containerName: string;
  startAttempted: boolean;
  started: boolean;
}

interface HclToken {
  kind: "word" | "string" | "punctuation";
  value: string;
  start: number;
  end: number;
}

const TERRAFORM_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/i;
const FORBIDDEN_AWS_PROVIDER_FIELDS = new Set([
  "access_key", "secret_key", "token", "profile", "shared_config_files",
  "shared_credentials_files", "custom_ca_bundle", "ec2_metadata_service_endpoint",
  "http_proxy", "https_proxy", "insecure", "max_retries", "proxy", "endpoints",
]);

export function terraformWorkerUserArguments(identity: HostIdentity = currentHostIdentity()): string[] {
  if (!Number.isSafeInteger(identity.uid) || !Number.isSafeInteger(identity.gid) ||
      (identity.uid ?? -1) < 0 || (identity.gid ?? -1) < 0) {
    return [];
  }
  return ["--user", `${identity.uid}:${identity.gid}`];
}

export async function prepareTerraformWorkspace(config: TerraformRunConfig): Promise<void> {
  const source = resolve(config.sourceDirectory);
  const destination = resolve(config.privateDirectory);
  if (source === destination || destination.startsWith(source + sep)) {
    throw new Error("private Terraform workspace must be outside the source Terraform root");
  }
  await assertTerraformTreeRoot(config.projectDirectory, source);
  if ((await listTerraformFiles(source)).some((path) => basename(path) === "zz_anbo_ministack_override.tf")) {
    throw new Error("Terraform root contains reserved file zz_anbo_ministack_override.tf");
  }
  await validateTerraformTree(source);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: async (entry) => entry === source || !await terraformTreePathExcluded(entry, config.excludedPaths ?? []),
  });
  if (config.cachedLockPath !== undefined) {
    try {
      await writeFile(join(destination, ".terraform.lock.hcl"), await readFile(config.cachedLockPath), { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await replaceBackendsWithLocal(destination, `/anbo-state/${basename(config.statePath)}`);
  await writeMiniStackProviderOverride(
    destination,
    config.miniStackEndpoint,
    config.accountId ?? "000000000000",
  );
}

export async function runTerraform(
  config: TerraformRunConfig,
  dependencies: TerraformDependencies = {},
): Promise<TerraformRunResult> {
  if (!TERRAFORM_DIGEST_PATTERN.test(config.workerImage)) {
    throw new Error("Terraform worker image must be pinned with a sha256 digest");
  }
  if (config.allowHostFallback === true) {
    throw new Error("host Terraform fallback cannot provide network isolation and is intentionally unsupported");
  }
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  await assertTerraformTreeRoot(config.projectDirectory, config.sourceDirectory);
  await mkdir(config.pluginCacheDirectory, { recursive: true });
  const lockCacheDirectory = config.lockCacheDirectory ?? join(dirname(config.pluginCacheDirectory), "locks");
  const lockCacheKey = await terraformLockCacheKey(config.sourceDirectory, config.workerImage);
  const lockCachePath = lockCacheKey === undefined ? undefined : join(lockCacheDirectory, lockCacheKey, ".terraform.lock.hcl");
  if (lockCachePath !== undefined) await mkdir(dirname(lockCachePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(config.statePath), { recursive: true });
  await runLifecycleStep("terraform.workspace.prepare", dependencies.onLifecycle, async () => {
    await prepareTerraformWorkspace({ ...config, ...(lockCachePath === undefined ? {} : { cachedLockPath: lockCachePath }) });
  });

  const initEnvironment = scrubTerraformEnvironment(config.environment ?? process.env, false);
  const isolatedEnvironment = terraformMiniStackEnvironment(
    scrubTerraformEnvironment(config.environment ?? process.env, true),
    config.miniStackEndpoint,
    config.region ?? "us-east-1",
    config.accountId ?? "000000000000",
  );
  const worker: TerraformWorkerSession = {
    containerName: `anbo-terraform-${randomUUID().replaceAll("-", "")}`,
    startAttempted: false,
    started: false,
  };
  let primaryFailure: unknown;
  try {
    await runTerraformWorker(commands, config, worker, ["init", "-input=false", "-no-color"], {
      environment: initEnvironment,
      phase: "terraform.init",
      onOutput: dependencies.onOutput,
      onLifecycle: dependencies.onLifecycle,
    });
    if (lockCachePath !== undefined) await persistTerraformLock(join(config.privateDirectory, ".terraform.lock.hcl"), lockCachePath);
    await isolateTerraformWorkerNetwork(commands, config, worker);
    await runTerraformWorker(commands, config, worker, ["validate", "-no-color"], {
      environment: isolatedEnvironment,
      phase: "terraform.validate",
      onOutput: dependencies.onOutput,
      onLifecycle: dependencies.onLifecycle,
    });

    const planPath = join(config.privateDirectory, ".anbo.plan");
    const variableArguments = resolveVariableArguments(config);
    const plan = await runTerraformWorker(commands, config, worker, [
      "plan", "-input=false", "-no-color", "-compact-warnings", "-detailed-exitcode", "-out=/workspace/.anbo.plan",
      ...variableArguments,
    ], {
      environment: isolatedEnvironment,
      phase: "terraform.plan",
      allowedExitCodes: [0, 2],
      onLifecycle: dependencies.onLifecycle,
    });
    if (dependencies.onOutput !== undefined) {
      await dependencies.onOutput("stdout", summarizeTerraformPlan(plan.stdout, plan.code), "terraform.plan");
    }
    const changes = plan.code === 0
      ? emptyChangeSummary()
      : await inspectTerraformPlan(commands, config, worker, isolatedEnvironment, dependencies.onLifecycle);

    if (plan.code === 0) {
      await dependencies.onLifecycle?.({
        phase: "terraform.apply",
        status: "skipped",
        durationMs: 0,
        reason: "terraform_plan_empty",
      });
    } else {
      // Applying the saved filename, rather than re-planning, is a safety invariant.
      await runTerraformWorker(commands, config, worker, ["apply", "-input=false", "-no-color", "/workspace/.anbo.plan"], {
        environment: isolatedEnvironment,
        phase: "terraform.apply",
        onOutput: dependencies.onOutput,
        onLifecycle: dependencies.onLifecycle,
      });
    }
    const outputResult = await runTerraformWorker(commands, config, worker, ["output", "-json"], {
      environment: isolatedEnvironment,
      phase: "terraform.output",
      onLifecycle: dependencies.onLifecycle,
    });
    return {
      privateDirectory: config.privateDirectory,
      planPath,
      statePath: config.statePath,
      changes,
      outputs: parseTerraformOutputs(outputResult.stdout),
    };
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    try {
      await removeTerraformWorker(commands, worker);
    } catch (cleanupFailure) {
      if (primaryFailure === undefined) throw cleanupFailure;
      const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
      if (primaryFailure instanceof Error) {
        Object.defineProperty(primaryFailure, "cleanupFailure", {
          configurable: true,
          value: cleanupFailure,
        });
      }
      // Teardown failure is secondary: report it, but let the original
      // Terraform or cancellation error keep its phase and exit contract.
      await Promise.resolve(dependencies.onLifecycle?.({
        phase: "terraform.cleanup",
        status: "failed",
        durationMs: 0,
        reason: cleanupMessage,
      })).catch(() => undefined);
    }
  }
}

export async function removeProjectTerraformWorkers(
  projectId: string,
  commands: CommandExecutor = new ProcessCommandExecutor(),
  signal?: AbortSignal,
): Promise<void> {
  const options = signal === undefined ? {} : { signal };
  const listed = await commands.run("docker", [
    "ps", "-aq",
    "--filter", `label=anbo.dev/project=${safeProjectId(projectId)}`,
    "--filter", "label=anbo.dev/component=terraform-worker",
  ], options);
  if (listed.code !== 0) {
    const detail = listed.stderr.trim() || listed.stdout.trim() || `exit code ${listed.code}`;
    throw new Error(`could not list Terraform workers for cleanup: ${detail}`);
  }
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return;
  const removed = await commands.run("docker", ["rm", "-f", ...ids], options);
  if (removed.code !== 0) {
    const detail = removed.stderr.trim() || removed.stdout.trim() || `exit code ${removed.code}`;
    throw new Error(`could not remove Terraform workers: ${detail}`);
  }
}

function summarizeTerraformPlan(stdout: string, code: number): string {
  const plan = [...stdout.matchAll(/^Plan:\s+(.+)$/gm)].at(-1)?.[1];
  if (plan !== undefined) return `Terraform plan: ${plan}\n`;
  if (code === 0 || /No changes\./.test(stdout)) return "Terraform plan: no changes\n";
  return "Terraform plan completed with changes\n";
}

export function terraformMiniStackEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  endpoint: string,
  region: string,
  accountId: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...base,
    AWS_ACCESS_KEY_ID: accountId,
    AWS_SECRET_ACCESS_KEY: "anbo-ministack-only",
    AWS_DEFAULT_REGION: region,
    AWS_REGION: region,
    AWS_ENDPOINT_URL: endpoint,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SKIP_CREDENTIALS_VALIDATION: "true",
    AWS_SKIP_METADATA_API_CHECK: "true",
    AWS_SKIP_REQUESTING_ACCOUNT_ID: "true",
    AWS_S3_USE_PATH_STYLE: "true",
  };
  for (const service of MINISTACK_TERRAFORM_ENDPOINTS) {
    environment[`AWS_ENDPOINT_URL_${service.toUpperCase()}`] = endpoint;
  }
  return environment;
}

export function scrubTerraformEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  _includeTerraformVariables: boolean,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // This is deliberately an allowlist. In particular, ANBO_TOKEN, cloud clone
  // credentials, ambient AWS profiles, CI tokens, and TF_VAR_* never enter the worker.
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  result["TF_IN_AUTOMATION"] = "1";
  result["CHECKPOINT_DISABLE"] = "1";
  return result;
}

export async function validateTerraformTree(root: string): Promise<void> {
  const files = await listTerraformFiles(root);
  for (const path of files) {
    const content = await readFile(path, "utf8");
    if (path.endsWith(".tf.json")) {
      validateTerraformJson(JSON.parse(content) as unknown, path);
    } else {
      validateTerraformHcl(content, path);
    }
  }
}

export function validateTerraformHcl(content: string, path = "Terraform configuration"): void {
  const tokens = tokenizeHcl(content);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word") continue;
    if (token.value === "provisioner") {
      throw new Error(`${path} uses a provisioner; provisioners are not allowed in an isolated sandbox`);
    }
    if (token.value === "data") {
      const type = tokens[index + 1];
      if (type?.kind === "string" && (type.value === "external" || type.value === "terraform_remote_state")) {
        throw new Error(`${path} uses forbidden data source ${type.value}`);
      }
    }
    if (token.value === "module") {
      const openIndex = findNextToken(tokens, index + 1, "{");
      if (openIndex < 0) throw new Error(`${path} has a malformed module block`);
      const closeIndex = matchingBraceToken(tokens, openIndex);
      for (let inner = openIndex + 1; inner + 2 < closeIndex; inner += 1) {
        if (tokens[inner]?.value !== "source" || tokens[inner + 1]?.value !== "=") continue;
        const source = tokens[inner + 2];
        if (source?.kind === "string" && (source.value.startsWith("../") || source.value.startsWith("/"))) {
          throw new Error(`${path} references local module ${source.value} outside its Terraform root; configure the common parent as the root`);
        }
      }
    }
    if (token.value === "provider" && tokens[index + 1]?.value === "aws") {
      const openIndex = findNextToken(tokens, index + 2, "{");
      if (openIndex < 0) throw new Error(`${path} has a malformed AWS provider block`);
      const closeIndex = matchingBraceToken(tokens, openIndex);
      for (let inner = openIndex + 1; inner < closeIndex; inner += 1) {
        const candidate = tokens[inner];
        if (candidate?.kind === "word" && FORBIDDEN_AWS_PROVIDER_FIELDS.has(candidate.value)) {
          throw new Error(`${path} configures aws provider ${candidate.value}; Anbo must exclusively control credentials and endpoints`);
        }
      }
      index = closeIndex;
    }
  }
}

export function parseTerraformOutputs(output: string): Record<string, unknown> {
  const parsed = JSON.parse(output) as unknown;
  if (!isRecord(parsed)) throw new Error("terraform output -json returned an object with an unexpected shape");
  const outputs: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(parsed)) {
    if (!isRecord(raw) || !("value" in raw)) throw new Error(`Terraform output ${name} was malformed`);
    // Terraform's sensitivity bit is the source of truth. Missing or malformed
    // metadata is treated as sensitive so persistence fails closed.
    if (raw["sensitive"] !== false) continue;
    outputs[name] = raw["value"];
  }
  return outputs;
}

async function runTerraformWorker(
  commands: CommandExecutor,
  config: TerraformRunConfig,
  worker: TerraformWorkerSession,
  terraformArgs: readonly string[],
  options: {
    environment: NodeJS.ProcessEnv;
    phase: string;
    onOutput?: (stream: "stdout" | "stderr", text: string, phase: string) => void | Promise<void>;
    onLifecycle?: (event: TerraformLifecycleEvent) => void | Promise<void>;
    allowedExitCodes?: readonly number[];
  },
): Promise<RuntimeCommandResult> {
  const commandOptions: RuntimeCommandOptions = {
    ...(config.signal === undefined ? {} : { signal: config.signal }),
    ...(options.onOutput === undefined ? {} : { onOutput: (stream: "stdout" | "stderr", text: string) => options.onOutput?.(stream, text, options.phase) }),
  };
  const phase = options.phase as TerraformLifecyclePhase;
  await options.onLifecycle?.({ phase, status: "started" });
  const started = performance.now();
  let result: RuntimeCommandResult | undefined;
  try {
    if (!worker.started) await startTerraformWorker(commands, config, worker, commandOptions);
    const args = [
      "exec",
      ...dockerEnvironmentArguments(options.environment),
      worker.containerName,
      "terraform",
      ...terraformArgs,
    ];
    result = await commands.run("docker", args, commandOptions);
    const allowed = options.allowedExitCodes ?? [0];
    if (!allowed.includes(result.code)) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      throw new Error(`${options.phase} failed: ${detail}`);
    }
    await options.onLifecycle?.({
      phase,
      status: "succeeded",
      durationMs: elapsedMilliseconds(started),
      exitCode: result.code,
    });
    return result;
  } catch (cause) {
    await options.onLifecycle?.({
      phase,
      status: "failed",
      durationMs: elapsedMilliseconds(started),
      ...(result === undefined ? {} : { exitCode: result.code }),
    });
    throw cause instanceof TerraformPhaseError ? cause : new TerraformPhaseError(phase, cause);
  }
}

async function startTerraformWorker(
  commands: CommandExecutor,
  config: TerraformRunConfig,
  worker: TerraformWorkerSession,
  options: RuntimeCommandOptions,
): Promise<void> {
  const startOptions = options.signal === undefined ? {} : { signal: options.signal };
  // The daemon can create the named container before the Docker client is
  // cancelled or loses its response. Cleanup must therefore key off the
  // attempt, not only a successful client return.
  worker.startAttempted = true;
  const result = await commands.run("docker", [
    "run", "--detach", "--rm", "--name", worker.containerName,
    "--network", "bridge",
    ...terraformWorkerUserArguments(),
    "--label", "anbo.dev/managed=true",
    "--label", "anbo.dev/component=terraform-worker",
    ...(config.projectId === undefined ? [] : ["--label", `anbo.dev/project=${safeProjectId(config.projectId)}`]),
    "--mount", `type=bind,src=${resolve(config.privateDirectory)},dst=/workspace`,
    "--mount", `type=bind,src=${resolve(config.pluginCacheDirectory)},dst=/terraform-cache`,
    "--mount", `type=bind,src=${resolve(dirname(config.statePath))},dst=/anbo-state`,
    "--workdir", "/workspace",
    "--env", "HOME=/tmp",
    "--env", "TF_PLUGIN_CACHE_DIR=/terraform-cache",
    "--entrypoint", "/bin/sh",
    config.workerImage,
    "-c", "while :; do sleep 3600; done",
  ], startOptions);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`could not start Terraform worker: ${detail}`);
  }
  worker.started = true;
}

async function isolateTerraformWorkerNetwork(
  commands: CommandExecutor,
  config: TerraformRunConfig,
  worker: TerraformWorkerSession,
): Promise<void> {
  if (!worker.started || config.networkName === "bridge") return;
  const options = config.signal === undefined ? {} : { signal: config.signal };
  const connected = await commands.run("docker", ["network", "connect", config.networkName, worker.containerName], options);
  if (connected.code !== 0) {
    throw new Error(`could not connect Terraform worker to isolated network: ${connected.stderr.trim() || connected.stdout.trim()}`);
  }
  const disconnected = await commands.run("docker", ["network", "disconnect", "bridge", worker.containerName], options);
  if (disconnected.code !== 0) {
    throw new Error(`could not remove Terraform worker egress network: ${disconnected.stderr.trim() || disconnected.stdout.trim()}`);
  }
}

async function removeTerraformWorker(commands: CommandExecutor, worker: TerraformWorkerSession): Promise<void> {
  if (!worker.startAttempted) return;
  const removed = await commands.run("docker", ["rm", "-f", worker.containerName], { cleanup: true });
  if (removed.code !== 0) {
    const detail = removed.stderr.trim() || removed.stdout.trim() || `exit code ${removed.code}`;
    if (!/(?:no such|not found)/i.test(detail)) {
      throw new Error(`could not remove Terraform worker ${worker.containerName}: ${detail}`);
    }
  }
  worker.startAttempted = false;
  worker.started = false;
}

async function persistTerraformLock(source: string, destination: string): Promise<void> {
  let contents: Buffer;
  try { contents = await readFile(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function currentHostIdentity(): HostIdentity {
  return {
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
    ...(typeof process.getgid === "function" ? { gid: process.getgid() } : {}),
  };
}

async function inspectTerraformPlan(
  commands: CommandExecutor,
  config: TerraformRunConfig,
  worker: TerraformWorkerSession,
  environment: NodeJS.ProcessEnv,
  onLifecycle?: (event: TerraformLifecycleEvent) => void | Promise<void>,
): Promise<TerraformChangeSummary> {
  const result = await runTerraformWorker(commands, config, worker, ["show", "-json", "/workspace/.anbo.plan"], {
    environment,
    phase: "terraform.show",
    ...(onLifecycle === undefined ? {} : { onLifecycle }),
  });
  const plan = JSON.parse(result.stdout) as unknown;
  if (!isRecord(plan) || !Array.isArray(plan["resource_changes"])) return emptyChangeSummary();
  const summary = emptyChangeSummary();
  for (const change of plan["resource_changes"]) {
    if (!isRecord(change) || !isRecord(change["change"]) || !Array.isArray(change["change"]["actions"])) continue;
    const actions = change["change"]["actions"];
    if (actions.includes("delete") && actions.includes("create")) summary.replace += 1;
    else if (actions.includes("create")) summary.create += 1;
    else if (actions.includes("update")) summary.update += 1;
    else if (actions.includes("delete")) summary.delete += 1;
    else summary.noOp += 1;
  }
  return summary;
}

async function runLifecycleStep<T>(
  phase: TerraformLifecyclePhase,
  onLifecycle: TerraformDependencies["onLifecycle"],
  operation: () => Promise<T>,
): Promise<T> {
  await onLifecycle?.({ phase, status: "started" });
  const started = performance.now();
  try {
    const result = await operation();
    await onLifecycle?.({ phase, status: "succeeded", durationMs: elapsedMilliseconds(started) });
    return result;
  } catch (cause) {
    await onLifecycle?.({ phase, status: "failed", durationMs: elapsedMilliseconds(started) });
    throw cause instanceof TerraformPhaseError ? cause : new TerraformPhaseError(phase, cause);
  }
}

function elapsedMilliseconds(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function resolveVariableArguments(config: TerraformRunConfig): string[] {
  return (config.variableFiles ?? []).map((path) => {
    const absolute = resolve(config.sourceDirectory, path);
    const withinRoot = relative(resolve(config.sourceDirectory), absolute);
    if (withinRoot.startsWith(".." + sep) || isAbsolute(withinRoot)) {
      throw new Error(`Terraform variable file must be inside its Terraform root: ${path}`);
    }
    return `-var-file=/workspace/${withinRoot.split(sep).join("/")}`;
  });
}

function dockerEnvironmentArguments(environment: NodeJS.ProcessEnv): string[] {
  const allowed = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return allowed.flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

async function replaceBackendsWithLocal(root: string, statePath: string): Promise<void> {
  const files = await listTerraformFiles(root);
  let replacements = 0;
  for (const path of files) {
    const content = await readFile(path, "utf8");
    if (path.endsWith(".tf.json")) {
      const parsed = JSON.parse(content) as unknown;
      if (!isRecord(parsed)) continue;
      const terraform = parsed["terraform"];
      if (isRecord(terraform) && "backend" in terraform) {
        terraform["backend"] = { local: { path: statePath } };
        await writeFile(path, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
        replacements += 1;
      }
      continue;
    }
    const rewritten = rewriteHclBackends(content, statePath);
    if (rewritten.replacements > 0) {
      await writeFile(path, rewritten.content, { mode: 0o600 });
      replacements += rewritten.replacements;
    }
  }
  if (replacements === 0) {
    await writeFile(
      join(root, "anbo_backend_override.tf.json"),
      JSON.stringify({ terraform: { backend: { local: { path: statePath } } } }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}

async function writeMiniStackProviderOverride(root: string, endpoint: string, accountId: string): Promise<void> {
  const aliases = await findAwsProviderAliases(root);
  const endpointLines = MINISTACK_TERRAFORM_ENDPOINTS
    .map((service) => `    ${service.padEnd(15)} = ${JSON.stringify(endpoint)}`)
    .join("\n");
  const providerBlocks = [undefined, ...aliases].map((alias) => [
    `provider "aws" {`,
    ...(alias === undefined ? [] : [`  alias                       = ${JSON.stringify(alias)}`]),
    `  access_key                  = ${JSON.stringify(accountId)}`,
    `  secret_key                  = "anbo-ministack-only"`,
    `  s3_use_path_style           = true`,
    `  skip_credentials_validation = true`,
    `  skip_metadata_api_check     = true`,
    `  skip_requesting_account_id  = true`,
    `  endpoints {`,
    endpointLines,
    `  }`,
    `}`,
  ].join("\n"));
  await writeFile(
    join(root, "zz_anbo_ministack_override.tf"),
    `# Generated in Anbo's private workspace. Do not copy this into production.\n${providerBlocks.join("\n\n")}\n`,
    { mode: 0o600 },
  );
}

async function findAwsProviderAliases(root: string): Promise<string[]> {
  const aliases = new Set<string>();
  for (const path of await listTerraformFiles(root)) {
    if (basename(path) === "zz_anbo_ministack_override.tf") continue;
    const content = await readFile(path, "utf8");
    if (path.endsWith(".tf.json")) {
      const value = JSON.parse(content) as unknown;
      if (!isRecord(value) || !isRecord(value["provider"])) continue;
      const aws = value["provider"]["aws"];
      for (const provider of Array.isArray(aws) ? aws : [aws]) {
        if (isRecord(provider) && typeof provider["alias"] === "string") aliases.add(provider["alias"]);
      }
      continue;
    }
    const tokens = tokenizeHcl(content);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.value !== "provider" || tokens[index + 1]?.value !== "aws") continue;
      const openIndex = findNextToken(tokens, index + 2, "{");
      if (openIndex < 0) continue;
      const closeIndex = matchingBraceToken(tokens, openIndex);
      for (let inner = openIndex + 1; inner + 2 < closeIndex; inner += 1) {
        if (tokens[inner]?.value !== "alias" || tokens[inner + 1]?.value !== "=") continue;
        const alias = tokens[inner + 2];
        if (alias?.kind !== "string") throw new Error(`${path} uses a non-literal AWS provider alias`);
        aliases.add(alias.value);
      }
      index = closeIndex;
    }
  }
  return [...aliases].sort();
}

function rewriteHclBackends(content: string, statePath: string): { content: string; replacements: number } {
  const tokens = tokenizeHcl(content);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "terraform") continue;
    const terraformOpen = findNextToken(tokens, index + 1, "{");
    if (terraformOpen < 0) continue;
    const terraformClose = matchingBraceToken(tokens, terraformOpen);
    for (let inner = terraformOpen + 1; inner < terraformClose; inner += 1) {
      if (tokens[inner]?.value !== "backend") continue;
      const backendOpen = findNextToken(tokens, inner + 1, "{");
      if (backendOpen < 0 || backendOpen >= terraformClose) continue;
      const backendClose = matchingBraceToken(tokens, backendOpen);
      ranges.push({ start: tokens[inner]?.start ?? 0, end: tokens[backendClose]?.end ?? 0 });
      inner = backendClose;
    }
    index = terraformClose;
  }
  let rewritten = content;
  const replacement = `backend "local" { path = ${JSON.stringify(statePath)} }`;
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    rewritten = rewritten.slice(0, range.start) + replacement + rewritten.slice(range.end);
  }
  return { content: rewritten, replacements: ranges.length };
}

function validateTerraformJson(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`${path} must contain a Terraform JSON object`);
  if ("provisioner" in value) throw new Error(`${path} uses a provisioner; provisioners are not allowed`);
  const data = value["data"];
  if (isRecord(data) && ("external" in data || "terraform_remote_state" in data)) {
    throw new Error(`${path} uses a forbidden data source`);
  }
  const provider = value["provider"];
  if (isRecord(provider) && "aws" in provider) {
    const awsProviders = Array.isArray(provider["aws"]) ? provider["aws"] : [provider["aws"]];
    for (const aws of awsProviders) {
      if (!isRecord(aws)) continue;
      for (const field of Object.keys(aws)) {
        if (FORBIDDEN_AWS_PROVIDER_FIELDS.has(field)) {
          throw new Error(`${path} configures aws provider ${field}; Anbo controls credentials and endpoints`);
        }
      }
    }
  }
  walkJson(value, (key) => {
    if (key === "provisioner") throw new Error(`${path} uses a provisioner; provisioners are not allowed`);
  });
}

function walkJson(value: unknown, visitor: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visitor);
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      visitor(key);
      walkJson(child, visitor);
    }
  }
}

async function listTerraformFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".terraform" || entry.name === ".anbo" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listTerraformFiles(path));
    else if (entry.isFile() && (entry.name.endsWith(".tf") || entry.name.endsWith(".tf.json"))) files.push(path);
  }
  return files;
}

function tokenizeHcl(content: string): HclToken[] {
  const tokens: HclToken[] = [];
  let index = 0;
  while (index < content.length) {
    const character = content[index] ?? "";
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === "#" || (character === "/" && content[index + 1] === "/")) {
      const newline = content.indexOf("\n", index);
      index = newline < 0 ? content.length : newline + 1;
      continue;
    }
    if (character === "/" && content[index + 1] === "*") {
      const close = content.indexOf("*/", index + 2);
      index = close < 0 ? content.length : close + 2;
      continue;
    }
    if (character === '"') {
      const start = index;
      index += 1;
      let value = "";
      while (index < content.length) {
        const current = content[index] ?? "";
        if (current === "\\") {
          value += current + (content[index + 1] ?? "");
          index += 2;
        } else if (current === '"') {
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      tokens.push({ kind: "string", value, start, end: index });
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(character)) {
      const start = index;
      while (index < content.length && /[A-Za-z0-9_.-]/.test(content[index] ?? "")) index += 1;
      tokens.push({ kind: "word", value: content.slice(start, index), start, end: index });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function findNextToken(tokens: readonly HclToken[], start: number, value: string): number {
  for (let index = start; index < tokens.length; index += 1) if (tokens[index]?.value === value) return index;
  return -1;
}

function matchingBraceToken(tokens: readonly HclToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "{") depth += 1;
    if (tokens[index]?.value === "}") depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error("Terraform configuration contains an unclosed block");
}

function emptyChangeSummary(): TerraformChangeSummary {
  return { create: 0, update: 0, delete: 0, replace: 0, noOp: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
