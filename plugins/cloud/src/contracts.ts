export const ANBO_K8S_ENV_ID_PATTERN = /^env-[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;
export const ANBO_K8S_ENV_ID_DESCRIPTION = "env-[a-z0-9](2-50 lowercase alphanumeric or hyphen chars, ending alphanumeric)";
export const ANBO_K8S_ENV_ID_MAX_LENGTH = 54;
export const ANBO_K8S_TTL_MIN_SECONDS = 60;
export const ANBO_K8S_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;

export const ANBO_K8S_REQUIRED_SERVICES = [
  "query-api",
  "ingest-gateway",
  "processor-worker",
  "status-rollup-worker"
] as const;

export const ANBO_K8S_SIDE_EFFECT_MODES = [
  "capture",
  "block",
  "block_write_capture_payload",
  "record_only",
  "deterministic_stub",
  "shadow"
] as const;

export const ANBO_K8S_ENVIRONMENT_STATUSES = [
  "Pending",
  "SourceChecking",
  "ReplicaWaiting",
  "SnapshotSelecting",
  "BranchCreating",
  "ReadyForFirstTest",
  "Deploying",
  "Migrating",
  "SmokeTesting",
  "Ready",
  "Passed",
  "Failed",
  "Suspended",
  "Deleting",
  "Deleted"
] as const;

export type AnboK8sEnvironmentStatus = typeof ANBO_K8S_ENVIRONMENT_STATUSES[number];

export type AnboK8sServiceSpec = {
  image: string;
  replicas?: number;
  port?: number;
  command?: string[];
  args?: string[];
  readinessProbe?: AnboK8sServiceReadinessProbeSpec;
};

export type AnboK8sServiceReadinessProbeSpec = {
  path: string;
  port?: number;
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
};

export type AnboK8sPostgresSpec = {
  mode: "wal_replica_cow_branch";
  source: string;
  base_snapshot: "latest_safe" | string;
  branch_compute?: {
    min_instances?: number;
    max_idle_seconds?: number;
    max_snapshot_age_seconds?: number;
    allocation?: AnboK8sBranchAllocation;
  };
};

export type AnboK8sS3Spec = {
  mode: "overlay";
  base_bucket: string;
  base_prefix: string;
  overlay_bucket: string;
  overlay_prefix: string;
};

export type AnboK8sQueuesSpec = {
  mode: "sqs_namespace";
  names: string[];
};

export const ANBO_K8S_DYNAMODB_API_LEVELS = [
  "mvp-2026-07-core",
  "mvp-2026-07-query",
  "mvp-2026-07-expressions"
] as const;

export type AnboK8sDynamoDBApiLevel = typeof ANBO_K8S_DYNAMODB_API_LEVELS[number];

export type AnboK8sDynamoDBTableSpec = {
  sourceTable: string;
  logicalTable: string;
};

export type AnboK8sDynamoDBSpec =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      mode: "branchable_gateway";
      mirrorRef: string;
      maxMirrorLagSeconds: number;
      supportedApiLevel: AnboK8sDynamoDBApiLevel;
      region?: string;
      tables: AnboK8sDynamoDBTableSpec[];
    };

export type AnboK8sSideEffectMode = typeof ANBO_K8S_SIDE_EFFECT_MODES[number];

export type AnboK8sSideEffectsSpec = Record<string, AnboK8sSideEffectMode>;

export type AnboK8sEnvironmentSpec = {
  ttl: string;
  repo: string;
  sha: string;
  tenant_id: string;
  services: Record<string, AnboK8sServiceSpec>;
  postgres?: AnboK8sPostgresSpec;
  s3: AnboK8sS3Spec;
  queues: AnboK8sQueuesSpec;
  dynamodb?: AnboK8sDynamoDBSpec;
  side_effects: AnboK8sSideEffectsSpec;
  route: {
    base_url: string;
    path: string;
  };
  tests: {
    migration: string;
    smoke: string;
    auto_run?: "none" | "all";
  };
};

