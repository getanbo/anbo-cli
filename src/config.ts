import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ANBO_MANIFEST_VERSION,
  AnboError,
  ExitCode,
  type CloneConfig,
  type DiscoveryReport,
  type SandboxManifest,
  type SecretReference
} from "./types.js";
import { routeTerraformVariableFiles } from "./terraform-layout.js";
import { CERTIFIED_MINISTACK_DIGEST, CERTIFIED_MINISTACK_IMAGE } from "./distribution.js";

export const DEFAULT_MANIFEST_PATH = ".anbo/sandbox.json";
export const DEFAULT_MINISTACK_IMAGE = CERTIFIED_MINISTACK_IMAGE;
export const DEFAULT_MINISTACK_DIGEST = CERTIFIED_MINISTACK_DIGEST;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SECRET_REFERENCE = /^(?:env:\/\/[A-Za-z_][A-Za-z0-9_]*|exec:\/\/.+)$/;

export interface ConfigureResult {
  manifest: SandboxManifest;
  manifestPath: string;
  created: boolean;
  discovery: DiscoveryReport;
}

export function resolveManifestPath(root: string, input = DEFAULT_MANIFEST_PATH): string {
  const projectRoot = resolve(root);
  const candidate = resolve(projectRoot, input);
  const rel = relative(projectRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw configError(`manifest path must remain inside the project root: ${input}`, "ANBO_CONFIG_PATH_OUTSIDE_ROOT");
  }
  return candidate;
}

