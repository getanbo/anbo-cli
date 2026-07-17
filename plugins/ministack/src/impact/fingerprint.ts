import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ImpactNode, ImpactNodeKind } from "./graph.js";

export type ImpactDigest = `sha256:${string}`;
export type ImpactCertainty = "exact" | "unknown";

export interface ImpactFingerprintRecord {
  path: string;
  type: "directory" | "file" | "missing" | "symlink" | "unsupported";
  mode?: number;
  size?: number;
  sha256?: ImpactDigest;
  target?: string;
}

export interface ImpactFingerprint {
  digest: ImpactDigest;
  certainty: ImpactCertainty;
  records: readonly ImpactFingerprintRecord[];
  issues: readonly string[];
}

export interface FingerprintInputsOptions {
  root: string;
  inputs?: readonly string[];
  definition?: unknown;
  exclude?: readonly string[];
}

export interface FingerprintImpactNodeOptions extends FingerprintInputsOptions {
  id: string;
  kind: ImpactNodeKind;
  dependencies?: readonly string[];
  cacheable?: boolean;
  alwaysRun?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}

const FINGERPRINT_DOMAIN = "anbo.impact.inputs.v1";
const VALUE_DOMAIN = "anbo.impact.value.v1";
const GLOB_MAGIC = /[*?[\]]/;

/** Canonical JSON rejects values that cannot be represented deterministically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function fingerprintValue(value: unknown, domain = VALUE_DOMAIN): ImpactDigest {
  return sha256(`${domain}\0${canonicalJson(value)}`);
}

/**
 * Hash project-relative files, directories, and glob patterns without including
 * the checkout's absolute path. A filesystem read race degrades to `unknown`
 * rather than creating a reusable cache entry.
 */
export async function fingerprintInputs(options: FingerprintInputsOptions): Promise<ImpactFingerprint> {
  const root = resolve(options.root);
  const inputs = normalizedPatterns(options.inputs ?? []);
  const excludes = normalizedPatterns(options.exclude ?? []);
  const records = new Map<string, ImpactFingerprintRecord>();
  const issues: string[] = [];

  for (const input of inputs) {
    if (hasGlob(input)) {
      const prefix = globStaticPrefix(input);
      const start = resolveProjectPath(root, prefix === "" ? "." : prefix);
      const matcher = globRegex(input);
      await collectMatchingTree(root, start, matcher, excludes, records, issues);
      continue;
    }
    const path = resolveProjectPath(root, input);
    await collectExactTree(root, path, input, excludes, records, issues);
  }

  const sortedRecords = [...records.values()].sort((left, right) => compareText(left.path, right.path));
  const sortedIssues = [...new Set(issues)].sort(compareText);
  return {
    digest: fingerprintValue({
      schema_version: 1,
      definition: options.definition ?? null,
      inputs,
      excludes,
      records: sortedRecords,
      issues: sortedIssues,
    }, FINGERPRINT_DOMAIN),
    certainty: sortedIssues.length === 0 ? "exact" : "unknown",
    records: sortedRecords,
    issues: sortedIssues,
  };
}

export async function fingerprintImpactNode(options: FingerprintImpactNodeOptions): Promise<ImpactNode> {
  const fingerprint = await fingerprintInputs(options);
  return {
    id: options.id,
    kind: options.kind,
    fingerprint: fingerprint.digest,
    certainty: fingerprint.certainty,
    dependencies: [...(options.dependencies ?? [])],
    ...(fingerprint.issues.length === 0 ? {} : { issues: fingerprint.issues }),
    ...(options.cacheable === undefined ? {} : { cacheable: options.cacheable }),
    ...(options.alwaysRun === undefined ? {} : { alwaysRun: options.alwaysRun }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("canonical JSON does not support cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors));
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareText)
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key], ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function normalizedPatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map(normalizePattern))].sort(compareText);
}

function normalizePattern(input: string): string {
  if (input.length === 0 || input.includes("\0")) throw new Error("impact input paths must be non-empty and contain no null bytes");
  if (isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error(`impact input must be project-relative: ${input}`);
  }
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  const parts = normalized.split("/");
  if (parts.includes("..")) throw new Error(`impact input must remain inside the project: ${input}`);
  return normalized === "" ? "." : normalized;
}

function resolveProjectPath(root: string, input: string): string {
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`impact input must remain inside the project: ${input}`);
  }
  return path;
}

function hasGlob(input: string): boolean {
  return GLOB_MAGIC.test(input);
}

