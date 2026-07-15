import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AnboError, ExitCode, type DiscoveryReport, type DockerfileDiscovery, type SdkDiscovery, type SdkLanguage, type TerraformRootDiscovery } from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".anbo",
  ".terraform",
  ".next",
  ".venv",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor"
]);

const MAX_FILES = 50_000;
const MAX_INSPECT_BYTES = 2 * 1024 * 1024;

type SdkEvidence = "manifest" | "source";

interface SdkHintCandidate extends SdkDiscovery {
  evidence: SdkEvidence;
}

const SDK_EVIDENCE_PRIORITY: Record<SdkEvidence, number> = {
  manifest: 0,
  source: 1
};

export interface DiscoveryOptions {
  maxFiles?: number;
}

export function discoverProject(input: string, options: DiscoveryOptions = {}): DiscoveryReport {
  const root = projectRoot(input);
  const files = walkProjectFiles(root, options.maxFiles ?? MAX_FILES);
  return {
    root,
    terraform: discoverTerraform(root, files),
    sdk: discoverSdks(root, files),
    dockerfiles: discoverDockerfiles(root, files)
  };
}

export function projectRoot(input: string): string {
  const absolute = resolve(input);
  if (!existsSync(absolute)) {
    throw new AnboError(`project path does not exist: ${absolute}`, {
      exitCode: ExitCode.Configuration,
      code: "ANBO_PROJECT_NOT_FOUND"
    });
  }
  let current = realpathSync(statSync(absolute).isDirectory() ? absolute : dirname(absolute));
  const original = current;
  while (true) {
    if ([
      join(current, ".anbo", "sandbox.json"),
      join(current, ".git"),
      join(current, "package.json"),
      join(current, "pyproject.toml"),
      join(current, "go.mod"),
      join(current, "pom.xml")
    ].some(existsSync)) return current;
    const parent = dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}

export function discoverTerraform(root: string, files = walkProjectFiles(root, MAX_FILES)): TerraformRootDiscovery[] {
  const terraformDirectories = new Map<string, string[]>();
  const variableFiles: string[] = [];
  const moduleDirectories = new Set<string>();
  for (const absolute of files) {
    const name = basename(absolute);
    const isTerraform = name.endsWith(".tf") || name.endsWith(".tf.json");
    const isVariables = name.endsWith(".tfvars") || name.endsWith(".tfvars.json");
    if (!isTerraform && !isVariables) continue;
    if (isVariables) {
      variableFiles.push(absolute);
      continue;
    }
    const directory = dirname(absolute);
    const terraformFiles = terraformDirectories.get(directory) ?? [];
    terraformFiles.push(relativePath(root, absolute));
    terraformDirectories.set(directory, terraformFiles);
    for (const source of discoverLocalModuleSources(absolute)) {
      const moduleDirectory = resolve(directory, source);
      if (isInside(root, moduleDirectory)) moduleDirectories.add(moduleDirectory);
    }
  }

  const roots = [...terraformDirectories.entries()]
    .filter(([directory]) => ![...moduleDirectories].some((moduleDirectory) => isInside(moduleDirectory, directory)))
    .map(([directory, terraformFiles]) => ({
      directory,
      path: relativePath(root, directory),
      files: terraformFiles.sort(),
      variable_files: [] as string[]
    }));

  for (const variableFile of variableFiles.sort()) {
    if ([...moduleDirectories].some((directory) => isInside(directory, variableFile))) continue;
    const owner = roots
      .filter((candidate) => isInside(candidate.directory, variableFile))
      .sort((left, right) => pathDepth(right.directory) - pathDepth(left.directory) || left.path.localeCompare(right.path))[0];
    owner?.variable_files.push(relativePath(root, variableFile));
  }

  return roots
    .map(({ directory: _directory, ...entry }) => entry)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function discoverSdks(root: string, files = walkProjectFiles(root, MAX_FILES)): SdkDiscovery[] {
  const hints = new Map<string, SdkHintCandidate>();
  for (const absolute of files) {
    const name = basename(absolute);
    const extension = extensionOf(name);
    const relativeFile = relativePath(root, absolute);
    if (!isSdkCandidate(name, extension)) continue;
    const stat = statSync(absolute);
    if (stat.size > MAX_INSPECT_BYTES) continue;
    const source = readFileSync(absolute, "utf8");

    if (name === "package.json") {
      discoverNodePackageJson(source, relativeFile, hints);
    }
    if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
      addMatches(hints, "node", source, /(?:from\s*|require\s*\(\s*|import\s*\(\s*)["'](@aws-sdk\/[a-z0-9_-]+|aws-sdk)["']/gi, relativeFile, "source");
    }

    if (/^(?:requirements(?:-[^.]*)?\.txt|pyproject\.toml|Pipfile)$/.test(name)) {
      addMatches(hints, "python", source, /(?:^|[\s"'])(boto3|botocore|aioboto3)(?=[\s"'=<>~!;,\]])/gim, relativeFile, "manifest");
    }
    if (extension === ".py") {
      addMatches(hints, "python", source, /^\s*(?:from|import)\s+(boto3|botocore|aioboto3)(?:\.|\s|$)/gim, relativeFile, "source");
    }

    if (name === "go.mod") {
      addMatches(hints, "go", source, /["\s](github\.com\/aws\/aws-sdk-go(?:-v2)?(?:\/[a-zA-Z0-9_./-]+)?)/g, relativeFile, "manifest");
    } else if (extension === ".go") {
      addMatches(hints, "go", source, /["\s](github\.com\/aws\/aws-sdk-go(?:-v2)?(?:\/[a-zA-Z0-9_./-]+)?)/g, relativeFile, "source");
    }

    if (["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].includes(name)) {
      addMatches(hints, "java", source, /((?:software\.amazon\.awssdk|com\.amazonaws)[:.][a-zA-Z0-9_.-]+)/g, relativeFile, "manifest");
    }
    if (extension === ".java" || extension === ".kt") {
      addMatches(hints, "java", source, /(?:import\s+)((?:software\.amazon\.awssdk|com\.amazonaws)\.[a-zA-Z0-9_.*]+)/g, relativeFile, "source", (match) => {
        const parts = match.split(".");
        return parts.slice(0, Math.min(parts.length, 4)).join(".");
      });
    }
  }
  return [...hints.values()].map(({ evidence: _evidence, ...hint }) => hint).sort((left, right) =>
    left.language.localeCompare(right.language) || left.package.localeCompare(right.package) || left.file.localeCompare(right.file)
  );
}

export function discoverDockerfiles(root: string, files = walkProjectFiles(root, MAX_FILES)): DockerfileDiscovery[] {
  return files
    .filter((path) => /^Dockerfile(?:\.[A-Za-z0-9_.-]+)?$/.test(basename(path)))
    .map((path) => ({ path: relativePath(root, path), context: relativePath(root, dirname(path)) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function discoverNodePackageJson(source: string, file: string, hints: Map<string, SdkHintCandidate>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const manifest = parsed as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const dependencies = manifest[section];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const packageName of Object.keys(dependencies)) {
      if (packageName === "aws-sdk" || packageName.startsWith("@aws-sdk/")) addHint(hints, "node", packageName, file, "manifest");
    }
  }
}

function addMatches(
  hints: Map<string, SdkHintCandidate>,
  language: SdkLanguage,
  source: string,
  pattern: RegExp,
  file: string,
  evidence: SdkEvidence,
  normalize: (match: string) => string = (match) => match
): void {
  for (const match of source.matchAll(pattern)) {
    const packageName = match[1];
    if (packageName !== undefined) addHint(hints, language, normalize(packageName), file, evidence);
  }
}

function addHint(
  hints: Map<string, SdkHintCandidate>,
  language: SdkLanguage,
  packageName: string,
  file: string,
  evidence: SdkEvidence
): void {
  const key = `${language}\0${packageName}`;
  const hint = { language, package: packageName, file, evidence };
  const current = hints.get(key);
  if (current === undefined
    || SDK_EVIDENCE_PRIORITY[hint.evidence] < SDK_EVIDENCE_PRIORITY[current.evidence]
    || (hint.evidence === current.evidence && hint.file.localeCompare(current.file) < 0)) {
    hints.set(key, hint);
  }
}

function walkProjectFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(path);
        if (files.length > maxFiles) {
          throw new AnboError(`project discovery exceeded ${maxFiles} files`, {
            exitCode: ExitCode.Configuration,
            code: "ANBO_DISCOVERY_FILE_LIMIT",
            details: { remediation: "Ignore generated directories or configure the project from a narrower root." }
          });
        }
      }
    }
  };
  walk(root);
  return files;
}

function isSdkCandidate(name: string, extension: string): boolean {
  return [
    "package.json", "pyproject.toml", "Pipfile", "go.mod",
    "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"
  ].includes(name)
    || /^requirements(?:-[^.]*)?\.txt$/.test(name)
    || [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".java", ".kt"].includes(extension);
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index);
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  return value.length === 0 ? "." : value;
}

function discoverLocalModuleSources(path: string): string[] {
  const source = readFileSync(path, "utf8");
  if (path.endsWith(".tf.json")) return discoverJsonLocalModuleSources(source);
  const tokens = tokenizeTerraform(source);
  const moduleSources: string[] = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index]?.value !== "module" || tokens[index + 1]?.kind !== "string" || tokens[index + 2]?.value !== "{") continue;
    const close = matchingBrace(tokens, index + 2);
    let depth = 1;
    for (let inner = index + 3; inner < close; inner += 1) {
      const token = tokens[inner];
      if (token?.value === "{") depth += 1;
      if (token?.value === "}") depth -= 1;
      if (depth !== 1 || token?.value !== "source" || tokens[inner + 1]?.value !== "=") continue;
      const value = tokens[inner + 2];
      if (value?.kind === "string" && isLocalModuleSource(value.value)) moduleSources.push(value.value);
    }
    index = close;
  }
  return moduleSources;
}

function discoverJsonLocalModuleSources(source: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed["module"])) return [];
  const sources: string[] = [];
  for (const module of Object.values(parsed["module"])) {
    if (isRecord(module) && typeof module["source"] === "string" && isLocalModuleSource(module["source"])) {
      sources.push(module["source"]);
    }
  }
  return sources;
}

interface TerraformToken {
  kind: "word" | "string" | "punctuation";
  value: string;
}

function tokenizeTerraform(source: string): TerraformToken[] {
  const tokens: TerraformToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === "#" || (character === "/" && source[index + 1] === "/")) {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (character === '"') {
      index += 1;
      let value = "";
      while (index < source.length) {
        const current = source[index] ?? "";
        if (current === "\\") {
          value += current + (source[index + 1] ?? "");
          index += 2;
        } else if (current === '"') {
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(character)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_.-]/.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "word", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function matchingBrace(tokens: readonly TerraformToken[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "{") depth += 1;
    if (tokens[index]?.value === "}") depth -= 1;
    if (depth === 0) return index;
  }
  return tokens.length;
}

function isLocalModuleSource(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../") || isAbsolute(source);
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pathDepth(path: string): number {
  return resolve(path).split(sep).filter((part) => part.length > 0).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const __testing = { walkProjectFiles };
