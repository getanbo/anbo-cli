#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type {
  AnboK8sBranchAllocation,
  AnboK8sEnvironmentResource,
  AnboK8sEnvironmentStatus,
  AnboK8sServiceSpec
} from "./contracts.js";
import { validateAnboEnvironment } from "./contracts.js";
import type {
  EnvApiEnvironmentSummary,
  EnvApiTestRunExecution,
  EnvApiTestRunLogs,
  EnvApiTestRunReport,
  EnvApiTestRunRequest,
  EnvApiTestRunSummary,
  EnvApiTestRunStatus,
  EnvApiTestRunType
} from "./env-api.js";

type JsonRecord = Record<string, unknown>;

export type AnboCliRepoConfig = {
  version: 1;
  mode?: "env_api" | "preview" | "demo";
  apiUrl: string;
  project: string;
  repo: {
    name: string;
    remoteUrl?: string;
  };
  source?: string;
  routeBaseUrl: string;
  s3: {
    baseBucket: string;
    basePrefix: string;
    overlayBucket: string;
  };
  defaults: {
    ttl: string;
    baseSnapshot: string;
    allocation: AnboK8sBranchAllocation;
    dynamodbLink?: string;
  };
  sources?: AnboCliConfiguredSource[];
  databaseLinks?: {
    checkedAt: string;
    postgres?: {
      link: string;
      snapshotRef: string;
    };
    dynamodb?: {
      link: string;
      region: string;
      logicalTables: string[];
      supportedApiLevel: string;
    };
  };
};

export type AnboCliConfiguredSource =
  | {
      type: "postgres";
      link: string;
      snapshotRef?: string;
    }
  | {
      type: "dynamodb";
      link: string;
      region?: string;
      logicalTables?: string[];
      supportedApiLevel?: string;
    };

export type AnboCliCredentials = {
  version: 1;
  endpoints: Record<string, { token: string }>;
  previewEndpoints?: Record<string, { token: string; activeSessionId?: string }>;
  demoEndpoints?: Record<string, { token: string; activeSessionId?: string }>;
};

type BrowserLauncherSpawn = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; timeout: number }
) => { status: number | null };

export type AnboCliDependencies = {
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => boolean;
  browserSpawn?: BrowserLauncherSpawn;
  platform?: NodeJS.Platform;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  prompt?: (label: string) => Promise<string>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  localCommandSpawn?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" }
  ) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error };
  dynamodbSmoke?: (input: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    tableName: string;
    partitionKey: string;
    sortKey: string;
  }) => Promise<{ tables: string[]; sourceRowCount: number; writeReadBack: boolean }>;
};

type ParsedArgs = {
  command?: string;
  positional: string[];
  flags: Record<string, string | true>;
  afterDoubleDash: string[];
};

type SetupInput = {
  apiUrl: string;
  project: string;
  source: string;
  routeBaseUrl: string;
  baseBucket: string;
  basePrefix: string;
  overlayBucket: string;
  allocation: AnboK8sBranchAllocation;
  ttl: string;
  baseSnapshot: string;
  token?: string;
};

type CreateInput = {
  image: string;
  sha: string;
  envId?: string;
  source?: string;
  snapshot?: string;
  ttl?: string;
  allocation: AnboK8sBranchAllocation;
  wait: boolean;
  json: boolean;
  timeoutSeconds: number;
  pollIntervalMs: number;
};

type TestInput = {
  envId: string;
  type: EnvApiTestRunType;
  execution: EnvApiTestRunExecution;
  image: string;
  command: string[];
  shards: number;
  timeoutSeconds: number;
  wait: boolean;
  pollIntervalMs: number;
  json: boolean;
};

type TestStatusInput = {
  envId: string;
  runId: string;
  json: boolean;
};

type LogsInput = {
  envId: string;
  runId: string;
  tail?: number;
  json: boolean;
};

type ReportInput = {
  envId: string;
  runId: string;
  out?: string;
};

type DemoApiDeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type DemoApiDeviceToken = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
};

type DemoApiBranch = {
  id: string;
  name: string;
  status: string;
  state?: string | null;
  ready: boolean;
  preview_url: string | null;
  database_url: string | null;
  message?: string | null;
  source?: {
    type: "postgres" | "dynamodb";
    link: string;
  };
  dynamodb?: {
    link: string;
    phase: string | null;
    endpoint: string | null;
    region: string;
    supported_api_level: string;
  };
  created_at?: string;
  expires_at?: string;
  deleted_at?: string | null;
};

type DemoApiBranchList = {
  branches: DemoApiBranch[];
};

type DemoApiBranchUrl = {
  database_url: string;
};

type DemoApiDynamoDBCredentials = {
  version: 1;
  branch_id: string;
  branch_name: string;
  endpoint_url: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expires_at: string;
  issued_at: string;
  supported_api_level: string;
  tables: string[];
};

type DemoBranchConnection = {
  type: "postgres";
  database_url: string;
  expires_at?: string;
  environment: {
    DATABASE_URL: string;
  };
} | {
  type: "dynamodb";
  endpoint_url: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expires_at: string;
  issued_at: string;
  supported_api_level: string;
  tables: string[];
  environment: Record<string, string>;
};

type DemoBranchCreateResult = DemoApiBranch & {
  connection?: DemoBranchConnection;
};

type DemoApiDatabaseLinksPreflight = {
  version: 1;
  type?: "postgres" | "dynamodb";
  checked_at: string;
  ready: boolean;
  defaults: {
    postgres_link?: string;
    dynamodb_link?: string;
  };
  postgres: Array<{
    link: string;
    ready: boolean;
    source_check_ok: boolean;
    snapshot_ref: string;
    snapshot_id: string | null;
    snapshot_ready: boolean;
    replica_lag_seconds: number | null;
    message: string | null;
  }>;
  dynamodb: Array<{
    link: string;
    ready: boolean;
    mirror_ref: string;
    phase: string | null;
    lag_seconds: number | null;
    region: string;
    logical_tables: string[];
    supported_api_level: string;
    snapshot_ready: boolean;
    gateway_ready: boolean;
    last_checkpoint_at: string | null;
    message: string | null;
  }>;
};

type DemoApiTokenMetadata = {
  id: string;
  name: string | null;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  status: "active" | "expired" | "revoked";
};

type DemoApiTokenCreate = {
  token: string;
  token_type: "Bearer";
  scopes: string[];
  created_at: string;
  expires_at: string;
  id: string;
  name: string | null;
};

type DemoApiTokenList = {
  tokens: DemoApiTokenMetadata[];
};

type DemoSqlResult = {
  fields?: string[];
  rows?: unknown[];
  rowCount?: number;
  row_count?: number;
  truncated?: boolean;
  request_id?: string;
};

type DestroyInput = {
  envId: string;
  wait: boolean;
  json: boolean;
  timeoutSeconds: number;
  pollIntervalMs: number;
};

const CONFIG_PATH = ".anbo/config.json";
const DEFAULT_PREVIEW_API_URL = "https://app.getanbo.com";
const DEFAULT_PREVIEW_ROUTE_BASE_URL = "https://preview.getanbo.com";
const DATABASE_LINKS_PREFLIGHT_TIMEOUT_MS = 30_000;
const READY_STATES = new Set<AnboK8sEnvironmentStatus>(["ReadyForFirstTest", "Ready", "Passed"]);
const TERMINAL_FAILURE_STATES = new Set<AnboK8sEnvironmentStatus>(["Failed", "Deleted"]);
const TEST_RUN_TERMINAL_STATES = new Set<EnvApiTestRunStatus>(["Passed", "Failed", "TimedOut", "Canceled"]);
const TEST_RUN_FAILURE_STATES = new Set<EnvApiTestRunStatus>(["Failed", "TimedOut", "Canceled"]);
const VALID_ALLOCATIONS = new Set<AnboK8sBranchAllocation>(["pool_required", "pool_preferred", "fresh_required"]);
const VALID_TEST_TYPES = new Set<EnvApiTestRunType>(["migration", "smoke", "test", "ci"]);
const VALID_API_TOKEN_SCOPES = new Set(["branches:read", "branches:write", "branches:credentials"]);
const WAIT_PROGRESS_INTERVAL_MS = 10_000;
const CLI_VERSION_FALLBACK = "0.1.0";

const REQUIRED_SERVICES = [
  "query-api",
  "ingest-gateway",
  "processor-worker",
  "status-rollup-worker"
] as const;

const SERVICE_PORTS: Record<string, number | undefined> = {
  "query-api": 3001,
  "ingest-gateway": 3000,
  "processor-worker": undefined,
  "status-rollup-worker": undefined
};

export async function runAnboCli(args: string[], dependencies: AnboCliDependencies = {}): Promise<number> {
  const runtimeDependencies: AnboCliDependencies = {
    ...dependencies,
    env: dependencies.env ?? process.env
  };
  const parsed = parseArgs(args);
  const command = parsed.command ?? "help";
  try {
    switch (command) {
      case "sandbox":
        throw new Error("sandbox commands belong to the MiniStack target plugin");
      case "setup":
        await runSetup(parsed, runtimeDependencies);
        return 0;
      case "login":
        await runLogin(parsed, runtimeDependencies);
        return 0;
      case "logout":
        await runLogout(parsed, runtimeDependencies);
        return 0;
      case "auth":
        await runAuth(parsed, runtimeDependencies);
        return 0;
      case "demo":
        await runDemo(parsed, runtimeDependencies);
        return 0;
      case "branch":
        return (await runBranch(parsed, runtimeDependencies)) ?? 0;
      case "token":
        await runToken(parsed, runtimeDependencies);
        return 0;
      case "version":
      case "--version":
      case "-v":
        printVersion(parsed, runtimeDependencies);
        return 0;
      case "create":
        await runCreate(parsed, runtimeDependencies);
        return 0;
      case "status":
        await runStatus(parsed, runtimeDependencies);
        return 0;
      case "destroy":
        await runDestroy(parsed, runtimeDependencies);
        return 0;
      case "sql":
        await runSql(parsed, runtimeDependencies);
        return 0;
      case "test":
      case "test-run":
        await runTest(parsed, runtimeDependencies);
        return 0;
      case "test-status":
        await runTestStatus(parsed, runtimeDependencies);
        return 0;
      case "logs":
        await runLogs(parsed, runtimeDependencies);
        return 0;
      case "report":
        await runReport(parsed, runtimeDependencies);
        return 0;
      case "help":
      case "--help":
      case "-h":
        printHelp(runtimeDependencies);
        return 0;
      default:
        throw new Error(`unknown anbo command ${command}`);
    }
  } catch (error) {
    writeErr(runtimeDependencies, redactSensitiveText(getErrorMessage(error)));
    return 1;
  }
}

export function buildAnboEnvironmentManifest(config: AnboCliRepoConfig, input: CreateInput): AnboK8sEnvironmentResource {
  const envId = input.envId ?? defaultEnvId(config.project, input.sha);
  const services: Record<string, AnboK8sServiceSpec> = {};
  for (const serviceName of REQUIRED_SERVICES) {
    const service: AnboK8sServiceSpec = {
      image: input.image,
      replicas: 0
    };
    const port = SERVICE_PORTS[serviceName];
    if (port !== undefined) {
      service.port = port;
    }
    services[serviceName] = service;
  }

  return validateAnboEnvironment({
    apiVersion: "k8s.anbo.dev/v1",
    kind: "AnboEnvironment",
    metadata: {
      name: envId
    },
    spec: {
      ttl: input.ttl ?? config.defaults.ttl,
      repo: config.repo.name,
      sha: input.sha,
      tenant_id: config.project,
      services,
      postgres: {
        mode: "wal_replica_cow_branch",
        source: input.source ?? requiredConfiguredPostgresSource(config),
        base_snapshot: input.snapshot ?? config.defaults.baseSnapshot,
        branch_compute: {
          allocation: input.allocation
        }
      },
      s3: {
        mode: "overlay",
        base_bucket: config.s3.baseBucket,
        base_prefix: config.s3.basePrefix,
        overlay_bucket: config.s3.overlayBucket,
        overlay_prefix: `envs/${envId}/`
      },
      queues: {
        mode: "sqs_namespace",
        names: ["ingest_shard", "agent_jobs", "dlq"]
      },
      side_effects: {
        slack: "capture",
        webhooks: "record_only",
        llm: "deterministic_stub"
      },
      route: {
        base_url: config.routeBaseUrl,
        path: `/e/${envId}`
      },
      tests: {
        migration: "explicit test-run",
        smoke: "explicit test-run",
        auto_run: "none"
      }
    }
  });
}

export function buildAnboTestRunRequest(input: Omit<TestInput, "envId" | "json" | "wait" | "pollIntervalMs">): EnvApiTestRunRequest {
  return {
    type: input.type,
    execution: input.execution,
    image: input.image,
    command: input.command,
    shards: input.shards,
    timeout_seconds: input.timeoutSeconds
  };
}

