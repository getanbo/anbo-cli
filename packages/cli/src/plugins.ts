import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  AnboPluginLock,
  AnboPluginV1,
  AnboProjectConfig,
  JsonObject,
  PluginCommandRequestV1,
  PluginContextV1,
  PluginDescriptorV1,
  PluginFlagsV1,
  PluginRuntimeV1,
  TargetActionV1,
  TargetRequestV1,
  TargetResultV1,
} from "@getanbo/plugin-sdk";
import { TARGET_ACTIONS } from "@getanbo/plugin-sdk";
import { CLI_VERSION, EXIT_CODE } from "./constants.js";
import { savePluginLock } from "./config.js";
import { AnboError, PluginCompatibilityError, PluginUnavailableError } from "./errors.js";
import type { EventWriter } from "./events.js";
import { runProcess } from "./process.js";
import { createCredentialStore, createStateStore, pluginPaths } from "./storage.js";

const CLI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

interface ExecutableTarget {
  execute(request: TargetRequestV1): Promise<TargetResultV1>;
}

type ExecutableCommand = (request: PluginCommandRequestV1) => Promise<TargetResultV1>;

export interface LoadedPlugin {
  plugin: AnboPluginV1;
  runtime: PluginRuntimeV1;
  packageName: string;
  packageRoot: string;
  manifest: PluginDescriptorV1;
  integrity?: string;
}

export async function loadAndActivatePlugin(input: {
  rootDir: string;
  target: string;
  project: AnboProjectConfig;
  lock: AnboPluginLock;
  writer: EventWriter;
  signal: AbortSignal;
  allowUnlocked: boolean;
}): Promise<LoadedPlugin> {
  const mapping = input.project.plugins[input.target];
  if (!mapping) {
    throw new PluginUnavailableError(input.target, "<package mapped in .anbo/project.json>");
  }
  const modulePath = resolvePluginArtifact(mapping.package, input.rootDir);
  const manifestPath = resolvePluginArtifact(mapping.package, input.rootDir, "descriptor");
  if (!modulePath || !manifestPath) throw new PluginUnavailableError(input.target, mapping.package);

  const packageMetadata = await findPackageMetadata(modulePath, mapping.package);
  const manifest = await readDescriptor(manifestPath);
  validateDescriptor(manifest, input.target, mapping.package);
  validatePackageIdentity(manifest, packageMetadata, mapping.package);
  await validateConfigSchema(manifest, packageMetadata.root, mapping.config ?? {});

  const imported = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const candidate = imported.default ?? imported.plugin;
  if (!isPlugin(candidate)) {
    throw new PluginCompatibilityError(
      `${mapping.package} must default-export { descriptor, activate(context) }.`,
    );
  }
  validateDescriptor(candidate.descriptor, input.target, mapping.package);
  validateDescriptorAgreement(manifest, candidate.descriptor, mapping.package);

  const integrity = await findInstalledIntegrity(packageMetadata.root, mapping.package);
  validateLock(
    input.lock,
    input.target,
    mapping.package,
    candidate.descriptor.version,
    integrity,
    input.allowUnlocked,
  );
  const context = await createPluginContext(
    input.rootDir,
    candidate.descriptor.id,
    input.writer,
    input.signal,
  );
  const runtime = await candidate.activate(context);
  validateRuntime(runtime, candidate.descriptor);
  return {
    plugin: candidate,
    runtime,
    packageName: mapping.package,
    packageRoot: packageMetadata.root,
    manifest,
    ...(integrity ? { integrity } : {}),
  };
}

export async function lockLoadedPlugin(input: {
  rootDir: string;
  target: string;
  lock: AnboPluginLock;
  loaded: LoadedPlugin;
}): Promise<void> {
  input.lock.plugins[input.target] = {
    package: input.loaded.packageName,
    version: input.loaded.plugin.descriptor.version,
    ...(input.loaded.integrity ? { integrity: input.loaded.integrity } : {}),
  };
  await savePluginLock(input.rootDir, input.lock);
}

