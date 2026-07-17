import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import dockerIgnore, { type Ignore } from "@balena/dockerignore";
import type { BuildConfig } from "../types.js";
import type { CommandExecutor } from "./ministack.js";
import { ProcessCommandExecutor, safeProjectId } from "./ministack.js";

export interface BuildResult {
  name: string;
  image?: string;
  cacheHit: boolean;
  fingerprint: string;
  metadata: Record<string, unknown>;
}

interface BuildState {
  version: 2;
  fingerprint: string;
  kind: "command" | "docker";
  image?: string;
  image_id?: string;
  output_fingerprint?: string;
  outputs: string[];
  completed_at: string;
}

interface BuildInput {
  path: string;
  relativePath: string;
  details: Stats;
  dereferencedContent?: Buffer;
}

interface DockerBuildContext {
  inputs: BuildInput[];
  bytes: number;
  files: number;
  excludedDefaults: string[];
}

interface BuildFingerprint {
  value: string;
  dockerContext?: DockerBuildContext;
}

export interface InspectedBuildFingerprint {
  value: string;
  certainty: "exact" | "unknown";
  issues: readonly string[];
}

class MissingDeclaredBuildInputError extends Error {
  constructor(readonly input: string) {
    super(`build input does not exist: ${input}`);
    this.name = "MissingDeclaredBuildInputError";
  }
}

const createDockerIgnore = dockerIgnore as unknown as (options?: { ignorecase?: boolean }) => Ignore;
const LARGE_BUILD_CONTEXT_BYTES = 100 * 1024 * 1024;
const BUILD_CACHE_MARKER = ".anbo-managed-build-cache-v2";
const BUILD_CACHE_MARKER_CONTENT = "anbo managed build cache v2\n";
const DEFAULT_DOCKER_IGNORE = [
  ".git",
  "**/.git",
  ".anbo",
  "**/.anbo",
  ".terraform",
  "**/.terraform",
  "node_modules",
  "**/node_modules",
  "coverage",
  "**/coverage",
  "artifacts",
  "**/artifacts",
  "evidence",
  "**/evidence",
  "*.log",
  "**/*.log",
].join("\n");
const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".anbo",
  ".terraform",
  "node_modules",
  "coverage",
  "artifacts",
  "evidence",
]);