function globStaticPrefix(pattern: string): string {
  const parts = pattern.split("/");
  const staticParts: string[] = [];
  for (const part of parts) {
    if (hasGlob(part)) break;
    staticParts.push(part);
  }
  return staticParts.join("/");
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const content = pattern.slice(index + 1, end);
        source += `[${content.startsWith("!") ? `^${escapeCharacterClass(content.slice(1))}` : escapeCharacterClass(content)}]`;
        index = end;
      }
    } else {
      source += escapeRegex(character);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegex(value: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}

function escapeCharacterClass(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

async function collectMatchingTree(
  root: string,
  start: string,
  matcher: RegExp,
  excludes: readonly string[],
  records: Map<string, ImpactFingerprintRecord>,
  issues: string[],
): Promise<void> {
  let details: BigIntStats;
  try {
    details = await lstat(start, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    issues.push(readIssue(root, start, error));
    return;
  }
  await walk(root, start, details, excludes, async (path, entryDetails) => {
    const relativePath = projectRelative(root, path);
    if (matcher.test(relativePath)) await addRecord(root, path, entryDetails, records, issues);
  }, issues);
}

async function collectExactTree(
  root: string,
  path: string,
  declaredPath: string,
  excludes: readonly string[],
  records: Map<string, ImpactFingerprintRecord>,
  issues: string[],
): Promise<void> {
  let details: BigIntStats;
  try {
    details = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      records.set(declaredPath, { path: declaredPath, type: "missing" });
      return;
    }
    issues.push(readIssue(root, path, error));
    return;
  }
  await walk(root, path, details, excludes, async (entryPath, entryDetails) => {
    await addRecord(root, entryPath, entryDetails, records, issues);
  }, issues);
}

async function walk(
  root: string,
  path: string,
  details: BigIntStats,
  excludes: readonly string[],
  visit: (path: string, details: BigIntStats) => Promise<void>,
  issues: string[],
): Promise<void> {
  const relativePath = projectRelative(root, path);
  if (relativePath !== "." && matchesAny(excludes, relativePath)) return;
  await visit(path, details);
  if (!details.isDirectory()) return;
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    issues.push(readIssue(root, path, error));
    return;
  }
  names.sort(compareText);
  for (const name of names) {
    const child = join(path, name);
    let childDetails: BigIntStats;
    try {
      childDetails = await lstat(child, { bigint: true });
    } catch (error) {
      issues.push(readIssue(root, child, error));
      continue;
    }
    await walk(root, child, childDetails, excludes, visit, issues);
  }
}

async function addRecord(
  root: string,
  path: string,
  details: BigIntStats,
  records: Map<string, ImpactFingerprintRecord>,
  issues: string[],
): Promise<void> {
  const relativePath = projectRelative(root, path);
  const mode = Number(details.mode & 0o7777n);
  if (details.isDirectory()) {
    records.set(relativePath, { path: relativePath, type: "directory", mode });
    return;
  }
  if (details.isSymbolicLink()) {
    try {
      records.set(relativePath, { path: relativePath, type: "symlink", mode, target: await readlink(path) });
    } catch (error) {
      issues.push(readIssue(root, path, error));
    }
    return;
  }
  if (details.isFile()) {
    const stable = await readStableFile(path, details);
    if (stable === undefined) {
      issues.push(`${relativePath}: changed repeatedly while being fingerprinted`);
      return;
    }
    if (stable.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      issues.push(`${relativePath}: file is too large to fingerprint safely`);
      return;
    }
    records.set(relativePath, {
      path: relativePath,
      type: "file",
      mode: Number(stable.mode & 0o7777n),
      size: Number(stable.size),
      sha256: sha256(stable.contents),
    });
    return;
  }
  records.set(relativePath, { path: relativePath, type: "unsupported", mode });
  issues.push(`${relativePath}: unsupported filesystem entry`);
}

async function readStableFile(
  path: string,
  initial: BigIntStats,
): Promise<(BigIntStats & { contents: Buffer }) | undefined> {
  let before = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const contents = await readFile(path);
      const after = await lstat(path, { bigint: true });
      if (after.isFile() && sameFile(before, after) && BigInt(contents.byteLength) === after.size) {
        return Object.assign(after, { contents });
      }
      before = after;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) =>
    hasGlob(pattern)
      ? globRegex(pattern).test(path)
      : path === pattern || path.startsWith(`${pattern}/`)
  );
}

function projectRelative(root: string, path: string): string {
  const value = relative(root, path);
  return value === "" ? "." : value.split(sep).join("/");
}

function readIssue(root: string, path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${projectRelative(root, path)}: ${detail}`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sha256(value: string | Buffer): ImpactDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