export async function executeTarget(input: {
  loaded: LoadedPlugin;
  target: string;
  action: TargetActionV1;
  rootDir: string;
  config: unknown;
  args: readonly string[];
  passthrough: readonly string[];
  flags: PluginFlagsV1;
  writer: EventWriter;
}): Promise<TargetResultV1> {
  const provider = findTargetProvider(input.loaded.runtime, input.target);
  if (!provider) {
    throw new PluginCompatibilityError(
      `${input.loaded.packageName} does not provide target ${input.target}.`,
    );
  }
  if (!descriptorActions(input.loaded.plugin.descriptor, input.target).includes(input.action)) {
    throw new PluginCompatibilityError(
      `${input.loaded.packageName} does not support ${input.action}.`,
    );
  }
  const project = projectIdentity(input.rootDir);
  const result = normalizeResult(await provider.execute({
    api_version: 1,
    action: input.action,
    project,
    config: input.config,
    args: input.args,
    passthrough: input.passthrough,
    flags: input.flags,
  }));
  emitDiagnostics(result, input.writer, input.loaded.plugin.descriptor.id);
  return result;
}

export async function executePluginCommand(input: {
  loaded: LoadedPlugin;
  name: string;
  rootDir: string;
  config: unknown;
  args: readonly string[];
  passthrough: readonly string[];
  flags: PluginFlagsV1;
  writer: EventWriter;
}): Promise<TargetResultV1> {
  const command = findPluginCommand(input.loaded.runtime, input.name);
  if (!command) {
    throw new PluginCompatibilityError(
      `${input.loaded.packageName} does not provide command ${input.name}.`,
    );
  }
  const result = normalizeResult(await command({
    name: input.name,
    command: input.name,
    project: projectIdentity(input.rootDir),
    config: input.config,
    args: input.args,
    passthrough: input.passthrough,
    flags: input.flags,
  }));
  emitDiagnostics(result, input.writer, input.loaded.plugin.descriptor.id);
  return result;
}

export function validateDescriptor(
  descriptor: PluginDescriptorV1,
  target?: string,
  packageName = "plugin",
): void {
  const validId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
  const validVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
  if (descriptor.schema_version !== 1 || descriptor.plugin_api !== 1) {
    throw new PluginCompatibilityError(`${packageName} uses an unsupported Plugin API.`);
  }
  if (!validId.test(descriptor.id) || !validVersion.test(descriptor.version)) {
    throw new PluginCompatibilityError(`${packageName} has an invalid descriptor identity.`);
  }
  if (!descriptor.engines?.anbo || !supportsVersion(descriptor.engines.anbo, CLI_VERSION)) {
    throw new PluginCompatibilityError(
      `${packageName}@${descriptor.version} requires anbo ${descriptor.engines?.anbo ?? "<missing>"}; running ${CLI_VERSION}.`,
    );
  }
  if (descriptor.engines.node && !supportsVersion(descriptor.engines.node, process.versions.node)) {
    throw new PluginCompatibilityError(
      `${packageName}@${descriptor.version} requires Node.js ${descriptor.engines.node}; running ${process.versions.node}.`,
    );
  }
  if (
    !Array.isArray(descriptor.targets) ||
    descriptor.targets.some((entry) => {
      return typeof entry === "string"
        ? !validId.test(entry)
        : !entry || !validId.test(entry.id) || !validActions(entry.actions);
    })
  ) {
    throw new PluginCompatibilityError(`${packageName} declares invalid targets.`);
  }
  if (target && !descriptorTargets(descriptor).includes(target)) {
    throw new PluginCompatibilityError(`${packageName} does not declare target ${target}.`);
  }
  if (descriptor.actions !== undefined && !validActions(descriptor.actions)) {
    throw new PluginCompatibilityError(`${packageName} declares invalid target actions.`);
  }
}