async function runSetup(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const cwd = dependencies.cwd ?? process.cwd();
  const detected = detectRepo(cwd);
  if (boolFlag(parsed, "demo") || boolFlag(parsed, "preview")) {
    const engine = setupEngineFromArgs(parsed);
    const apiUrl = previewApiUrlFromArgs(parsed, dependencies);
    const token = previewTokenFromArgs(parsed, dependencies, apiUrl);
    const preflightStartedAtMs = clockMs(dependencies);
    const quiet = boolFlag(parsed, "json");
    if (!quiet) {
      writeSetupProgress(dependencies, engine, preflightStartedAtMs);
    }
    const preflight = assertDemoDatabaseLinksPreflight(await waitWithHeartbeat(
      previewApiRequest<DemoApiDatabaseLinksPreflight>(
        dependencies,
        apiUrl,
        "GET",
        `/v1/database-links?type=${engine}`,
        undefined,
        token,
        { timeoutMs: DATABASE_LINKS_PREFLIGHT_TIMEOUT_MS }
      ),
      dependencies,
      quiet,
      2_000,
      () => writeSetupProgress(dependencies, engine, preflightStartedAtMs)
    ));
    if (preflight.type !== undefined && preflight.type !== engine) {
      throw new Error(`${databaseTypeLabel(engine)} preflight returned ${preflight.type} sources`);
    }
    const selectedLinks = engine === "postgres" ? preflight.postgres : preflight.dynamodb;
    if (selectedLinks.length === 0 || selectedLinks.some((link) => !link.ready)) {
      throw new Error(databaseLinksPreflightFailure(preflight, engine));
    }
    printDatabaseLinksPreflight(dependencies, preflight, engine);

    const previous = readCompatiblePreviewConfig(cwd, apiUrl);
    const previousSources = previous === undefined ? [] : configuredBranchSources(previous);
    const replacementSources: AnboCliConfiguredSource[] = engine === "postgres"
      ? preflight.postgres.map((link) => ({
          type: "postgres",
          link: link.link,
          snapshotRef: link.snapshot_ref
        }))
      : preflight.dynamodb.map((link) => ({
          type: "dynamodb",
          link: link.link,
          region: link.region,
          logicalTables: [...link.logical_tables],
          supportedApiLevel: link.supported_api_level
        }));
    const sources = [
      ...previousSources.filter((source) => source.type !== engine),
      ...replacementSources
    ];
    assertUniqueConfiguredSources(sources);
    const postgresDefault = engine === "postgres"
      ? preflight.postgres.find((link) => link.link === preflight.defaults.postgres_link) ?? preflight.postgres[0]
      : previous?.databaseLinks?.postgres;
    const dynamodbDefault = engine === "dynamodb"
      ? preflight.dynamodb.find((link) => link.link === preflight.defaults.dynamodb_link) ?? preflight.dynamodb[0]
      : previous?.databaseLinks?.dynamodb;
    const config: AnboCliRepoConfig = {
      version: 1,
      mode: "demo",
      apiUrl,
      project: stringFlag(parsed, "project") ?? previous?.project ?? "free-preview",
      repo: {
        name: detected.name,
        ...(detected.remoteUrl === undefined ? {} : { remoteUrl: detected.remoteUrl })
      },
      ...(postgresDefault === undefined ? {} : { source: postgresDefault.link }),
      routeBaseUrl: (stringFlag(parsed, "route-base-url")
        ?? stringFlag(parsed, "demo-url")
        ?? stringFlag(parsed, "preview-url")
        ?? dependencies.env?.ANBO_PREVIEW_ROUTE_BASE_URL
        ?? previous?.routeBaseUrl
        ?? DEFAULT_PREVIEW_ROUTE_BASE_URL).replace(/\/+$/, ""),
      s3: {
        baseBucket: stringFlag(parsed, "base-bucket") ?? previous?.s3.baseBucket ?? "anbo-preview-base",
        basePrefix: normalizeS3Prefix(stringFlag(parsed, "base-prefix") ?? previous?.s3.basePrefix ?? "preview/"),
        overlayBucket: stringFlag(parsed, "overlay-bucket") ?? previous?.s3.overlayBucket ?? "anbo-preview-overlays"
      },
      defaults: {
        ttl: stringFlag(parsed, "ttl") ?? previous?.defaults.ttl ?? "1h",
        baseSnapshot: stringFlag(parsed, "snapshot") ?? previous?.defaults.baseSnapshot ?? "latest_safe",
        allocation: allocationFromFlag(stringFlag(parsed, "allocation") ?? previous?.defaults.allocation ?? "pool_required"),
        ...(dynamodbDefault === undefined ? {} : { dynamodbLink: dynamodbDefault.link })
      },
      sources,
      databaseLinks: {
        checkedAt: preflight.checked_at,
        ...(postgresDefault === undefined ? {} : {
          postgres: "snapshot_ref" in postgresDefault
            ? { link: postgresDefault.link, snapshotRef: postgresDefault.snapshot_ref }
            : postgresDefault
        }),
        ...(dynamodbDefault === undefined ? {} : {
          dynamodb: {
            link: dynamodbDefault.link,
            region: dynamodbDefault.region,
            logicalTables: "logical_tables" in dynamodbDefault
              ? [...dynamodbDefault.logical_tables]
              : [...dynamodbDefault.logicalTables],
            supportedApiLevel: "supported_api_level" in dynamodbDefault
              ? dynamodbDefault.supported_api_level
              : dynamodbDefault.supportedApiLevel
          }
        })
      }
    };
    writeRepoConfig(cwd, config);
    writeOut(dependencies, `wrote ${CONFIG_PATH}`);
    writeOut(dependencies, `configured demo API ${apiUrl}`);
    writeOut(dependencies, `configured demo branches under ${config.routeBaseUrl}`);
    if (sources.length === 1) {
      writeOut(dependencies, `branch create will use ${sources[0]!.link} automatically`);
    } else {
      writeOut(dependencies, `configured sources: ${sources.map((source) => source.link).join(", ")}`);
      writeOut(dependencies, "branch create requires --from SOURCE when more than one source is configured");
    }
    return;
  }
  const setupEngine = parsed.positional[0];
  if (setupEngine !== undefined && setupEngine !== "postgres") {
    throw new Error("self-hosted setup currently supports postgres; use anbo setup postgres or anbo setup dynamodb --demo");
  }
  const input: SetupInput = {
    apiUrl: apiBaseUrlFromUrl(await requiredSetupValue(parsed, dependencies, "api-url", "Env API URL"), "Env API URL"),
    project: await requiredSetupValue(parsed, dependencies, "project", "Project name", detected.name),
    source: await requiredSetupValue(parsed, dependencies, "source", "Source Postgres alias"),
    routeBaseUrl: await requiredSetupValue(parsed, dependencies, "route-base-url", "Preview route base URL"),
    baseBucket: await requiredSetupValue(parsed, dependencies, "base-bucket", "Base raw S3 bucket"),
    basePrefix: normalizeS3Prefix(await requiredSetupValue(parsed, dependencies, "base-prefix", "Base raw S3 prefix")),
    overlayBucket: await requiredSetupValue(parsed, dependencies, "overlay-bucket", "Overlay S3 bucket"),
    allocation: allocationFromFlag(stringFlag(parsed, "allocation") ?? "pool_required"),
    ttl: stringFlag(parsed, "ttl") ?? "2h",
    baseSnapshot: stringFlag(parsed, "snapshot") ?? "latest_safe"
  };
  const token = stringFlag(parsed, "token");
  if (token !== undefined) {
    input.token = token;
  }

  const config: AnboCliRepoConfig = {
    version: 1,
    apiUrl: input.apiUrl,
    project: input.project,
    repo: {
      name: detected.name,
      ...(detected.remoteUrl === undefined ? {} : { remoteUrl: detected.remoteUrl })
    },
    source: input.source,
    routeBaseUrl: input.routeBaseUrl,
    s3: {
      baseBucket: input.baseBucket,
      basePrefix: input.basePrefix,
      overlayBucket: input.overlayBucket
    },
    defaults: {
      ttl: input.ttl,
      baseSnapshot: input.baseSnapshot,
      allocation: input.allocation
    }
  };

  writeRepoConfig(cwd, config);
  if (input.token !== undefined) {
    writeCredential(dependencies, input.apiUrl, input.token);
  }
  writeOut(dependencies, `wrote ${CONFIG_PATH}`);
  if (input.token !== undefined) {
    writeOut(dependencies, `stored credentials in ${credentialsPath(dependencies)}`);
  } else {
    writeOut(dependencies, "no token stored; set ANBO_ENV_API_TOKEN or rerun setup with --token");
  }
}

function setupEngineFromArgs(parsed: ParsedArgs): "postgres" | "dynamodb" {
  const engine = parsed.positional[0];
  if (engine === "postgres" || engine === "dynamodb") {
    return engine;
  }
  if (engine === undefined) {
    throw new Error("choose a database type: anbo setup postgres --demo or anbo setup dynamodb --demo");
  }
  throw new Error(`unsupported database type ${engine}; choose postgres or dynamodb`);
}

function readCompatiblePreviewConfig(cwd: string, apiUrl: string): AnboCliRepoConfig | undefined {
  const path = resolve(cwd, CONFIG_PATH);
  if (!existsSync(path)) {
    return undefined;
  }
  const existing = assertRepoConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  return isPreviewConfig(existing) && existing.apiUrl.replace(/\/+$/, "") === apiUrl.replace(/\/+$/, "")
    ? existing
    : undefined;
}

function configuredBranchSources(config: AnboCliRepoConfig): AnboCliConfiguredSource[] {
  if (config.sources !== undefined) {
    const sources = config.sources.map((source) => ({
      ...source,
      ...(source.type === "dynamodb" && source.logicalTables !== undefined
        ? { logicalTables: [...source.logicalTables] }
        : {})
    }));
    assertUniqueConfiguredSources(sources);
    return sources;
  }

  const sources: AnboCliConfiguredSource[] = [];
  const postgres = config.databaseLinks?.postgres;
  if (postgres !== undefined) {
    sources.push({ type: "postgres", link: postgres.link, snapshotRef: postgres.snapshotRef });
  } else if (config.source !== undefined) {
    sources.push({ type: "postgres", link: config.source, snapshotRef: config.defaults.baseSnapshot });
  }
  const dynamodb = config.databaseLinks?.dynamodb;
  if (dynamodb !== undefined) {
    sources.push({
      type: "dynamodb",
      link: dynamodb.link,
      region: dynamodb.region,
      logicalTables: [...dynamodb.logicalTables],
      supportedApiLevel: dynamodb.supportedApiLevel
    });
  } else if (config.defaults.dynamodbLink !== undefined) {
    sources.push({ type: "dynamodb", link: config.defaults.dynamodbLink });
  }
  assertUniqueConfiguredSources(sources);
  return sources;
}

function assertUniqueConfiguredSources(sources: AnboCliConfiguredSource[]): void {
  const aliases = new Set<string>();
  for (const source of sources) {
    if (aliases.has(source.link)) {
      throw new Error(`source alias ${source.link} is configured more than once; source aliases must be unique`);
    }
    aliases.add(source.link);
  }
}

function requiredConfiguredPostgresSource(config: AnboCliRepoConfig): string {
  const source = config.source ?? configuredBranchSources(config).find((entry) => entry.type === "postgres")?.link;
  if (source === undefined) {
    throw new Error("no PostgreSQL source is configured");
  }
  return source;
}

function resolveBranchSource(config: AnboCliRepoConfig, rawFrom: string | true | undefined): AnboCliConfiguredSource {
  const sources = configuredBranchSources(config);
  if (sources.length === 0) {
    throw new Error("no database sources are configured; run anbo setup postgres or anbo setup dynamodb");
  }
  if (rawFrom === true || (typeof rawFrom === "string" && rawFrom.trim().length === 0)) {
    throw new Error("--from requires a source alias");
  }
  if (rawFrom === undefined) {
    if (sources.length === 1) {
      return sources[0]!;
    }
    throw new Error(
      `multiple database sources are configured (${formatConfiguredSources(sources)}); use --from SOURCE`
    );
  }
  const selected = sources.find((source) => source.link === rawFrom);
  if (selected === undefined) {
    throw new Error(`source ${rawFrom} is not configured; configured sources: ${formatConfiguredSources(sources)}`);
  }
  return selected;
}

function rejectLegacyBranchSourceFlags(parsed: ParsedArgs): void {
  const legacy = ["dynamodb", "no-dynamodb", "dynamodb-link"].find((flag) => parsed.flags[flag] !== undefined);
  if (legacy !== undefined) {
    throw new Error(`--${legacy} is no longer used for branch selection; use --from SOURCE`);
  }
}

function formatConfiguredSources(sources: AnboCliConfiguredSource[]): string {
  return sources.map((source) => `${databaseTypeLabel(source.type)} ${source.link}`).join(", ");
}

function databaseTypeLabel(type: "postgres" | "dynamodb"): string {
  return type === "postgres" ? "PostgreSQL" : "DynamoDB";
}

function writeSetupProgress(
  dependencies: AnboCliDependencies,
  engine: "postgres" | "dynamodb",
  startedAtMs: number
): void {
  writeOut(
    dependencies,
    `checking ${databaseTypeLabel(engine)} sources: elapsed=${formatDurationMs(clockMs(dependencies) - startedAtMs)} phase=preflight`
  );
}