export async function buildDeclaredImages(
  options: {
    projectId: string;
    root: string;
    builds: Readonly<Record<string, BuildConfig>>;
    cacheRoot: string;
    signal?: AbortSignal;
  },
  dependencies: {
    commands?: CommandExecutor;
    onOutput?: (build: string, stream: "stdout" | "stderr", text: string) => void | Promise<void>;
  } = {},
): Promise<Record<string, BuildResult>> {
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  const projectId = safeProjectId(options.projectId);
  const results: Record<string, BuildResult> = {};
  let buildxAvailable: boolean | undefined;
  for (const [name, config] of Object.entries(options.builds)) {
    const context = resolve(options.root, config.context);
    const cacheDirectory = join(options.cacheRoot, projectId, safeProjectId(name));
    const statePath = join(cacheDirectory, "state.json");
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(options.cacheRoot, BUILD_CACHE_MARKER), BUILD_CACHE_MARKER_CONTENT, { mode: 0o600 });
    const ownOutputs = (config.outputs ?? []).map((path) => resolve(options.root, path));
    const fingerprintResult = await buildFingerprint(options.root, context, config, [options.cacheRoot, ...ownOutputs]);
    const fingerprint = fingerprintResult.value;
    const previous = await readBuildState(statePath);

    if (config.command !== undefined) {
      const outputPaths = (config.outputs ?? []).map((path) => resolve(options.root, path));
      const currentOutputFingerprint = await buildOutputsFingerprint(options.root, config.outputs ?? []);
      const reusable = previous?.kind === "command" &&
        previous.fingerprint === fingerprint &&
        currentOutputFingerprint !== undefined &&
        previous.output_fingerprint === currentOutputFingerprint;
      if (!reusable) {
        const [command, ...args] = config.command;
        if (command === undefined) throw new Error(`command build ${name} has no executable`);
        const result = await commands.run(command, args, {
          cwd: context,
          env: safeBuildEnvironment(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(dependencies.onOutput === undefined ? {} : { onOutput: (stream: "stdout" | "stderr", text: string) => dependencies.onOutput?.(name, stream, text) }),
        });
        if (result.code !== 0) throw new Error(`command build ${name} failed: ${result.stderr.trim() || result.stdout.trim()}`);
        const missing = outputPaths.filter((path) => !existsSync(path));
        if (missing.length > 0) throw new Error(`command build ${name} did not create: ${missing.join(", ")}`);
        const outputFingerprint = await buildOutputsFingerprint(options.root, config.outputs ?? []);
        if (outputFingerprint === undefined) throw new Error(`command build ${name} outputs disappeared before caching`);
        await writeBuildState(statePath, {
          version: 2,
          fingerprint,
          kind: "command",
          output_fingerprint: outputFingerprint,
          outputs: [...(config.outputs ?? [])],
          completed_at: new Date().toISOString(),
        });
      }
      results[name] = { name, cacheHit: reusable, fingerprint, metadata: { outputs: config.outputs ?? [] } };
      continue;
    }

    const image = `anbo/${projectId}/${safeProjectId(name)}:${fingerprint.slice(0, 16)}`;
    const imageInspection = await commands.run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
    const imageId = imageInspection.code === 0 ? imageInspection.stdout.trim() : "";
    const reusable = previous?.kind === "docker" &&
      previous.fingerprint === fingerprint &&
      previous.image === image &&
      imageId.length > 0 &&
      previous.image_id === imageId;
    const dockerContext = fingerprintResult.dockerContext;
    if (dockerContext === undefined) throw new Error(`Docker build ${name} did not produce context metadata`);
    const contextMetadata: Record<string, unknown> = {
      context_bytes: dockerContext.bytes,
      context_files: dockerContext.files,
      context_default_excludes: dockerContext.excludedDefaults,
      context_large: dockerContext.bytes > LARGE_BUILD_CONTEXT_BYTES,
    };
    let metadata: Record<string, unknown> = contextMetadata;
    if (!reusable) {
      const buildkitCache = join(cacheDirectory, "buildkit");
      const nextCache = join(cacheDirectory, `buildkit-next-${randomUUID()}`);
      const metadataPath = join(cacheDirectory, `metadata-${randomUUID()}.json`);
      try {
        buildxAvailable ??= await hasBuildx(commands, options.signal);
        if (dockerContext.bytes > LARGE_BUILD_CONTEXT_BYTES) {
          await dependencies.onOutput?.(
            name,
            "stderr",
            `Anbo build context is ${formatBytes(dockerContext.bytes)} after exclusions; add project-specific rules to .dockerignore.\n`,
          );
        }
        const preparedContext = await materializeDockerContext(context, dockerContext.inputs, cacheDirectory);
        const commonArgs = [
          "--pull",
          "--tag", image,
          "--label", "anbo.dev/managed=true",
          "--label", `anbo.dev/project=${projectId}`,
          "--label", `anbo.dev/build=${name}`,
          "--file", resolve(preparedContext, config.dockerfile ?? "Dockerfile"),
          ...(config.target === undefined ? [] : ["--target", config.target]),
          ...(config.platform === undefined ? [] : ["--platform", config.platform]),
          ...Object.entries(config.args ?? {}).sort(([left], [right]) => left.localeCompare(right))
            .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
          preparedContext,
        ];
        const args = buildxAvailable
          ? [
              "buildx", "build", "--load",
              ...commonArgs.slice(0, -1),
              ...(existsSync(buildkitCache) ? ["--cache-from", `type=local,src=${buildkitCache}`] : []),
              "--cache-to", `type=local,dest=${nextCache},mode=max`,
              "--metadata-file", metadataPath,
              preparedContext,
            ]
          : ["build", ...commonArgs];
        let result: Awaited<ReturnType<CommandExecutor["run"]>>;
        try {
          result = await commands.run("docker", args, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(dependencies.onOutput === undefined ? {} : { onOutput: (stream: "stdout" | "stderr", text: string) => dependencies.onOutput?.(name, stream, text) }),
          });
        } finally {
          await rm(preparedContext, { recursive: true, force: true });
        }
        if (result.code !== 0) {
          const builder = buildxAvailable ? "Buildx" : "classic Docker builder";
          throw new Error(`Docker build ${name} failed with ${builder}: ${result.stderr.trim() || result.stdout.trim()}`);
        }
        metadata = { ...contextMetadata, build_engine: buildxAvailable ? "buildx" : "docker" };
        if (buildxAvailable) {
          try {
            metadata = {
              ...metadata,
              ...(JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>),
            };
          } catch { /* Optional BuildKit metadata. */ }
          if (existsSync(nextCache)) {
            await rm(buildkitCache, { recursive: true, force: true });
            await rename(nextCache, buildkitCache);
          }
        }
      } finally {
        await Promise.all([
          rm(nextCache, { recursive: true, force: true }),
          rm(metadataPath, { force: true }),
        ]);
      }
      const builtInspection = await commands.run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
      const builtImageId = builtInspection.code === 0 ? builtInspection.stdout.trim() : "";
      if (builtImageId.length === 0) {
        throw new Error(`Docker build ${name} completed but the tagged image identity could not be verified`);
      }
      await writeBuildState(statePath, {
        version: 2,
        fingerprint,
        kind: "docker",
        image,
        image_id: builtImageId,
        outputs: [],
        completed_at: new Date().toISOString(),
      });
    }
    results[name] = { name, image, cacheHit: reusable, fingerprint, metadata };
  }
  return results;
}

