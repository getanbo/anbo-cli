import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

import type { AdapterConfig, SecretReference } from "./types.js";

export const ADAPTER_PROTOCOL_VERSION = 2 as const;

export type AdapterAction =
  | "handshake"
  | "discover"
  | "impact"
  | "configure"
  | "acquire"
  | "renew"
  | "health"
  | "reset"
  | "release"
  | "test"
  | "teardown";

export interface AdapterRequest {
  schema_version: typeof ADAPTER_PROTOCOL_VERSION;
  action: AdapterAction;
  project_id: string;
  project_root: string;
  run_id: string;
  payload: Record<string, unknown>;
}

export interface AdapterDiagnostic {
  code: string;
  level: "warning" | "error";
  message: string;
  remediation?: string;
  retryable?: boolean;
}

export interface AdapterBinding {
  name: string;
  kind: string;
  endpoint?: string;
  secret_handle?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export type AdapterImpactNodeKind =
  | "adapter"
  | "build"
  | "terraform"
  | "clone"
  | "service"
  | "test";

/**
 * Adapter-contributed nodes use the same wire format as the host impact graph.
 * IDs are globally namespaced as `<kind>:<name>`; adapters should include their
 * own name in `<name>` when the node is not intentionally shared.
 */
export interface AdapterImpactNode {
  id: string;
  kind: AdapterImpactNodeKind;
  fingerprint: `sha256:${string}`;
  dependencies?: string[];
  certainty?: "exact" | "unknown";
  issues?: string[];
  cacheable?: boolean;
  always_run?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AdapterImpact {
  nodes: AdapterImpactNode[];
}

export interface AdapterResponse {
  schema_version: typeof ADAPTER_PROTOCOL_VERSION;
  adapter: string;
  capabilities: string[];
  bindings: AdapterBinding[];
  diagnostics: AdapterDiagnostic[];
  state?: Record<string, unknown>;
  impact?: AdapterImpact;
}

export interface AdapterInvocationOptions {
  root: string;
  parentEnvironment: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  resolveSecret: (reference: SecretReference) => Promise<string>;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

export async function invokeAdapter(
  name: string,
  config: AdapterConfig,
  request: AdapterRequest,
  options: AdapterInvocationOptions,
): Promise<AdapterResponse> {
  if ((config.protocol ?? ADAPTER_PROTOCOL_VERSION) !== ADAPTER_PROTOCOL_VERSION) {
    throw new Error(`Adapter ${name} must use protocol ${ADAPTER_PROTOCOL_VERSION}`);
  }
  await verifyAdapterDigest(config, options.root);
  const environment = await adapterEnvironment(config, options);
  const executable = isAbsolute(config.executable)
    ? config.executable
    : config.executable.includes("/")
      ? resolve(options.root, config.executable)
      : config.executable;

  return await new Promise<AdapterResponse>((resolveResponse, reject) => {
    const child = spawn(executable, config.args ?? [], {
      cwd: options.root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Adapter ${name} exceeded ${options.timeoutMs ?? 30_000}ms`));
    }, options.timeoutMs ?? 30_000);
    timeout.unref();

    let stdout = "";
    let stderr = "";
    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024 || Buffer.byteLength(stderr) > 4 * 1024 * 1024) {
        child.kill("SIGTERM");
        reject(new Error(`Adapter ${name} exceeded its output limit`));
        return;
      }
      void options.onOutput?.(stream, text);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.once("error", (error) => {
      reject(new Error(`Adapter ${name} could not receive its request: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Adapter ${name} exited ${code ?? signal ?? "unknown"}: ${stderr.trim().slice(-2_000)}`));
        return;
      }
      try {
        resolveResponse(validateAdapterResponse(name, JSON.parse(stdout)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function verifyAdapterDigest(config: AdapterConfig, root: string): Promise<void> {
  if (config.digest === undefined) return;
  if (!config.executable.includes("/") && !isAbsolute(config.executable)) {
    throw new Error("Digest-pinned adapters must use an explicit executable path");
  }
  const path = isAbsolute(config.executable) ? config.executable : resolve(root, config.executable);
  const digest = `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  if (digest !== config.digest) throw new Error(`Adapter executable digest mismatch: expected ${config.digest}, received ${digest}`);
}

async function adapterEnvironment(
  config: AdapterConfig,
  options: AdapterInvocationOptions,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    PATH: options.parentEnvironment.PATH?.split(delimiter).join(delimiter),
    HOME: options.parentEnvironment.HOME,
    TMPDIR: options.parentEnvironment.TMPDIR,
    ANBO_ADAPTER_PROTOCOL: String(ADAPTER_PROTOCOL_VERSION),
  };
  for (const [key, reference] of Object.entries(config.environment ?? {})) {
    environment[key] = await options.resolveSecret(reference);
  }
  return environment;
}

function validateAdapterResponse(name: string, value: unknown): AdapterResponse {
  if (!isRecord(value) || value.schema_version !== ADAPTER_PROTOCOL_VERSION || typeof value.adapter !== "string") {
    throw new Error(`Adapter ${name} returned an invalid protocol response`);
  }
  if (!stringArray(value.capabilities) || !Array.isArray(value.bindings) || !Array.isArray(value.diagnostics)) {
    throw new Error(`Adapter ${name} returned invalid capabilities, bindings, or diagnostics`);
  }
  for (const capability of value.capabilities) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(capability)) throw new Error(`Adapter ${name} returned invalid capability ${capability}`);
  }
  for (const binding of value.bindings) {
    if (!isRecord(binding) || typeof binding.name !== "string" || typeof binding.kind !== "string") {
      throw new Error(`Adapter ${name} returned an invalid binding`);
    }
  }
  for (const diagnostic of value.diagnostics) {
    if (!isRecord(diagnostic)
      || typeof diagnostic.code !== "string"
      || (diagnostic.level !== "warning" && diagnostic.level !== "error")
      || typeof diagnostic.message !== "string") {
      throw new Error(`Adapter ${name} returned an invalid diagnostic`);
    }
  }
  if (value.impact !== undefined) validateAdapterImpact(name, value.impact);
  return value as unknown as AdapterResponse;
}

const IMPACT_NODE_KINDS = new Set<AdapterImpactNodeKind>([
  "adapter",
  "build",
  "terraform",
  "clone",
  "service",
  "test",
]);
const IMPACT_DEPENDENCY_KINDS = new Set([...IMPACT_NODE_KINDS, "runtime"]);
const IMPACT_FIELDS = new Set([
  "id",
  "kind",
  "fingerprint",
  "dependencies",
  "certainty",
  "issues",
  "cacheable",
  "always_run",
  "metadata",
]);
const IMPACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMPACT_NODE_ID = /^([a-z]+):([^\s:\0][^\s\0]*)$/;

function validateAdapterImpact(name: string, value: unknown): asserts value is AdapterImpact {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "nodes") || !Array.isArray(value.nodes)) {
    throw new Error(`Adapter ${name} returned invalid impact metadata`);
  }
  const ids = new Set<string>();
  for (const candidate of value.nodes) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !IMPACT_FIELDS.has(key))) {
      throw new Error(`Adapter ${name} returned an invalid impact node`);
    }
    const kind = candidate.kind;
    const id = candidate.id;
    if (typeof id !== "string" || typeof kind !== "string" || !IMPACT_NODE_KINDS.has(kind as AdapterImpactNodeKind)) {
      throw new Error(`Adapter ${name} returned an impact node with an invalid namespaced id or kind`);
    }
    const match = IMPACT_NODE_ID.exec(id);
    if (match === null || match[1] !== kind) {
      throw new Error(`Adapter ${name} returned an impact node with an invalid namespaced id or kind`);
    }
    if (ids.has(id)) throw new Error(`Adapter ${name} returned duplicate impact node ${id}`);
    ids.add(id);
    if (typeof candidate.fingerprint !== "string" || !IMPACT_DIGEST.test(candidate.fingerprint)) {
      throw new Error(`Adapter ${name} returned impact node ${id} with an invalid sha256 fingerprint`);
    }
    if (candidate.certainty !== undefined && candidate.certainty !== "exact" && candidate.certainty !== "unknown") {
      throw new Error(`Adapter ${name} returned impact node ${id} with invalid certainty`);
    }
    if (candidate.dependencies !== undefined) {
      validateImpactReferences(name, id, candidate.dependencies);
    }
    if (candidate.issues !== undefined && !nonEmptyStringArray(candidate.issues)) {
      throw new Error(`Adapter ${name} returned impact node ${id} with invalid issues`);
    }
    if (candidate.certainty === "unknown"
      && (candidate.issues === undefined || (candidate.issues as unknown[]).length === 0)) {
      throw new Error(`Adapter ${name} returned impact node ${id} without an issue explaining unknown certainty`);
    }
    if (candidate.cacheable !== undefined && typeof candidate.cacheable !== "boolean") {
      throw new Error(`Adapter ${name} returned impact node ${id} with invalid cacheable metadata`);
    }
    if (candidate.always_run !== undefined && typeof candidate.always_run !== "boolean") {
      throw new Error(`Adapter ${name} returned impact node ${id} with invalid always_run metadata`);
    }
    if (candidate.metadata !== undefined && !isRecord(candidate.metadata)) {
      throw new Error(`Adapter ${name} returned impact node ${id} with invalid metadata`);
    }
  }
}

function validateImpactReferences(name: string, nodeId: string, value: unknown): asserts value is string[] {
  if (!stringArray(value) || new Set(value).size !== value.length) {
    throw new Error(`Adapter ${name} returned impact node ${nodeId} with invalid dependencies`);
  }
  for (const dependency of value) {
    const match = IMPACT_NODE_ID.exec(dependency);
    if (match === null || !IMPACT_DEPENDENCY_KINDS.has(match[1]!)) {
      throw new Error(`Adapter ${name} returned impact node ${nodeId} with invalid dependency ${dependency}`);
    }
  }
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
