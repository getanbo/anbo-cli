import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const TERRAFORM_RECONCILIATION_SCHEMA_VERSION = 1 as const;

const EXCLUDED_DIRECTORIES = new Set([".anbo", ".git", ".terraform", "node_modules"]);
const EXCLUDED_FILES = new Set(["terraform.tfstate", "terraform.tfstate.backup"]);

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

/** Hashes every copied Terraform input using an unambiguous structured encoding. */
export async function terraformReconciliationFingerprint(
  input: TerraformReconciliationFingerprintInput,
): Promise<string> {
  const source = resolve(input.sourceDirectory);
  await assertTerraformTreeRoot(input.projectDirectory, source);
  const excludedPaths = resolvedPaths(input.excludedPaths ?? []);
  const tree: TerraformTreeRecord[] = [];
  await collectTerraformTree(source, source, excludedPaths, tree);
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
): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (await terraformTreePathExcluded(path, excludedPaths)) continue;
    const relativePath = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      records.push({ path: relativePath, type: "directory" });
      await collectTerraformTree(root, path, excludedPaths, records);
      continue;
    }
    const contents = await readFile(path);
    records.push({
      path: relativePath,
      type: "file",
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
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