export type AnboK8sEnvironmentCondition = {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

export type AnboK8sEnvironmentBranchStatus = {
  branchId?: string;
  baseSnapshot?: string;
  baseLsn?: string;
  databaseUrlSecretRef?: string;
  readyAt?: string;
  branchReadyObservationLagMs?: number;
  allocation?: "prepared_pool" | "fresh_on_demand";
  preparedBranchName?: string;
  poolClaimedAt?: string;
  poolMissReason?: string;
};

export type AnboK8sEnvironmentArtifactStatus = {
  bucket?: string;
  prefix?: string;
  summaryObject?: string;
};

export type AnboK8sEnvironmentOpenSearchStatus = {
  eventIndexPrefix?: string;
  eventSearchIndexPrefixes?: string[];
  telemetryV2IndexPrefix?: string;
  indexPattern?: string;
  endpointConfigured?: boolean;
  service?: "es" | "aoss";
  signRequests?: boolean;
};

export type AnboK8sEnvironmentRuntimeStatus = {
  isolationMode?: string;
  deployEnv?: string;
  preview?: boolean;
  envId?: string;
  sqsEndpointConfigured?: boolean;
  sqsEndpointHost?: string;
  dynamodbEndpointConfigured?: boolean;
  dynamodbEndpointHost?: string;
  dynamodbRegion?: string;
  dynamodbSupportedApiLevel?: AnboK8sDynamoDBApiLevel;
};

export const ANBO_K8S_DYNAMODB_BRANCH_PHASES = [
  "Requested",
  "WaitingForMirror",
  "CreatingStore",
  "CreatingCredentials",
  "ActivatingRoute",
  "Ready",
  "Deleting",
  "Deleted",
  "MirrorTooStale",
  "CredentialCreateFailed",
  "StoreCloneFailed",
  "RouteActivationFailed",
  "CleanupFailed"
] as const;

export type AnboK8sDynamoDBBranchPhase = typeof ANBO_K8S_DYNAMODB_BRANCH_PHASES[number];

export type AnboK8sEnvironmentDynamoDBStatus = {
  phase: AnboK8sDynamoDBBranchPhase;
  endpoint?: string;
  credentialSecretRef?: string;
  branchRef?: string;
  snapshotRef?: string;
  mirrorSequence?: string;
  sourceSnapshotTime?: string;
  lagSecondsAtCreation?: number;
  supportedApiLevel?: AnboK8sDynamoDBApiLevel;
  region?: string;
  message?: string;
};

export type AnboK8sEnvironmentResourceSnapshots = {
  postgres?: {
    snapshotId: string;
    sourceTime?: string;
  };
  dynamodb?: {
    mirrorId: string;
    mirrorSequence: string;
    sourceTime: string;
    lagSecondsAtBranchCreation: number;
  };
};

export type AnboK8sEnvironmentTimingKey =
  | "sourceCheckStartedAt"
  | "sourceCheckCompletedAt"
  | "branchRequestedAt"
  | "branchReadyObservedAt"
  | "readyForFirstTestAt"
  | "deployStartedAt"
  | "migrationStartedAt"
  | "migrationCompletedAt"
  | "smokeStartedAt"
  | "smokeCompletedAt"
  | "artifactsExportedAt"
  | "passedAt";

export type AnboK8sEnvironmentTimings = Partial<Record<AnboK8sEnvironmentTimingKey, string>>;

export type AnboK8sEnvironmentResource = {
  apiVersion: "k8s.anbo.dev/v1";
  kind: "AnboEnvironment";
  metadata: {
    name: string;
    namespace?: string;
    annotations?: Record<string, string>;
    generation?: number;
    creationTimestamp?: string;
  };
  spec: AnboK8sEnvironmentSpec;
  status?: {
    phase?: AnboK8sEnvironmentStatus;
    state?: AnboK8sEnvironmentStatus;
    message?: string;
    observedGeneration?: number;
    previewUrl?: string;
    branch?: AnboK8sEnvironmentBranchStatus;
    artifacts?: AnboK8sEnvironmentArtifactStatus;
    opensearch?: AnboK8sEnvironmentOpenSearchStatus;
    runtime?: AnboK8sEnvironmentRuntimeStatus;
    dynamodb?: AnboK8sEnvironmentDynamoDBStatus;
    resourceSnapshots?: AnboK8sEnvironmentResourceSnapshots;
    timings?: AnboK8sEnvironmentTimings;
    cleanup?: Record<string, unknown>;
    conditions?: AnboK8sEnvironmentCondition[];
  };
};

export type SourceCompatibilityInput = {
  canConnect: boolean;
  replicationUserExists: boolean;
  pgBasebackupWorks: boolean;
  walStreamWorks: boolean;
  supportedPostgresVersion: boolean;
  extensionsCompatible: boolean;
  diskSizeKnown: boolean;
  replicaLagObservable: boolean;
  walPressureMetricsAvailable: boolean;
};

export type SourceCompatibilityResult = {
  ok: boolean;
  failedChecks: string[];
};

export type PostgresSnapshotCandidate = {
  snapshotId: string;
  sourceReplayLsn: string;
  replicaLagSeconds: number;
  lagThresholdSeconds: number;
  checkpointCompleted: boolean;
  zfsSnapshotCreated: boolean;
  validationCloneStarted: boolean;
  recoveryCompleted: boolean;
  pgIsReady: boolean;
  expectedDatabaseExists: boolean;
  migrationTableReadable: boolean;
};

export type PostgresSnapshotPublicationResult = {
  ready: boolean;
  reason?: string;
};

export type BranchStartupInput = {
  branchId: string;
  clonedFromPinnedSnapshot: boolean;
  standbyConfigRemoved: boolean;
  sourceConnectionDisabled: boolean;
  startedAsWritableStandalone: boolean;
  recoveryCompleted: boolean;
  pgIsInRecovery: boolean;
  serviceCreated: boolean;
};

export type BranchStartupResult = {
  ready: boolean;
  reason?: string;
};

export type PostgresBranchDriver = {
  createBranch(input: {
    branchId: string;
    source: string;
    baseSnapshot: string;
    cloneSnapshotName?: string;
    dataPvcName?: string;
    preparedSecretName?: string;
    preparedBranchName?: string;
    allocation?: AnboK8sBranchAllocation;
    maxSnapshotAgeSeconds?: number;
    ttlSeconds: number;
    scheduledNode?: string;
  }): Promise<{
    branchId: string;
    databaseUrl: string;
    baseSnapshot: string;
    baseLsn: string;
    readyAt?: string;
    branchReadyObservationLagMs?: number;
    allocation?: "prepared_pool" | "fresh_on_demand";
    preparedBranchName?: string;
    poolClaimedAt?: string;
    poolMissReason?: string;
  }>;
  deleteBranch(branchId: string, options?: {
    dataPvcName?: string;
    preparedSecretName?: string;
    preparedBranchName?: string;
  }): Promise<void>;
  ensureBranchAccess?(branchId: string): Promise<void>;
  suspendBranch(branchId: string): Promise<void>;
  resumeBranch(branchId: string, options?: { scheduledNode?: string }): Promise<{ databaseUrl: string }>;
};

export type PostgresBranchTimingKey =
  | "scheduledAt"
  | "pvcAppliedAt"
  | "pvcBoundAt"
  | "prepJobCreatedAt"
  | "prepJobStartedAt"
  | "prepJobCompletedAt"
  | "deploymentAppliedAt"
  | "podStartedAt"
  | "deploymentReadyAt"
  | "pgWritableAt"
  | "readyAt";

export type PostgresBranchTimings = Partial<Record<PostgresBranchTimingKey, string>>;

export type PostgresBranchPhaseAdvanceInput = {
  branchId: string;
  source: string;
  baseSnapshot: string;
  cloneSnapshotName?: string;
  dataPvcName?: string;
  preparedSecretName?: string;
  preparedBranchName?: string;
  ttlSeconds: number;
  scheduledNode?: string;
  maxSnapshotAgeSeconds?: number;
  timings?: PostgresBranchTimings;
};

export type PostgresBranchPhaseAdvanceResult = {
  ready: boolean;
  message: string;
  timings?: PostgresBranchTimings;
  databaseUrl?: string;
  baseSnapshot?: string;
  baseLsn?: string;
};

export type PostgresBranchPhaseDriver = {
  advanceBranch(input: PostgresBranchPhaseAdvanceInput): Promise<PostgresBranchPhaseAdvanceResult>;
};

export const ANBO_K8S_BRANCH_ALLOCATIONS = [
  "pool_preferred",
  "pool_required",
  "fresh_required"
] as const;

export type AnboK8sBranchAllocation = typeof ANBO_K8S_BRANCH_ALLOCATIONS[number];

const REQUIRED_SPEC_FIELDS = [
  "ttl",
  "repo",
  "sha",
  "tenant_id",
  "services",
  "s3",
  "queues",
  "side_effects",
  "route",
  "tests"
] as const;

export function isValidAnboK8sEnvId(envId: string): boolean {
  return ANBO_K8S_ENV_ID_PATTERN.test(envId);
}

export function isAnboK8sEnvironmentStatus(value: string): value is AnboK8sEnvironmentStatus {
  return (ANBO_K8S_ENVIRONMENT_STATUSES as readonly string[]).includes(value);
}

export function assertValidAnboK8sEnvironmentStatus(value: string, label = "AnboEnvironment status"): void {
  if (!isAnboK8sEnvironmentStatus(value)) {
    throw new Error(`${label} must be one of ${ANBO_K8S_ENVIRONMENT_STATUSES.join(", ")}`);
  }
}

export function assertValidAnboK8sEnvId(envId: string): void {
  if (!isValidAnboK8sEnvId(envId)) {
    throw new Error(`invalid AnboK8s env id ${envId}; expected ${ANBO_K8S_ENV_ID_DESCRIPTION}`);
  }
}

export function parseAnboK8sTtlSeconds(ttl: string): number {
  const match = /^([1-9][0-9]*)([smhd])$/.exec(ttl);
  if (match === null) {
    throw new Error("AnboEnvironment spec.ttl must use a positive integer followed by s, m, h, or d");
  }
  const count = Number(match[1]);
  const multiplier = match[2] === "s" ? 1 : match[2] === "m" ? 60 : match[2] === "h" ? 3600 : 86400;
  const seconds = count * multiplier;
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("AnboEnvironment spec.ttl is too large");
  }
  if (seconds < ANBO_K8S_TTL_MIN_SECONDS) {
    throw new Error(`AnboEnvironment spec.ttl must be at least ${ANBO_K8S_TTL_MIN_SECONDS} seconds`);
  }
  if (seconds > ANBO_K8S_TTL_MAX_SECONDS) {
    throw new Error(`AnboEnvironment spec.ttl must be no more than ${ANBO_K8S_TTL_MAX_SECONDS} seconds`);
  }
  return seconds;
}

