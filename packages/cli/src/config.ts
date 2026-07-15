import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import {
  ANBO_PLUGIN_LOCK_API_VERSION,
  ANBO_PROJECT_API_VERSION,
  type AnboPluginLock,
  type AnboProjectConfig,
  type JsonObject,
} from "@getanbo/plugin-sdk";
import { FIRST_PARTY_PLUGINS, PLUGIN_LOCK_PATH, PROJECT_CONFIG_PATH } from "./constants.js";
import { UsageError } from "./errors.js";

export interface ProjectFiles {
  rootDir: string;
  project: AnboProjectConfig;
  lock: AnboPluginLock;
}

export async function resolveProjectRoot(start: string, explicitRoot?: string): Promise<string> {
  if (explicitRoot) return resolve(explicitRoot);
  let current = resolve(start);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (await fileExists(join(current, PROJECT_CONFIG_PATH))) return current;
    if (current === filesystemRoot) return resolve(start);
    current = dirname(current);
  }
}

export async function loadProject(rootDir: string): Promise<ProjectFiles> {
  const project = await readJson<AnboProjectConfig>(join(rootDir, PROJECT_CONFIG_PATH));
  if (!project) {
    throw new UsageError(
      `No ${PROJECT_CONFIG_PATH} found from ${rootDir}.`,
      "Run anbo configure --target <target> first.",
    );
  }
  validateProject(project);
  const lock =
    (await readJson<AnboPluginLock>(join(rootDir, PLUGIN_LOCK_PATH))) ?? emptyPluginLock();
  validatePluginLock(lock);
  return { rootDir, project, lock };
}

export async function ensureProject(rootDir: string, target: string): Promise<ProjectFiles> {
  const existing = await readJson<AnboProjectConfig>(join(rootDir, PROJECT_CONFIG_PATH));
  const firstParty = FIRST_PARTY_PLUGINS[target];
  if (!existing && !firstParty) {
    throw new UsageError(
      `Target ${target} is not registered.`,
      `Create ${PROJECT_CONFIG_PATH} with an explicit plugin package mapping.`,
    );
  }
  const project: AnboProjectConfig = existing ?? {
    apiVersion: ANBO_PROJECT_API_VERSION,
    defaultTarget: target,
    plugins: {},
  };
  validateProject(project);
  project.defaultTarget = project.defaultTarget || target;
  project.plugins[target] ??= {
    package: firstParty?.package ?? "",
    config: {},
  };
  if (!project.plugins[target]?.package && firstParty) {
    project.plugins[target] = { ...project.plugins[target], package: firstParty.package };
  }
  await writeJsonAtomic(join(rootDir, PROJECT_CONFIG_PATH), project);

  const lock =
    (await readJson<AnboPluginLock>(join(rootDir, PLUGIN_LOCK_PATH))) ?? emptyPluginLock();
  validatePluginLock(lock);
  await writeJsonAtomic(join(rootDir, PLUGIN_LOCK_PATH), lock);
  return { rootDir, project, lock };
}

export async function savePluginLock(rootDir: string, lock: AnboPluginLock): Promise<void> {
  validatePluginLock(lock);
  await writeJsonAtomic(join(rootDir, PLUGIN_LOCK_PATH), lock);
}

export function pluginConfig(project: AnboProjectConfig, target: string): JsonObject {
  return project.plugins[target]?.config ?? {};
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new UsageError(`Invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function validateProject(value: AnboProjectConfig): void {
  if (
    value.apiVersion !== ANBO_PROJECT_API_VERSION ||
    typeof value.defaultTarget !== "string" ||
    !isRecord(value.plugins)
  ) {
    throw new UsageError(`Invalid ${PROJECT_CONFIG_PATH}.`);
  }
  for (const [target, entry] of Object.entries(value.plugins)) {
    if (!target || !isRecord(entry) || typeof entry.package !== "string" || !entry.package) {
      throw new UsageError(`Invalid plugin mapping for target ${target || "<empty>"}.`);
    }
  }
}

function validatePluginLock(value: AnboPluginLock): void {
  if (value.apiVersion !== ANBO_PLUGIN_LOCK_API_VERSION || !isRecord(value.plugins)) {
    throw new UsageError(`Invalid ${PLUGIN_LOCK_PATH}.`);
  }
}

function emptyPluginLock(): AnboPluginLock {
  return { apiVersion: ANBO_PLUGIN_LOCK_API_VERSION, plugins: {} };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
