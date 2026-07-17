import type { OutputMode, PluginFlagsV1 } from "@getanbo/plugin-sdk";
import { LEGACY_CLOUD_COMMANDS } from "./constants.js";
import { UsageError } from "./errors.js";

export interface ParsedCliArgs {
  command: string;
  target?: string;
  root?: string;
  output: OutputMode;
  positionals: string[];
  passthrough: string[];
  flags: PluginFlagsV1;
  raw: string[];
  help: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const raw = [...argv];
  const normalized = normalizeCompatibilityAlias(argv);
  let command: string | undefined;
  let target = normalized.target;
  let root: string | undefined;
  let output: OutputMode = "human";
  let help = false;
  const positionals: string[] = [];
  const passthrough: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let index = 0; index < normalized.args.length; index += 1) {
    const token = normalized.args[index];
    if (token === undefined) continue;
    if (token === "--") {
      passthrough.push(...normalized.args.slice(index + 1));
      positionals.push("--", ...passthrough);
      break;
    }
    if (token === "-h" || token === "--help") {
      help = true;
      continue;
    }
    if (token === "-v" || token === "--version") {
      command ??= "version";
      continue;
    }
    if (token === "--json") {
      output = "json";
      continue;
    }
    if (token.startsWith("--")) {
      const [namePart, inlineValue] = token.slice(2).split(/=(.*)/su, 2);
      if (!namePart) throw new UsageError(`Invalid option ${token}.`);
      const name = namePart.replace(/^no-/u, "");
      let value: string | boolean = !namePart.startsWith("no-");
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else if (value === true && expectsValue(name)) {
        const next = normalized.args[index + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new UsageError(`Option --${name} requires a value.`);
        }
        value = next;
        index += 1;
      } else if (value === true && !isBooleanFlag(name)) {
        const next = normalized.args[index + 1];
        if (next !== undefined && !next.startsWith("-") && command !== undefined) {
          value = next;
          index += 1;
        }
      }

      if (name === "target" && typeof value === "string") {
        target = value;
      } else if (name === "root" && typeof value === "string") {
        root = value;
      } else if (name === "output" && typeof value === "string") {
        output = parseOutput(value);
      } else {
        addFlag(flags, name, value);
        if (namePart.startsWith("no-")) addFlag(flags, namePart, true);
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new UsageError(`Unknown option ${token}.`);
    }
    if (command === undefined) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  command ??= "help";
  if (LEGACY_CLOUD_COMMANDS.has(command)) target ??= "cloud";

  return {
    command,
    ...(target ? { target } : {}),
    ...(root ? { root } : {}),
    output,
    positionals,
    passthrough,
    flags,
    raw,
    help,
  };
}

function normalizeCompatibilityAlias(argv: string[]): { args: string[]; target?: string } {
  const [first, second, ...rest] = argv;
  if (first !== "sandbox") return { args: argv };
  const aliases: Record<string, string> = {
    up: "deploy",
    down: "down",
    status: "status",
    test: "test",
    logs: "logs",
    debug: "debug",
  };
  if (!second || !aliases[second]) {
    throw new UsageError(
      "Unknown sandbox command.",
      "Use anbo sandbox up, down, status, test, logs, or debug.",
    );
  }
  return { args: [aliases[second], ...rest] as string[], target: "ministack" };
}

function parseOutput(value: string): OutputMode {
  if (value === "human" || value === "json" || value === "jsonl") return value;
  throw new UsageError(`Unsupported output mode ${value}.`, "Use human, json, or jsonl.");
}

function expectsValue(name: string): boolean {
  return new Set(["target", "root", "output", "verify"]).has(name);
}

function isBooleanFlag(name: string): boolean {
  return new Set([
    "affected", "all", "dry-run", "failed", "follow", "force", "full", "purge",
    "reconcile", "refresh", "stale", "test", "wait", "yes",
  ]).has(name);
}

function addFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  value: string | boolean,
): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[name] = [String(existing), String(value)];
  }
}