async function hasBuildx(commands: CommandExecutor, signal?: AbortSignal): Promise<boolean> {
  const result = await commands.run("docker", ["buildx", "version"], signal === undefined ? {} : { signal });
  if (result.code === 0) return true;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  if (/buildx[^\n]*(?:not a docker command|not found|unknown command)|unknown command[^\n]*buildx/i.test(detail)) {
    return false;
  }
  throw new Error(`could not check Docker Buildx availability: ${detail}`);
}

export async function pruneBuildCache(
  projectIdValue: string,
  commands: CommandExecutor = new ProcessCommandExecutor(),
  signal?: AbortSignal,
): Promise<void> {
  const projectId = safeProjectId(projectIdValue);
  const options = signal === undefined ? {} : { signal };
  const images = await commands.run("docker", ["image", "ls", "-q", "--filter", `label=anbo.dev/project=${projectId}`], options);
  if (images.code !== 0) throw new Error(`could not inspect managed build images: ${commandEvidence(images)}`);
  const ids = [...new Set(images.stdout.split(/\s+/).filter(Boolean))];
  if (ids.length > 0) {
    const removed = await commands.run("docker", ["image", "rm", "-f", ...ids], options);
    if (removed.code !== 0) throw new Error(`could not remove managed build images: ${commandEvidence(removed)}`);
  }
}