export function validateAnboEnvironment(resource: unknown): AnboK8sEnvironmentResource {
  if (!isRecord(resource)) {
    throw new Error("AnboEnvironment must be an object");
  }
  if (resource["apiVersion"] !== "k8s.anbo.dev/v1") {
    throw new Error("AnboEnvironment apiVersion must be k8s.anbo.dev/v1");
  }
  if (resource["kind"] !== "AnboEnvironment") {
    throw new Error("AnboEnvironment kind must be AnboEnvironment");
  }
  const metadata = resource["metadata"];
  if (!isRecord(metadata) || typeof metadata["name"] !== "string") {
    throw new Error("AnboEnvironment metadata.name is required");
  }
  assertValidAnboK8sEnvId(metadata["name"]);
  const spec = resource["spec"];
  if (!isRecord(spec)) {
    throw new Error("AnboEnvironment spec is required");
  }
  for (const field of REQUIRED_SPEC_FIELDS) {
    if (spec[field] === undefined) {
      throw new Error(`AnboEnvironment spec.${field} is required`);
    }
  }
  validatePlainString(spec["ttl"], "AnboEnvironment spec.ttl");
  parseAnboK8sTtlSeconds(spec["ttl"]);
  validatePlainString(spec["repo"], "AnboEnvironment spec.repo");
  validatePlainString(spec["sha"], "AnboEnvironment spec.sha");
  validatePlainString(spec["tenant_id"], "AnboEnvironment spec.tenant_id");
  validateServices(spec["services"]);
  if (spec["postgres"] !== undefined) {
    validatePostgres(spec["postgres"]);
  }
  validateS3(spec["s3"]);
  validateQueues(spec["queues"]);
  validateDynamoDB(spec["dynamodb"]);
  if (spec["postgres"] === undefined && (!isRecord(spec["dynamodb"]) || spec["dynamodb"]["enabled"] !== true)) {
    throw new Error("AnboEnvironment spec must enable at least one database source");
  }
  validateSideEffects(spec["side_effects"]);
  validateRoute(spec["route"], metadata["name"]);
  validateTests(spec["tests"]);
  validateStatus(resource["status"]);
  return resource as AnboK8sEnvironmentResource;
}

