import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TERRAFORM_RECONCILIATION_SCHEMA_VERSION = 1 as const;

const EXCLUDED_DIRECTORIES = new Set([".anbo", ".git", ".terraform", "node_modules"]);
const EXCLUDED_FILES = new Set(["terraform.tfstate", "terraform.tfstate.backup"]);
const TERRAFORM_TREE_HASH_CACHE_SCHEMA_VERSION = 1 as const;

export interface TerraformReconciliationFingerprintInput {
  projectDirectory: string;
  sourceDirectory: string;
  excludedPaths?: readonly string[];
  root: string;
  variableFiles: readonly string[];
  workerImage: string;
  stateIdentity: {
    key: string;
    filename: string;
  };
  miniStack: {
    containerName: string;
    containerId?: string;
    runtimeGeneration?: string;
    networkName: string;
    containerEndpoint: string;
    image: string;
    profile: "full";
    persistence: boolean;
    environment?: Readonly<Record<string, string>>;
  };
  terraform: {
    region: string;
    accountId: string;
  };
}

interface TerraformTreeRecord {
  path: string;
  type: "directory" | "file";
  bytes?: number;
  sha256?: string;
}

interface TerraformTreeFileMetadata {
  size: string;
  mtime_ns: string;
  ctime_ns: string;
  dev: string;
  ino: string;
}

interface TerraformTreeHashCacheEntry extends TerraformTreeFileMetadata {
  path: string;
  sha256: string;
}

interface TerraformTreeHashCache {
  schema_version: typeof TERRAFORM_TREE_HASH_CACHE_SCHEMA_VERSION;
  files: TerraformTreeHashCacheEntry[];
}

export interface TerraformReconciliationFingerprintOptions {
  /** Project/root-scoped cache outside the source tree. Cache failures degrade to a full content scan. */
  treeHashCachePath?: string;
  /** Injectable source-content reader used by focused cache tests. */
  readContent?: (path: string) => Promise<Buffer>;
}

/** Hashes every copied Terraform input using an unambiguous structured encoding. */
export async function terraformReconciliationFingerprint(
  input: TerraformReconciliationFingerprintInput,
  options: TerraformReconciliationFingerprintOptions = {},
): Promise<string> {
  const source = resolve(input.sourceDirectory);
  await assertTerraformTreeRoot(input.projectDirectory, source);
  const excludedPaths = resolvedPaths(input.excludedPaths ?? []);
  const tree: TerraformTreeRecord[] = [];
  const previousCache = options.treeHashCachePath === undefined
    ? emptyTerraformTreeHashCache()
    : await readTerraformTreeHashCache(options.treeHashCachePath);
  const nextCache = new Map<string, TerraformTreeHashCacheEntry>();
  await collectTerraformTree(
    source,
    source,
    excludedPaths,
    tree,
    previousCache.files,
    nextCache,
    options.readContent ?? readFile,
  );
  if (options.treeHashCachePath !== undefined) {
    const payload = terraformTreeHashCachePayload(nextCache);
    if (stableJson(payload) !== previousCache.canonical) {
      await writeTerraformTreeHashCache(options.treeHashCachePath, payload).catch(() => undefined);
    }
  }
  return createHash("sha256").update(stableJson({
    schema_version: TERRAFORM_RECONCILIATION_SCHEMA_VERSION,
    root: input.root,
    // Terraform applies later -var-file values last, so declaration order is semantic.
    variable_files: [...input.variableFiles],
    worker_image: input.workerImage,
    state: input.stateIdentity,
    ministack: input.miniStack,
    terraform: input.terraform,
    tree,
  })).digest("hex");
}

export async function assertTerraformTreeRoot(projectDirectory: string, sourceDirectory: string): Promise<void> {
  const project = resolve(projectDirectory);
  const source = resolve(sourceDirectory);
  const lexicalPath = relative(project, source);
  if (lexicalPath === ".." || lexicalPath.startsWith(`..${sep}`) || isAbsolute(lexicalPath)) {
    throw new Error(`Terraform root must remain inside the project: ${sourceDirectory}`);
  }

  const components = lexicalPath === "" ? [] : lexicalPath.split(sep);
  let current = project;
  for (const component of ["", ...components]) {
    if (component !== "") current = join(current, component);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new Error(`Terraform tree may not contain symbolic links: ${current}`);
    if (!details.isDirectory()) throw new Error(`Terraform root ancestor must be a directory: ${current}`);
  }

  const [projectRealPath, sourceRealPath] = await Promise.all([realpath(project), realpath(source)]);
  const realPath = relative(projectRealPath, sourceRealPath);
  if (realPath === ".." || realPath.startsWith(`..${sep}`) || isAbsolute(realPath)) {
    throw new Error(`Terraform root must remain inside the real project directory: ${sourceDirectory}`);
  }
}