function commandEvidence(result: { code: number; stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

/**
 * Compute the same content identity used by the build cache without executing
 * the build. Impact planning uses this so its build nodes cannot disagree with
 * the cache about which files form the effective build context.
 */
export async function fingerprintDeclaredBuild(
  root: string,
  config: BuildConfig,
): Promise<string> {
  const context = resolve(root, config.context);
  return (await buildFingerprint(root, context, config, [])).value;
}

/**
 * Missing declared inputs can be outputs of an earlier build. Impact preview
 * must not fail before that producer gets a chance to run, so represent the
 * missing input deterministically and mark the result non-reusable.
 */
export async function inspectDeclaredBuildFingerprint(
  root: string,
  config: BuildConfig,
): Promise<InspectedBuildFingerprint> {
  try {
    return {
      value: await fingerprintDeclaredBuild(root, config),
      certainty: "exact",
      issues: [],
    };
  } catch (error) {
    const missingInput = missingBuildInput(root, error);
    if (missingInput === undefined) throw error;
    const value = createHash("sha256")
      .update("anbo.missing-build-input.v1\0")
      .update(JSON.stringify({ config, missing_input: missingInput }))
      .digest("hex");
    return {
      value,
      certainty: "unknown",
      issues: [`Build input ${missingInput} is missing and may be produced by another build.`],
    };
  }
}

export async function validateDeclaredBuildCache(
  options: {
    projectId: string;
    root: string;
    builds: Readonly<Record<string, BuildConfig>>;
    cacheRoot: string;
    fingerprints: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  },
  dependencies: { commands?: CommandExecutor } = {},
): Promise<boolean> {
  const commands = dependencies.commands ?? new ProcessCommandExecutor();
  const projectId = safeProjectId(options.projectId);
  for (const [name, config] of Object.entries(options.builds)) {
    const fingerprint = options.fingerprints[name];
    if (fingerprint === undefined) return false;
    const cacheDirectory = join(options.cacheRoot, projectId, safeProjectId(name));
    const previous = await readBuildState(join(cacheDirectory, "state.json"));
    if (previous?.fingerprint !== fingerprint) return false;
    if (config.command !== undefined) {
      if (previous.kind !== "command" ||
          previous.output_fingerprint !== await buildOutputsFingerprint(options.root, config.outputs ?? [])) {
        return false;
      }
      continue;
    }
    const image = `anbo/${projectId}/${safeProjectId(name)}:${fingerprint.slice(0, 16)}`;
    if (previous.kind !== "docker" || previous.image !== image || previous.image_id === undefined) return false;
    const inspected = await commands.run(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", image],
      options.signal === undefined ? {} : { signal: options.signal },
    );
    if (inspected.code !== 0 || inspected.stdout.trim() !== previous.image_id) return false;
  }
  return true;
}

async function buildFingerprint(
  root: string,
  context: string,
  config: BuildConfig,
  extraExcluded: readonly string[],
): Promise<BuildFingerprint> {
  const hash = createHash("sha256");
  const outputPaths = new Set([
    ...(config.outputs ?? []).map((path) => resolve(root, path)),
    ...extraExcluded.map((path) => resolve(path)),
  ]);
  hash.update(JSON.stringify({ ...config, outputs: [...(config.outputs ?? [])].sort() }));
  const dockerContext = config.command === undefined
    ? await listDockerInputs(context, config, outputPaths)
    : undefined;
  const inputs = dockerContext !== undefined
    ? dockerContext.inputs
    : config.inputs === undefined
      ? await listInputs(context, outputPaths)
      : await listDeclaredInputs(context, config.inputs, outputPaths);
  for (const input of inputs) {
    hash.update(input.relativePath);
    hash.update("\0");
    hash.update(inputKind(input.details));
    hash.update("\0");
    hash.update((input.details.mode & 0o7777).toString(8));
    hash.update("\0");
    if (input.details.isFile()) hash.update(await readFile(input.path));
    else if (input.details.isSymbolicLink()) hash.update(await readlink(input.path));
    else if (!input.details.isDirectory()) throw new Error(`build input has unsupported type: ${input.relativePath}`);
    hash.update("\0");
    if (input.dereferencedContent !== undefined) {
      hash.update("control-file-content\0");
      hash.update(input.dereferencedContent);
      hash.update("\0");
    }
  }
  return {
    value: hash.digest("hex"),
    ...(dockerContext === undefined ? {} : { dockerContext }),
  };
}

async function listDockerInputs(
  context: string,
  config: BuildConfig,
  excluded: ReadonlySet<string>,
): Promise<DockerBuildContext> {
  const dockerfile = resolve(context, config.dockerfile ?? "Dockerfile");
  pathWithinContext(context, dockerfile, "Dockerfile");
  const specificIgnore = `${dockerfile}.dockerignore`;
  const ignorePath = existsSync(specificIgnore)
    ? specificIgnore
    : existsSync(join(context, ".dockerignore"))
      ? join(context, ".dockerignore")
      : undefined;
  const matcher = createDockerIgnore({ ignorecase: false });
  matcher.add(DEFAULT_DOCKER_IGNORE);
  const projectIgnore = ignorePath === undefined ? "" : await readFile(ignorePath, "utf8");
  if (projectIgnore.length > 0) matcher.add(projectIgnore);
  const projectHasNegations = projectIgnore.split(/\r?\n/).some((line) => line.trimStart().startsWith("!"));

  // Docker reads these control files even when an ignore rule excludes them.
  // Hash their dereferenced contents as well as their filesystem entry so a
  // symlinked Dockerfile or ignore file cannot produce a stale cache hit.
  const controlFiles = [dockerfile, ...(ignorePath === undefined ? [] : [ignorePath])];
  // Docker receives the complete context. `inputs` remains useful for command
  // builds, but cannot safely narrow a Docker fingerprint unless the transmitted
  // context is narrowed as well.
  const excludedDefaults = new Set<string>();
  const candidates = await listDockerCandidates(context, projectHasNegations, excludedDefaults, excluded);
  const byPath = new Map(candidates.map((input) => [input.path, input]));
  for (const path of controlFiles) {
    const [details, dereferencedContent] = await Promise.all([lstat(path), readFile(path)]);
    byPath.set(path, { path, relativePath: normalizedRelativePath(context, path), details, dereferencedContent });
  }
  const alwaysIncluded = new Set(controlFiles);
  const filtered = [...byPath.values()].filter((input) =>
    alwaysIncluded.has(input.path) || !isDockerIgnored(matcher, input.relativePath)
  );
  filtered.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    inputs: filtered,
    bytes: filtered.reduce((total, input) =>
      total + (input.details.isFile() || input.details.isSymbolicLink() ? input.details.size : 0), 0),
    files: filtered.filter((input) => !input.details.isDirectory()).length,
    excludedDefaults: [...excludedDefaults].sort(),
  };
}

function isDockerIgnored(matcher: Ignore, relativePath: string): boolean {
  return matcher.ignores(relativePath);
}

async function listDockerCandidates(
  context: string,
  projectHasNegations: boolean,
  excludedDefaults: Set<string>,
  excluded: ReadonlySet<string>,
): Promise<BuildInput[]> {
  const inputs: BuildInput[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (isExcluded(path, excluded)) continue;
      const relativePath = normalizedRelativePath(context, path);
      const details = await lstat(path);
      if (details.isDirectory() && await isManagedBuildCacheDirectory(path)) continue;
      if (details.isDirectory() && isDefaultIgnoredDirectory(relativePath) && !projectHasNegations) {
        excludedDefaults.add(relativePath);
        continue;
      }
      if (details.isFile() && entry.name.endsWith(".log") && !projectHasNegations) {
        excludedDefaults.add(relativePath);
        continue;
      }
      inputs.push({ path, relativePath, details });
      if (details.isDirectory()) await visit(path);
    }
  };
  await visit(context);
  return inputs;
}