export function evaluateSourceCompatibility(input: SourceCompatibilityInput): SourceCompatibilityResult {
  const failedChecks = Object.entries(input)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  return { ok: failedChecks.length === 0, failedChecks };
}

export function evaluateSnapshotPublication(candidate: PostgresSnapshotCandidate): PostgresSnapshotPublicationResult {
  if (candidate.replicaLagSeconds > candidate.lagThresholdSeconds) {
    return { ready: false, reason: "replica_lag_exceeds_threshold" };
  }
  const checks: Array<[boolean, string]> = [
    [candidate.checkpointCompleted, "checkpoint_not_completed"],
    [candidate.zfsSnapshotCreated, "zfs_snapshot_not_created"],
    [candidate.validationCloneStarted, "validation_clone_not_started"],
    [candidate.recoveryCompleted, "recovery_not_completed"],
    [candidate.pgIsReady, "pg_not_ready"],
    [candidate.expectedDatabaseExists, "expected_database_missing"],
    [candidate.migrationTableReadable, "migration_table_not_readable"]
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) {
    return { ready: false, reason: failed[1] };
  }
  return { ready: true };
}

export function evaluateBranchStartup(input: BranchStartupInput): BranchStartupResult {
  assertValidAnboK8sEnvId(input.branchId);
  const checks: Array<[boolean, string]> = [
    [input.clonedFromPinnedSnapshot, "branch_not_cloned_from_pinned_snapshot"],
    [input.standbyConfigRemoved, "standby_config_not_removed"],
    [input.sourceConnectionDisabled, "source_connection_not_disabled"],
    [input.startedAsWritableStandalone, "branch_not_started_as_writable_standalone"],
    [input.recoveryCompleted, "branch_recovery_not_completed"],
    [!input.pgIsInRecovery, "branch_is_still_in_recovery"],
    [input.serviceCreated, "branch_service_not_created"]
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) {
    return { ready: false, reason: failed[1] };
  }
  return { ready: true };
}

