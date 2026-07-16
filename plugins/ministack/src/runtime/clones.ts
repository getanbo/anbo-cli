import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloneConfig, SecretReference } from "../types.js";
import type { CommandExecutor } from "./ministack.js";
import { ProcessCommandExecutor, safeProjectId } from "./ministack.js";

export type CloneEngine = "postgres" | "dynamodb";

export interface CloneMetadata {
  engine: CloneEngine;
  provider: "anbo-cloud" | "external";
  branch_id: string;
  branch_name: string;
  source?: string;
  source_revision?: string;
  expires_at?: string;
  owned: boolean;
}

export interface PostgresCloneLease {
  engine: "postgres";
  metadata: CloneMetadata;
  databaseUrl: string;
}

export interface DynamoDbCloneLease {
  engine: "dynamodb";
  metadata: CloneMetadata;
  endpointUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt?: string;
  supportedApiLevel?: string;
  tables: string[];
}

export type CloneLease = PostgresCloneLease | DynamoDbCloneLease;

export class AmbiguousCloneCreateError extends Error {
  readonly branchName: string;

  constructor(engine: CloneEngine, branchName: string, cause: unknown) {
    super(
      `${engine} clone create may have succeeded but ownership could not be confirmed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "AmbiguousCloneCreateError";
    this.branchName = branchName;
  }
}

const CONTAINER_HOSTNAME = "host.docker.internal";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);
const SECURE_POSTGRES_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Returns the clone endpoint as seen from a Docker container. External clone
 * endpoints may intentionally refer to a service on the host; cloud-issued
 * endpoints must be preserved byte-for-byte.
 */
export function cloneEndpointForContainer(lease: CloneLease): string {
  const endpoint = lease.engine === "postgres" ? lease.databaseUrl : lease.endpointUrl;
  if (lease.metadata.provider !== "external") return endpoint;

  const parsed = new URL(endpoint);
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return endpoint;
  parsed.hostname = CONTAINER_HOSTNAME;
  return parsed.toString();
}

export interface CloneState {
  version: 1;
  project_id: string;
  clones: Partial<Record<CloneEngine, CloneMetadata>>;
}

export interface CloneAcquireRequest {
  projectId: string;
  engine: CloneEngine;
  config: CloneConfig;
  statePath: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  apiUrl?: string;
  tokenReference?: SecretReference;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /**
   * Cancels reusable readiness/credential work without interrupting the cloud
   * create request before its branch ownership can be persisted.
   */
  readinessSignal?: AbortSignal;
}

export interface CloneDependencies {
  fetch?: typeof globalThis.fetch;
  commands?: CommandExecutor;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onStatus?: (status: string, metadata?: CloneMetadata) => void;
  registerSecret?: (value: string) => void;
  resolveSecret?: (reference: SecretReference) => Promise<string>;
}

interface CloudBranch {
  id: string;
  name: string;
  status: string;
  ready: boolean;
  source?: { type: CloneEngine; link: string };
  created_at?: string;
  expires_at?: string;
  source_revision?: string;
}

interface DynamoCredentials {
  version: 1;
  branch_id: string;
  branch_name: string;
  endpoint_url: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expires_at: string;
  supported_api_level: string;
  tables: string[];
}

const SECRET_FIELD_PATTERN = /(?:token|password|secret|credential|database_url|authorization)/i;
const cloneStateUpdateChains = new Map<string, Promise<void>>();

export async function acquireClone(
  request: CloneAcquireRequest,
  dependencies: CloneDependencies = {},
): Promise<CloneLease> {
  if (request.config.provider === "external") {
    return await acquireExternalClone(request, dependencies);
  }
  return await acquireCloudClone(request, dependencies);
}

export async function acquireConfiguredClones(
  request: Omit<CloneAcquireRequest, "engine" | "config"> & {
    postgres?: CloneConfig;
    dynamodb?: CloneConfig;
  },
  dependencies: CloneDependencies = {},
): Promise<Partial<Record<CloneEngine, CloneLease>>> {
  const work: Array<Promise<[CloneEngine, CloneLease]>> = [];
  const siblingAbort = new AbortController();
  const readinessSignal = AbortSignal.any([
    ...(request.signal === undefined ? [] : [request.signal]),
    ...(request.readinessSignal === undefined ? [] : [request.readinessSignal]),
    siblingAbort.signal,
  ]);
  let hasFailure = false;
  let firstFailure: unknown;
  const acquire = (engine: CloneEngine, config: CloneConfig): Promise<[CloneEngine, CloneLease]> =>
    acquireClone({ ...request, engine, config, readinessSignal }, dependencies)
      .then((lease): [CloneEngine, CloneLease] => [engine, lease])
      .catch((cause: unknown) => {
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = cause;
          siblingAbort.abort(cause);
        }
        throw cause;
      });
  if (request.postgres !== undefined) {
    work.push(acquire("postgres", request.postgres));
  }
  if (request.dynamodb !== undefined) {
    work.push(acquire("dynamodb", request.dynamodb));
  }
  const settled = await Promise.allSettled(work);
  if (hasFailure) throw firstFailure;
  return Object.fromEntries(settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  )) as Partial<Record<CloneEngine, CloneLease>>;
}

export async function purgeOwnedClones(
  options: {
    statePath: string;
    apiUrl: string;
    token: string;
    signal?: AbortSignal;
  },
  dependencies: CloneDependencies = {},
): Promise<void> {
  const state = await readCloneState(options.statePath);
  if (state === undefined) return;
  await Promise.all(Object.values(state.clones).map(async (metadata) => {
    if (metadata?.owned !== true) return;
    await cloudRequest(
      dependencies.fetch ?? globalThis.fetch,
      options.apiUrl,
      options.token,
      "DELETE",
      `/v1/branches/${encodeURIComponent(metadata.branch_id)}`,
      undefined,
      options.signal,
    );
  }));
  await writeCloneState(options.statePath, { ...state, clones: {} });
}

export async function resetOwnedClones(
  request: Omit<CloneAcquireRequest, "engine" | "config"> & {
    postgres?: CloneConfig;
    dynamodb?: CloneConfig;
    apiUrl: string;
    tokenReference: SecretReference;
  },
  dependencies: CloneDependencies = {},
): Promise<Partial<Record<CloneEngine, CloneLease>>> {
  const token = await resolveCloneSecret(request.tokenReference, request, dependencies);
  dependencies.registerSecret?.(token);
  await purgeOwnedClones({
    statePath: request.statePath,
    apiUrl: request.apiUrl,
    token,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }, dependencies);
  return await acquireConfiguredClones(request, dependencies);
}

export async function readCloneState(path: string): Promise<CloneState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value) || value["version"] !== 1 || typeof value["project_id"] !== "string" || !isRecord(value["clones"])) {
      throw new Error("clone state is malformed");
    }
    assertNoSecrets(value);
    return value as unknown as CloneState;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeCloneState(path: string, state: CloneState): Promise<void> {
  assertNoSecrets(state);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export async function resolveSecretReference(
  reference: SecretReference,
  environment: Readonly<NodeJS.ProcessEnv>,
  commandExecutor: CommandExecutor = new ProcessCommandExecutor(),
): Promise<string> {
  if (reference.startsWith("env://")) {
    const name = reference.slice("env://".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment secret reference ${reference}`);
    const value = environment[name];
    if (value === undefined || value.length === 0) throw new Error(`secret environment variable ${name} is not set`);
    return value;
  }
  if (reference.startsWith("exec://")) {
    const specification = decodeURIComponent(reference.slice("exec://".length));
    const argv = parseExecReference(specification);
    const command = argv.shift();
    if (command === undefined || command.length === 0) throw new Error("exec secret reference has no executable");
    const result = await commandExecutor.run(command, argv, { env: { ...environment } });
    if (result.code !== 0) throw new Error(`credential process failed with exit code ${result.code}`);
    const value = result.stdout.replace(/[\r\n]+$/, "");
    if (value.length === 0) throw new Error("credential process returned an empty secret");
    return value;
  }
  throw new Error("unsupported secret reference");
}

