import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { JsonObject, JsonValue, TargetActionV1, TargetResultV1 } from "@getanbo/plugin-sdk";
import { parseCliArgs, type ParsedCliArgs } from "./args.js";
import { ensureProject, loadProject, pluginConfig, resolveProjectRoot } from "./config.js";
import {
  CLI_VERSION,
  EXIT_CODE,
  FIRST_PARTY_PLUGINS,
  LEGACY_CLOUD_COMMANDS,
  LIFECYCLE,
} from "./constants.js";
import { AnboError, UsageError } from "./errors.js";
import { EventWriter } from "./events.js";
import {
  executePluginCommand,
  executeTarget,
  isPluginPackageInstalled,
  loadAndActivatePlugin,
  lockLoadedPlugin,
} from "./plugins.js";

export interface CliDependencies {
  cwd?: string;
  stdout?: (value: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const previousEnv = process.env;
  if (dependencies.env) process.env = dependencies.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const writeOut = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    parsed = fallbackArgs(argv);
    return await finishWithParseError(error, parsed, writeOut);
  } finally {
    if (dependencies.env) process.env = previousEnv;
  }

  const controller = new AbortController();
  const upstreamAbort = () => controller.abort(dependencies.signal?.reason);
  dependencies.signal?.addEventListener("abort", upstreamAbort, { once: true });
  if (dependencies.signal?.aborted) upstreamAbort();
  const runId = randomUUID();
  const writer = new EventWriter(runId, parsed.command, parsed.target, parsed.output, writeOut);
  const started = performance.now();
  let cancellationEmitted = false;
  const emitCancellation = () => {
    if (cancellationEmitted) return;
    cancellationEmitted = true;
    writer.emit({
      type: "run.cancellation_requested",
      level: "warn",
      message: "Cancellation requested; waiting for the active operation to stop.",
    });
  };
  controller.signal.addEventListener("abort", emitCancellation, { once: true });

  writer.emit({
    type: "run.started",
    message: `anbo ${parsed.command} started`,
    data: { argv: parsed.raw, output: parsed.output },
  });

  let exitCode: number = EXIT_CODE.success;
  try {
    if (dependencies.env) process.env = dependencies.env;
    await dispatch(parsed, cwd, writer, controller.signal);
    if (controller.signal.aborted) exitCode = EXIT_CODE.cancelled;
  } catch (error) {
    const normalized = normalizeError(error, controller.signal.aborted);
    exitCode = normalized.exitCode;
    writer.emit({
      type: "diagnostic",
      level: "error",
      message: normalized.message,
      data: {
        code: normalized.code,
        ...(normalized.hint ? { remediation: normalized.hint } : {}),
      },
    });
  } finally {
    if (dependencies.env) process.env = previousEnv;
    dependencies.signal?.removeEventListener("abort", upstreamAbort);
    controller.signal.removeEventListener("abort", emitCancellation);
  }

  writer.emit({
    type: "run.finished",
    level: exitCode === 0 ? "info" : "error",
    message: exitCode === 0 ? "Run completed." : "Run failed.",
    data: {
      status: exitCode === 0 ? "succeeded" : exitCode === 130 ? "cancelled" : "failed",
      exitCode,
      duration_ms: Math.round(performance.now() - started),
    },
  });
  writer.flushJson(exitCode);
  return exitCode;
}