function validateServices(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("AnboEnvironment spec.services must contain at least one service");
  }
  for (const requiredName of ANBO_K8S_REQUIRED_SERVICES) {
    if (value[requiredName] === undefined) {
      throw new Error(`AnboEnvironment spec.services must include ${requiredName}`);
    }
  }
  for (const [name, service] of Object.entries(value)) {
    validateKubernetesDnsLabel(name, `AnboEnvironment spec.services.${name}`);
    if (!isRecord(service)) {
      throw new Error(`AnboEnvironment spec.services.${name} must be an object`);
    }
    validateImageReference(service["image"], `AnboEnvironment spec.services.${name}.image`);
    if (service["replicas"] !== undefined && (!Number.isInteger(service["replicas"]) || Number(service["replicas"]) < 0)) {
      throw new Error(`AnboEnvironment spec.services.${name}.replicas must be a non-negative integer`);
    }
    if (service["port"] !== undefined && (!Number.isInteger(service["port"]) || Number(service["port"]) <= 0 || Number(service["port"]) > 65535)) {
      throw new Error(`AnboEnvironment spec.services.${name}.port must be an integer from 1 to 65535`);
    }
    validateStringArray(service["command"], `AnboEnvironment spec.services.${name}.command`);
    validateStringArray(service["args"], `AnboEnvironment spec.services.${name}.args`);
    validateServiceReadinessProbe(service["readinessProbe"], service["port"], `AnboEnvironment spec.services.${name}.readinessProbe`);
  }
}

function validateStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  for (const [index, entry] of value.entries()) {
    validatePlainString(entry, `${label}[${index}]`);
  }
}

function validateServiceReadinessProbe(value: unknown, servicePort: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  validateHttpPath(value["path"], `${label}.path`);
  if (value["port"] !== undefined) {
    validatePortNumber(value["port"], `${label}.port`);
  } else if (servicePort === undefined) {
    throw new Error(`${label}.port is required when the service port is omitted`);
  }
  validateOptionalProbeInteger(value["initialDelaySeconds"], `${label}.initialDelaySeconds`, 0);
  validateOptionalProbeInteger(value["periodSeconds"], `${label}.periodSeconds`, 1);
  validateOptionalProbeInteger(value["timeoutSeconds"], `${label}.timeoutSeconds`, 1);
  validateOptionalProbeInteger(value["successThreshold"], `${label}.successThreshold`, 1);
  validateOptionalProbeInteger(value["failureThreshold"], `${label}.failureThreshold`, 1);
}

function validateHttpPath(value: unknown, label: string): void {
  validatePlainString(value, label);
  if (!value.startsWith("/") || /[\s?#]/.test(value)) {
    throw new Error(`${label} must be an absolute HTTP path without whitespace, query, or fragment`);
  }
}

function validateOptionalProbeInteger(value: unknown, label: string, minimum: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }
}