export function aggregateTerraformReconciliationFingerprint(
  roots: readonly { index: number; root: string; state_key: string; fingerprint: string }[],
): string {
  return createHash("sha256")
    .update(stableJson({
      schema_version: TERRAFORM_RECONCILIATION_SCHEMA_VERSION,
      roots: roots.map(({ index, root, state_key, fingerprint }) => ({ index, root, state_key, fingerprint })),
    }))
    .digest("hex");
}

export function terraformRootStateKey(projectRoot: string, configuredRoot: string): string {
  const project = resolve(projectRoot);
  const root = resolve(project, configuredRoot);
  const path = relative(project, root);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Terraform root must remain inside the project: ${configuredRoot}`);
  }
  const canonical = path === "" ? "." : path.split(sep).join("/");
  return createHash("sha256").update(`anbo.terraform.root.v1\0${canonical}`).digest("hex");
}

export interface TerraformStateMetadata {
  size: number;
  sha256: string;
}

/** State files are small; hashing detects replacement without persisting their contents. */
export async function terraformStateMetadata(path: string): Promise<TerraformStateMetadata | undefined> {
  try {
    const details = await lstat(path);
    if (!details.isFile()) return undefined;
    const contents = await readFile(path);
    return { size: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function terraformLockCacheKey(sourceDirectory: string, workerImage: string): Promise<string | undefined> {
  let sourceLock: Buffer;
  try { sourceLock = await readFile(join(sourceDirectory, ".terraform.lock.hcl")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return createHash("sha256")
    .update("anbo.terraform.lock-cache.v1\0")
    .update(workerImage)
    .update("\0")
    .update(sourceLock)
    .digest("hex");
}

export async function terraformTreePathExcluded(path: string, excludedPaths: readonly string[]): Promise<boolean> {
  const absolute = resolve(path);
  if (resolvedPaths(excludedPaths).some((excluded) => absolute === excluded || absolute.startsWith(`${excluded}${sep}`))) {
    return true;
  }
  const details = await lstat(absolute);
  const name = absolute.slice(absolute.lastIndexOf(sep) + 1);
  if (details.isSymbolicLink()) throw new Error(`Terraform tree may not contain symbolic links: ${path}`);
  if (!details.isDirectory() && !details.isFile()) throw new Error(`Terraform tree contains unsupported filesystem entry: ${path}`);
  return details.isDirectory() ? EXCLUDED_DIRECTORIES.has(name) : EXCLUDED_FILES.has(name);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function collectTerraformTree(
  root: string,
  directory: string,
  excludedPaths: readonly string[],
  records: TerraformTreeRecord[],
  cachedFiles: ReadonlyMap<string, TerraformTreeHashCacheEntry>,
  nextCache: Map<string, TerraformTreeHashCacheEntry>,
  readContent: (path: string) => Promise<Buffer>,
): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (resolvedPathExcluded(path, excludedPaths)) continue;
    const details = await lstat(path, { bigint: true });
    assertSupportedTerraformTreeEntry(path, details);
    if (details.isDirectory() ? EXCLUDED_DIRECTORIES.has(entry.name) : EXCLUDED_FILES.has(entry.name)) continue;
    const relativePath = relative(root, path).split(sep).join("/");
    if (details.isDirectory()) {
      records.push({ path: relativePath, type: "directory" });
      await collectTerraformTree(root, path, excludedPaths, records, cachedFiles, nextCache, readContent);
      continue;
    }
    let metadata = terraformTreeFileMetadata(details);
    let sha256: string;
    const cached = cachedFiles.get(relativePath);
    if (cached !== undefined && sameTerraformTreeFileMetadata(cached, metadata)) {
      sha256 = cached.sha256;
    } else {
      const hashed = await hashStableTerraformFile(path, details, readContent);
      metadata = hashed.metadata;
      sha256 = hashed.sha256;
    }
    nextCache.set(relativePath, { path: relativePath, ...metadata, sha256 });
    records.push({
      path: relativePath,
      type: "file",
      bytes: Number(BigInt(metadata.size)),
      sha256,
    });
  }
}

async function hashStableTerraformFile(
  path: string,
  initialDetails: BigIntStats,
  readContent: (path: string) => Promise<Buffer>,
): Promise<{ metadata: TerraformTreeFileMetadata; sha256: string }> {
  let before = initialDetails;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const beforeMetadata = terraformTreeFileMetadata(before);
    const contents = await readContent(path);
    const after = await lstat(path, { bigint: true });
    assertSupportedTerraformTreeEntry(path, after);
    if (!after.isFile()) throw new Error(`Terraform tree entry changed type while hashing: ${path}`);
    const afterMetadata = terraformTreeFileMetadata(after);
    if (sameTerraformTreeFileMetadata(beforeMetadata, afterMetadata) && BigInt(contents.byteLength) === after.size) {
      return {
        metadata: afterMetadata,
        sha256: createHash("sha256").update(contents).digest("hex"),
      };
    }
    before = after;
  }
  throw new Error(`Terraform input changed repeatedly while hashing: ${path}`);
}

function terraformTreeFileMetadata(details: BigIntStats): TerraformTreeFileMetadata {
  if (!details.isFile()) throw new Error("Terraform tree hash metadata requires a regular file");
  if (details.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Terraform input is too large to fingerprint safely: ${details.size.toString()} bytes`);
  }
  return {
    size: details.size.toString(),
    mtime_ns: details.mtimeNs.toString(),
    ctime_ns: details.ctimeNs.toString(),
    dev: details.dev.toString(),
    ino: details.ino.toString(),
  };
}