async function acquireExternalClone(
  request: CloneAcquireRequest,
  dependencies: CloneDependencies,
): Promise<CloneLease> {
  const branchName = `${safeProjectId(request.projectId)}-${request.engine}-external`;
  const metadata: CloneMetadata = {
    engine: request.engine,
    provider: "external",
    branch_id: branchName,
    branch_name: branchName,
    ...(request.config.source === undefined ? {} : { source: request.config.source }),
    owned: false,
  };
  if (request.engine === "postgres") {
    if (request.config.endpoint === undefined) throw new Error("external PostgreSQL clone requires endpoint secret reference");
    const databaseUrl = await resolveCloneSecret(request.config.endpoint, request, dependencies);
    assertPostgresUrl(databaseUrl);
    dependencies.registerSecret?.(databaseUrl);
    await updateCloneMetadata(request.statePath, request.projectId, metadata);
    dependencies.onStatus?.("ready", metadata);
    return { engine: "postgres", metadata, databaseUrl };
  }

  if (request.config.endpoint === undefined) throw new Error("external DynamoDB clone requires endpoint secret reference");
  const endpointUrl = await resolveCloneSecret(request.config.endpoint, request, dependencies);
  assertHttpEndpoint(endpointUrl);
  const credentials = request.config.credentials ?? {};
  const accessKeyId = await requiredCredential(credentials, "access_key_id", request, dependencies);
  const secretAccessKey = await requiredCredential(credentials, "secret_access_key", request, dependencies);
  const sessionToken = credentials["session_token"] === undefined
    ? ""
    : await resolveCloneSecret(credentials["session_token"], request, dependencies);
  dependencies.registerSecret?.(endpointUrl);
  dependencies.registerSecret?.(accessKeyId);
  dependencies.registerSecret?.(secretAccessKey);
  dependencies.registerSecret?.(sessionToken);
  await updateCloneMetadata(request.statePath, request.projectId, metadata);
  dependencies.onStatus?.("ready", metadata);
  return {
    engine: "dynamodb",
    metadata,
    endpointUrl,
    region: request.config.region ?? "us-east-1",
    accessKeyId,
    secretAccessKey,
    sessionToken,
    tables: [],
  };
}