function validatePostgres(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("AnboEnvironment spec.postgres must be an object");
  }
  if (value["mode"] !== "wal_replica_cow_branch") {
    throw new Error("AnboEnvironment spec.postgres.mode must be wal_replica_cow_branch");
  }
  validatePlainString(value["source"], "AnboEnvironment spec.postgres.source");
  validatePlainString(value["base_snapshot"], "AnboEnvironment spec.postgres.base_snapshot");
  if (value["branch_compute"] !== undefined) {
    if (!isRecord(value["branch_compute"])) {
      throw new Error("AnboEnvironment spec.postgres.branch_compute must be an object");
    }
    const allocation = value["branch_compute"]["allocation"];
    if (allocation !== undefined && !(ANBO_K8S_BRANCH_ALLOCATIONS as readonly string[]).includes(String(allocation))) {
      throw new Error(`AnboEnvironment spec.postgres.branch_compute.allocation must be one of ${ANBO_K8S_BRANCH_ALLOCATIONS.join(", ")}`);
    }
    const maxSnapshotAgeSeconds = value["branch_compute"]["max_snapshot_age_seconds"];
    if (maxSnapshotAgeSeconds !== undefined && (!Number.isInteger(maxSnapshotAgeSeconds) || Number(maxSnapshotAgeSeconds) < 0)) {
      throw new Error("AnboEnvironment spec.postgres.branch_compute.max_snapshot_age_seconds must be a non-negative integer");
    }
  }
}

function validateS3(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("AnboEnvironment spec.s3 must be an object");
  }
  if (value["mode"] !== "overlay") {
    throw new Error("AnboEnvironment spec.s3.mode must be overlay");
  }
  validateS3BucketName(value["base_bucket"], "AnboEnvironment spec.s3.base_bucket");
  validateS3Prefix(value["base_prefix"], "AnboEnvironment spec.s3.base_prefix");
  validateS3BucketName(value["overlay_bucket"], "AnboEnvironment spec.s3.overlay_bucket");
  validateS3Prefix(value["overlay_prefix"], "AnboEnvironment spec.s3.overlay_prefix");
}

function validateQueues(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("AnboEnvironment spec.queues must be an object");
  }
  if (value["mode"] !== "sqs_namespace") {
    throw new Error("AnboEnvironment spec.queues.mode must be sqs_namespace");
  }
  if (!Array.isArray(value["names"]) || value["names"].length === 0 || !value["names"].every((name) => typeof name === "string" && name.length > 0)) {
    throw new Error("AnboEnvironment spec.queues.names must contain queue names");
  }
  for (const name of value["names"]) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
      throw new Error(`AnboEnvironment spec.queues.names contains invalid queue name ${name}`);
    }
  }
  const names = new Set(value["names"]);
  for (const requiredName of ["ingest_shard", "agent_jobs", "dlq"]) {
    if (!names.has(requiredName)) {
      throw new Error(`AnboEnvironment spec.queues.names must include ${requiredName}`);
    }
  }
}

function validateDynamoDB(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value) || typeof value["enabled"] !== "boolean") {
    throw new Error("AnboEnvironment spec.dynamodb.enabled must be a boolean");
  }
  if (value["enabled"] === false) {
    return;
  }
  if (value["mode"] !== "branchable_gateway") {
    throw new Error("AnboEnvironment spec.dynamodb.mode must be branchable_gateway");
  }
  validateKubernetesDnsLabelValue(value["mirrorRef"], "AnboEnvironment spec.dynamodb.mirrorRef");
  const maxMirrorLagSeconds = value["maxMirrorLagSeconds"];
  if (!Number.isInteger(maxMirrorLagSeconds) || Number(maxMirrorLagSeconds) < 0) {
    throw new Error("AnboEnvironment spec.dynamodb.maxMirrorLagSeconds must be a non-negative integer");
  }
  const apiLevel = value["supportedApiLevel"];
  if (typeof apiLevel !== "string" || !(ANBO_K8S_DYNAMODB_API_LEVELS as readonly string[]).includes(apiLevel)) {
    throw new Error(`AnboEnvironment spec.dynamodb.supportedApiLevel must be one of ${ANBO_K8S_DYNAMODB_API_LEVELS.join(", ")}`);
  }
  if (value["region"] !== undefined) {
    validateAwsRegion(value["region"], "AnboEnvironment spec.dynamodb.region");
  }
  const tables = value["tables"];
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error("AnboEnvironment spec.dynamodb.tables must contain at least one table mapping");
  }
  const logicalTables = new Set<string>();
  for (const [index, table] of tables.entries()) {
    if (!isRecord(table)) {
      throw new Error(`AnboEnvironment spec.dynamodb.tables[${index}] must be an object`);
    }
    validateDynamoDBTableName(table["sourceTable"], `AnboEnvironment spec.dynamodb.tables[${index}].sourceTable`);
    validateDynamoDBTableName(table["logicalTable"], `AnboEnvironment spec.dynamodb.tables[${index}].logicalTable`);
    const logicalTable = String(table["logicalTable"]);
    if (logicalTables.has(logicalTable)) {
      throw new Error(`AnboEnvironment spec.dynamodb.tables contains duplicate logicalTable ${logicalTable}`);
    }
    logicalTables.add(logicalTable);
  }
}