function writeBranchCreateProgress(
  dependencies: AnboCliDependencies,
  name: string,
  source: AnboCliConfiguredSource,
  startedAtMs: number,
  phase: string
): void {
  writeOut(
    dependencies,
    `creating ${databaseTypeLabel(source.type)} branch ${name} from ${source.link}: ` +
      `elapsed=${formatDurationMs(clockMs(dependencies) - startedAtMs)} phase=${phase}`
  );
}

function branchProvisioningPhase(branch: DemoApiBranch): string {
  return branch.dynamodb?.phase ?? branch.state ?? branch.status;
}

function clockMs(dependencies: AnboCliDependencies): number {
  return (dependencies.now?.() ?? new Date()).getTime();
}

async function waitWithHeartbeat<T>(
  operation: Promise<T>,
  _dependencies: AnboCliDependencies,
  quiet: boolean,
  intervalMs: number,
  heartbeat: () => void
): Promise<T> {
  if (quiet) {
    return await operation;
  }
  const timer = setInterval(heartbeat, intervalMs);
  timer.unref();
  try {
    return await operation;
  } finally {
    clearInterval(timer);
  }
}

async function runLogin(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
  const start = await previewApiRequest<DemoApiDeviceStart>(dependencies, previewUrl, "POST", "/v1/cli/device/start");
  const verificationUrl = validateLoginVerificationUrl(start.verification_uri, previewUrl, dependencies);
  writeOut(dependencies, `verification_url: ${verificationUrl}`);
  writeOut(dependencies, `user_code: ${start.user_code}`);
  if (!boolFlag(parsed, "no-browser")) {
    if (openUrlInBrowser(verificationUrl, dependencies)) {
      writeOut(dependencies, "opened browser for Auth0 login");
    } else {
      writeOut(dependencies, "could not open a browser automatically; open verification_url manually");
    }
  }
  writeOut(dependencies, "waiting for browser approval...");
  const deadline = Date.now() + start.expires_in * 1000;
  let latestError = "authorization pending";
  while (Date.now() < deadline) {
    const token = await previewApiRequestOrError<DemoApiDeviceToken>(
      dependencies,
      previewUrl,
      "POST",
      "/v1/cli/device/token",
      { device_code: start.device_code }
    );
    if (token.ok) {
      writePreviewCredential(dependencies, previewUrl, token.body.access_token);
      writeOut(dependencies, `stored Anbo credentials for ${previewUrl}`);
      return;
    }
    latestError = token.message;
    if (token.status !== 428) {
      break;
    }
    await sleep(Math.max(1, start.interval) * 1000);
  }
  throw new Error(`login failed: ${latestError}`);
}

function validateLoginVerificationUrl(
  verificationUri: string,
  previewUrl: string,
  dependencies: AnboCliDependencies
): string {
  let parsed: URL;
  try {
    parsed = new URL(verificationUri);
  } catch {
    throw new Error("login verification_url must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("login verification_url must use http or https");
  }
  if (/[\u0000-\u001F\u007F\s"'`<>\\|;&]/.test(verificationUri) || verificationUri.includes("$(") || verificationUri.includes("${")) {
    throw new Error("login verification_url contains unsafe shell metacharacters");
  }
  const allowedOrigins = loginVerificationAllowedOrigins(previewUrl, dependencies);
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error(`login verification_url origin ${parsed.origin} does not match ${Array.from(allowedOrigins).join(" or ")}`);
  }
  return parsed.href;
}

function loginVerificationAllowedOrigins(previewUrl: string, dependencies: AnboCliDependencies): Set<string> {
  const origins = new Set<string>([httpOriginFromUrl(previewUrl, "preview API URL")]);
  for (const candidate of [
    dependencies.env?.ANBO_PUBLIC_BASE_URL,
    dependencies.env?.ANBO_PUBLIC_ORIGIN,
    dependencies.env?.ANBO_APP_URL,
    dependencies.env?.ANBO_K8_PUBLIC_BASE_URL
  ]) {
    const origin = optionalHttpOriginFromUrl(candidate);
    if (origin !== undefined) {
      origins.add(origin);
    }
  }
  return origins;
}

function httpOriginFromUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.protocol === "http:" && !isLocalHttpHost(parsed.hostname)) {
    throw new Error(`${label} must use https unless it targets localhost`);
  }
  return parsed.origin;
}

function optionalHttpOriginFromUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    return httpOriginFromUrl(value, "public origin URL");
  } catch {
    return undefined;
  }
}

function apiBaseUrlFromUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.protocol === "http:" && !isLocalHttpHost(parsed.hostname)) {
    throw new Error(`${label} must use https unless it targets localhost`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`${label} must not include embedded credentials`);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`${label} must not include query strings or fragments`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost");
}

function openUrlInBrowser(url: string, dependencies: AnboCliDependencies): boolean {
  if (dependencies.openBrowser !== undefined) {
    return dependencies.openBrowser(url);
  }
  const platform = dependencies.platform ?? process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const spawnBrowser = dependencies.browserSpawn ?? spawnSync;
  const result = spawnBrowser(command, args, {
    stdio: "ignore",
    timeout: 3000
  });
  return result.status === 0;
}

async function runLogout(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
  deletePreviewCredential(dependencies, previewUrl);
  writeOut(dependencies, `removed Anbo credentials for ${previewUrl}`);
}

async function runAuth(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const subcommand = requiredPositional(parsed, 0, "auth command");
  const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
  if (subcommand === "login") {
    await runLogin(withoutFirstPositional(parsed), dependencies);
    return;
  }
  if (subcommand === "logout") {
    await runLogout(withoutFirstPositional(parsed), dependencies);
    return;
  }
  throw new Error(`unknown auth command ${subcommand}`);
}

async function runDemo(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const subcommand = requiredPositional(parsed, 0, "demo command");
  if (subcommand === "sql") {
    throw new Error("hosted SQL is not available in demo mode; use anbo branch url NAME and run psql, migrations, or tests with DATABASE_URL");
  }
  throw new Error("anbo demo subcommands are deprecated; use anbo branch create/info/url/list/delete");
}

async function runBranch(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<number | void> {
  const subcommand = requiredPositional(parsed, 0, "branch command");
  const config = readRepoConfig(dependencies);
  if (!isPreviewConfig(config)) {
    throw new Error("anbo branch is only available after anbo setup postgres --demo or anbo setup dynamodb --demo");
  }
  const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
  const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
  if (subcommand === "create") {
    const name = requiredPositional(parsed, 1, "branch name");
    const json = boolFlag(parsed, "json");
    const waitTimeoutMs = positiveIntFlag(parsed, "timeout-seconds", 600) * 1_000;
    const pollIntervalMs = positiveIntFlag(parsed, "poll-interval-ms", 2_000);
    rejectLegacyBranchSourceFlags(parsed);
    const source = resolveBranchSource(config, parsed.flags["from"]);
    const startedAtMs = clockMs(dependencies);
    if (!json) {
      writeBranchCreateProgress(dependencies, name, source, startedAtMs, "requesting");
    }
    let branch = await waitWithHeartbeat(
      previewApiRequest<DemoApiBranch>(
        dependencies,
        previewUrl,
        "POST",
        "/v1/branches",
        { name, from: source.link },
        token,
        { timeoutMs: waitTimeoutMs }
      ),
      dependencies,
      json,
      pollIntervalMs,
      () => writeBranchCreateProgress(dependencies, name, source, startedAtMs, "requesting")
    );
    if (!boolFlag(parsed, "no-wait")) {
      branch = await waitForDemoBranchReady(
        dependencies,
        previewUrl,
        token,
        name,
        branch,
        json,
        waitTimeoutMs,
        source,
        startedAtMs,
        pollIntervalMs
      );
    }
    const includeCredentials = !boolFlag(parsed, "no-credentials");
    const connection = branch.ready && includeCredentials
      ? await requestDemoBranchConnection(dependencies, previewUrl, token, branch, source)
      : undefined;
    printDemoBranchCreateResult(dependencies, branch, connection, json, includeCredentials);
    return;
  }
  if (subcommand === "info") {
    const name = requiredPositional(parsed, 1, "branch name or id");
    const branch = await previewApiRequest<DemoApiBranch>(
      dependencies,
      previewUrl,
      "GET",
      `/v1/branches/${encodeURIComponent(name)}`,
      undefined,
      token
    );
    printDemoBranch(dependencies, branch, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
    return;
  }
  if (subcommand === "url") {
    const name = requiredPositional(parsed, 1, "branch name or id");
    const result = await requestDemoBranchUrl(dependencies, previewUrl, token, name);
    if (boolFlag(parsed, "json")) {
      writeOut(dependencies, JSON.stringify(result, null, 2));
    } else {
      writeOut(dependencies, result.database_url);
    }
    return;
  }
  if (subcommand === "credentials") {
    const name = requiredPositional(parsed, 1, "branch name or id");
    const format = stringFlag(parsed, "format") ?? "env";
    if (format !== "env" && format !== "json") {
      throw new Error("--format must be env or json");
    }
    const credentials = await requestDemoDynamoDBCredentials(
      dependencies,
      previewUrl,
      token,
      name
    );
    if (format === "json") {
      writeOut(dependencies, JSON.stringify(credentials, null, 2));
    } else {
      for (const [key, value] of Object.entries(dynamoDBCredentialEnvironment(credentials))) {
        writeOut(dependencies, `export ${key}=${shellQuote(value)}`);
      }
    }
    return;
  }
  if (subcommand === "with-env") {
    const name = requiredPositional(parsed, 1, "branch name or id");
    if (parsed.afterDoubleDash.length === 0) {
      throw new Error("anbo branch with-env requires -- COMMAND [ARG...]");
    }
    const credentials = await requestDemoDynamoDBCredentials(
      dependencies,
      previewUrl,
      token,
      name
    );
    const [command, ...args] = parsed.afterDoubleDash;
    if (command === undefined || command.length === 0) {
      throw new Error("anbo branch with-env requires -- COMMAND [ARG...]");
    }
    const result = (dependencies.localCommandSpawn ?? spawnSync)(command, args, {
      cwd: dependencies.cwd ?? process.cwd(),
      env: localDynamoDBCommandEnvironment(dependencies.env ?? process.env, credentials),
      stdio: "inherit"
    });
    if (result.error !== undefined) {
      throw new Error(`failed to start local command: ${result.error.message}`);
    }
    if (result.status === null) {
      throw new Error(`local command terminated by ${result.signal ?? "an unknown signal"}`);
    }
    return result.status;
  }
  if (subcommand === "dynamodb-smoke") {
    const name = requiredPositional(parsed, 1, "branch name or id");
    const credentials = await requestDemoDynamoDBCredentials(
      dependencies,
      previewUrl,
      token,
      name
    );
    const tableName = credentials.tables.includes("BillingEvents")
      ? "BillingEvents"
      : credentials.tables[0];
    if (tableName === undefined) {
      throw new Error("DynamoDB branch does not advertise any tables");
    }
    const now = dependencies.now?.() ?? new Date();
    const partitionKey = `account#anbo-smoke-${credentials.branch_id}`;
    const sortKey = String(now.getTime());
    const smoke = await (dependencies.dynamodbSmoke ?? runDynamoDBSmoke)({
      endpoint: credentials.endpoint_url,
      region: credentials.region,
      accessKeyId: credentials.access_key_id,
      secretAccessKey: credentials.secret_access_key,
      sessionToken: credentials.session_token,
      tableName,
      partitionKey,
      sortKey
    });
    writeOut(dependencies, `endpoint: ${credentials.endpoint_url}`);
    writeOut(dependencies, `tables: ${smoke.tables.join(", ")}`);
    writeOut(dependencies, `source_rows: ${smoke.sourceRowCount}`);
    writeOut(dependencies, `write: ding ding ding (${partitionKey}/${sortKey})`);
    writeOut(dependencies, `read_back: ${smoke.writeReadBack ? "ok" : "failed"}`);
    if (!smoke.writeReadBack) {
      throw new Error("DynamoDB smoke write was not readable from the branch");
    }
    return;
  }
  if (subcommand === "list") {
    const result = await previewApiRequest<DemoApiBranchList>(
      dependencies,
      previewUrl,
      "GET",
      "/v1/branches",
      undefined,
      token
    );
    printDemoBranchList(dependencies, result, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
    return;
  }
  if (subcommand === "delete") {
    const name = requiredPositional(parsed, 1, "branch name or id");
    let branch = await previewApiRequest<DemoApiBranch>(
      dependencies,
      previewUrl,
      "DELETE",
      `/v1/branches/${encodeURIComponent(name)}`,
      undefined,
      token
    );
    if (boolFlag(parsed, "wait") && branch.status !== "deleted") {
      branch = await waitForDemoBranchDeleted(
        dependencies,
        previewUrl,
        token,
        branch,
        boolFlag(parsed, "json"),
        positiveIntFlag(parsed, "timeout-seconds", 600) * 1_000
      );
    }
    printDemoBranch(dependencies, branch, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
    return;
  }
  throw new Error(`unknown branch command ${subcommand}`);
}

async function waitForDemoBranchReady(
  dependencies: AnboCliDependencies,
  previewUrl: string,
  token: string | undefined,
  name: string,
  initial: DemoApiBranch,
  quiet: boolean,
  timeoutMs: number,
  source: AnboCliConfiguredSource,
  startedAtMs: number,
  pollIntervalMs: number
): Promise<DemoApiBranch> {
  let latest = initial;
  const pollId = initial.id;
  const deadline = startedAtMs + timeoutMs;
  while (clockMs(dependencies) < deadline) {
    if (latest.ready) {
      return latest;
    }
    if (latest.status === "failed" || latest.status === "deleted" || latest.status === "deleting") {
      throw new Error(`branch ${name} reached terminal status ${latest.status}`);
    }
    if (!quiet) {
      writeBranchCreateProgress(
        dependencies,
        name,
        source,
        startedAtMs,
        branchProvisioningPhase(latest)
      );
    }
    await sleepFor(dependencies, pollIntervalMs);
    latest = await waitWithHeartbeat(
      previewApiRequest<DemoApiBranch>(
        dependencies,
        previewUrl,
        "GET",
        `/v1/branches/${encodeURIComponent(pollId)}`,
        undefined,
        token,
        { timeoutMs: Math.max(1, deadline - clockMs(dependencies)) }
      ),
      dependencies,
      quiet,
      pollIntervalMs,
      () => writeBranchCreateProgress(
        dependencies,
        name,
        source,
        startedAtMs,
        branchProvisioningPhase(latest)
      )
    );
  }
  throw new Error(`timed out waiting for branch ${name}; latest status was ${latest.status}`);
}

async function requestDemoBranchUrl(
  dependencies: AnboCliDependencies,
  previewUrl: string,
  token: string | undefined,
  name: string
): Promise<DemoApiBranchUrl> {
  const deadline = Date.now() + 90_000;
  let latestError = "branch database URL is not ready";
  while (Date.now() < deadline) {
    const response = await previewApiRequestOrError<DemoApiBranchUrl>(
      dependencies,
      previewUrl,
      "GET",
      `/v1/branches/${encodeURIComponent(name)}/url`,
      undefined,
      token
    );
    if (response.ok) {
      return response.body;
    }
    latestError = response.message;
    const retryable = response.status === 502 ||
      response.status === 503 ||
      (response.status === 409 && /not ready/i.test(response.message));
    if (!retryable) {
      throw new Error(`GET /v1/branches/${name}/url failed ${response.status}: ${response.message}`);
    }
    await sleepFor(dependencies, 2_000);
  }
  throw new Error(`branch database URL is not ready: ${latestError}`);
}

async function requestDemoDynamoDBCredentials(
  dependencies: AnboCliDependencies,
  previewUrl: string,
  token: string | undefined,
  name: string
): Promise<DemoApiDynamoDBCredentials> {
  const credentials = await previewApiRequest<DemoApiDynamoDBCredentials>(
    dependencies,
    previewUrl,
    "POST",
    `/v1/branches/${encodeURIComponent(name)}/dynamodb/credentials`,
    {},
    token
  );
  return assertDemoDynamoDBCredentials(credentials, previewUrl, dependencies);
}

async function requestDemoBranchConnection(
  dependencies: AnboCliDependencies,
  previewUrl: string,
  token: string | undefined,
  branch: DemoApiBranch,
  configuredSource: AnboCliConfiguredSource
): Promise<DemoBranchConnection> {
  const source = branch.source ?? configuredSource;
  if (source.type !== configuredSource.type || source.link !== configuredSource.link) {
    throw new Error("created branch source did not match the requested source");
  }
  if (source.type === "postgres") {
    const result = await requestDemoBranchUrl(dependencies, previewUrl, token, branch.id);
    return {
      type: "postgres",
      database_url: result.database_url,
      ...(branch.expires_at === undefined ? {} : { expires_at: branch.expires_at }),
      environment: { DATABASE_URL: result.database_url }
    };
  }

  const credentials = await requestDemoDynamoDBCredentials(
    dependencies,
    previewUrl,
    token,
    branch.id
  );
  if (credentials.branch_id !== branch.id || credentials.branch_name !== branch.name) {
    throw new Error("DynamoDB credential lease did not match the created branch");
  }
  return {
    type: "dynamodb",
    endpoint_url: credentials.endpoint_url,
    region: credentials.region,
    access_key_id: credentials.access_key_id,
    secret_access_key: credentials.secret_access_key,
    session_token: credentials.session_token,
    expires_at: credentials.expires_at,
    issued_at: credentials.issued_at,
    supported_api_level: credentials.supported_api_level,
    tables: [...credentials.tables],
    environment: dynamoDBCredentialEnvironment(credentials)
  };
}

function assertDemoDynamoDBCredentials(
  value: DemoApiDynamoDBCredentials,
  previewUrl: string,
  dependencies: AnboCliDependencies
): DemoApiDynamoDBCredentials {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["branch_id"] !== "string" || value["branch_id"].length === 0 ||
    typeof value["branch_name"] !== "string" || value["branch_name"].length === 0 ||
    typeof value["endpoint_url"] !== "string" ||
    typeof value["region"] !== "string" || value["region"].length === 0 ||
    typeof value["access_key_id"] !== "string" || value["access_key_id"].length === 0 ||
    typeof value["secret_access_key"] !== "string" || value["secret_access_key"].length === 0 ||
    typeof value["session_token"] !== "string" || value["session_token"].length === 0 ||
    typeof value["expires_at"] !== "string" ||
    typeof value["issued_at"] !== "string" ||
    typeof value["supported_api_level"] !== "string" || value["supported_api_level"].length === 0 ||
    !Array.isArray(value["tables"]) ||
    !value["tables"].every((table) => typeof table === "string" && table.length > 0)
  ) {
    throw new Error("DynamoDB credential response was malformed");
  }
  assertExternalDynamoDBEndpoint(value.endpoint_url, previewUrl);
  const expiryMs = Date.parse(value.expires_at);
  const nowMs = (dependencies.now?.() ?? new Date()).getTime();
  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) {
    throw new Error("DynamoDB credential lease is expired or malformed");
  }
  return value;
}

function assertExternalDynamoDBEndpoint(endpoint: string, previewUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("DynamoDB endpoint must be a valid URL");
  }
  const localDevelopment = isLocalHttpHost(parsed.hostname) && isLocalHttpHost(new URL(previewUrl).hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localDevelopment)) {
    throw new Error("DynamoDB endpoint must use https outside local development");
  }
  if (
    parsed.hostname.endsWith(".svc") ||
    parsed.hostname.includes(".svc.") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("DynamoDB endpoint is not a public credential-free gateway URL");
  }
}

