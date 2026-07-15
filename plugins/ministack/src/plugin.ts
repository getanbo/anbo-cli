import { existsSync } from "node:fs";

import type {
  AnboPluginV1,
  PluginContextV1,
  PluginDescriptorV1,
  PluginRuntimeV1,
  TargetProviderV1,
  TargetRequestV1,
  TargetResultV1,
} from "@getanbo/plugin-sdk";

import {
  DEFAULT_MANIFEST_PATH,
  createDefaultManifest,
  loadManifest,
  parseManifest,
  resolveManifestPath,
  writeManifest,
} from "./config.js";
import { runDeploy } from "./deploy.js";
import { discoverProject } from "./discovery.js";
import { PluginEventSink } from "./event-sink.js";
import { HostCommandExecutor, hostFetch } from "./host.js";
import { AnboError, ExitCode, type CommandAction, type RunSummary, type SandboxManifest } from "./types.js";

export const descriptor: PluginDescriptorV1 = {
  schema_version: 1,
  plugin_api: 1,
  id: "anbo.ministack",
  package: "@getanbo/plugin-ministack",
  name: "Anbo MiniStack",
  version: "0.1.0",
  engines: { anbo: ">=0.2.0 <0.3.0", node: ">=22.0.0" },
  kinds: ["target"],
  targets: ["ministack"],
  actions: ["configure", "deploy", "status", "test", "logs", "debug", "down", "capabilities", "cache"],
  config: { schema: "./schemas/plugin-config.v1.schema.json", schema_version: 1 },
  capabilities: [
    "terraform.discovery",
    "terraform.aws.apply",
    "ministack.runtime",
    "data.clone.postgres",
    "data.clone.dynamodb",
    "build.cache",
    "smoke.test",
    "structured.logs",
    "adapter.v2",
  ],
};

class MiniStackTarget implements TargetProviderV1 {
  readonly id = "ministack";

  constructor(private readonly context: PluginContextV1) {}

  async execute(request: TargetRequestV1): Promise<TargetResultV1> {
    if (request.api_version !== 1) {
      return failed("ANBO_PLUGIN_API_MISMATCH", `MiniStack target requires api_version 1, received ${String(request.api_version)}`);
    }
    const runId = typeof request.flags["run-id"] === "string" ? request.flags["run-id"] : undefined;
    const sink = new PluginEventSink(this.context, runId);
    try {
      const summary = request.action === "configure"
        ? await this.configure(request, sink)
        : await this.run(request, sink);
      return { status: "succeeded", data: { ...summary } };
    } catch (cause) {
      const error = toAnboError(cause, this.context.signal);
      const remediation = error.details?.remediation ?? remediationFor(error.code);
      await sink.diagnostic({
        code: error.code,
        cause: error.message,
        remediation,
        retryable: error.details?.retryable ?? false,
        safe_to_retry: error.details?.safe_to_retry ?? false,
        evidence: error.details?.evidence,
      }).catch(() => undefined);
      return {
        status: error.exitCode === ExitCode.Cancelled ? "cancelled" : "failed",
        data: { action: request.action, exit_code: error.exitCode },
        diagnostics: [{ code: error.code, message: error.message, remediation }],
      };
    }
  }

  private async configure(request: TargetRequestV1, sink: PluginEventSink): Promise<RunSummary> {
    const phase = await sink.startPhase("Terraform discovery", "anbo.ministack.configure");
    const discovery = discoverProject(request.project.root);
    const manifestPath = resolveManifestPath(discovery.root, manifestPathFrom(request.config));
    const existed = existsSync(manifestPath);
    const force = request.flags["force"] === true;
    const dryRun = request.flags["dry-run"] === true;
    const manifest = existed && !force
      ? loadManifest(discovery.root, manifestPathFrom(request.config)).manifest
      : createDefaultManifest(discovery);
    parseManifest(manifest);
    if (!dryRun && (!existed || force)) writeManifest(manifestPath, manifest, { overwrite: force });
    await phase.finish("Terraform discovery complete", {
      terraform_roots: discovery.terraform.map((entry) => entry.path),
      sdk_hints: discovery.sdk,
      dockerfiles: discovery.dockerfiles.map((entry) => entry.path),
    });
    return {
      action: "configure",
      status: "succeeded",
      manifest_path: manifestPath,
      created: !existed && !dryRun,
      updated: existed && force && !dryRun,
      dry_run: dryRun,
      discovery,
      manifest,
    };
  }

  private async run(request: TargetRequestV1, sink: PluginEventSink): Promise<RunSummary> {
    const action = request.action as CommandAction;
    const { manifest, path } = runtimeManifest(request);
    return await runDeploy({
      root: request.project.root,
      runtimeProjectId: request.project.runtime_id,
      manifestPath: path,
      manifest,
      action,
      args: [...request.args],
      flags: request.flags,
      env: process.env,
      ...(this.context.signal === undefined ? {} : { signal: this.context.signal }),
      stateHome: this.context.paths.state,
      cacheHome: this.context.paths.cache,
      resolveSecret: (reference) => this.context.secrets.resolve(reference),
      commands: new HostCommandExecutor(this.context),
      fetch: hostFetch(this.context),
    }, sink);
  }
}

function runtimeManifest(request: TargetRequestV1): { manifest: SandboxManifest; path: string } {
  if (isSandboxManifest(request.config)) {
    return {
      manifest: parseManifest(request.config),
      path: resolveManifestPath(request.project.root, manifestPathFrom(request.config)),
    };
  }
  return loadManifest(request.project.root, manifestPathFrom(request.config));
}

function manifestPathFrom(config: unknown): string {
  if (isRecord(config) && typeof config["manifest"] === "string") return config["manifest"];
  return DEFAULT_MANIFEST_PATH;
}

function isSandboxManifest(value: unknown): value is SandboxManifest {
  return isRecord(value) && value["schema_version"] === 2 && isRecord(value["ministack"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failed(code: string, message: string): TargetResultV1 {
  return { status: "failed", diagnostics: [{ code, message }] };
}

function toAnboError(cause: unknown, signal?: AbortSignal): AnboError {
  if (cause instanceof AnboError) return cause;
  if (signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError")) {
    return new AnboError("operation cancelled", { exitCode: ExitCode.Cancelled, code: "ANBO_CANCELLED", cause });
  }
  return new AnboError(cause instanceof Error ? cause.message : String(cause), {
    exitCode: ExitCode.Runtime,
    code: "ANBO_MINISTACK_PLUGIN_FAILED",
    cause,
  });
}

function remediationFor(code: string): string {
  if (code.includes("CONFIG")) return "Correct .anbo/sandbox.json or rerun anbo configure --target ministack.";
  if (code.includes("DOCKER")) return "Start Docker and verify docker info succeeds, then retry the same anbo command.";
  return "Inspect the diagnostic events with anbo debug, correct the reported prerequisite, and retry.";
}

export function activate(context: PluginContextV1): PluginRuntimeV1 {
  return { targets: [new MiniStackTarget(context)] };
}

const plugin: AnboPluginV1 = { descriptor, activate };

export default plugin;