async function dispatch(
  parsed: ParsedCliArgs,
  cwd: string,
  writer: EventWriter,
  signal: AbortSignal,
): Promise<void> {
  if (parsed.help || parsed.command === "help") {
    writer.emit({ type: "help", message: HELP });
    return;
  }
  if (parsed.command === "version") {
    writer.emit({ type: "version", message: `anbo ${CLI_VERSION}`, data: { version: CLI_VERSION } });
    return;
  }
  if (parsed.command === "plugin") {
    await runPluginCommand(parsed, cwd, writer);
    return;
  }

  const rootDir = await resolveProjectRoot(cwd, parsed.root);
  if (parsed.command === "doctor") {
    await runDoctor(parsed, rootDir, writer, signal);
    return;
  }

  const cloudNamespace = parsed.command === "cloud";
  const isConfigure = parsed.command === "configure" || parsed.command === "setup";
  const isLegacy = LEGACY_CLOUD_COMMANDS.has(parsed.command) || cloudNamespace;
  let target = parsed.target;
  if (cloudNamespace) target = "cloud";
  let files;
  if (isConfigure || isLegacy) {
    target ??= isLegacy ? "cloud" : undefined;
    if (!target) {
      try {
        target = (await loadProject(rootDir)).project.defaultTarget;
      } catch {
        throw new UsageError("configure requires --target for a new project.");
      }
    }
    files = await ensureProject(rootDir, target);
  } else {
    files = await loadProject(rootDir);
    target ??= files.project.defaultTarget;
  }
  if (!target) throw new UsageError("No target selected.");
  writer.setTarget(target);

  const loaded = await loadAndActivatePlugin({
    rootDir,
    target,
    project: files.project,
    lock: files.lock,
    writer,
    signal,
    allowUnlocked: isConfigure || isLegacy,
  });

  let result: TargetResultV1;
  const action = targetAction(parsed.command);
  if (action) {
    result = await executeTarget({
      loaded,
      target,
      action,
      rootDir,
      config: pluginConfig(files.project, target),
      args: parsed.positionals,
      passthrough: parsed.passthrough,
      flags: parsed.flags,
      writer,
    });
  } else {
    const routed = routePluginCommand(parsed);
    result = await executePluginCommand({
      loaded,
      name: routed.name,
      rootDir,
      config: pluginConfig(files.project, target),
      args: routed.args,
      passthrough: routed.passthrough,
      flags: parsed.flags,
      writer,
    });
  }
  if (result.data) {
    writer.emit({
      type: "command.result",
      source: loaded.plugin.descriptor.id,
      data: toJsonData(result.data),
    });
  }
  if (result.status === "cancelled") {
    throw new AnboError("Plugin operation was cancelled.", "ANBO_CANCELLED", EXIT_CODE.cancelled);
  }
  if (result.status === "failed") {
    throw new AnboError("Plugin operation failed.", "ANBO_PLUGIN_OPERATION_FAILED");
  }
  if (isConfigure || isLegacy) {
    await lockLoadedPlugin({ rootDir, target, lock: files.lock, loaded });
  }
}

async function runPluginCommand(
  parsed: ParsedCliArgs,
  cwd: string,
  writer: EventWriter,
): Promise<void> {
  const subcommand = parsed.positionals[0] ?? "list";
  if (subcommand !== "list") {
    throw new UsageError(`Unknown plugin command ${subcommand}.`, "Use anbo plugin list.");
  }
  const rootDir = await resolveProjectRoot(cwd, parsed.root);
  let configured: Record<string, { package: string }> = {};
  try {
    configured = (await loadProject(rootDir)).project.plugins;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
  }
  const ids = new Set([...Object.keys(FIRST_PARTY_PLUGINS), ...Object.keys(configured)]);
  const plugins = [...ids].sort().map((id) => {
    const entry = configured[id] ?? FIRST_PARTY_PLUGINS[id];
    const packageName = entry?.package ?? "";
    return {
      id,
      package: packageName,
      configured: Boolean(configured[id]),
      installed: packageName ? isPluginPackageInstalled(packageName, rootDir) : false,
      firstParty: Boolean(FIRST_PARTY_PLUGINS[id]),
    };
  });
  const lines = plugins.map((plugin) => {
    const state = plugin.installed ? "installed" : plugin.configured ? "missing" : "available";
    return `${plugin.id.padEnd(12)} ${state.padEnd(10)} ${plugin.package}`;
  });
  writer.emit({
    type: "plugin.list",
    message: lines.join("\n"),
    data: { plugins: toJsonArray(plugins) },
  });
}

async function runDoctor(
  parsed: ParsedCliArgs,
  rootDir: string,
  writer: EventWriter,
  signal: AbortSignal,
): Promise<void> {
  writer.emit({
    type: "doctor.check",
    message: `Node.js ${process.version} is supported.`,
    data: { check: "node", status: "passed", version: process.version },
  });
  try {
    const files = await loadProject(rootDir);
    const target = parsed.target ?? files.project.defaultTarget;
    writer.emit({
      type: "doctor.check",
      message: `Project configuration is valid for target ${target}.`,
      data: { check: "project", status: "passed", root: rootDir, target },
    });
    const loaded = await loadAndActivatePlugin({
      rootDir,
      target,
      project: files.project,
      lock: files.lock,
      writer,
      signal,
      allowUnlocked: false,
    });
    writer.emit({
      type: "doctor.check",
      message: `${loaded.packageName}@${loaded.plugin.descriptor.version} is compatible.`,
      data: { check: "plugin", status: "passed", package: loaded.packageName },
    });
  } catch (error) {
    if (error instanceof UsageError && !parsed.target) {
      writer.emit({
        type: "doctor.check",
        level: "warn",
        message: "No Anbo project is configured in this directory.",
        data: { check: "project", status: "skipped" },
      });
      return;
    }
    throw error;
  }
}