function isDefaultIgnoredDirectory(relativePath: string): boolean {
  return relativePath.split("/").some((part) => DEFAULT_IGNORED_DIRECTORY_NAMES.has(part));
}

async function materializeDockerContext(
  sourceContext: string,
  inputs: readonly BuildInput[],
  cacheDirectory: string,
): Promise<string> {
  const destination = join(cacheDirectory, `context-${randomUUID()}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    for (const input of inputs) {
      const target = resolve(destination, input.relativePath);
      pathWithinContext(destination, target, input.relativePath);
      if (input.details.isDirectory()) {
        await mkdir(target, { recursive: true, mode: input.details.mode & 0o7777 });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (input.details.isFile()) {
        await copyFile(input.path, target);
        await chmod(target, input.details.mode & 0o7777);
        continue;
      }
      if (input.details.isSymbolicLink()) {
        await symlink(await readlink(input.path), target);
        continue;
      }
      throw new Error(`Docker context input has unsupported type: ${normalizedRelativePath(sourceContext, input.path)}`);
    }
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

async function listDeclaredInputs(context: string, inputs: readonly string[], excluded: ReadonlySet<string>): Promise<BuildInput[]> {
  const entries = new Map<string, BuildInput>();
  for (const input of inputs) {
    const path = resolve(context, input);
    pathWithinContext(context, path, input);
    let details;
    try {
      details = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingDeclaredBuildInputError(input);
      throw error;
    }
    if (details.isDirectory()) {
      if (await isManagedBuildCacheDirectory(path)) continue;
      if (!isExcluded(path, excluded)) {
        if (path !== resolve(context)) {
          entries.set(path, { path, relativePath: normalizedRelativePath(context, path), details });
        }
        for (const nested of await listInputs(path, excluded, context)) entries.set(nested.path, nested);
      }
    } else if (!isExcluded(path, excluded)) {
      entries.set(path, { path, relativePath: normalizedRelativePath(context, path), details });
    }
  }
  return [...entries.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function listInputs(
  directory: string,
  excluded: ReadonlySet<string>,
  context = directory,
): Promise<BuildInput[]> {
  const inputs: BuildInput[] = [];
  const visit = async (current: string): Promise<void> => {
    if (isExcluded(current, excluded)) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (isExcluded(path, excluded)) continue;
      const details = await lstat(path);
      if (details.isDirectory() && await isManagedBuildCacheDirectory(path)) continue;
      inputs.push({ path, relativePath: normalizedRelativePath(context, path), details });
      if (details.isDirectory()) await visit(path);
    }
  };
  await visit(directory);
  return inputs.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function pathWithinContext(context: string, path: string, declared: string): string {
  const withinContext = relative(context, path);
  if (withinContext.startsWith(".." + sep) || withinContext === ".." || withinContext.startsWith(sep)) {
    throw new Error(`build input must remain inside its context: ${declared}`);
  }
  return withinContext;
}

function normalizedRelativePath(context: string, path: string): string {
  return relative(context, path).split(sep).join("/");
}

function isExcluded(path: string, excluded: ReadonlySet<string>): boolean {
  return [...excluded].some((excludedPath) => path === excludedPath || path.startsWith(excludedPath + sep));
}

async function isManagedBuildCacheDirectory(path: string): Promise<boolean> {
  const marker = join(path, BUILD_CACHE_MARKER);
  if (!existsSync(marker)) return false;
  try {
    return await readFile(marker, "utf8") === BUILD_CACHE_MARKER_CONTENT;
  } catch {
    return false;
  }
}

function missingBuildInput(root: string, error: unknown): string | undefined {
  if (error instanceof MissingDeclaredBuildInputError) return error.input;
  const filesystemError = error as NodeJS.ErrnoException;
  if (filesystemError.code !== "ENOENT") return undefined;
  if (typeof filesystemError.path !== "string") return "<filesystem input>";
  const relativePath = relative(resolve(root), resolve(filesystemError.path));
  if (relativePath === "" || relativePath === ".") return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return "<filesystem input>";
  return relativePath.split(sep).join("/");
}

function inputKind(details: Stats): string {
  if (details.isFile()) return "file";
  if (details.isDirectory()) return "directory";
  if (details.isSymbolicLink()) return "symlink";
  return "other";
}

async function buildOutputsFingerprint(root: string, outputs: readonly string[]): Promise<string | undefined> {
  const hash = createHash("sha256");
  const visit = async (path: string, relativePath: string): Promise<boolean> => {
    let details: Stats;
    try {
      details = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    hash.update(relativePath);
    hash.update("\0");
    hash.update(inputKind(details));
    hash.update("\0");
    hash.update((details.mode & 0o7777).toString(8));
    hash.update("\0");
    if (details.isFile()) {
      hash.update(await readFile(path));
    } else if (details.isSymbolicLink()) {
      hash.update(await readlink(path));
    } else if (details.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childRelative = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
        if (!await visit(join(path, entry.name), childRelative)) return false;
      }
    } else {
      throw new Error(`build output has unsupported type: ${relativePath}`);
    }
    hash.update("\0");
    return true;
  };
  for (const output of [...outputs].sort()) {
    const path = resolve(root, output);
    pathWithinContext(root, path, output);
    if (!await visit(path, output.replaceAll("\\", "/"))) return undefined;
  }
  return hash.digest("hex");
}

async function readBuildState(path: string): Promise<BuildState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BuildState>;
    if (parsed.version !== 2 ||
        typeof parsed.fingerprint !== "string" ||
        (parsed.kind !== "command" && parsed.kind !== "docker") ||
        (parsed.kind === "command" && typeof parsed.output_fingerprint !== "string") ||
        (parsed.kind === "docker" && (typeof parsed.image !== "string" || typeof parsed.image_id !== "string"))) {
      return undefined;
    }
    return parsed as BuildState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeBuildState(path: string, state: BuildState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function safeBuildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment["CI"] = "1";
  return environment;
}