function sameTerraformTreeFileMetadata(
  left: TerraformTreeFileMetadata,
  right: TerraformTreeFileMetadata,
): boolean {
  return left.size === right.size && left.mtime_ns === right.mtime_ns && left.ctime_ns === right.ctime_ns &&
    left.dev === right.dev && left.ino === right.ino;
}

function assertSupportedTerraformTreeEntry(path: string, details: BigIntStats): void {
  if (details.isSymbolicLink()) throw new Error(`Terraform tree may not contain symbolic links: ${path}`);
  if (!details.isDirectory() && !details.isFile()) {
    throw new Error(`Terraform tree contains unsupported filesystem entry: ${path}`);
  }
}

function resolvedPathExcluded(path: string, excludedPaths: readonly string[]): boolean {
  const absolute = resolve(path);
  return excludedPaths.some((excluded) => absolute === excluded || absolute.startsWith(`${excluded}${sep}`));
}

function terraformTreeHashCachePayload(
  entries: ReadonlyMap<string, TerraformTreeHashCacheEntry>,
): TerraformTreeHashCache {
  return {
    schema_version: TERRAFORM_TREE_HASH_CACHE_SCHEMA_VERSION,
    files: [...entries.values()].sort((left, right) => compareText(left.path, right.path)),
  };
}

function emptyTerraformTreeHashCache(): {
  files: ReadonlyMap<string, TerraformTreeHashCacheEntry>;
  canonical?: string;
} {
  return { files: new Map() };
}

async function readTerraformTreeHashCache(path: string): Promise<{
  files: ReadonlyMap<string, TerraformTreeHashCacheEntry>;
  canonical?: string;
}> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isTerraformTreeHashCache(parsed)) return emptyTerraformTreeHashCache();
    const files = new Map<string, TerraformTreeHashCacheEntry>();
    for (const entry of parsed.files) {
      if (files.has(entry.path)) return emptyTerraformTreeHashCache();
      files.set(entry.path, entry);
    }
    return { files, canonical: stableJson(parsed) };
  } catch {
    return emptyTerraformTreeHashCache();
  }
}

function isTerraformTreeHashCache(value: unknown): value is TerraformTreeHashCache {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate["schema_version"] !== TERRAFORM_TREE_HASH_CACHE_SCHEMA_VERSION || !Array.isArray(candidate["files"])) {
    return false;
  }
  return candidate["files"].every((value): value is TerraformTreeHashCacheEntry => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry["path"] === "string" && safeRelativeCachePath(entry["path"]) &&
      typeof entry["sha256"] === "string" && /^[a-f0-9]{64}$/.test(entry["sha256"]) &&
      decimalString(entry["size"], false) && BigInt(entry["size"]) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      decimalString(entry["mtime_ns"], true) && decimalString(entry["ctime_ns"], true) &&
      decimalString(entry["dev"], false) && decimalString(entry["ino"], false);
  });
}

function safeRelativeCachePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && value.split("/").every((component) => component !== "" && component !== "." && component !== "..");
}

function decimalString(value: unknown, signed: boolean): value is string {
  return typeof value === "string" && (signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value);
}

async function writeTerraformTreeHashCache(path: string, payload: TerraformTreeHashCache): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${stableJson(payload)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function resolvedPaths(paths: readonly string[]): string[] {
  return paths.map((path) => resolve(path));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