function dynamoDBCredentialEnvironment(credentials: DemoApiDynamoDBCredentials): Record<string, string> {
  return {
    AWS_ENDPOINT_URL_DYNAMODB: credentials.endpoint_url,
    AWS_REGION: credentials.region,
    AWS_ACCESS_KEY_ID: credentials.access_key_id,
    AWS_SECRET_ACCESS_KEY: credentials.secret_access_key,
    AWS_SESSION_TOKEN: credentials.session_token,
    ANBO_DYNAMODB_SUPPORTED_API_LEVEL: credentials.supported_api_level,
    ANBO_DYNAMODB_CREDENTIAL_EXPIRES_AT: credentials.expires_at
  };
}

function localDynamoDBCommandEnvironment(
  parent: NodeJS.ProcessEnv,
  credentials: DemoApiDynamoDBCredentials
): NodeJS.ProcessEnv {
  const environment = { ...parent };
  for (const key of [
    "ANBO_TOKEN",
    "ANBO_PREVIEW_TOKEN",
    "ANBO_DEMO_TOKEN",
    "ANBO_PREVIEW_API_TOKEN",
    "ANBO_DEMO_API_TOKEN",
    "ANBO_ENV_API_TOKEN",
    "ANBO_K8S_ENV_API_TOKEN"
  ]) {
    delete environment[key];
  }
  return { ...environment, ...dynamoDBCredentialEnvironment(credentials) };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runDynamoDBSmoke(input: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  tableName: string;
  partitionKey: string;
  sortKey: string;
}): Promise<{ tables: string[]; sourceRowCount: number; writeReadBack: boolean }> {
  const {
    DynamoDBClient,
    GetItemCommand,
    ListTablesCommand,
    PutItemCommand,
    QueryCommand
  } = await import("@aws-sdk/client-dynamodb");
  const client = new DynamoDBClient({
    endpoint: input.endpoint,
    region: input.region,
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      sessionToken: input.sessionToken
    }
  });
  try {
    const listed = await client.send(new ListTablesCommand({}));
    const queried = await client.send(new QueryCommand({
      TableName: input.tableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": { S: "account#demo" } }
    }));
    await client.send(new PutItemCommand({
      TableName: input.tableName,
      Item: {
        pk: { S: input.partitionKey },
        sk: { N: input.sortKey },
        message: { S: "ding ding ding" },
        entity: { S: "anbo-smoke" }
      }
    }));
    const read = await client.send(new GetItemCommand({
      TableName: input.tableName,
      Key: {
        pk: { S: input.partitionKey },
        sk: { N: input.sortKey }
      },
      ConsistentRead: true
    }));
    return {
      tables: listed.TableNames ?? [],
      sourceRowCount: queried.Count ?? queried.Items?.length ?? 0,
      writeReadBack: read.Item?.["message"]?.S === "ding ding ding"
    };
  } finally {
    client.destroy();
  }
}

async function waitForDemoBranchDeleted(
  dependencies: AnboCliDependencies,
  previewUrl: string,
  token: string | undefined,
  initial: DemoApiBranch,
  quiet: boolean,
  timeoutMs: number
): Promise<DemoApiBranch> {
  let latest = initial;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    if (latest.status === "deleted") return latest;
    if (latest.status === "failed") {
      throw new Error(`branch ${latest.name} failed while deleting`);
    }
    if (!quiet && latest.status !== lastStatus) {
      writeOut(dependencies, `waiting for branch ${latest.name} deletion: ${latest.status}`);
      lastStatus = latest.status;
    }
    await sleepFor(dependencies, 2_000);
    latest = await previewApiRequest<DemoApiBranch>(
      dependencies,
      previewUrl,
      "GET",
      `/v1/branches/${encodeURIComponent(initial.id)}`,
      undefined,
      token
    );
  }
  throw new Error(`timed out waiting for branch ${initial.name} deletion; latest status was ${latest.status}`);
}

async function runToken(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const subcommand = requiredPositional(parsed, 0, "token command");
  const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
  const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
  if (subcommand === "create") {
    const body: Record<string, unknown> = {};
    const name = stringFlag(parsed, "name");
    if (name !== undefined) {
      if (name.trim().length === 0) throw new Error("--name must not be empty");
      body.name = name.trim();
    }
    const scopes = stringFlag(parsed, "scopes");
    if (scopes !== undefined) {
      body.scopes = apiTokenScopesFromFlag(scopes);
    }
    const expiresIn = stringFlag(parsed, "expires-in");
    if (expiresIn !== undefined) {
      body.expires_in = positiveIntFromRaw(expiresIn, "expires-in");
    }
    const created = await previewApiRequest<DemoApiTokenCreate>(
      dependencies,
      previewUrl,
      "POST",
      "/v1/tokens",
      body,
      token
    );
    if (boolFlag(parsed, "json")) {
      writeOut(dependencies, JSON.stringify(created, null, 2));
    } else {
      writeOut(dependencies, created.token);
    }
    return;
  }
  if (subcommand === "list") {
    const result = await previewApiRequest<DemoApiTokenList>(
      dependencies,
      previewUrl,
      "GET",
      "/v1/tokens",
      undefined,
      token
    );
    if (boolFlag(parsed, "json")) {
      writeOut(dependencies, JSON.stringify(result, null, 2));
      return;
    }
    if (result.tokens.length === 0) {
      writeOut(dependencies, "no API tokens");
      return;
    }
    for (const metadata of result.tokens) {
      printApiTokenMetadata(dependencies, metadata);
    }
    return;
  }
  if (subcommand === "revoke") {
    const id = requiredPositional(parsed, 1, "token id");
    const revoked = await previewApiRequest<DemoApiTokenMetadata>(
      dependencies,
      previewUrl,
      "DELETE",
      `/v1/tokens/${encodeURIComponent(id)}`,
      undefined,
      token
    );
    if (boolFlag(parsed, "json")) {
      writeOut(dependencies, JSON.stringify(revoked, null, 2));
    } else {
      printApiTokenMetadata(dependencies, revoked);
    }
    return;
  }
  throw new Error(`unknown token command ${subcommand}`);
}

function apiTokenScopesFromFlag(value: string): string[] {
  const scopes = Array.from(new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean)));
  if (scopes.length === 0 || scopes.some((scope) => !VALID_API_TOKEN_SCOPES.has(scope))) {
    throw new Error(`--scopes must be a comma-separated subset of ${Array.from(VALID_API_TOKEN_SCOPES).join(",")}`);
  }
  return scopes;
}

function printApiTokenMetadata(dependencies: AnboCliDependencies, token: DemoApiTokenMetadata): void {
  writeOut(
    dependencies,
    `${token.id} name=${token.name ?? "unnamed"} status=${token.status}` +
      ` scopes=${token.scopes.join(",")} expires_at=${token.expires_at}` +
      ` last_used_at=${token.last_used_at ?? "never"}`
  );
}