function validateSideEffects(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("AnboEnvironment spec.side_effects must contain at least one side-effect policy");
  }
  const allowedModes = new Set<string>(ANBO_K8S_SIDE_EFFECT_MODES);
  for (const [name, mode] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name)) {
      throw new Error(`AnboEnvironment spec.side_effects contains invalid target ${name}`);
    }
    if (typeof mode !== "string" || !allowedModes.has(mode)) {
      throw new Error(`AnboEnvironment spec.side_effects.${name} must be one of ${ANBO_K8S_SIDE_EFFECT_MODES.join(", ")}`);
    }
  }
}

function validateRoute(value: unknown, envId: string): void {
  if (!isRecord(value)) {
    throw new Error("AnboEnvironment spec.route must be an object");
  }
  validateOriginBaseUrl(value["base_url"], "AnboEnvironment spec.route.base_url");
  if (value["path"] !== `/e/${envId}`) {
    throw new Error(`AnboEnvironment spec.route.path must be /e/${envId}`);
  }
}

function validateTests(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("AnboEnvironment spec.tests must be an object");
  }
  for (const field of ["migration", "smoke"]) {
    validatePlainString(value[field], `AnboEnvironment spec.tests.${field}`);
  }
  const autoRun = value["auto_run"];
  if (autoRun !== undefined && autoRun !== "none" && autoRun !== "all") {
    throw new Error("AnboEnvironment spec.tests.auto_run must be none or all");
  }
}

function validateStatus(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error("AnboEnvironment status must be an object");
  }
  const phase = value["phase"];
  if (phase !== undefined) {
    if (typeof phase !== "string") {
      throw new Error("AnboEnvironment status.phase must be a string");
    }
    assertValidAnboK8sEnvironmentStatus(phase, "AnboEnvironment status.phase");
  }
  const state = value["state"];
  if (state !== undefined) {
    if (typeof state !== "string") {
      throw new Error("AnboEnvironment status.state must be a string");
    }
    assertValidAnboK8sEnvironmentStatus(state, "AnboEnvironment status.state");
  }
  if (phase !== undefined && state !== undefined && phase !== state) {
    throw new Error("AnboEnvironment status.phase and status.state must match when both are present");
  }
  if (value["message"] !== undefined) {
    validateStatusMessage(value["message"]);
  }
  validateDynamoDBStatus(value["dynamodb"]);
  validateResourceSnapshots(value["resourceSnapshots"]);
}

function validateDynamoDBStatus(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value) || typeof value["phase"] !== "string" ||
      !(ANBO_K8S_DYNAMODB_BRANCH_PHASES as readonly string[]).includes(value["phase"])) {
    throw new Error(`AnboEnvironment status.dynamodb.phase must be one of ${ANBO_K8S_DYNAMODB_BRANCH_PHASES.join(", ")}`);
  }
  if (value["endpoint"] !== undefined) {
    validateHttpUrl(value["endpoint"], "AnboEnvironment status.dynamodb.endpoint");
  }
  for (const field of ["credentialSecretRef", "branchRef", "snapshotRef"] as const) {
    if (value[field] !== undefined) {
      validateKubernetesDnsLabelValue(value[field], `AnboEnvironment status.dynamodb.${field}`);
    }
  }
  for (const field of ["mirrorSequence", "sourceSnapshotTime"] as const) {
    if (value[field] !== undefined) {
      validatePlainString(value[field], `AnboEnvironment status.dynamodb.${field}`);
    }
  }
  const lagSeconds = value["lagSecondsAtCreation"];
  if (lagSeconds !== undefined && (!Number.isFinite(lagSeconds) || Number(lagSeconds) < 0)) {
    throw new Error("AnboEnvironment status.dynamodb.lagSecondsAtCreation must be a non-negative number");
  }
  if (value["supportedApiLevel"] !== undefined &&
      !(ANBO_K8S_DYNAMODB_API_LEVELS as readonly unknown[]).includes(value["supportedApiLevel"])) {
    throw new Error(`AnboEnvironment status.dynamodb.supportedApiLevel must be one of ${ANBO_K8S_DYNAMODB_API_LEVELS.join(", ")}`);
  }
  if (value["region"] !== undefined) {
    validateAwsRegion(value["region"], "AnboEnvironment status.dynamodb.region");
  }
}