function validateRuntime(runtime: PluginRuntimeV1, descriptor: PluginDescriptorV1): void {
  if (!runtime || typeof runtime !== "object") {
    throw new PluginCompatibilityError(`${descriptor.id} activation returned an invalid runtime.`);
  }
  for (const [id, target] of runtimeTargetEntries(runtime.targets ?? [])) {
    if (!id || !target || typeof target.execute !== "function") {
      throw new PluginCompatibilityError(`${descriptor.id} returned an invalid target provider.`);
    }
  }
  const commands = runtime.commands;
  if (commands && !Array.isArray(commands)) {
    for (const [name, command] of Object.entries(commands)) {
      if (!name || typeof command !== "function") {
        throw new PluginCompatibilityError(`${descriptor.id} returned an invalid command.`);
      }
    }
  }
}

function validateLock(
  lock: AnboPluginLock,
  target: string,
  packageName: string,
  version: string,
  integrity: string | undefined,
  allowUnlocked: boolean,
): void {
  const entry = lock.plugins[target];
  if (!entry && allowUnlocked) return;
  if (!entry) {
    throw new PluginCompatibilityError(
      `Target ${target} is not locked. Run anbo configure --target ${target}.`,
    );
  }
  if (entry.package !== packageName || entry.version !== version) {
    throw new PluginCompatibilityError(
      `Plugin lock mismatch for ${target}: expected ${entry.package}@${entry.version}, loaded ${packageName}@${version}.`,
    );
  }
  if (entry.integrity && integrity && entry.integrity !== integrity) {
    throw new PluginCompatibilityError(`Plugin integrity mismatch for ${packageName}@${version}.`);
  }
}

async function createPluginContext(
  rootDir: string,
  pluginId: string,
  writer: EventWriter,
  signal: AbortSignal,
): Promise<PluginContextV1> {
  const paths = pluginPaths(rootDir, pluginId);
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  return {
    signal,
    events: {
      async emit(event) {
        writer.emitPlugin(event);
      },
      async startPhase(name, options) {
        const source = options?.source ?? pluginId;
        writer.emit({ type: "phase.started", source, message: `${name} started`, data: { phase: name } });
        return {
          async finish(message, fields) {
            writer.emit({
              type: "phase.finished",
              source,
              message: message ?? `${name} finished`,
              data: { phase: name, ...(fields ? { fields: toJson(fields) } : {}) },
            });
          },
          async fail(message, fields) {
            writer.emit({
              type: "phase.failed",
              source,
              level: "error",
              message,
              data: { phase: name, ...(fields ? { fields: toJson(fields) } : {}) },
            });
          },
        };
      },
    },
    process: { run: async (command, args, options) => await runProcess(command, args, options, signal) },
    http: {
      async request(input, init = {}) {
        const combinedSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
        return await fetch(input, { ...init, signal: combinedSignal });
      },
    },
    state: createStateStore(paths.state),
    credentials: createCredentialStore(paths.state),
    secrets: {
      async resolve(reference) {
        let value: string | undefined;
        if (reference.startsWith("exec://")) {
          const result = await runProcess(
            "/bin/sh",
            ["-c", reference.slice("exec://".length)],
            { cwd: rootDir },
            signal,
          );
          value = result.stdout.trim();
        } else {
          const name = reference.replace(/^env:(?:\/\/)?/u, "");
          value = process.env[name];
        }
        if (!value) {
          throw new AnboError(
            `Secret ${reference} is unavailable.`,
            "ANBO_SECRET_MISSING",
            EXIT_CODE.operationFailed,
            "Provide the referenced environment variable or secret command.",
          );
        }
        writer.addSecret(value);
        return value;
      },
    },
    adapters: {
      async invoke(name) {
        throw new AnboError(
          `Adapter ${name} is not configured.`,
          "ANBO_ADAPTER_UNAVAILABLE",
          EXIT_CODE.operationFailed,
          `Declare adapter ${name} in the target plugin configuration.`,
        );
      },
    },
    paths,
  };
}