async function acquireCloudClone(
  request: CloneAcquireRequest,
  dependencies: CloneDependencies,
): Promise<CloneLease> {
  if (request.config.source === undefined || request.config.source.length === 0) {
    throw new Error(`anbo-cloud ${request.engine} clone requires a source`);
  }
  const apiUrl = request.apiUrl ?? request.environment["ANBO_API_URL"];
  if (apiUrl === undefined) throw new Error("anbo-cloud clone requires ANBO_API_URL");
  assertHttpEndpoint(apiUrl);
  const tokenReference = request.tokenReference ?? "env://ANBO_TOKEN";
  const token = await resolveCloneSecret(tokenReference, request, dependencies);
  dependencies.registerSecret?.(token);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const state = await readCloneState(request.statePath);
  const existing = state?.clones[request.engine];
  let branch: CloudBranch | undefined;
  const readinessSignal = request.readinessSignal ?? request.signal;
  if (existing !== undefined && existing.provider === "anbo-cloud" && existing.source === request.config.source &&
      !expiresSoon(existing.expires_at, dependencies.now?.() ?? Date.now())) {
    try {
      branch = await cloudRequest<CloudBranch>(fetcher, apiUrl, token, "GET", `/v1/branches/${encodeURIComponent(existing.branch_id)}`, undefined, readinessSignal);
      assertBranch(branch, request.engine, request.config.source);
      dependencies.onStatus?.("reused", existing);
    } catch {
      branch = undefined;
    }
  }
  if (branch === undefined) {
    throwIfAborted(readinessSignal);
    dependencies.onStatus?.("requesting");
    const branchName = `${safeProjectId(request.projectId)}-${request.engine}`;
    try {
      branch = await cloudRequest<CloudBranch>(fetcher, apiUrl, token, "POST", "/v1/branches", {
        name: branchName,
        from: request.config.source,
        ...(request.config.ttl_seconds === undefined ? {} : { ttl_seconds: request.config.ttl_seconds }),
      }, request.signal);
      assertBranch(branch, request.engine, request.config.source);
      // Persist ownership before readiness polling. If the caller is cancelled
      // after the create response, the next run reuses or purges this exact
      // branch instead of issuing a duplicate create.
      await updateCloneMetadata(
        request.statePath,
        request.projectId,
        cloudCloneMetadata(request, branch, true),
      );
    } catch (cause) {
      throw new AmbiguousCloneCreateError(request.engine, branchName, cause);
    }
  }
  branch = await waitForReady(branch, request, apiUrl, token, fetcher, dependencies, readinessSignal);
  const metadata = cloudCloneMetadata(
    request,
    branch,
    existing?.branch_id === branch.id ? existing.owned : true,
  );
  await updateCloneMetadata(request.statePath, request.projectId, metadata);
  dependencies.onStatus?.("ready", metadata);
  if (request.engine === "postgres") {
    const value = await cloudRequest<unknown>(fetcher, apiUrl, token, "GET", `/v1/branches/${encodeURIComponent(branch.id)}/url`, undefined, readinessSignal);
    if (!isRecord(value) || typeof value["database_url"] !== "string") throw new Error("PostgreSQL clone credential response was malformed");
    assertPostgresUrl(value["database_url"]);
    dependencies.registerSecret?.(value["database_url"]);
    return { engine: "postgres", metadata, databaseUrl: value["database_url"] };
  }
  const value = await cloudRequest<DynamoCredentials>(fetcher, apiUrl, token, "POST", `/v1/branches/${encodeURIComponent(branch.id)}/dynamodb/credentials`, {}, readinessSignal);
  assertDynamoCredentials(value, branch, dependencies.now?.() ?? Date.now());
  dependencies.registerSecret?.(value.endpoint_url);
  dependencies.registerSecret?.(value.access_key_id);
  dependencies.registerSecret?.(value.secret_access_key);
  dependencies.registerSecret?.(value.session_token);
  return {
    engine: "dynamodb",
    metadata: { ...metadata, expires_at: value.expires_at },
    endpointUrl: value.endpoint_url,
    region: value.region,
    accessKeyId: value.access_key_id,
    secretAccessKey: value.secret_access_key,
    sessionToken: value.session_token,
    expiresAt: value.expires_at,
    supportedApiLevel: value.supported_api_level,
    tables: [...value.tables],
  };
}