async function runCreate(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  if (config.mode === "demo") {
    throw new Error("anbo create is not available in demo mode; use anbo branch create NAME");
  }
  const input = createInputFromArgs(parsed, config);
  const manifest = buildAnboEnvironmentManifest(config, input);
  const client = envApiClient(config, parsed, dependencies);
  let summary = await client.request<EnvApiEnvironmentSummary>("POST", "/envs", manifest);
  if (input.wait) {
    summary = await waitForEnvState(
      client,
      manifest.metadata.name,
      input.timeoutSeconds,
      input.pollIntervalMs,
      (state) => READY_STATES.has(state) || TERMINAL_FAILURE_STATES.has(state),
      input.json ? undefined : envWaitProgressReporter(dependencies)
    );
  }
  printEnvironmentSummary(dependencies, summary, input.json);
  if (input.wait && !READY_STATES.has(summary.state)) {
    throw new Error(`environment ${manifest.metadata.name} reached ${summary.state}, not ReadyForFirstTest`);
  }
}

async function runStatus(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  if (config.mode === "demo") {
    throw new Error("anbo status is not available in demo mode; use anbo branch info NAME or anbo branch list");
  }
  const envId = requiredPositional(parsed, 0, "env_id");
  const json = boolFlag(parsed, "json");
  const client = envApiClient(config, parsed, dependencies);
  const summary = await client.request<EnvApiEnvironmentSummary>("GET", `/envs/${encodeURIComponent(envId)}`);
  printEnvironmentSummary(dependencies, summary, json);
}

async function runDestroy(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  if (config.mode === "demo") {
    throw new Error("anbo destroy is not available in demo mode; use anbo branch delete NAME");
  }
  const input = destroyInputFromArgs(parsed);
  const client = envApiClient(config, parsed, dependencies);
  let summary = await client.request<EnvApiEnvironmentSummary>("DELETE", `/envs/${encodeURIComponent(input.envId)}`);
  if (input.wait) {
    summary = await waitForEnvState(
      client,
      input.envId,
      input.timeoutSeconds,
      input.pollIntervalMs,
      (state) => state === "Deleted",
      input.json ? undefined : envWaitProgressReporter(dependencies)
    );
  }
  printEnvironmentSummary(dependencies, summary, input.json);
}

async function runSql(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  const sql = parsed.afterDoubleDash.length > 0 ? parsed.afterDoubleDash.join(" ") : requiredFlag(parsed, "sql");
  if (config.mode === "demo") {
    throw new Error("anbo sql is not available in demo mode; use anbo branch url NAME and run psql, migrations, or tests with DATABASE_URL");
  }
  const envId = requiredPositional(parsed, 0, "env_id");
  const client = envApiClient(config, parsed, dependencies);
  const result = await client.request<DemoSqlResult>("POST", `/envs/${encodeURIComponent(envId)}/sql`, { sql });
  printPreviewSqlResult(dependencies, result, boolFlag(parsed, "json"));
}

async function runTest(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  const input = testInputFromArgs(parsed);
  const client = envApiClient(config, parsed, dependencies);
  let summary = await client.request<EnvApiTestRunSummary>(
    "POST",
    `/envs/${encodeURIComponent(input.envId)}/test-runs`,
    buildAnboTestRunRequest(input)
  );
  if (input.wait) {
    summary = await waitForTestRunState(
      client,
      input.envId,
      summary.runId,
      input.timeoutSeconds,
      input.pollIntervalMs,
      (status) => TEST_RUN_TERMINAL_STATES.has(status),
      input.json ? undefined : testRunWaitProgressReporter(dependencies)
    );
  }
  printTestRunSummary(dependencies, summary, input.json);
  if (input.wait && TEST_RUN_FAILURE_STATES.has(summary.status)) {
    throw new Error(testRunFailureMessage(summary));
  }
}

async function runTestStatus(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  const input = testStatusInputFromArgs(parsed);
  const client = envApiClient(config, parsed, dependencies);
  const summary = await client.request<EnvApiTestRunSummary>(
    "GET",
    `/envs/${encodeURIComponent(input.envId)}/test-runs/${encodeURIComponent(input.runId)}`
  );
  printTestRunSummary(dependencies, summary, input.json);
  if (TEST_RUN_FAILURE_STATES.has(summary.status)) {
    throw new Error(testRunFailureMessage(summary));
  }
}

async function runLogs(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  const input = logsInputFromArgs(parsed);
  const client = envApiClient(config, parsed, dependencies);
  const logs = await client.request<EnvApiTestRunLogs>(
    "GET",
    `/envs/${encodeURIComponent(input.envId)}/test-runs/${encodeURIComponent(input.runId)}/logs`
  );
  printTestRunLogs(dependencies, withTail(logs, input.tail), input.json);
}

async function runReport(parsed: ParsedArgs, dependencies: AnboCliDependencies): Promise<void> {
  const config = readRepoConfig(dependencies);
  const runId = stringFlag(parsed, "test-run");
  if (isPreviewConfig(config) && runId === undefined) {
    const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
    const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
    const branchName = requiredPositional(parsed, 0, "branch name or id");
    const report = await previewApiRequest<unknown>(
      dependencies,
      previewUrl,
      "GET",
      `/v1/branches/${encodeURIComponent(branchName)}/report`,
      undefined,
      token
    );
    writeJsonReport(dependencies, report, stringFlag(parsed, "out"));
    return;
  }
  if (runId === undefined) {
    const envId = requiredPositional(parsed, 0, "env_id");
    const client = envApiClient(config, parsed, dependencies);
    const summary = await client.request<EnvApiEnvironmentSummary>(
      "GET",
      `/envs/${encodeURIComponent(envId)}`
    );
    writeJsonReport(
      dependencies,
      buildEnvironmentUsageReport(summary, config, dependencies.now?.() ?? new Date()),
      stringFlag(parsed, "out")
    );
    return;
  }
  const input = reportInputFromArgs(parsed);
  const client = envApiClient(config, parsed, dependencies);
  const report = await client.request<EnvApiTestRunReport>(
    "GET",
    `/envs/${encodeURIComponent(input.envId)}/test-runs/${encodeURIComponent(input.runId)}/report`
  );
  writeJsonReport(dependencies, report, input.out);
  writeOut(dependencies, `status: ${report.summary.status}`);
  if (report.summary.failedJob !== undefined) {
    writeOut(dependencies, `failed_job: ${report.summary.failedJob}`);
  }
}

function writeJsonReport(dependencies: AnboCliDependencies, report: unknown, out: string | undefined): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out === undefined) {
    writeOut(dependencies, JSON.stringify(redactJsonSecrets(report), null, 2));
    return;
  }
  const outPath = resolve(dependencies.cwd ?? process.cwd(), out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  writeOut(dependencies, `wrote ${outPath}`);
}

function buildEnvironmentUsageReport(
  summary: EnvApiEnvironmentSummary,
  config: AnboCliRepoConfig,
  generatedAt: Date
): JsonRecord {
  const generatedAtIso = generatedAt.toISOString();
  const startedAt = earliestIso([
    summary.timings?.sourceCheckStartedAt,
    summary.timings?.branchRequestedAt,
    summary.timings?.readyForFirstTestAt
  ]) ?? generatedAtIso;
  const branchStartedAt = summary.timings?.branchRequestedAt ?? startedAt;
  const branchReadyAt = summary.branch?.readyAt ?? summary.timings?.branchReadyObservedAt ?? null;
  return {
    schema_version: 1,
    type: "anbo_preview_environment_usage",
    generated_at: generatedAtIso,
    env_id: summary.envId,
    project_id: config.project,
    source: config.source,
    status: summary.state,
    preview_url: summary.previewUrl ?? `${config.routeBaseUrl.replace(/\/+$/, "")}/e/${summary.envId}`,
    branch: {
      allocation: summary.branch?.allocation ?? null,
      prepared_branch_name: summary.branch?.preparedBranchName ?? null,
      base_snapshot: summary.branch?.baseSnapshot ?? null,
      base_lsn: summary.branch?.baseLsn ?? null,
      ready_at: branchReadyAt,
      ready_observation_lag_ms: summary.branch?.branchReadyObservationLagMs ?? null
    },
    usage: {
      env_runtime_seconds: secondsBetween(startedAt, generatedAtIso),
      branch_runtime_seconds: secondsBetween(branchStartedAt, generatedAtIso),
      sql_query_count: null,
      sql_failed_count: null,
      sql_row_count: null
    },
    telemetry: {
      deploy_env: summary.runtime?.deployEnv ?? null,
      isolation_mode: summary.runtime?.isolationMode ?? null,
      sqs_endpoint_configured: summary.runtime?.sqsEndpointConfigured ?? null,
      timings: summary.timings ?? {},
      raw_env_api_sql_counts_tracked: false,
      hosted_preview_sql_counts_tracked: true
    }
  };
}

function earliestIso(values: readonly (string | undefined)[]): string | undefined {
  let earliest: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms < earliestMs) {
      earliest = value;
      earliestMs = ms;
    }
  }
  return earliest;
}

function secondsBetween(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  return Math.round((endMs - startMs) / 1000);
}

function createInputFromArgs(parsed: ParsedArgs, config: AnboCliRepoConfig): CreateInput {
  if (boolFlag(parsed, "fresh") && boolFlag(parsed, "pool-preferred")) {
    throw new Error("--fresh and --pool-preferred cannot be used together");
  }
  const allocation = boolFlag(parsed, "fresh")
    ? "fresh_required"
    : boolFlag(parsed, "pool-preferred")
      ? "pool_preferred"
      : config.defaults.allocation;
  return {
    image: requiredFlag(parsed, "image"),
    sha: requiredFlag(parsed, "sha"),
    ...(stringFlag(parsed, "env-id") === undefined ? {} : { envId: stringFlag(parsed, "env-id")! }),
    ...(stringFlag(parsed, "source") === undefined ? {} : { source: stringFlag(parsed, "source")! }),
    ...(stringFlag(parsed, "snapshot") === undefined ? {} : { snapshot: stringFlag(parsed, "snapshot")! }),
    ...(stringFlag(parsed, "ttl") === undefined ? {} : { ttl: stringFlag(parsed, "ttl")! }),
    allocation,
    wait: !boolFlag(parsed, "no-wait"),
    json: boolFlag(parsed, "json"),
    timeoutSeconds: positiveIntFlag(parsed, "timeout-seconds", 300),
    pollIntervalMs: positiveIntFlag(parsed, "poll-interval-ms", 1000)
  };
}

function testInputFromArgs(parsed: ParsedArgs): TestInput {
  const type = testTypeFromFlag(stringFlag(parsed, "type") ?? "test");
  return {
    envId: requiredPositional(parsed, 0, "env_id"),
    type,
    execution: boolFlag(parsed, "external") ? "external" : "cluster_job",
    image: requiredFlag(parsed, "image"),
    command: parsed.afterDoubleDash.length > 0 ? parsed.afterDoubleDash : commandFromFlag(parsed),
    shards: positiveIntFlag(parsed, "shards", 1),
    timeoutSeconds: positiveIntFlag(parsed, "timeout-seconds", 900),
    wait: boolFlag(parsed, "wait"),
    pollIntervalMs: positiveIntFlag(parsed, "poll-interval-ms", 1000),
    json: boolFlag(parsed, "json")
  };
}

function testStatusInputFromArgs(parsed: ParsedArgs): TestStatusInput {
  return {
    envId: requiredPositional(parsed, 0, "env_id"),
    runId: requiredPositional(parsed, 1, "run_id"),
    json: boolFlag(parsed, "json")
  };
}

function logsInputFromArgs(parsed: ParsedArgs): LogsInput {
  const tail = stringFlag(parsed, "tail");
  return {
    envId: requiredPositional(parsed, 0, "env_id"),
    runId: requiredFlag(parsed, "test-run"),
    ...(tail === undefined ? {} : { tail: positiveIntFromRaw(tail, "tail") }),
    json: boolFlag(parsed, "json")
  };
}

function reportInputFromArgs(parsed: ParsedArgs): ReportInput {
  const out = stringFlag(parsed, "out");
  return {
    envId: requiredPositional(parsed, 0, "env_id"),
    runId: requiredFlag(parsed, "test-run"),
    ...(out === undefined ? {} : { out })
  };
}

function destroyInputFromArgs(parsed: ParsedArgs): DestroyInput {
  return {
    envId: requiredPositional(parsed, 0, "env_id"),
    wait: boolFlag(parsed, "wait"),
    json: boolFlag(parsed, "json"),
    timeoutSeconds: positiveIntFlag(parsed, "timeout-seconds", 300),
    pollIntervalMs: positiveIntFlag(parsed, "poll-interval-ms", 1000)
  };
}

function isPreviewConfig(config: AnboCliRepoConfig): boolean {
  return config.mode === "demo";
}

function previewApiUrlFromConfig(
  parsed: ParsedArgs,
  dependencies: AnboCliDependencies,
  config: AnboCliRepoConfig
): string {
  return apiBaseUrlFromUrl(stringFlag(parsed, "api-url")
    ?? stringFlag(parsed, "preview-api-url")
    ?? stringFlag(parsed, "app-url")
    ?? stringFlag(parsed, "demo-url")
    ?? dependencies.env?.ANBO_PREVIEW_API_URL
    ?? dependencies.env?.ANBO_APP_URL
    ?? dependencies.env?.ANBO_DEMO_API_URL
    ?? config.apiUrl
    ?? DEFAULT_PREVIEW_API_URL, "Preview API URL");
}