function targetAction(command: string): TargetActionV1 | undefined {
  if (command === "setup") return "configure";
  if (command === "create") return "deploy";
  if (command === "destroy") return "down";
  if (command === "test-run") return "test";
  if (LIFECYCLE.has(command)) return command as TargetActionV1;
  if (command === "capabilities" || command === "cache") return command;
  return undefined;
}

function routePluginCommand(parsed: ParsedCliArgs): {
  name: string;
  args: string[];
  passthrough: string[];
} {
  const aliases: Record<string, string> = {
    login: "cloud.login",
    logout: "cloud.logout",
    auth: "cloud.auth",
    demo: "cloud.demo",
    branch: "cloud.branch",
    token: "cloud.token",
    sql: "cloud.sql",
    report: "cloud.report",
    "test-status": "cloud.test-status",
    "test-run": "cloud.test-run",
  };
  if (parsed.command === "cloud") {
    const [subcommand, ...args] = parsed.positionals;
    if (!subcommand || subcommand === "--") {
      throw new UsageError(
        "cloud requires a subcommand.",
        "Use cloud login, logout, auth, demo, branch, token, sql, report, test-run, or test-status.",
      );
    }
    const name = aliases[subcommand];
    if (!name) throw new UsageError(`Unknown cloud command ${subcommand}.`);
    return { name, args, passthrough: parsed.passthrough };
  }
  return {
    name: aliases[parsed.command] ?? parsed.command,
    args: parsed.positionals,
    passthrough: parsed.passthrough,
  };
}

function normalizeError(error: unknown, aborted: boolean): AnboError {
  if (aborted) return new AnboError("Run cancelled.", "ANBO_CANCELLED", EXIT_CODE.cancelled);
  if (error instanceof AnboError) return error;
  return new AnboError(error instanceof Error ? error.message : String(error), "ANBO_UNEXPECTED");
}

async function finishWithParseError(
  error: unknown,
  parsed: ParsedCliArgs,
  writeOut: (value: string) => void,
): Promise<number> {
  const writer = new EventWriter(randomUUID(), parsed.command, parsed.target, parsed.output, writeOut);
  const normalized = normalizeError(error, false);
  writer.emit({ type: "run.started", message: "Argument parsing started." });
  writer.emit({
    type: "diagnostic",
    level: "error",
    message: normalized.message,
    data: { code: normalized.code, ...(normalized.hint ? { remediation: normalized.hint } : {}) },
  });
  writer.emit({
    type: "run.finished",
    level: "error",
    message: "Run failed.",
    data: { status: "failed", exitCode: normalized.exitCode, duration_ms: 0 },
  });
  writer.flushJson(normalized.exitCode);
  return normalized.exitCode;
}

function fallbackArgs(argv: string[]): ParsedCliArgs {
  const output = argv.includes("--json")
    ? "json"
    : argv.some((value, index) => value === "--output" && argv[index + 1] === "jsonl") ||
        argv.includes("--output=jsonl")
      ? "jsonl"
      : "human";
  return {
    command: argv[0] ?? "help",
    output,
    positionals: [],
    passthrough: [],
    flags: {},
    raw: argv,
    help: false,
  };
}

function toJsonData(value: unknown): JsonObject {
  const parsed = JSON.parse(JSON.stringify(value)) as JsonValue;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
}

function toJsonArray(value: unknown[]): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const HELP = `Anbo CLI ${CLI_VERSION}

Usage:
  anbo <command> [options]

Core commands:
  configure       Configure a deployment target
  deploy          Deploy the configured project
  status          Show target state
  test            Run target smoke or integration tests
  logs            Stream structured target logs
  debug           Collect deterministic diagnostics
  down            Stop and remove the target deployment
  doctor          Check core, project, and plugin compatibility
  plugin list     List known and configured plugins
  version         Print the CLI version

Compatibility:
  anbo sandbox up is an alias for anbo deploy --target ministack

Global options:
  --target <id>            Select a target
  --root <path>            Select a project root
  --output human|json|jsonl
  --json                   Alias for --output json
  --help                   Show help`;
