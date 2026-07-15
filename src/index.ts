import type {
  AnboPluginV1,
  PluginCommandRequestV1,
  PluginContextV1,
  PluginDescriptorV1,
  PluginFlagsV1,
  TargetRequestV1,
  TargetResultV1
} from "@getanbo/plugin-sdk";
import { runAnboCli } from "./legacy-cli.js";

export const descriptor: PluginDescriptorV1 = {
  schema_version: 1,
  plugin_api: 1,
  id: "anbo.cloud",
  name: "Anbo Cloud",
  version: "0.1.0",
  engines: { anbo: ">=0.2.0 <0.3.0" },
  targets: ["cloud"],
  actions: ["configure", "deploy", "status", "test", "logs", "debug", "down", "capabilities"]
};

const actionCommands: Partial<Record<TargetRequestV1["action"], string>> = {
  configure: "setup",
  deploy: "create",
  status: "status",
  test: "test",
  logs: "logs",
  debug: "status",
  down: "destroy"
};

const commandNames: Record<string, string> = {
  "cloud.login": "login",
  "cloud.logout": "logout",
  "cloud.auth": "auth",
  "cloud.demo": "demo",
  "cloud.branch": "branch",
  "cloud.token": "token",
  "cloud.sql": "sql",
  "cloud.report": "report",
  "cloud.test-run": "test-run",
  "cloud.test-status": "test-status"
};

async function emitLine(context: PluginContextV1, stream: "stdout" | "stderr", line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  await context.events.emit({
    kind: stream === "stderr" ? "diagnostic" : "plugin.output",
    phase: "cloud",
    source: descriptor.id,
    level: stream === "stderr" ? "error" : "info",
    message: parsed === undefined ? line : "Cloud command emitted structured output.",
    fields: parsed === undefined ? { stream } : { stream, value: parsed }
  });
}

function serializeFlags(flags: PluginFlagsV1): string[] {
  const result: string[] = [];
  for (const [name, value] of Object.entries(flags)) {
    if (value === false) continue;
    if (value === true) {
      result.push(`--${name}`);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) result.push(`--${name}`, entry);
  }
  return result;
}

function legacyArgs(command: string, args: readonly string[], flags: PluginFlagsV1): string[] {
  const separator = args.indexOf("--");
  const positional = separator < 0 ? args : args.slice(0, separator);
  const childCommand = separator < 0 ? [] : args.slice(separator);
  return [command, ...positional, ...serializeFlags(flags), ...childCommand];
}

async function executeLegacy(
  context: PluginContextV1,
  command: string,
  request: Pick<TargetRequestV1, "project" | "args" | "flags">
): Promise<TargetResultV1> {
  const pendingEvents: Array<Promise<void>> = [];
  const code = await runAnboCli(legacyArgs(command, request.args, request.flags), {
    cwd: request.project.root,
    signal: context.signal,
    stdout: (line) => pendingEvents.push(emitLine(context, "stdout", line)),
    stderr: (line) => pendingEvents.push(emitLine(context, "stderr", line))
  });
  await Promise.all(pendingEvents);
  return {
    status: code === 0 ? "succeeded" : "failed",
    data: { exit_code: code },
    ...(code === 0 ? {} : {
      diagnostics: [{
        code: "ANBO_CLOUD_COMMAND_FAILED",
        message: `Cloud command ${command} failed with exit code ${code}.`,
        remediation: "Inspect the preceding structured diagnostics and verify the Env API endpoint and credentials."
      }]
    })
  };
}

async function executeTarget(context: PluginContextV1, request: TargetRequestV1): Promise<TargetResultV1> {
  if (request.action === "capabilities") {
    const capabilities = [
      "anbo.cloud",
      "postgres.clone",
      "dynamodb.clone",
      "remote.tests",
      "structured.logs"
    ];
    await context.events.emit({
      kind: "capabilities",
      phase: "cloud",
      source: descriptor.id,
      level: "info",
      message: "Anbo Cloud capabilities discovered.",
      fields: { target: "cloud", capabilities }
    });
    return { status: "succeeded", data: { capabilities } };
  }
  if (request.action === "cache") {
    return {
      status: "failed",
      diagnostics: [{
        code: "ANBO_CLOUD_CACHE_UNSUPPORTED",
        message: "The cloud target does not expose a local cache."
      }]
    };
  }
  const command = actionCommands[request.action];
  if (command === undefined) {
    return {
      status: "failed",
      diagnostics: [{ code: "ANBO_CLOUD_ACTION_UNSUPPORTED", message: `Unsupported cloud action: ${request.action}` }]
    };
  }
  if (request.action === "debug") {
    await context.events.emit({
      kind: "diagnostic",
      phase: "cloud",
      source: descriptor.id,
      level: "info",
      message: "Cloud debug is reporting environment status. Use logs with a test run id for execution output."
    });
  }
  return executeLegacy(context, command, request);
}

async function executeCommand(context: PluginContextV1, request: PluginCommandRequestV1): Promise<TargetResultV1> {
  const command = commandNames[request.name];
  if (command === undefined) {
    return {
      status: "failed",
      diagnostics: [{ code: "ANBO_CLOUD_COMMAND_UNSUPPORTED", message: `Unsupported cloud command: ${request.name}` }]
    };
  }
  return executeLegacy(context, command, request);
}

export const plugin: AnboPluginV1 = {
  descriptor,
  async activate(context) {
    return {
      targets: [{ id: "cloud", execute: (request) => executeTarget(context, request) }],
      commands: Object.keys(commandNames).map((name) => ({
        name,
        execute: (request: PluginCommandRequestV1) => executeCommand(context, request)
      }))
    };
  }
};

export default plugin;