function cloudCloneMetadata(
  request: CloneAcquireRequest,
  branch: CloudBranch,
  owned: boolean,
): CloneMetadata {
  return {
    engine: request.engine,
    provider: "anbo-cloud",
    branch_id: branch.id,
    branch_name: branch.name,
    ...(request.config.source === undefined ? {} : { source: request.config.source }),
    ...(branch.source_revision === undefined ? {} : { source_revision: branch.source_revision }),
    ...(branch.expires_at === undefined ? {} : { expires_at: branch.expires_at }),
    owned,
  };
}

async function waitForReady(
  initial: CloudBranch,
  request: CloneAcquireRequest,
  apiUrl: string,
  token: string,
  fetcher: typeof globalThis.fetch,
  dependencies: CloneDependencies,
  signal?: AbortSignal,
): Promise<CloudBranch> {
  let branch = initial;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (request.timeoutMs ?? 600_000);
  while (!branch.ready) {
    throwIfAborted(signal);
    if (["failed", "deleted", "deleting"].includes(branch.status)) {
      throw new Error(`clone branch ${branch.id} reached terminal status ${branch.status}`);
    }
    if (now() >= deadline) throw new Error(`timed out waiting for clone branch ${branch.id}; last status ${branch.status}`);
    dependencies.onStatus?.(branch.status);
    await abortableSleep(sleep, request.pollIntervalMs ?? 2_000, signal);
    branch = await cloudRequest<CloudBranch>(fetcher, apiUrl, token, "GET", `/v1/branches/${encodeURIComponent(branch.id)}`, undefined, signal);
    assertBranch(branch, request.engine, request.config.source ?? "");
  }
  return branch;
}

