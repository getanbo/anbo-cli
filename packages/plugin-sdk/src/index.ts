export const ANBO_PLUGIN_API_VERSION = 1 as const;
export const ANBO_EVENT_API_VERSION = "anbo.dev/event/v1" as const;
export const ANBO_PROJECT_API_VERSION = "anbo.dev/project/v1" as const;
export const ANBO_PLUGIN_LOCK_API_VERSION = "anbo.dev/plugins-lock/v1" as const;

export const TARGET_ACTIONS = [
  "configure",
  "deploy",
  "status",
  "test",
  "logs",
  "debug",
  "run",
  "reset",
  "down",
  "capabilities",
  "cache",
  "impact",
  "verify",
  "recover",
] as const;

export type TargetActionV1 = (typeof TARGET_ACTIONS)[number];
export type LifecycleCommand = Exclude<TargetActionV1, "capabilities" | "cache">;
export type OutputMode = "human" | "json" | "jsonl";
export type EventLevel = "debug" | "info" | "warn" | "error";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type PluginFlagsV1 = Readonly<Record<string, string | boolean | string[]>>;

export interface PluginDescriptorTargetV1 {
  id: string;
  actions: readonly TargetActionV1[];
}

export interface PluginDescriptorV1 {
  schema_version: 1;
  plugin_api: 1;
  id: string;
  name?: string;
  package?: string;
  version: string;
  entrypoint?: string;
  engines: { anbo: string; node?: string };
  kinds?: readonly string[];
  targets: readonly (string | PluginDescriptorTargetV1)[];
  actions?: readonly TargetActionV1[];
  commands?: readonly string[];
  config?: { schema: string; schema_version: number };
  config_schema?: string;
  capabilities?: readonly string[];
}

export interface PluginEventV1 {
  kind?: string;
  type?: string;
  phase?: string;
  source?: string;
  level?: EventLevel;
  message?: string;
  service?: string;
  test_id?: string;
  correlation_id?: string;
  fields?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface PluginPhaseV1 {
  finish(message?: string, fields?: Record<string, unknown>): Promise<void>;
  fail(message: string, fields?: Record<string, unknown>): Promise<void>;
}

export interface ProcessRunOptionsV1 {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  input?: string;
  timeout_ms?: number;
  allow_failure?: boolean;
  /** Optional operation-local cancellation composed with the plugin host signal. */
  signal?: AbortSignal;
  /** Delivers stdout/stderr chunks while the child is still running. */
  on_output?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

export interface ProcessRunResultV1 {
  command: string;
  args: readonly string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface PluginStateV1 {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginCredentialsV1 {
  get(name: string): Promise<Record<string, string> | undefined>;
  set(name: string, value: Record<string, string>): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface PluginContextV1 {
  signal: AbortSignal;
  events: {
    emit(event: PluginEventV1): Promise<void>;
    startPhase(name: string, options?: { source?: string }): Promise<PluginPhaseV1>;
  };
  process: {
    run(
      command: string,
      args: readonly string[],
      options?: ProcessRunOptionsV1,
    ): Promise<ProcessRunResultV1>;
    /**
     * Runs a bounded teardown command without inheriting an already-aborted
     * operation signal. This is only for releasing resources created by a
     * plugin; ordinary work must use run().
     */
    cleanup?(
      command: string,
      args: readonly string[],
      options?: Omit<ProcessRunOptionsV1, "signal">,
    ): Promise<ProcessRunResultV1>;
  };
  http: { request(input: string | URL, init?: RequestInit): Promise<Response> };
  state: PluginStateV1;
  credentials: PluginCredentialsV1;
  secrets: { resolve(reference: string): Promise<string> };
  adapters: { invoke(name: string, request: unknown): Promise<unknown> };
  paths: { state: string; cache: string; data: string };
}

export interface TargetRequestV1 {
  api_version: 1;
  /** Canonical host run ID. Plugins must not replace it with a user flag. */
  run_id?: string;
  action: TargetActionV1;
  project: { root: string; logical_id: string; runtime_id: string };
  config: unknown;
  args: readonly string[];
  passthrough?: readonly string[];
  flags: PluginFlagsV1;
}

export interface PluginDiagnosticV1 {
  code: string;
  message: string;
  remediation?: string;
  level?: EventLevel;
  phase?: string;
  retryable?: boolean;
  safe_to_retry?: boolean;
  evidence?: unknown;
}

/** Canonical failure returned by a plugin target to the CLI host. */
export interface PluginFailureV1 extends PluginDiagnosticV1 {
  exit_code: number;
}

export interface TargetResultV1 {
  status?: "succeeded" | "failed" | "cancelled";
  ok?: boolean;
  data?: unknown;
  diagnostics?: PluginDiagnosticV1[];
  failure?: PluginFailureV1;
}

export interface TargetProviderV1 {
  id: string;
  execute(request: TargetRequestV1): Promise<TargetResultV1>;
}

export interface PluginCommandRequestV1 {
  name: string;
  command: string;
  run_id?: string;
  project: TargetRequestV1["project"];
  config: unknown;
  args: readonly string[];
  passthrough?: readonly string[];
  flags: PluginFlagsV1;
}

export interface PluginCommandV1 {
  name: string;
  execute(request: PluginCommandRequestV1): Promise<TargetResultV1>;
}

export interface AuthProviderV1 {
  id: string;
  execute(request: PluginCommandRequestV1): Promise<TargetResultV1>;
}

export interface ConfigMigrationV1 {
  from: string;
  migrate(config: unknown): Promise<unknown> | unknown;
}

export interface PluginRuntimeV1 {
  targets?: readonly TargetProviderV1[] | Record<string, Omit<TargetProviderV1, "id">>;
  commands?:
    | readonly PluginCommandV1[]
    | Record<string, (request: PluginCommandRequestV1) => Promise<TargetResultV1>>;
  authProviders?: readonly AuthProviderV1[] | Record<string, AuthProviderV1>;
  migrateConfig?: readonly ConfigMigrationV1[];
}

export interface AnboPluginV1 {
  descriptor: PluginDescriptorV1;
  activate(context: PluginContextV1): PluginRuntimeV1 | Promise<PluginRuntimeV1>;
}

export interface AnboEvent {
  apiVersion: typeof ANBO_EVENT_API_VERSION;
  runId: string;
  sequence: number;
  timestamp: string;
  source: "core" | string;
  command: string;
  target?: string;
  type: string;
  level: EventLevel;
  message?: string;
  data?: JsonObject;
}

export interface AnboProjectPluginConfig {
  package: string;
  config?: JsonObject;
}

export interface AnboProjectConfig {
  apiVersion: typeof ANBO_PROJECT_API_VERSION;
  defaultTarget: string;
  plugins: Record<string, AnboProjectPluginConfig>;
}

export interface AnboPluginLockEntry {
  package: string;
  version: string;
  integrity?: string;
}

export interface AnboPluginLock {
  apiVersion: typeof ANBO_PLUGIN_LOCK_API_VERSION;
  plugins: Record<string, AnboPluginLockEntry>;
}

export function definePlugin(plugin: AnboPluginV1): AnboPluginV1 {
  return plugin;
}
