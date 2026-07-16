import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
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
  version: 1;
  fingerprint: string;
  kind: "command" | "docker";
  image?: string;
  outputs: string[];
  completed_at: string;
}

interface BuildInput {
  path: string;
  relativePath: string;
  details: Stats;
  dereferencedContent?: Buffer;
}

const createDockerIgnore = dockerIgnore as unknown as (options?: { ignorecase?: boolean }) => Ignore;

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
    const ownOutputs = (config.outputs ?? []).map((path) => resolve(options.root, path));
    const fingerprint = await buildFingerprint(options.root, context, config, [cacheDirectory, ...ownOutputs]);
    const previous = await readBuildState(statePath);

    if (config.command !== undefined) {
      const outputPaths = (config.outputs ?? []).map((path) => resolve(options.root, path));
      const reusable = previous?.kind === "command" && previous.fingerprint === fingerprint && outputPaths.every(existsSync);
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
        await writeBuildState(statePath, {
          version: 1,
          fingerprint,
          kind: "command",
          outputs: [...(config.outputs ?? [])],
          completed_at: new Date().toISOString(),
        });
      }
      results[name] = { name, cacheHit: reusable, fingerprint, metadata: { outputs: config.outputs ?? [] } };
      continue;
    }

    const image = `anbo/${projectId}/${safeProjectId(name)}:${fingerprint.slice(0, 16)}`;
    const imageInspection = await commands.run("docker", ["image", "inspect", image]);
    const reusable = previous?.kind === "docker" && previous.fingerprint === fingerprint && previous.image === image && imageInspection.code === 0;
    let metadata: Record<string, unknown> = {};
    if (!reusable) {
      const buildkitCache = join(cacheDirectory, "buildkit");
      const nextCache = join(cacheDirectory, `buildkit-next-${randomUUID()}`);
      const metadataPath = join(cacheDirectory, `metadata-${randomUUID()}.json`);
      buildxAvailable ??= await hasBuildx(commands, options.signal);
      const commonArgs = [
        "--pull",
        "--tag", image,
        "--label", "anbo.dev/managed=true",
        "--label", `anbo.dev/project=${projectId}`,
        "--label", `anbo.dev/build=${name}`,
        "--file", resolve(context, config.dockerfile ?? "Dockerfile"),
        ...(config.target === undefined ? [] : ["--target", config.target]),
        ...(config.platform === undefined ? [] : ["--platform", config.platform]),
        ...Object.entries(config.args ?? {}).sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
        context,
      ];
      const args = buildxAvailable
        ? [
            "buildx", "build", "--load",
            ...commonArgs.slice(0, -1),
            ...(existsSync(buildkitCache) ? ["--cache-from", `type=local,src=${buildkitCache}`] : []),
            "--cache-to", `type=local,dest=${nextCache},mode=max`,
            "--metadata-file", metadataPath,
            context,
          ]
        : ["build", ...commonArgs];
      const result = await commands.run("docker", args, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(dependencies.onOutput === undefined ? {} : { onOutput: (stream: "stdout" | "stderr", text: string) => dependencies.onOutput?.(name, stream, text) }),
      });
      if (result.code !== 0) {
        await rm(nextCache, { recursive: true, force: true });
        await rm(metadataPath, { force: true });
        const builder = buildxAvailable ? "Buildx" : "classic Docker builder";
        throw new Error(`Docker build ${name} failed with ${builder}: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      metadata = { build_engine: buildxAvailable ? "buildx" : "docker" };
      if (buildxAvailable) {
        try {
          metadata = {
            ...metadata,
            ...(JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>),
          };
        } catch { /* Optional BuildKit metadata. */ }
        await rm(metadataPath, { force: true });
        if (existsSync(nextCache)) {
          await rm(buildkitCache, { recursive: true, force: true });
          await rename(nextCache, buildkitCache);
        }
      }
      await writeBuildState(statePath, {
        version: 1,
        fingerprint,
        kind: "docker",
        image,
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

async function buildFingerprint(root: string, context: string, config: BuildConfig, extraExcluded: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  const outputPaths = new Set([
    ...(config.outputs ?? []).map((path) => resolve(root, path)),
    ...extraExcluded.map((path) => resolve(path)),
  ]);
  hash.update(JSON.stringify({ ...config, outputs: [...(config.outputs ?? [])].sort() }));
  const inputs = config.command === undefined
    ? await listDockerInputs(context, config)
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
  return hash.digest("hex");
}

async function listDockerInputs(context: string, config: BuildConfig): Promise<BuildInput[]> {
  const dockerfile = resolve(context, config.dockerfile ?? "Dockerfile");
  pathWithinContext(context, dockerfile, "Dockerfile");
  const specificIgnore = `${dockerfile}.dockerignore`;
  const ignorePath = existsSync(specificIgnore)
    ? specificIgnore
    : existsSync(join(context, ".dockerignore"))
      ? join(context, ".dockerignore")
      : undefined;
  const matcher = createDockerIgnore({ ignorecase: false });
  if (ignorePath !== undefined) matcher.add(await readFile(ignorePath, "utf8"));

  // Docker reads these control files even when an ignore rule excludes them.
  // Hash their dereferenced contents as well as their filesystem entry so a
  // symlinked Dockerfile or ignore file cannot produce a stale cache hit.
  const controlFiles = [dockerfile, ...(ignorePath === undefined ? [] : [ignorePath])];
  // Docker receives the complete context. `inputs` remains useful for command
  // builds, but cannot safely narrow a Docker fingerprint unless the transmitted
  // context is narrowed as well.
  const candidates = await listInputs(context, new Set());
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

  return filtered;
}

function isDockerIgnored(matcher: Ignore, relativePath: string): boolean {
  return matcher.ignores(relativePath);
}

async function listDeclaredInputs(context: string, inputs: readonly string[], excluded: ReadonlySet<string>): Promise<BuildInput[]> {
  const entries = new Map<string, BuildInput>();
  for (const input of inputs) {
    const path = resolve(context, input);
    pathWithinContext(context, path, input);
    let details;
    try { details = await lstat(path); } catch { throw new Error(`build input does not exist: ${input}`); }
    if (details.isDirectory()) {
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

function inputKind(details: Stats): string {
  if (details.isFile()) return "file";
  if (details.isDirectory()) return "directory";
  if (details.isSymbolicLink()) return "symlink";
  return "other";
}

async function readBuildState(path: string): Promise<BuildState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BuildState>;
    if (parsed.version !== 1 || typeof parsed.fingerprint !== "string" || (parsed.kind !== "command" && parsed.kind !== "docker")) return undefined;
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