function resolvePluginArtifact(
  packageName: string,
  rootDir: string,
  subpath?: string,
): string | undefined {
  const specifier = subpath ? `${packageName}/${subpath}` : packageName;
  const projectRequire = createRequire(join(rootDir, "package.json"));
  for (const attempt of [
    () => projectRequire.resolve(specifier, { paths: [rootDir, process.cwd(), CLI_PACKAGE_ROOT] }),
    () => createRequire(import.meta.url).resolve(specifier),
  ]) {
    try {
      return attempt();
    } catch (error) {
      if (!isModuleNotFound(error)) throw error;
    }
  }
  return undefined;
}

async function readDescriptor(path: string): Promise<PluginDescriptorV1> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PluginDescriptorV1;
  } catch (error) {
    throw new PluginCompatibilityError(
      `Could not read static plugin descriptor ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function findPackageMetadata(
  modulePath: string,
  expectedName: string,
): Promise<{ root: string; name: string; version: string }> {
  let current = dirname(modulePath);
  while (true) {
    try {
      const value = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (value.name === expectedName && value.version) {
        return { root: current, name: value.name, version: value.version };
      }
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new PluginCompatibilityError(`Could not verify package identity for ${expectedName}.`);
}

function validatePackageIdentity(
  descriptor: PluginDescriptorV1,
  metadata: { name: string; version: string },
  expectedName: string,
): void {
  if (metadata.name !== expectedName || descriptor.package && descriptor.package !== expectedName) {
    throw new PluginCompatibilityError(`Plugin package identity does not match ${expectedName}.`);
  }
  if (metadata.version !== descriptor.version) {
    throw new PluginCompatibilityError(
      `Descriptor version ${descriptor.version} does not match ${metadata.name}@${metadata.version}.`,
    );
  }
}

function validateDescriptorAgreement(
  manifest: PluginDescriptorV1,
  runtime: PluginDescriptorV1,
  packageName: string,
): void {
  if (
    manifest.id !== runtime.id ||
    manifest.version !== runtime.version ||
    manifest.plugin_api !== runtime.plugin_api ||
    descriptorTargets(manifest).sort().join(",") !== descriptorTargets(runtime).sort().join(",")
  ) {
    throw new PluginCompatibilityError(`${packageName} runtime descriptor differs from its static manifest.`);
  }
}

async function validateConfigSchema(
  descriptor: PluginDescriptorV1,
  packageRoot: string,
  config: JsonObject,
): Promise<void> {
  const schemaReference = descriptor.config?.schema ?? descriptor.config_schema;
  if (!schemaReference) return;
  const schemaPath = resolve(packageRoot, schemaReference);
  const outside = relative(packageRoot, schemaPath);
  if (outside.startsWith("..") || outside.startsWith("/")) {
    throw new PluginCompatibilityError(`${descriptor.id} config schema escapes its package.`);
  }
  let schema: object;
  try {
    schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
  } catch (error) {
    throw new PluginCompatibilityError(
      `${descriptor.id} config schema is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new PluginCompatibilityError(
      `${descriptor.id} config schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (descriptor.config && Object.keys(config).length > 0 && !validate(config)) {
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new PluginCompatibilityError(`${descriptor.id} configuration is invalid: ${details}`);
  }
}

async function findInstalledIntegrity(
  packageRoot: string,
  packageName: string,
): Promise<string | undefined> {
  let current = packageRoot;
  const paths = new Set<string>();
  while (true) {
    paths.add(join(current, ".package-lock.json"));
    paths.add(join(current, "package-lock.json"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of paths) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        packages?: Record<string, { name?: string; integrity?: string }>;
      };
      for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
        if ((key.endsWith(`/node_modules/${packageName}`) || key === `node_modules/${packageName}`) && entry.integrity) {
          return entry.integrity;
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isMissingFile(error)) throw error;
    }
  }
  return undefined;
}

function normalizeResult(result: TargetResultV1): TargetResultV1 {
  const status = result.status ?? (result.ok === true ? "succeeded" : result.ok === false ? "failed" : undefined);
  if (!status) throw new PluginCompatibilityError("Plugin returned a result without status or ok.");
  return { ...result, status };
}

function emitDiagnostics(result: TargetResultV1, writer: EventWriter, source: string): void {
  for (const diagnostic of result.diagnostics ?? []) {
    writer.emit({
      type: "diagnostic",
      level: result.status === "failed" ? "error" : "warn",
      source,
      message: diagnostic.message,
      data: {
        code: diagnostic.code,
        ...(diagnostic.remediation ? { remediation: diagnostic.remediation } : {}),
      },
    });
  }
}

function supportsVersion(range: string, version: string): boolean {
  if (range === "*" || range === "latest" || range === version) return true;
  const current = version.split(".").map(Number);
  if (range.startsWith("^")) {
    const requested = range.slice(1).split(".").map(Number);
    return requested[0] === current[0] && (current[0] !== 0 || requested[1] === current[1]);
  }
  const minimum = range.match(/>=\s*(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
  const maximum = range.match(/<\s*(\d+)(?:\.(\d+)\.(\d+))?/u)?.slice(1).map((value) => Number(value ?? 0));
  if (minimum && compareVersions(current, minimum) < 0) return false;
  if (maximum && compareVersions(current, maximum) >= 0) return false;
  return Boolean(minimum || maximum);
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validActions(actions: readonly TargetActionV1[]): boolean {
  return Array.isArray(actions) && actions.every((action) => TARGET_ACTIONS.includes(action));
}

function descriptorTargets(descriptor: PluginDescriptorV1): string[] {
  return descriptor.targets.map((entry) => typeof entry === "string" ? entry : entry.id);
}

function descriptorActions(descriptor: PluginDescriptorV1, target: string): readonly TargetActionV1[] {
  const entry = descriptor.targets.find((candidate) => {
    return typeof candidate === "string" ? candidate === target : candidate.id === target;
  });
  if (entry && typeof entry !== "string") return entry.actions;
  return descriptor.actions ?? [];
}

function runtimeTargetEntries(
  targets: NonNullable<PluginRuntimeV1["targets"]>,
): Array<[string, ExecutableTarget]> {
  if (Array.isArray(targets)) return targets.map((target) => [target.id, target]);
  return Object.entries(targets) as Array<[string, ExecutableTarget]>;
}

function findTargetProvider(runtime: PluginRuntimeV1, target: string): ExecutableTarget | undefined {
  return runtimeTargetEntries(runtime.targets ?? []).find(([id]) => id === target)?.[1];
}

function findPluginCommand(runtime: PluginRuntimeV1, name: string): ExecutableCommand | undefined {
  const commands = runtime.commands;
  if (!commands) return undefined;
  if (Array.isArray(commands)) {
    const command = commands.find((candidate) => candidate.name === name);
    return command ? (request) => command.execute(request) : undefined;
  }
  return (commands as Record<string, ExecutableCommand>)[name];
}

function projectIdentity(rootDir: string): TargetRequestV1["project"] {
  return {
    root: rootDir,
    logical_id: sanitizeId(basename(rootDir)),
    runtime_id: createHash("sha256").update(rootDir).digest("hex").slice(0, 12),
  };
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-|-$/gu, "") || "project";
}

function toJson(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isPlugin(value: unknown): value is AnboPluginV1 {
  return Boolean(
    value && typeof value === "object" && "descriptor" in value && "activate" in value &&
      typeof (value as { activate?: unknown }).activate === "function",
  );
}

function isModuleNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND";
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
