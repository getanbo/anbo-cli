export const ANBO_MANIFEST_VERSION = 2 as const;

export type OutputMode = "human" | "json" | "jsonl";
export type CommandAction =
  | "deploy"
  | "test"
  | "run"
  | "status"
  | "logs"
  | "debug"
  | "reset"
  | "down"
  | "capabilities"
  | "cache";

export enum ExitCode {
  Success = 0,
  Usage = 2,
  Prerequisite = 3,
  Configuration = 4,
  Clone = 5,
  Terraform = 6,
  Runtime = 7,
  Test = 8,
  ChildProcess = 9,
  LockConflict = 10,
  Deadline = 124,
  Cancelled = 130
}

export type SecretReference = `env://${string}` | `exec://${string}`;
export type CloneProvider = "anbo-cloud" | "external";
export type DynamoDbPlane = "clone" | "ministack";

export interface ProjectConfig {
  name: string;
  id?: string;
}

export interface TerraformConfig {
  roots: string[];
  variable_files: string[];
}

export interface CloneConfig {
  provider: CloneProvider;
  source?: string;
  endpoint?: SecretReference;
  credentials?: Record<string, SecretReference>;
  region?: string;
  ttl_seconds?: number;
  retain_on_down?: boolean;
}

export interface DataConfig {
  postgres?: CloneConfig;
  dynamodb?: CloneConfig;
}

export interface PortConfig {
  container: number;
  host?: number;
  protocol?: "tcp" | "udp";
}

export type HealthcheckConfig =
  | { type: "http"; url: string; timeout_seconds?: number; interval_seconds?: number }
  | { type: "tcp"; port: number; timeout_seconds?: number; interval_seconds?: number }
  | { type: "command"; command: string[]; timeout_seconds?: number; interval_seconds?: number };

export interface ServiceConfig {
  build?: string;
  image?: string;
  command?: string[];
  working_directory?: string;
  environment?: Record<string, string>;
  ports?: PortConfig[];
  depends_on?: string[];
  healthcheck?: HealthcheckConfig;
  dynamodb_plane?: DynamoDbPlane;
}

export interface BuildConfig {
  context: string;
  /** Context-relative files/directories that determine cache invalidation. */
  inputs?: string[];
  dockerfile?: string;
  target?: string;
  platform?: string;
  args?: Record<string, string>;
  command?: string[];
  outputs?: string[];
}

export interface TestConfig {
  command: string[];
  service?: string;
  environment?: Record<string, string>;
  depends_on?: string[];
  timeout_seconds?: number;
  default?: boolean;
}

export interface MiniStackConfig {
  image: string;
  digest?: `sha256:${string}`;
  profile: "full";
  persistence: boolean;
  environment?: Record<string, string>;
}

export interface NetworkConfig {
  allow_hosts: string[];
  clone_egress: boolean;
}

export interface AdapterConfig {
  executable: string;
  protocol?: 2;
  digest?: `sha256:${string}`;
  args?: string[];
  capabilities?: string[];
  environment?: Record<string, SecretReference>;
  allowed_hosts?: string[];
}

export interface SandboxManifest {
  $schema?: string;
  schema_version: typeof ANBO_MANIFEST_VERSION;
  project: ProjectConfig;
  terraform: TerraformConfig;
  data: DataConfig;
  services: Record<string, ServiceConfig>;
  builds: Record<string, BuildConfig>;
  tests: Record<string, TestConfig>;
  ministack: MiniStackConfig;
  network: NetworkConfig;
  adapters: Record<string, AdapterConfig>;
}

export type SdkLanguage = "node" | "python" | "go" | "java";

export interface TerraformRootDiscovery {
  path: string;
  files: string[];
  variable_files: string[];
}

export interface SdkDiscovery {
  language: SdkLanguage;
  package: string;
  file: string;
}

export interface DockerfileDiscovery {
  path: string;
  context: string;
}

export interface DiscoveryReport {
  root: string;
  terraform: TerraformRootDiscovery[];
  sdk: SdkDiscovery[];
  dockerfiles: DockerfileDiscovery[];
}

export type RunEventKind =
  | "run.started"
  | "phase.started"
  | "progress"
  | "process.output"
  | "service.status"
  | "clone.status"
  | "terraform.change"
  | "test.started"
  | "test.progress"
  | "test.assertion"
  | "test.finished"
  | "diagnostic"
  | "heartbeat"
  | "artifact"
  | "run.finished";

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface RunEvent {
  schema_version: 1;
  seq: number;
  event_id: string;
  run_id: string;
  timestamp: string;
  elapsed_ms: number;
  kind: RunEventKind;
  phase: string;
  source: string;
  level: EventLevel;
  message: string;
  service?: string;
  test_id?: string;
  correlation_id?: string;
  redacted: boolean;
  fields?: Record<string, unknown>;
}

export type RunEventInput = Omit<RunEvent, "schema_version" | "seq" | "event_id" | "run_id" | "timestamp" | "elapsed_ms">;

export interface RunSummary {
  run_id?: string;
  action: string;
  status: "succeeded" | "failed" | "cancelled";
  started_at?: string;
  finished_at?: string;
  elapsed_ms?: number;
  diagnostics?: Array<{ code: string; message: string; remediation?: string }>;
  artifacts?: string[];
  [key: string]: unknown;
}

export interface DeployRequest {
  root: string;
  runtimeProjectId?: string;
  manifestPath: string;
  manifest: SandboxManifest;
  action: CommandAction;
  args: string[];
  flags: Readonly<Record<string, string | boolean | string[]>>;
  env: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
  stateHome?: string;
  cacheHome?: string;
  resolveSecret?: (reference: SecretReference) => Promise<string>;
  commands?: import("./runtime/ministack.js").CommandExecutor;
  fetch?: typeof globalThis.fetch;
}

export interface DiagnosticDetails {
  cause?: string;
  evidence?: unknown;
  remediation?: string;
  retryable?: boolean;
  safe_to_retry?: boolean;
}

export class AnboError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details?: DiagnosticDetails;

  constructor(message: string, options: { exitCode?: ExitCode; code?: string; details?: DiagnosticDetails; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AnboError";
    this.exitCode = options.exitCode ?? ExitCode.Runtime;
    this.code = options.code ?? "ANBO_RUNTIME_ERROR";
    if (options.details !== undefined) this.details = options.details;
  }
}