function previewApiUrlFromArgs(parsed: ParsedArgs, dependencies: AnboCliDependencies): string {
  return apiBaseUrlFromUrl(stringFlag(parsed, "api-url")
    ?? stringFlag(parsed, "preview-api-url")
    ?? stringFlag(parsed, "app-url")
    ?? stringFlag(parsed, "demo-url")
    ?? dependencies.env?.ANBO_PREVIEW_API_URL
    ?? dependencies.env?.ANBO_APP_URL
    ?? dependencies.env?.ANBO_DEMO_API_URL
    ?? dependencies.env?.ANBO_K8_DEMO_API_URL
    ?? DEFAULT_PREVIEW_API_URL, "Preview API URL");
}

function previewTokenFromArgs(parsed: ParsedArgs, dependencies: AnboCliDependencies, previewUrl: string): string {
  const token = stringFlag(parsed, "token")
    ?? dependencies.env?.ANBO_TOKEN
    ?? dependencies.env?.ANBO_PREVIEW_API_TOKEN
    ?? dependencies.env?.ANBO_DEMO_API_TOKEN
    ?? readPreviewCredential(dependencies, previewUrl)?.token;
  if (token === undefined || token.length === 0) {
    throw new Error(`Anbo credentials are required; run ${loginCommandHint(previewUrl)}`);
  }
  return token;
}

function loginCommandHint(previewUrl: string): string {
  return previewUrl === DEFAULT_PREVIEW_API_URL
    ? "anbo login"
    : `anbo login --app-url ${previewUrl}`;
}

async function previewApiRequest<T>(
  dependencies: AnboCliDependencies,
  previewUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  const response = await previewApiRequestOrError<T>(dependencies, previewUrl, method, path, body, token, options);
  if (!response.ok) {
    throw new Error(`${method} ${path} failed ${response.status}: ${response.message}`);
  }
  return response.body;
}

async function previewApiRequestOrError<T>(
  dependencies: AnboCliDependencies,
  previewUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  options: { timeoutMs?: number } = {}
): Promise<{ ok: true; body: T } | { ok: false; status: number; message: string }> {
  const headers: Record<string, string> = {
    accept: "application/json"
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${previewUrl}${path}`, {
    method,
    headers,
    ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        status: response.status,
        message: text.replace(/\s+/g, " ").trim().slice(0, 500) || `non-JSON response from ${previewUrl}${path}`
      };
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: errorMessageFromBody(parsed, text)
    };
  }
  return { ok: true, body: parsed as T };
}

function envApiClient(config: AnboCliRepoConfig, parsed: ParsedArgs, dependencies: AnboCliDependencies): {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
} {
  const apiUrl = apiBaseUrlFromUrl(stringFlag(parsed, "api-url")
    ?? dependencies.env?.ANBO_ENV_API_URL
    ?? dependencies.env?.ANBO_K8S_ENV_API_URL
    ?? config.apiUrl, "Env API URL");
  const token = stringFlag(parsed, "token")
    ?? dependencies.env?.ANBO_ENV_API_TOKEN
    ?? dependencies.env?.ANBO_K8S_ENV_API_TOKEN
    ?? readCredential(dependencies, apiUrl);
  if (token === undefined || token.length === 0) {
    throw new Error("Env API token is required; set ANBO_ENV_API_TOKEN or run anbo setup --token <token>");
  }
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      const response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 500)}`);
      }
      return (text.length === 0 ? {} : JSON.parse(text)) as T;
    }
  };
}

async function waitForEnvState(
  client: { request: <T>(method: string, path: string, body?: unknown) => Promise<T> },
  envId: string,
  timeoutSeconds: number,
  pollIntervalMs: number,
  done: (state: AnboK8sEnvironmentStatus) => boolean,
  onProgress?: (summary: EnvApiEnvironmentSummary, elapsedMs: number) => void
): Promise<EnvApiEnvironmentSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  let latest: EnvApiEnvironmentSummary | undefined;
  while (Date.now() < deadline) {
    latest = await client.request<EnvApiEnvironmentSummary>("GET", `/envs/${encodeURIComponent(envId)}`);
    if (done(latest.state)) {
      return latest;
    }
    onProgress?.(latest, Date.now() - startedAt);
    await sleep(pollIntervalMs);
  }
  throw new Error(`timed out waiting for ${envId}; latest state was ${latest?.state ?? "unknown"}`);
}

async function waitForTestRunState(
  client: { request: <T>(method: string, path: string, body?: unknown) => Promise<T> },
  envId: string,
  runId: string,
  timeoutSeconds: number,
  pollIntervalMs: number,
  done: (status: EnvApiTestRunStatus) => boolean,
  onProgress?: (summary: EnvApiTestRunSummary, elapsedMs: number) => void
): Promise<EnvApiTestRunSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  let latest: EnvApiTestRunSummary | undefined;
  while (Date.now() < deadline) {
    latest = await client.request<EnvApiTestRunSummary>(
      "GET",
      `/envs/${encodeURIComponent(envId)}/test-runs/${encodeURIComponent(runId)}`
    );
    if (done(latest.status)) {
      return latest;
    }
    onProgress?.(latest, Date.now() - startedAt);
    await sleep(pollIntervalMs);
  }
  throw new Error(`timed out waiting for test-run ${runId} in ${envId}; latest status was ${latest?.status ?? "unknown"}`);
}