async function abortableSleep(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await sleep(milliseconds);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void sleep(milliseconds).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function updateCloneMetadata(path: string, projectId: string, metadata: CloneMetadata): Promise<void> {
  await serializeCloneStateUpdate(path, async () => {
    const state = await readCloneState(path) ?? { version: 1, project_id: projectId, clones: {} };
    if (state.project_id !== projectId) throw new Error("clone state belongs to another project");
    await writeCloneState(path, { ...state, clones: { ...state.clones, [metadata.engine]: metadata } });
  });
}

async function serializeCloneStateUpdate(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = cloneStateUpdateChains.get(path) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  cloneStateUpdateChains.set(path, tail);
  try {
    await result;
  } finally {
    if (cloneStateUpdateChains.get(path) === tail) cloneStateUpdateChains.delete(path);
  }
}

async function cloudRequest<T>(
  fetcher: typeof globalThis.fetch,
  apiUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const base = apiUrl.replace(/\/+$/, "");
  const response = await fetcher(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  let value: unknown = {};
  if (text.length > 0) {
    try { value = JSON.parse(text) as unknown; } catch { value = {}; }
  }
  if (!response.ok) {
    const message = isRecord(value) && typeof value["error"] === "string" ? value["error"] : `HTTP ${response.status}`;
    throw new Error(`clone API ${method} ${path} failed: ${redactApiText(message)}`);
  }
  return value as T;
}

function assertBranch(value: CloudBranch, engine: CloneEngine, source: string): void {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
      typeof value.status !== "string" || typeof value.ready !== "boolean") {
    throw new Error("clone API branch response was malformed");
  }
  if (value.source !== undefined && (value.source.type !== engine || value.source.link !== source)) {
    throw new Error("clone API returned a branch for a different source");
  }
}

function assertDynamoCredentials(value: DynamoCredentials, branch: CloudBranch, now: number): void {
  if (!isRecord(value) || value.version !== 1 || value.branch_id !== branch.id || value.branch_name !== branch.name ||
      typeof value.endpoint_url !== "string" || typeof value.region !== "string" ||
      typeof value.access_key_id !== "string" || typeof value.secret_access_key !== "string" ||
      typeof value.session_token !== "string" || typeof value.expires_at !== "string" ||
      typeof value.supported_api_level !== "string" || !Array.isArray(value.tables) ||
      !value.tables.every((table) => typeof table === "string")) {
    throw new Error("DynamoDB clone credential response was malformed");
  }
  if (!Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= now) {
    throw new Error("DynamoDB clone credential lease is expired or malformed");
  }
  assertHttpEndpoint(value.endpoint_url);
}

function assertPostgresUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("PostgreSQL clone URL is malformed"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("PostgreSQL clone URL must use postgres protocol");
  if (url.hostname.length === 0) throw new Error("PostgreSQL clone URL has no host");
  const local = LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
  const sslModes = url.searchParams.getAll("sslmode").map((mode) => mode.toLowerCase());
  if (!local && (sslModes.length !== 1 || !SECURE_POSTGRES_SSL_MODES.has(sslModes[0] ?? ""))) {
    throw new Error("PostgreSQL clone URL must set sslmode=require, verify-ca, or verify-full outside local development");
  }
}

function assertHttpEndpoint(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("clone endpoint is malformed"); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("clone endpoint must use HTTPS outside local development");
  }
  if (url.username.length > 0 || url.password.length > 0) throw new Error("HTTP clone endpoint must not embed credentials");
}

async function requiredCredential(
  credentials: Record<string, SecretReference>,
  name: string,
  request: CloneAcquireRequest,
  dependencies: CloneDependencies,
): Promise<string> {
  const reference = credentials[name];
  if (reference === undefined) throw new Error(`external DynamoDB clone requires ${name} credential reference`);
  return await resolveCloneSecret(reference, request, dependencies);
}

async function resolveCloneSecret(
  reference: SecretReference,
  request: Pick<CloneAcquireRequest, "environment">,
  dependencies: CloneDependencies,
): Promise<string> {
  return dependencies.resolveSecret === undefined
    ? await resolveSecretReference(reference, request.environment, dependencies.commands)
    : await dependencies.resolveSecret(reference);
}

function expiresSoon(value: string | undefined, now: number): boolean {
  if (value === undefined) return false;
  const expiry = Date.parse(value);
  return !Number.isFinite(expiry) || expiry <= now + 60_000;
}

function assertNoSecrets(value: unknown, path = "state"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSecrets(child, `${path}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_FIELD_PATTERN.test(key)) throw new Error(`refusing to persist secret field ${path}.${key}`);
      if (typeof child === "string" && /^(?:postgres(?:ql)?:\/\/|Bearer\s+)/i.test(child)) {
        throw new Error(`refusing to persist secret value ${path}.${key}`);
      }
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

function redactApiText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[REDACTED]")
    .replace(/(?:token|secret|password)=\S+/gi, "$1=[REDACTED]");
}

function parseExecReference(value: string): string[] {
  if (value.trim().startsWith("[")) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string")) {
      throw new Error("exec secret JSON reference must be a string array");
    }
    return parsed;
  }
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && value[index + 1] !== undefined) current += value[++index];
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current.length > 0) { parts.push(current); current = ""; }
    } else {
      current += character;
    }
  }
  if (quote !== undefined) throw new Error("exec secret reference contains an unclosed quote");
  if (current.length > 0) parts.push(current);
  return parts;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