export function loadManifest(root: string, input = DEFAULT_MANIFEST_PATH): { manifest: SandboxManifest; path: string } {
  const path = resolveManifestPath(root, input);
  if (!existsSync(path)) {
    throw configError(
      `sandbox manifest not found at ${path}; run \`anbo configure\` first`,
      "ANBO_CONFIG_NOT_FOUND",
      "Run anbo configure from the project root."
    );
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw configError(`sandbox manifest must be a regular, non-symlink file: ${path}`, "ANBO_CONFIG_UNSAFE_FILE");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (cause) {
    throw configError(`sandbox manifest is not valid JSON: ${path}`, "ANBO_CONFIG_INVALID_JSON", undefined, cause);
  }
  return { manifest: parseManifest(value), path };
}

export function parseManifest(value: unknown): SandboxManifest {
  const root = objectAt(value, "$", [
    "$schema",
    "schema_version",
    "project",
    "terraform",
    "data",
    "services",
    "builds",
    "tests",
    "ministack",
    "network",
    "adapters"
  ]);
  if (root["schema_version"] !== ANBO_MANIFEST_VERSION) {
    fail("$.schema_version", `must equal ${ANBO_MANIFEST_VERSION}`);
  }
  if (root["$schema"] !== undefined) stringAt(root["$schema"], "$.$schema");

  const project = objectAt(root["project"], "$.project", ["name", "id"]);
  identifierAt(project["name"], "$.project.name");
  if (project["id"] !== undefined) identifierAt(project["id"], "$.project.id");

  const terraform = objectAt(root["terraform"], "$.terraform", ["roots", "variable_files"]);
  const roots = stringArrayAt(terraform["roots"], "$.terraform.roots", { min: 1 });
  roots.forEach((path, index) => relativePathAt(path, `$.terraform.roots[${index}]`));
  const variableFiles = stringArrayAt(terraform["variable_files"], "$.terraform.variable_files");
  variableFiles.forEach((path, index) => relativePathAt(path, `$.terraform.variable_files[${index}]`));
  uniqueAt(roots, "$.terraform.roots");
  uniqueAt(variableFiles, "$.terraform.variable_files");
  try {
    routeTerraformVariableFiles(resolve(sep), roots, variableFiles);
  } catch (cause) {
    fail("$.terraform.variable_files", cause instanceof Error ? cause.message : String(cause));
  }

  const data = objectAt(root["data"], "$.data", ["postgres", "dynamodb"]);
  if (data["postgres"] !== undefined) cloneAt(data["postgres"], "$.data.postgres", "postgres");
  if (data["dynamodb"] !== undefined) cloneAt(data["dynamodb"], "$.data.dynamodb", "dynamodb");

  const builds = recordAt(root["builds"], "$.builds", (entry, path) => {
    const build = objectAt(entry, path, ["context", "inputs", "dockerfile", "target", "platform", "args", "command", "outputs"]);
    relativePathAt(build["context"], `${path}.context`);
    if (build["inputs"] !== undefined) {
      const inputs = stringArrayAt(build["inputs"], `${path}.inputs`, { min: 1 });
      inputs.forEach((input, index) => relativePathAt(input, `${path}.inputs[${index}]`));
      uniqueAt(inputs, `${path}.inputs`);
    }
    optionalRelativePathAt(build["dockerfile"], `${path}.dockerfile`);
    optionalStringAt(build["target"], `${path}.target`);
    optionalStringAt(build["platform"], `${path}.platform`);
    if (build["args"] !== undefined) stringRecordAt(build["args"], `${path}.args`);
    optionalCommandAt(build["command"], `${path}.command`);
    if (build["outputs"] !== undefined) {
      const outputs = stringArrayAt(build["outputs"], `${path}.outputs`, { min: 1 });
      outputs.forEach((output, index) => relativePathAt(output, `${path}.outputs[${index}]`));
      uniqueAt(outputs, `${path}.outputs`);
    }
    if (build["dockerfile"] === undefined && build["command"] === undefined) {
      fail(path, "must define dockerfile or command");
    }
  });

  const services = recordAt(root["services"], "$.services", (entry, path) => {
    const service = objectAt(entry, path, [
      "build", "image", "command", "working_directory", "environment", "ports", "depends_on", "healthcheck", "dynamodb_plane"
    ]);
    optionalStringAt(service["build"], `${path}.build`);
    optionalStringAt(service["image"], `${path}.image`);
    if (service["build"] === undefined && service["image"] === undefined) {
      fail(path, "must define build or image");
    }
    if (service["build"] !== undefined && service["image"] !== undefined) {
      fail(path, "cannot define both build and image");
    }
    if (service["build"] !== undefined && !Object.hasOwn(builds, service["build"] as string)) {
      fail(`${path}.build`, `references unknown build ${String(service["build"])}`);
    }
    optionalCommandAt(service["command"], `${path}.command`);
    optionalRelativePathAt(service["working_directory"], `${path}.working_directory`);
    if (service["environment"] !== undefined) {
      const environment = stringRecordAt(service["environment"], `${path}.environment`);
      validateRuntimeEnvironment(environment, `${path}.environment`);
    }
    if (service["ports"] !== undefined) portsAt(service["ports"], `${path}.ports`);
    if (service["depends_on"] !== undefined) stringArrayAt(service["depends_on"], `${path}.depends_on`);
    if (service["healthcheck"] !== undefined) healthcheckAt(service["healthcheck"], `${path}.healthcheck`);
    if (service["dynamodb_plane"] !== undefined && service["dynamodb_plane"] !== "clone" && service["dynamodb_plane"] !== "ministack") {
      fail(`${path}.dynamodb_plane`, "must be clone or ministack");
    }
  });
  for (const [name, entry] of Object.entries(services)) {
    const dependsOn = (entry as { depends_on?: string[] }).depends_on ?? [];
    for (const dependency of dependsOn) {
      if (!Object.hasOwn(services, dependency)) fail(`$.services.${name}.depends_on`, `references unknown service ${dependency}`);
      if (dependency === name) fail(`$.services.${name}.depends_on`, "cannot depend on itself");
    }
  }

  const tests = recordAt(root["tests"], "$.tests", (entry, path) => {
    const test = objectAt(entry, path, ["command", "service", "environment", "depends_on", "timeout_seconds", "default"]);
    commandAt(test["command"], `${path}.command`);
    if (test["service"] !== undefined) {
      const service = stringAt(test["service"], `${path}.service`);
      if (!Object.hasOwn(services, service)) fail(`${path}.service`, `references unknown service ${service}`);
    }
    if (test["environment"] !== undefined) {
      validateRuntimeEnvironment(stringRecordAt(test["environment"], `${path}.environment`), `${path}.environment`);
    }
    if (test["depends_on"] !== undefined) {
      for (const service of stringArrayAt(test["depends_on"], `${path}.depends_on`)) {
        if (!Object.hasOwn(services, service)) fail(`${path}.depends_on`, `references unknown service ${service}`);
      }
    }
    optionalPositiveIntegerAt(test["timeout_seconds"], `${path}.timeout_seconds`);
    optionalBooleanAt(test["default"], `${path}.default`);
  });
  void tests;

  const ministack = objectAt(root["ministack"], "$.ministack", ["image", "digest", "profile", "persistence", "environment"]);
  const image = stringAt(ministack["image"], "$.ministack.image");
  if (!/^(?:[^@\s]+:[^@\s]+(?:@sha256:[a-f0-9]{64})?|[^@\s]+@sha256:[a-f0-9]{64})$/.test(image)) {
    fail("$.ministack.image", "must use an explicit tag or immutable sha256 reference");
  }
  if (ministack["digest"] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(stringAt(ministack["digest"], "$.ministack.digest"))) {
    fail("$.ministack.digest", "must be a sha256 digest");
  }
  if (ministack["profile"] !== "full") fail("$.ministack.profile", "must equal full");
  booleanAt(ministack["persistence"], "$.ministack.persistence");
  if (ministack["environment"] !== undefined) stringRecordAt(ministack["environment"], "$.ministack.environment");

  const network = objectAt(root["network"], "$.network", ["allow_hosts", "clone_egress"]);
  uniqueAt(stringArrayAt(network["allow_hosts"], "$.network.allow_hosts"), "$.network.allow_hosts");
  booleanAt(network["clone_egress"], "$.network.clone_egress");

  recordAt(root["adapters"], "$.adapters", (entry, path) => {
    const adapter = objectAt(entry, path, ["executable", "protocol", "digest", "args", "capabilities", "environment", "allowed_hosts"]);
    const executable = stringAt(adapter["executable"], `${path}.executable`);
    if (isAbsolute(executable)) fail(`${path}.executable`, "must be a PATH command or project-relative path, not an absolute path");
    if (adapter["protocol"] !== undefined && adapter["protocol"] !== 2) fail(`${path}.protocol`, "must equal 2");
    if (adapter["digest"] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(stringAt(adapter["digest"], `${path}.digest`))) {
      fail(`${path}.digest`, "must be a sha256 digest");
    }
    if (adapter["args"] !== undefined) stringArrayAt(adapter["args"], `${path}.args`);
    if (adapter["capabilities"] !== undefined) uniqueAt(stringArrayAt(adapter["capabilities"], `${path}.capabilities`), `${path}.capabilities`);
    if (adapter["environment"] !== undefined) {
      const environment = stringRecordAt(adapter["environment"], `${path}.environment`);
      for (const [key, reference] of Object.entries(environment)) secretReferenceAt(reference, `${path}.environment.${key}`);
    }
    if (adapter["allowed_hosts"] !== undefined) uniqueAt(stringArrayAt(adapter["allowed_hosts"], `${path}.allowed_hosts`), `${path}.allowed_hosts`);
  });

  return value as SandboxManifest;
}

export function createDefaultManifest(discovery: DiscoveryReport): SandboxManifest {
  const projectName = safeIdentifier(basename(discovery.root));
  const builds: SandboxManifest["builds"] = {};
  for (const dockerfile of discovery.dockerfiles) {
    let name = safeIdentifier(dockerfile.context === "." ? projectName : dockerfile.context.replaceAll("/", "-"));
    let suffix = 2;
    while (Object.hasOwn(builds, name)) name = `${safeIdentifier(projectName)}-${suffix++}`;
    builds[name] = { context: dockerfile.context, dockerfile: relative(dockerfile.context, dockerfile.path) || basename(dockerfile.path) };
  }
  return {
    $schema: "https://raw.githubusercontent.com/getanbo/anbo-plugin-ministack/v0.1.0/schemas/sandbox.v2.schema.json",
    schema_version: ANBO_MANIFEST_VERSION,
    project: { name: projectName },
    terraform: {
      roots: discovery.terraform.length === 0 ? ["."] : discovery.terraform.map((entry) => entry.path),
      variable_files: discovery.terraform.flatMap((entry) => entry.variable_files).sort()
    },
    data: {},
    services: {},
    builds,
    tests: {},
    ministack: {
      image: DEFAULT_MINISTACK_IMAGE,
      digest: DEFAULT_MINISTACK_DIGEST,
      profile: "full",
      persistence: true
    },
    network: { allow_hosts: [], clone_egress: true },
    adapters: {}
  };
}

export function writeManifest(path: string, manifest: SandboxManifest, options: { overwrite?: boolean } = {}): void {
  parseManifest(manifest);
  if (existsSync(path) && options.overwrite !== true) {
    throw configError(`sandbox manifest already exists at ${path}`, "ANBO_CONFIG_EXISTS");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function cloneAt(value: unknown, path: string, kind: "postgres" | "dynamodb"): CloneConfig {
  const clone = objectAt(value, path, ["provider", "source", "endpoint", "credentials", "region", "ttl_seconds", "retain_on_down"]);
  if (clone["provider"] !== "anbo-cloud" && clone["provider"] !== "external") {
    fail(`${path}.provider`, "must be anbo-cloud or external");
  }
  if (clone["source"] !== undefined) identifierAt(clone["source"], `${path}.source`);
  if (clone["endpoint"] !== undefined) secretReferenceAt(clone["endpoint"], `${path}.endpoint`);
  if (clone["credentials"] !== undefined) {
    const credentials = stringRecordAt(clone["credentials"], `${path}.credentials`);
    for (const [key, reference] of Object.entries(credentials)) secretReferenceAt(reference, `${path}.credentials.${key}`);
  }
  if (clone["region"] !== undefined) stringAt(clone["region"], `${path}.region`);
  optionalPositiveIntegerAt(clone["ttl_seconds"], `${path}.ttl_seconds`);
  optionalBooleanAt(clone["retain_on_down"], `${path}.retain_on_down`);
  if (clone["provider"] === "anbo-cloud" && clone["source"] === undefined) {
    fail(`${path}.source`, "is required for provider anbo-cloud");
  }
  if (clone["provider"] === "external" && clone["endpoint"] === undefined) {
    fail(`${path}.endpoint`, "is required for provider external and must be an env:// or exec:// reference");
  }
  if (kind === "dynamodb" && clone["region"] === undefined) {
    fail(`${path}.region`, "is required for DynamoDB clones");
  }
  return clone as unknown as CloneConfig;
}

function objectAt(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const result = value as Record<string, unknown>;
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(result)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}`, "is not a supported property");
  }
  return result;
}

function recordAt(
  value: unknown,
  path: string,
  validate: (entry: unknown, entryPath: string) => void
): Record<string, unknown> {
  const record = objectAt(value, path, Object.keys((value ?? {}) as object));
  for (const [name, entry] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    identifierAt(name, `${path} key`);
    validate(entry, `${path}.${name}`);
  }
  return record;
}

function stringRecordAt(value: unknown, path: string): Record<string, string> {
  const record = objectAt(value, path, Object.keys((value ?? {}) as object));
  for (const [key, entry] of Object.entries(record)) stringAt(entry, `${path}.${key}`);
  return record as Record<string, string>;
}

function healthcheckAt(value: unknown, path: string): void {
  const check = objectAt(value, path, ["type", "url", "port", "command", "timeout_seconds", "interval_seconds"]);
  optionalPositiveIntegerAt(check["timeout_seconds"], `${path}.timeout_seconds`);
  optionalPositiveIntegerAt(check["interval_seconds"], `${path}.interval_seconds`);
  if (check["type"] === "http") {
    const url = stringAt(check["url"], `${path}.url`);
    if (!/^https?:\/\//.test(url)) fail(`${path}.url`, "must be an http:// or https:// URL");
  } else if (check["type"] === "tcp") {
    portNumberAt(check["port"], `${path}.port`);
  } else if (check["type"] === "command") {
    commandAt(check["command"], `${path}.command`);
  } else {
    fail(`${path}.type`, "must be http, tcp, or command");
  }
}

function portsAt(value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path, "must be an array");
  value.forEach((entry, index) => {
    const port = objectAt(entry, `${path}[${index}]`, ["container", "host", "protocol"]);
    portNumberAt(port["container"], `${path}[${index}].container`);
    if (port["host"] !== undefined) portNumberAt(port["host"], `${path}[${index}].host`);
    if (port["protocol"] !== undefined && port["protocol"] !== "tcp" && port["protocol"] !== "udp") {
      fail(`${path}[${index}].protocol`, "must be tcp or udp");
    }
  });
}

function commandAt(value: unknown, path: string): string[] {
  return stringArrayAt(value, path, { min: 1 });
}

function optionalCommandAt(value: unknown, path: string): void {
  if (value !== undefined) commandAt(value, path);
}

function stringArrayAt(value: unknown, path: string, options: { min?: number } = {}): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < (options.min ?? 0)) fail(path, `must contain at least ${options.min ?? 0} item(s)`);
  return value.map((entry, index) => stringAt(entry, `${path}[${index}]`));
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  if (value.includes("\0")) fail(path, "must not contain a null byte");
  return value;
}

function identifierAt(value: unknown, path: string): string {
  const name = stringAt(value, path);
  if (!IDENTIFIER.test(name)) fail(path, "must contain only letters, numbers, dot, underscore, or hyphen");
  return name;
}

function relativePathAt(value: unknown, path: string): string {
  const input = stringAt(value, path);
  if (isAbsolute(input)) fail(path, "must be project-relative");
  const normalized = input.replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) fail(path, "must remain inside the project root");
  return input;
}

function optionalRelativePathAt(value: unknown, path: string): void {
  if (value !== undefined) relativePathAt(value, path);
}

function secretReferenceAt(value: unknown, path: string): SecretReference {
  const reference = stringAt(value, path);
  if (!SECRET_REFERENCE.test(reference)) fail(path, "must use env://NAME or exec://COMMAND");
  return reference as SecretReference;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function optionalBooleanAt(value: unknown, path: string): void {
  if (value !== undefined) booleanAt(value, path);
}

function optionalStringAt(value: unknown, path: string): void {
  if (value !== undefined) stringAt(value, path);
}

function optionalPositiveIntegerAt(value: unknown, path: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) fail(path, "must be a positive integer");
}

function portNumberAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) fail(path, "must be an integer from 1 through 65535");
  return value as number;
}

function uniqueAt(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "must not contain duplicate values");
}

function isLiteralCloneSecret(name: string, value: string): boolean {
  if (SECRET_REFERENCE.test(value)) return false;
  return /^(?:postgres|postgresql):\/\//i.test(value)
    || /^(?:DATABASE_URL|PGPASSWORD|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ANBO_CLONE_TOKEN)$/i.test(name)
    || /^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(value);
}

function validateRuntimeEnvironment(environment: Record<string, string>, path: string): void {
  for (const [name, environmentValue] of Object.entries(environment)) {
    if (isLiteralCloneSecret(name, environmentValue)) {
      fail(`${path}.${name}`, "clone credentials and database URLs must use an env:// or exec:// reference");
    }
  }
}

function safeIdentifier(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return normalized.slice(0, 128) || "app";
}

function fail(path: string, message: string): never {
  throw configError(`${path} ${message}`, "ANBO_CONFIG_INVALID");
}

function configError(message: string, code: string, remediation?: string, cause?: unknown): AnboError {
  return new AnboError(message, {
    exitCode: ExitCode.Configuration,
    code,
    ...(remediation === undefined ? {} : { details: { remediation, retryable: false, safe_to_retry: false } }),
    ...(cause === undefined ? {} : { cause })
  });
}
