import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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

const IGNORED_DIRECTORIES = new Set([".git", ".anbo", ".terraform", "node_modules"]);

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
  const declaredOutputs = Object.values(options.builds).flatMap((build) => (build.outputs ?? []).map((path) => resolve(options.root, path)));
  const results: Record<string, BuildResult> = {};
  for (const [name, config] of Object.entries(options.builds)) {
    const context = resolve(options.root, config.context);
    const cacheDirectory = join(options.cacheRoot, projectId, safeProjectId(name));
    const statePath = join(cacheDirectory, "state.json");
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const fingerprint = await buildFingerprint(options.root, context, config, [cacheDirectory, ...declaredOutputs]);
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
      const args = [
        "buildx", "build", "--load", "--pull",
        "--tag", image,
        "--label", "anbo.dev/managed=true",
        "--label", `anbo.dev/project=${projectId}`,
        "--label", `anbo.dev/build=${name}`,
        ...(existsSync(buildkitCache) ? ["--cache-from", `type=local,src=${buildkitCache}`] : []),
        "--cache-to", `type=local,dest=${nextCache},mode=max`,
        "--metadata-file", metadataPath,
        "--file", resolve(context, config.dockerfile ?? "Dockerfile"),
        ...(config.target === undefined ? [] : ["--target", config.target]),
        ...(config.platform === undefined ? [] : ["--platform", config.platform]),
        ...Object.entries(config.args ?? {}).sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
        context,
      ];
      const result = await commands.run("docker", args, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(dependencies.onOutput === undefined ? {} : { onOutput: (stream: "stdout" | "stderr", text: string) => dependencies.onOutput?.(name, stream, text) }),
      });
      if (result.code !== 0) {
        await rm(nextCache, { recursive: true, force: true });
        await rm(metadataPath, { force: true });
        throw new Error(`Docker build ${name} failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      try { metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>; } catch { /* Optional BuildKit metadata. */ }
      await rm(metadataPath, { force: true });
      if (existsSync(nextCache)) {
        await rm(buildkitCache, { recursive: true, force: true });
        await rename(nextCache, buildkitCache);
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
  const files = config.inputs === undefined
    ? await listInputs(context, outputPaths)
    : await listDeclaredInputs(context, config.inputs, outputPaths);
  for (const path of files) {
    hash.update(relative(context, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listDeclaredInputs(context: string, inputs: readonly string[], excluded: ReadonlySet<string>): Promise<string[]> {
  const files = new Set<string>();
  for (const input of inputs) {
    const path = resolve(context, input);
    const withinContext = relative(context, path);
    if (withinContext.startsWith(".." + sep) || withinContext === ".." || withinContext.startsWith(sep)) {
      throw new Error(`build input must remain inside its context: ${input}`);
    }
    let details;
    try { details = await lstat(path); } catch { throw new Error(`build input does not exist: ${input}`); }
    if (details.isSymbolicLink()) throw new Error(`build input may not be a symbolic link: ${input}`);
    if (details.isDirectory()) {
      for (const nested of await listInputs(path, excluded)) files.add(nested);
    } else if (details.isFile() && ![...excluded].some((excludedPath) => path === excludedPath || path.startsWith(excludedPath + sep))) {
      files.add(path);
    }
  }
  return [...files].sort();
}

async function listInputs(directory: string, excluded: ReadonlySet<string>): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    if ([...excluded].some((path) => current === path || current.startsWith(path + sep))) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = join(current, entry.name);
      if ([...excluded].some((excludedPath) => path === excludedPath || path.startsWith(excludedPath + sep))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(directory);
  return files.sort();
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