function validateResourceSnapshots(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error("AnboEnvironment status.resourceSnapshots must be an object");
  }
  const postgres = value["postgres"];
  if (postgres !== undefined) {
    if (!isRecord(postgres)) {
      throw new Error("AnboEnvironment status.resourceSnapshots.postgres must be an object");
    }
    validatePlainString(postgres["snapshotId"], "AnboEnvironment status.resourceSnapshots.postgres.snapshotId");
  }
  const dynamodb = value["dynamodb"];
  if (dynamodb !== undefined) {
    if (!isRecord(dynamodb)) {
      throw new Error("AnboEnvironment status.resourceSnapshots.dynamodb must be an object");
    }
    validatePlainString(dynamodb["mirrorId"], "AnboEnvironment status.resourceSnapshots.dynamodb.mirrorId");
    validatePlainString(dynamodb["mirrorSequence"], "AnboEnvironment status.resourceSnapshots.dynamodb.mirrorSequence");
    validatePlainString(dynamodb["sourceTime"], "AnboEnvironment status.resourceSnapshots.dynamodb.sourceTime");
    const lagSeconds = dynamodb["lagSecondsAtBranchCreation"];
    if (!Number.isFinite(lagSeconds) || Number(lagSeconds) < 0) {
      throw new Error("AnboEnvironment status.resourceSnapshots.dynamodb.lagSecondsAtBranchCreation must be a non-negative number");
    }
  }
}

function validateStatusMessage(value: unknown): void {
  if (typeof value !== "string") {
    throw new Error("AnboEnvironment status.message must be a string");
  }
  if (value !== value.trim() || /[\r\n]/.test(value)) {
    throw new Error("AnboEnvironment status.message must be a single-line string without surrounding whitespace");
  }
}

function validatePlainString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  if (value !== value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a single-line string without surrounding whitespace`);
  }
}

function validateKubernetesDnsLabel(value: string, label: string): void {
  if (value.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw new Error(`${label} must be a Kubernetes DNS label`);
  }
}

function validateKubernetesDnsLabelValue(value: unknown, label: string): asserts value is string {
  validatePlainString(value, label);
  validateKubernetesDnsLabel(value, label);
}

function validateDynamoDBTableName(value: unknown, label: string): asserts value is string {
  validatePlainString(value, label);
  if (value.length < 3 || value.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${label} must be a valid DynamoDB table name`);
  }
}

function validateAwsRegion(value: unknown, label: string): asserts value is string {
  validatePlainString(value, label);
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be an AWS region`);
  }
}

function validateHttpUrl(value: unknown, label: string): asserts value is string {
  validatePlainString(value, label);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an http or https URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an http or https URL without credentials or fragment`);
  }
}

function validatePortNumber(value: unknown, label: string): void {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
}

function validateImageReference(value: unknown, label: string): void {
  validatePlainString(value, label);
  if (/\s/.test(value)) {
    throw new Error(`${label} must not contain whitespace`);
  }
  const lastSegment = value.slice(value.lastIndexOf("/") + 1);
  if (!lastSegment.includes(":") && !value.includes("@sha256:")) {
    throw new Error(`${label} must include an image tag or sha256 digest`);
  }
}

function validateS3BucketName(value: unknown, label: string): void {
  validatePlainString(value, label);
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes("..") ||
    value.includes(".-") ||
    value.includes("-.") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) {
    throw new Error(`${label} must be a valid S3 bucket name`);
  }
}

function validateS3Prefix(value: unknown, label: string): void {
  validatePlainString(value, label);
  if (value.startsWith("/") || value.includes("//") || value.split("/").includes("..") || !value.endsWith("/")) {
    throw new Error(`${label} must be a relative S3 prefix ending in /`);
  }
}

function validateOriginBaseUrl(value: unknown, label: string): void {
  validatePlainString(value, label);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an http or https URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(`${label} must be an http or https origin URL`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