function readRepoConfig(dependencies: AnboCliDependencies): AnboCliRepoConfig {
  const cwd = dependencies.cwd ?? process.cwd();
  const path = resolve(cwd, CONFIG_PATH);
  if (!existsSync(path)) {
    throw new Error(`${CONFIG_PATH} not found; run anbo setup first`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return assertRepoConfig(parsed);
}

function readCredentials(dependencies: AnboCliDependencies): AnboCliCredentials {
  const path = credentialsPath(dependencies);
  if (!existsSync(path)) {
    return { version: 1, endpoints: {} };
  }
  return assertCredentials(JSON.parse(readFileSync(path, "utf8")));
}

function writeCredentials(dependencies: AnboCliDependencies, credentials: AnboCliCredentials): void {
  const path = credentialsPath(dependencies);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to write Anbo credentials through a symlink: ${path}`);
  }
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeRepoConfig(cwd: string, config: AnboCliRepoConfig): void {
  const path = resolve(cwd, CONFIG_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readCredential(dependencies: AnboCliDependencies, apiUrl: string): string | undefined {
  const credentials = readCredentials(dependencies);
  return credentials.endpoints[apiUrl]?.token;
}

function writeCredential(dependencies: AnboCliDependencies, apiUrl: string, token: string): void {
  const existing = readCredentials(dependencies);
  existing.endpoints[apiUrl] = { token };
  writeCredentials(dependencies, existing);
}

function readPreviewCredential(dependencies: AnboCliDependencies, previewUrl: string): { token: string; activeSessionId?: string } | undefined {
  const credentials = readCredentials(dependencies);
  return credentials.previewEndpoints?.[previewUrl] ?? credentials.demoEndpoints?.[previewUrl];
}

function writePreviewCredential(dependencies: AnboCliDependencies, previewUrl: string, token: string): void {
  const credentials = readCredentials(dependencies);
  const existing = credentials.previewEndpoints?.[previewUrl] ?? credentials.demoEndpoints?.[previewUrl];
  credentials.previewEndpoints ??= {};
  credentials.previewEndpoints[previewUrl] = {
    token,
    ...(existing?.activeSessionId === undefined ? {} : { activeSessionId: existing.activeSessionId })
  };
  writeCredentials(dependencies, credentials);
}

function deletePreviewCredential(dependencies: AnboCliDependencies, previewUrl: string): void {
  const credentials = readCredentials(dependencies);
  if (credentials.previewEndpoints !== undefined) {
    delete credentials.previewEndpoints[previewUrl];
  }
  if (credentials.demoEndpoints !== undefined) {
    delete credentials.demoEndpoints[previewUrl];
  }
  writeCredentials(dependencies, credentials);
}

function credentialsPath(dependencies: AnboCliDependencies): string {
  const env = dependencies.env ?? process.env;
  if ((dependencies.platform ?? process.platform) === "win32") {
    const windowsConfigRoot = env.APPDATA?.trim() || env.LOCALAPPDATA?.trim() || env.USERPROFILE?.trim();
    if (windowsConfigRoot) {
      return join(windowsConfigRoot, "anbo", "credentials.json");
    }
  }
  const homeDir = dependencies.homeDir ?? env.HOME;
  if (homeDir === undefined || homeDir.trim().length === 0) {
    throw new Error("Cannot determine Anbo credentials directory; set HOME or pass a platform config directory");
  }
  return join(homeDir, ".config", "anbo", "credentials.json");
}

function assertRepoConfig(value: unknown): AnboCliRepoConfig {
  if (!isRecord(value) || value["version"] !== 1) {
    throw new Error(`${CONFIG_PATH} must contain an Anbo CLI config with version 1`);
  }
  const config = value as Partial<AnboCliRepoConfig>;
  if (config.mode === "preview") {
    throw new Error(
      `${CONFIG_PATH} uses removed legacy preview mode; run anbo setup postgres --demo or anbo setup dynamodb --demo`
    );
  }
  for (const key of ["apiUrl", "project", "routeBaseUrl"] as const) {
    if (typeof config[key] !== "string" || config[key].length === 0) {
      throw new Error(`${CONFIG_PATH} is missing ${key}`);
    }
  }
  if (config.source !== undefined && (typeof config.source !== "string" || config.source.length === 0)) {
    throw new Error(`${CONFIG_PATH} source must be a non-empty string`);
  }
  if (!isRecord(config.repo) || typeof config.repo["name"] !== "string" || config.repo["name"].length === 0) {
    throw new Error(`${CONFIG_PATH} is missing repo.name`);
  }
  if (!isRecord(config.s3)) {
    throw new Error(`${CONFIG_PATH} is missing s3 config`);
  }
  if (!isRecord(config.defaults)) {
    throw new Error(`${CONFIG_PATH} is missing defaults`);
  }
  if (config.defaults["dynamodbLink"] !== undefined &&
      (typeof config.defaults["dynamodbLink"] !== "string" || config.defaults["dynamodbLink"].length === 0)) {
    throw new Error(`${CONFIG_PATH} defaults.dynamodbLink must be a non-empty string`);
  }
  if (config.sources !== undefined) {
    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      throw new Error(`${CONFIG_PATH} sources must be a non-empty array`);
    }
    for (const source of config.sources) {
      if (!isRecord(source) || (source["type"] !== "postgres" && source["type"] !== "dynamodb") ||
          typeof source["link"] !== "string" || source["link"].length === 0) {
        throw new Error(`${CONFIG_PATH} contains an invalid database source`);
      }
      if (source["type"] === "postgres" && source["snapshotRef"] !== undefined &&
          (typeof source["snapshotRef"] !== "string" || source["snapshotRef"].length === 0)) {
        throw new Error(`${CONFIG_PATH} contains an invalid PostgreSQL source`);
      }
      if (source["type"] === "dynamodb") {
        if (source["region"] !== undefined && (typeof source["region"] !== "string" || source["region"].length === 0)) {
          throw new Error(`${CONFIG_PATH} contains an invalid DynamoDB source region`);
        }
        if (source["logicalTables"] !== undefined && (!Array.isArray(source["logicalTables"]) ||
            !source["logicalTables"].every((table) => typeof table === "string" && table.length > 0))) {
          throw new Error(`${CONFIG_PATH} contains invalid DynamoDB source tables`);
        }
        if (source["supportedApiLevel"] !== undefined &&
            (typeof source["supportedApiLevel"] !== "string" || source["supportedApiLevel"].length === 0)) {
          throw new Error(`${CONFIG_PATH} contains an invalid DynamoDB source API level`);
        }
      }
    }
    assertUniqueConfiguredSources(config.sources as AnboCliConfiguredSource[]);
  }
  if (config.databaseLinks !== undefined) {
    if (!isRecord(config.databaseLinks) || typeof config.databaseLinks["checkedAt"] !== "string") {
      throw new Error(`${CONFIG_PATH} databaseLinks must contain a checkedAt timestamp`);
    }
    const postgres = config.databaseLinks["postgres"];
    if (postgres !== undefined && (!isRecord(postgres) || typeof postgres["link"] !== "string" ||
        typeof postgres["snapshotRef"] !== "string")) {
      throw new Error(`${CONFIG_PATH} databaseLinks.postgres is invalid`);
    }
    const dynamodb = config.databaseLinks["dynamodb"];
    if (dynamodb !== undefined && (!isRecord(dynamodb) || typeof dynamodb["link"] !== "string" ||
        typeof dynamodb["region"] !== "string" || typeof dynamodb["supportedApiLevel"] !== "string" ||
        !Array.isArray(dynamodb["logicalTables"]) ||
        !dynamodb["logicalTables"].every((table) => typeof table === "string" && table.length > 0))) {
      throw new Error(`${CONFIG_PATH} databaseLinks.dynamodb is invalid`);
    }
  }
  if (!isPreviewConfig(config as AnboCliRepoConfig) && config.source === undefined) {
    throw new Error(`${CONFIG_PATH} is missing source`);
  }
  return value as AnboCliRepoConfig;
}

function assertDemoDatabaseLinksPreflight(value: unknown): DemoApiDatabaseLinksPreflight {
  if (!isRecord(value) || value["version"] !== 1 || typeof value["checked_at"] !== "string" ||
      typeof value["ready"] !== "boolean" || !isRecord(value["defaults"]) ||
      !Array.isArray(value["postgres"]) || !Array.isArray(value["dynamodb"])) {
    throw new Error("GET /v1/database-links returned an invalid preflight response");
  }
  if (value["type"] !== undefined && value["type"] !== "postgres" && value["type"] !== "dynamodb") {
    throw new Error("GET /v1/database-links returned an invalid source type");
  }
  const defaults = value["defaults"];
  if (defaults["postgres_link"] !== undefined && typeof defaults["postgres_link"] !== "string") {
    throw new Error("GET /v1/database-links returned an invalid PostgreSQL default");
  }
  if (defaults["dynamodb_link"] !== undefined && typeof defaults["dynamodb_link"] !== "string") {
    throw new Error("GET /v1/database-links returned an invalid DynamoDB default");
  }
  for (const entry of value["postgres"]) {
    if (!isRecord(entry) || typeof entry["link"] !== "string" || typeof entry["ready"] !== "boolean" ||
        typeof entry["source_check_ok"] !== "boolean" || typeof entry["snapshot_ref"] !== "string" ||
        (entry["snapshot_id"] !== null && typeof entry["snapshot_id"] !== "string") ||
        typeof entry["snapshot_ready"] !== "boolean" ||
        (entry["replica_lag_seconds"] !== null && typeof entry["replica_lag_seconds"] !== "number") ||
        (entry["message"] !== null && typeof entry["message"] !== "string")) {
      throw new Error("GET /v1/database-links returned an invalid PostgreSQL link");
    }
  }
  for (const entry of value["dynamodb"]) {
    if (!isRecord(entry) || typeof entry["link"] !== "string" || typeof entry["ready"] !== "boolean" ||
        typeof entry["mirror_ref"] !== "string" ||
        (entry["phase"] !== null && typeof entry["phase"] !== "string") ||
        (entry["lag_seconds"] !== null && typeof entry["lag_seconds"] !== "number") ||
        typeof entry["region"] !== "string" || !Array.isArray(entry["logical_tables"]) ||
        !entry["logical_tables"].every((table) => typeof table === "string" && table.length > 0) ||
        typeof entry["supported_api_level"] !== "string" || typeof entry["snapshot_ready"] !== "boolean" ||
        typeof entry["gateway_ready"] !== "boolean" ||
        (entry["last_checkpoint_at"] !== null && typeof entry["last_checkpoint_at"] !== "string") ||
        (entry["message"] !== null && typeof entry["message"] !== "string")) {
      throw new Error("GET /v1/database-links returned an invalid DynamoDB link");
    }
  }
  const result = value as DemoApiDatabaseLinksPreflight;
  if (result.defaults.postgres_link !== undefined &&
      !result.postgres.some((entry) => entry.link === result.defaults.postgres_link)) {
    throw new Error("GET /v1/database-links PostgreSQL default does not resolve to an advertised link");
  }
  if (result.defaults.dynamodb_link !== undefined &&
      !result.dynamodb.some((entry) => entry.link === result.defaults.dynamodb_link)) {
    throw new Error("GET /v1/database-links DynamoDB default does not resolve to an advertised link");
  }
  return result;
}

function printDatabaseLinksPreflight(
  dependencies: AnboCliDependencies,
  preflight: DemoApiDatabaseLinksPreflight,
  engine: "postgres" | "dynamodb"
): void {
  if (engine === "postgres") {
    for (const postgres of preflight.postgres) {
      writeOut(
        dependencies,
        `PostgreSQL  ${postgres.link}  ${postgres.ready ? "ready" : "not ready"}` +
          `  snapshot=${postgres.snapshot_ref}${postgres.message === null ? "" : `  ${postgres.message}`}`
      );
    }
    return;
  }
  for (const dynamodb of preflight.dynamodb) {
    writeOut(
      dependencies,
      `DynamoDB    ${dynamodb.link}  ${dynamodb.ready ? "ready" : "not ready"}` +
        `  ${dynamodb.logical_tables.join(",")}  ${dynamodb.region}  ${dynamodb.supported_api_level}` +
        `${dynamodb.message === null ? "" : `  ${dynamodb.message}`}`
    );
  }
}

function databaseLinksPreflightFailure(
  preflight: DemoApiDatabaseLinksPreflight,
  engine: "postgres" | "dynamodb"
): string {
  const failures = engine === "postgres"
    ? preflight.postgres.filter((entry) => !entry.ready)
        .map((entry) => `PostgreSQL ${entry.link}: ${entry.message ?? "not ready"}`)
    : preflight.dynamodb.filter((entry) => !entry.ready)
        .map((entry) => `DynamoDB ${entry.link}: ${entry.message ?? "not ready"}`);
  return `${databaseTypeLabel(engine)} preflight failed; ` +
    `${failures.join("; ") || "the server did not advertise a ready source"}`;
}

function assertCredentials(value: unknown): AnboCliCredentials {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["endpoints"])) {
    throw new Error(`${credentialsPath({})} must contain Anbo CLI credentials with version 1`);
  }
  return value as AnboCliCredentials;
}

async function requiredSetupValue(
  parsed: ParsedArgs,
  dependencies: AnboCliDependencies,
  flag: string,
  label: string,
  fallback?: string
): Promise<string> {
  const value = stringFlag(parsed, flag) ?? fallback;
  if (value !== undefined && value.length > 0) {
    return value;
  }
  if (dependencies.prompt !== undefined) {
    const prompted = await dependencies.prompt(label);
    if (prompted.trim().length > 0) {
      return prompted.trim();
    }
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      const prompted = await readline.question(`${label}: `);
      if (prompted.trim().length > 0) {
        return prompted.trim();
      }
    } finally {
      readline.close();
    }
  }
  throw new Error(`--${flag} is required for anbo setup`);
}

function parseArgs(args: string[]): ParsedArgs {
  const separator = args.indexOf("--");
  const before = separator === -1 ? args : args.slice(0, separator);
  const afterDoubleDash = separator === -1 ? [] : args.slice(separator + 1);
  const [command, ...rest] = before;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    if (raw.includes("=")) {
      const [key, value] = raw.split(/=(.*)/s, 2);
      if (key !== undefined && key.length > 0) {
        flags[key] = value ?? "";
      }
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[raw] = next;
      index += 1;
    } else {
      flags[raw] = true;
    }
  }
  return {
    ...(command === undefined ? {} : { command }),
    positional,
    flags,
    afterDoubleDash
  };
}

function withoutFirstPositional(parsed: ParsedArgs): ParsedArgs {
  return {
    ...parsed,
    positional: parsed.positional.slice(1)
  };
}

function detectRepo(cwd: string): { name: string; remoteUrl?: string } {
  const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 3000
  });
  const root = rootResult.status === 0 ? rootResult.stdout.trim() : cwd;
  const remoteResult = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 3000
  });
  const remoteUrl = remoteResult.status === 0 ? remoteResult.stdout.trim() : undefined;
  return {
    name: safeSegment(basename(root), "repo"),
    ...(remoteUrl === undefined || remoteUrl.length === 0 ? {} : { remoteUrl })
  };
}

function defaultEnvId(project: string, sha: string): string {
  const candidate = `env-${safeSegment(project, "project")}-${safeSegment(sha, "sha")}`;
  if (candidate.length <= 54 && /^env-[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/.test(candidate)) {
    return candidate;
  }
  return `env-${safeSegment(project, "project").slice(0, 24)}-${hashText(`${project}:${sha}`).slice(0, 12)}`;
}

function normalizeS3Prefix(value: string): string {
  const normalized = value.replace(/^\/+/, "");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requiredPositional(parsed: ParsedArgs, index: number, label: string): string {
  const value = parsed.positional[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || parsed.flags[name] === "true";
}

function positiveIntFlag(parsed: ParsedArgs, name: string, fallback: number): number {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) {
    return fallback;
  }
  return positiveIntFromRaw(raw, name);
}

function positiveIntFromRaw(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function allocationFromFlag(value: string): AnboK8sBranchAllocation {
  if (!VALID_ALLOCATIONS.has(value as AnboK8sBranchAllocation)) {
    throw new Error(`allocation must be one of ${Array.from(VALID_ALLOCATIONS).join(", ")}`);
  }
  return value as AnboK8sBranchAllocation;
}

function testTypeFromFlag(value: string): EnvApiTestRunType {
  if (!VALID_TEST_TYPES.has(value as EnvApiTestRunType)) {
    throw new Error(`--type must be one of ${Array.from(VALID_TEST_TYPES).join(", ")}`);
  }
  return value as EnvApiTestRunType;
}

function commandFromFlag(parsed: ParsedArgs): string[] {
  const command = stringFlag(parsed, "command");
  if (command === undefined || command.length === 0) {
    throw new Error("test command is required after --, for example: anbo test env-id --image repo/app:tag -- npm test");
  }
  return command.split(" ").filter((part) => part.length > 0);
}

function printEnvironmentSummary(dependencies: AnboCliDependencies, summary: EnvApiEnvironmentSummary, json: boolean): void {
  if (json) {
    writeOut(dependencies, JSON.stringify(summary, null, 2));
    return;
  }
  writeOut(dependencies, `env_id: ${summary.envId}`);
  writeOut(dependencies, `state: ${summary.state}`);
  const readyDuration = readyForFirstTestDuration(summary);
  if (readyDuration !== undefined) {
    writeOut(dependencies, `ready_for_first_test: ${readyDuration}`);
  }
  if (summary.previewUrl !== undefined) {
    writeOut(dependencies, `preview_url: ${summary.previewUrl}`);
  }
  if (summary.branch?.allocation !== undefined) {
    writeOut(dependencies, `allocation: ${summary.branch.allocation}`);
  }
  if (summary.branch?.baseSnapshot !== undefined) {
    writeOut(dependencies, `base_snapshot: ${summary.branch.baseSnapshot}`);
  }
}

function printTestRunSummary(dependencies: AnboCliDependencies, summary: EnvApiTestRunSummary, json: boolean): void {
  if (json) {
    writeOut(dependencies, JSON.stringify(redactJsonSecrets(summary), null, 2));
    return;
  }
  writeOut(dependencies, `env_id: ${summary.envId}`);
  writeOut(dependencies, `run_id: ${summary.runId}`);
  writeOut(dependencies, `status: ${summary.status}`);
  writeOut(dependencies, `execution: ${summary.execution}`);
  const duration = testRunDuration(summary);
  if (duration !== undefined) {
    writeOut(dependencies, `duration: ${duration}`);
  }
  if (summary.jobs !== undefined && summary.jobs.length > 0) {
    writeOut(dependencies, `jobs: ${summary.jobs.map((job) => `${job.name}=${job.status}`).join(", ")}`);
  } else if (summary.jobNames !== undefined && summary.jobNames.length > 0) {
    writeOut(dependencies, `jobs: ${summary.jobNames.join(", ")}`);
  }
  if (summary.failedJob !== undefined) {
    writeOut(dependencies, `failed_job: ${summary.failedJob}`);
  }
  if (summary.reason !== undefined) {
    writeOut(dependencies, `reason: ${summary.reason}`);
  }
  if (summary.message !== undefined) {
    writeOut(dependencies, `message: ${summary.message}`);
  }
  if (summary.external?.databaseUrlSecretRef !== undefined) {
    writeOut(dependencies, `database_url_secret: ${summary.external.databaseUrlSecretRef}`);
  }
  if (summary.logTail !== undefined && summary.logTail.length > 0) {
    writeOut(dependencies, "log_tail:");
    for (const line of summary.logTail.slice(-20)) {
      writeOut(dependencies, `  ${redactSensitiveText(line)}`);
    }
  }
}

function printTestRunLogs(dependencies: AnboCliDependencies, logs: EnvApiTestRunLogs, json: boolean): void {
  if (json) {
    writeOut(dependencies, JSON.stringify(redactJsonSecrets(logs), null, 2));
    return;
  }
  writeOut(dependencies, `env_id: ${logs.envId}`);
  writeOut(dependencies, `run_id: ${logs.runId}`);
  writeOut(dependencies, `status: ${logs.status}`);
  for (const entry of logs.entries) {
    const pod = entry.podName === undefined ? "" : ` pod=${entry.podName}`;
    const container = entry.container === undefined ? "" : ` container=${entry.container}`;
    writeOut(dependencies, `--- job=${entry.jobName}${pod}${container}`);
    for (const line of entry.text.split(/\r?\n/)) {
      writeOut(dependencies, redactSensitiveText(line));
    }
  }
}

function printDemoBranch(dependencies: AnboCliDependencies, branch: DemoApiBranch, json: boolean, showSecrets = false): void {
  if (json) {
    writeOut(dependencies, JSON.stringify(showSecrets ? branch : redactJsonSecrets(branch), null, 2));
    return;
  }
  writeOut(dependencies, `branch_id: ${branch.id}`);
  writeOut(dependencies, `name: ${branch.name}`);
  if (branch.source !== undefined) {
    writeOut(dependencies, `source: ${databaseTypeLabel(branch.source.type)} ${branch.source.link}`);
  }
  writeOut(dependencies, `status: ${branch.status}`);
  if (branch.state !== undefined && branch.state !== null) {
    writeOut(dependencies, `state: ${branch.state}`);
  }
  writeOut(dependencies, `ready: ${branch.ready ? "true" : "false"}`);
  if (branch.database_url !== null) {
    writeOut(dependencies, showSecrets ? `database_url: ${branch.database_url}` : "database_url: [redacted; use anbo branch url NAME]");
  }
  if (branch.dynamodb !== undefined) {
    writeOut(dependencies, `dynamodb_link: ${branch.dynamodb.link}`);
    writeOut(dependencies, `dynamodb_phase: ${branch.dynamodb.phase ?? "pending"}`);
    writeOut(dependencies, `dynamodb_region: ${branch.dynamodb.region}`);
    writeOut(dependencies, `dynamodb_api_level: ${branch.dynamodb.supported_api_level}`);
    if (branch.dynamodb.endpoint !== null) {
      writeOut(dependencies, `dynamodb_endpoint: ${branch.dynamodb.endpoint}`);
    }
  }
  if (branch.message !== undefined && branch.message !== null) {
    writeOut(dependencies, `message: ${branch.message}`);
  }
}

function printDemoBranchCreateResult(
  dependencies: AnboCliDependencies,
  branch: DemoApiBranch,
  connection: DemoBranchConnection | undefined,
  json: boolean,
  showCredentials: boolean
): void {
  const result: DemoBranchCreateResult = {
    ...branch,
    ...(connection?.type === "postgres" ? { database_url: connection.database_url } : {}),
    ...(connection === undefined ? {} : { connection })
  };
  if (json) {
    writeOut(dependencies, JSON.stringify(showCredentials ? result : redactJsonSecrets(result), null, 2));
    return;
  }

  printDemoBranch(dependencies, result, false, showCredentials);
  if (connection === undefined) {
    writeOut(
      dependencies,
      branch.ready
        ? "connection: omitted; request it with anbo branch url NAME or anbo branch credentials NAME"
        : "connection: pending; request it after the branch is ready"
    );
    return;
  }

  writeOut(dependencies, `connection_type: ${connection.type}`);
  if (connection.type === "postgres") {
    if (connection.expires_at !== undefined) {
      writeOut(dependencies, `credential_expires_at: ${connection.expires_at}`);
    }
    writeOut(dependencies, "connection_environment:");
    writeOut(dependencies, `  export DATABASE_URL=${shellQuote(connection.database_url)}`);
    return;
  }

  writeOut(dependencies, `credential_expires_at: ${connection.expires_at}`);
  writeOut(dependencies, `dynamodb_tables: ${connection.tables.join(",")}`);
  writeOut(dependencies, "connection_environment:");
  for (const [key, value] of Object.entries(connection.environment)) {
    writeOut(dependencies, `  export ${key}=${shellQuote(value)}`);
  }
}

function printDemoBranchList(dependencies: AnboCliDependencies, result: DemoApiBranchList, json: boolean, showSecrets = false): void {
  if (json) {
    writeOut(dependencies, JSON.stringify(showSecrets ? result : redactJsonSecrets(result), null, 2));
    return;
  }
  if (result.branches.length === 0) {
    writeOut(dependencies, "no branches");
    return;
  }
  for (const branch of result.branches) {
    const url = branch.database_url === null ? "" : showSecrets ? ` database_url=${branch.database_url}` : " database_url=[redacted]";
    const dynamodb = branch.dynamodb === undefined ? "" : ` dynamodb_link=${branch.dynamodb.link} dynamodb_phase=${branch.dynamodb.phase ?? "pending"}`;
    const source = branch.source === undefined ? "" : ` source_type=${branch.source.type} source=${branch.source.link}`;
    writeOut(dependencies, `${branch.name} branch_id=${branch.id} status=${branch.status}${source}${dynamodb}${url}`);
  }
}

function printPreviewSqlResult(dependencies: AnboCliDependencies, result: DemoSqlResult, json: boolean): void {
  if (json) {
    writeOut(dependencies, JSON.stringify(result, null, 2));
    return;
  }
  writeOut(dependencies, `request_id: ${result.request_id ?? "n/a"}`);
  writeOut(dependencies, `row_count: ${result.rowCount ?? result.row_count ?? 0}`);
  writeOut(dependencies, `truncated: ${result.truncated === true ? "true" : "false"}`);
  if (Array.isArray(result.rows) && result.rows.length > 0) {
    writeOut(dependencies, "rows:");
    for (const row of result.rows) {
      writeOut(dependencies, `  ${JSON.stringify(row)}`);
    }
  }
}

function envWaitProgressReporter(
  dependencies: AnboCliDependencies
): (summary: EnvApiEnvironmentSummary, elapsedMs: number) => void {
  let lastKey: string | undefined;
  let lastPrintedElapsedMs = -WAIT_PROGRESS_INTERVAL_MS;
  return (summary, elapsedMs) => {
    const key = [
      summary.state,
      summary.message ?? "",
      summary.branch?.allocation ?? "",
      summary.branch?.poolMissReason ?? "",
      summary.branch?.baseSnapshot ?? ""
    ].join("|");
    if (key === lastKey && elapsedMs - lastPrintedElapsedMs < WAIT_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastKey = key;
    lastPrintedElapsedMs = elapsedMs;
    const parts = [
      `waiting env: env_id=${summary.envId}`,
      `state=${summary.state}`,
      `elapsed=${formatDurationMs(elapsedMs)}`
    ];
    if (summary.branch?.allocation !== undefined) {
      parts.push(`allocation=${summary.branch.allocation}`);
    }
    if (summary.branch?.baseSnapshot !== undefined) {
      parts.push(`base_snapshot=${summary.branch.baseSnapshot}`);
    }
    if (summary.branch?.poolMissReason !== undefined) {
      parts.push(`pool=${summary.branch.poolMissReason}`);
    }
    if (summary.message !== undefined) {
      parts.push(`message=${summary.message}`);
    }
    writeOut(dependencies, parts.join(" "));
  };
}

function testRunWaitProgressReporter(
  dependencies: AnboCliDependencies
): (summary: EnvApiTestRunSummary, elapsedMs: number) => void {
  let lastKey: string | undefined;
  let lastPrintedElapsedMs = -WAIT_PROGRESS_INTERVAL_MS;
  return (summary, elapsedMs) => {
    const jobStatus = summary.jobs?.map((job) => `${job.name}=${job.status}`).join(",")
      ?? summary.jobNames?.join(",")
      ?? "";
    const key = [
      summary.status,
      summary.failedJob ?? "",
      summary.reason ?? "",
      summary.message ?? "",
      jobStatus
    ].join("|");
    if (key === lastKey && elapsedMs - lastPrintedElapsedMs < WAIT_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastKey = key;
    lastPrintedElapsedMs = elapsedMs;
    const parts = [
      `waiting test-run: env_id=${summary.envId}`,
      `run_id=${summary.runId}`,
      `status=${summary.status}`,
      `elapsed=${formatDurationMs(elapsedMs)}`
    ];
    if (jobStatus.length > 0) {
      parts.push(`jobs=${jobStatus}`);
    }
    if (summary.failedJob !== undefined) {
      parts.push(`failed_job=${summary.failedJob}`);
    }
    if (summary.reason !== undefined) {
      parts.push(`reason=${summary.reason}`);
    }
    writeOut(dependencies, parts.join(" "));
  };
}

function withTail(logs: EnvApiTestRunLogs, tail: number | undefined): EnvApiTestRunLogs {
  if (tail === undefined) {
    return logs;
  }
  return {
    ...logs,
    entries: logs.entries.map((entry) => ({
      ...entry,
      text: entry.text.split(/\r?\n/).slice(-tail).join("\n")
    }))
  };
}

function testRunFailureMessage(summary: EnvApiTestRunSummary): string {
  const parts = [`test-run ${summary.runId} in ${summary.envId} ended ${summary.status}`];
  if (summary.failedJob !== undefined) {
    parts.push(`failed_job=${summary.failedJob}`);
  }
  if (summary.reason !== undefined) {
    parts.push(`reason=${summary.reason}`);
  }
  return parts.join("; ");
}

function testRunDuration(summary: EnvApiTestRunSummary): string | undefined {
  if (summary.durationMs !== undefined) {
    return formatDurationMs(summary.durationMs);
  }
  const start = summary.startedAt ?? summary.createdAt;
  const end = summary.endedAt;
  if (start === undefined || end === undefined) {
    return undefined;
  }
  const durationMs = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  return formatDurationMs(durationMs);
}

function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function readyForFirstTestDuration(summary: EnvApiEnvironmentSummary): string | undefined {
  const start = summary.timings?.sourceCheckStartedAt ?? summary.timings?.branchRequestedAt;
  const end = summary.timings?.readyForFirstTestAt ?? summary.branch?.readyAt;
  if (start === undefined || end === undefined) {
    return undefined;
  }
  const durationMs = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function printHelp(dependencies: AnboCliDependencies): void {
  writeOut(dependencies, [
    "Usage:",
    "  anbo version [--json]",
    "  anbo sandbox up [--output human|json|jsonl]",
    "  anbo login [--no-browser] [--app-url URL]",
    "  anbo logout [--app-url URL]",
    "  anbo setup postgres --demo [--app-url URL] [--token TOKEN]",
    "  anbo setup dynamodb --demo [--app-url URL] [--token TOKEN]",
    "  anbo branch create NAME [--from SOURCE] [--json] [--no-wait] [--no-credentials]",
    "  anbo branch info NAME [--json]",
    "  anbo branch url NAME",
    "  anbo branch credentials NAME [--format env|json]",
    "  anbo branch with-env NAME -- COMMAND [ARG...]",
    "  anbo branch dynamodb-smoke NAME",
    "  anbo branch list [--json]",
    "  anbo branch delete NAME [--wait] [--json]",
    "  anbo token create [--name NAME] [--scopes SCOPE,...] [--expires-in SECONDS] [--json]",
    "  anbo token list [--json]",
    "  anbo token revoke ID [--json]",
    "  anbo report BRANCH_NAME [--out FILE]",
    "  anbo setup postgres --api-url URL --project NAME --source SOURCE --route-base-url URL --base-bucket BUCKET --base-prefix PREFIX --overlay-bucket BUCKET [--token TOKEN]",
    "  anbo create --image IMAGE --sha SHA [--fresh|--pool-preferred] [--no-wait]",
    "  anbo status ENV_ID",
    "  anbo test ENV_ID --image IMAGE [--type migration|smoke|test|ci] [--shards N] [--wait] -- COMMAND...",
    "  anbo test-status ENV_ID RUN_ID",
    "  anbo logs ENV_ID --test-run RUN_ID [--tail N]",
    "  anbo report ENV_ID --test-run RUN_ID --out FILE",
    "  anbo destroy ENV_ID [--wait]"
  ].join("\n"));
}

function printVersion(parsed: ParsedArgs, dependencies: AnboCliDependencies): void {
  const version = readCliVersion();
  if (boolFlag(parsed, "json")) {
    writeOut(dependencies, JSON.stringify({ name: "anbo", version }, null, 2));
    return;
  }
  writeOut(dependencies, version);
}

function readCliVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPaths = [
    resolve(here, "../package.json"),
    resolve(here, "../../package.json"),
    resolve(process.cwd(), "package.json")
  ];
  for (const packageJsonPath of packageJsonPaths) {
    try {
      const value = JSON.parse(readFileSync(packageJsonPath, "utf8")) as JsonRecord;
      if (typeof value["version"] === "string" && value["version"].length > 0) {
        return value["version"];
      }
    } catch {
      // Try the next likely package root.
    }
  }
  return CLI_VERSION_FALLBACK;
}

function safeSegment(value: string, fallback: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return segment.length === 0 ? fallback : segment;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactJsonSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonSecrets(item));
  }
  if (isRecord(value)) {
    const redacted: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "database_url" || normalizedKey.includes("authorization") || normalizedKey.endsWith("token") || normalizedKey.includes("password") || normalizedKey.includes("secret")) {
        redacted[key] = entry === null || entry === undefined ? entry : "[redacted]";
      } else {
        redacted[key] = redactJsonSecrets(entry);
      }
    }
    return redacted;
  }
  return value;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]")
    .replace(/\banbo_[A-Za-z0-9._-]+\b/g, "anbo_[redacted]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgres://[redacted]")
    .replace(/(database_url=)[^\s]+/gi, "$1[redacted]");
}

function writeOut(dependencies: AnboCliDependencies, line: string): void {
  (dependencies.stdout ?? console.log)(line);
}

function writeErr(dependencies: AnboCliDependencies, line: string): void {
  (dependencies.stderr ?? console.error)(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sleepFor(dependencies: AnboCliDependencies, ms: number): Promise<void> {
  return dependencies.sleep?.(ms) ?? sleep(ms);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    const error = body["error"];
    if (typeof error === "string") {
      return error;
    }
    if (isRecord(error) && typeof error["message"] === "string") {
      return error["message"];
    }
  }
  return fallback.slice(0, 500);
}
