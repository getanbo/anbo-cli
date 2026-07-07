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
];
export const ANBO_K8S_SIDE_EFFECT_MODES = [
    "capture",
    "block",
    "block_write_capture_payload",
    "record_only",
    "deterministic_stub",
    "shadow"
];
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
];
export const ANBO_K8S_BRANCH_ALLOCATIONS = [
    "pool_preferred",
    "pool_required",
    "fresh_required"
];
const REQUIRED_SPEC_FIELDS = [
    "ttl",
    "repo",
    "sha",
    "tenant_id",
    "services",
    "postgres",
    "s3",
    "queues",
    "side_effects",
    "route",
    "tests"
];
export function isValidAnboK8sEnvId(envId) {
    return ANBO_K8S_ENV_ID_PATTERN.test(envId);
}
export function isAnboK8sEnvironmentStatus(value) {
    return ANBO_K8S_ENVIRONMENT_STATUSES.includes(value);
}
export function assertValidAnboK8sEnvironmentStatus(value, label = "AnboEnvironment status") {
    if (!isAnboK8sEnvironmentStatus(value)) {
        throw new Error(`${label} must be one of ${ANBO_K8S_ENVIRONMENT_STATUSES.join(", ")}`);
    }
}
export function assertValidAnboK8sEnvId(envId) {
    if (!isValidAnboK8sEnvId(envId)) {
        throw new Error(`invalid AnboK8s env id ${envId}; expected ${ANBO_K8S_ENV_ID_DESCRIPTION}`);
    }
}
export function parseAnboK8sTtlSeconds(ttl) {
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
export function validateAnboEnvironment(resource) {
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
    validatePostgres(spec["postgres"]);
    validateS3(spec["s3"]);
    validateQueues(spec["queues"]);
    validateSideEffects(spec["side_effects"]);
    validateRoute(spec["route"], metadata["name"]);
    validateTests(spec["tests"]);
    validateStatus(resource["status"]);
    return resource;
}
export function evaluateSourceCompatibility(input) {
    const failedChecks = Object.entries(input)
        .filter(([, value]) => value !== true)
        .map(([key]) => key);
    return { ok: failedChecks.length === 0, failedChecks };
}
export function evaluateSnapshotPublication(candidate) {
    if (candidate.replicaLagSeconds > candidate.lagThresholdSeconds) {
        return { ready: false, reason: "replica_lag_exceeds_threshold" };
    }
    const checks = [
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
export function evaluateBranchStartup(input) {
    assertValidAnboK8sEnvId(input.branchId);
    const checks = [
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
function validateServices(value) {
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
function validateStringArray(value, label) {
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
function validateServiceReadinessProbe(value, servicePort, label) {
    if (value === undefined) {
        return;
    }
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object`);
    }
    validateHttpPath(value["path"], `${label}.path`);
    if (value["port"] !== undefined) {
        validatePortNumber(value["port"], `${label}.port`);
    }
    else if (servicePort === undefined) {
        throw new Error(`${label}.port is required when the service port is omitted`);
    }
    validateOptionalProbeInteger(value["initialDelaySeconds"], `${label}.initialDelaySeconds`, 0);
    validateOptionalProbeInteger(value["periodSeconds"], `${label}.periodSeconds`, 1);
    validateOptionalProbeInteger(value["timeoutSeconds"], `${label}.timeoutSeconds`, 1);
    validateOptionalProbeInteger(value["successThreshold"], `${label}.successThreshold`, 1);
    validateOptionalProbeInteger(value["failureThreshold"], `${label}.failureThreshold`, 1);
}
function validateHttpPath(value, label) {
    validatePlainString(value, label);
    if (!value.startsWith("/") || /[\s?#]/.test(value)) {
        throw new Error(`${label} must be an absolute HTTP path without whitespace, query, or fragment`);
    }
}
function validateOptionalProbeInteger(value, label, minimum) {
    if (value === undefined) {
        return;
    }
    if (!Number.isInteger(value) || Number(value) < minimum) {
        throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
    }
}
function validatePostgres(value) {
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
        if (allocation !== undefined && !ANBO_K8S_BRANCH_ALLOCATIONS.includes(String(allocation))) {
            throw new Error(`AnboEnvironment spec.postgres.branch_compute.allocation must be one of ${ANBO_K8S_BRANCH_ALLOCATIONS.join(", ")}`);
        }
        const maxSnapshotAgeSeconds = value["branch_compute"]["max_snapshot_age_seconds"];
        if (maxSnapshotAgeSeconds !== undefined && (!Number.isInteger(maxSnapshotAgeSeconds) || Number(maxSnapshotAgeSeconds) < 0)) {
            throw new Error("AnboEnvironment spec.postgres.branch_compute.max_snapshot_age_seconds must be a non-negative integer");
        }
    }
}
function validateS3(value) {
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
function validateQueues(value) {
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
function validateSideEffects(value) {
    if (!isRecord(value) || Object.keys(value).length === 0) {
        throw new Error("AnboEnvironment spec.side_effects must contain at least one side-effect policy");
    }
    const allowedModes = new Set(ANBO_K8S_SIDE_EFFECT_MODES);
    for (const [name, mode] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name)) {
            throw new Error(`AnboEnvironment spec.side_effects contains invalid target ${name}`);
        }
        if (typeof mode !== "string" || !allowedModes.has(mode)) {
            throw new Error(`AnboEnvironment spec.side_effects.${name} must be one of ${ANBO_K8S_SIDE_EFFECT_MODES.join(", ")}`);
        }
    }
}
function validateRoute(value, envId) {
    if (!isRecord(value)) {
        throw new Error("AnboEnvironment spec.route must be an object");
    }
    validateOriginBaseUrl(value["base_url"], "AnboEnvironment spec.route.base_url");
    if (value["path"] !== `/e/${envId}`) {
        throw new Error(`AnboEnvironment spec.route.path must be /e/${envId}`);
    }
}
function validateTests(value) {
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
function validateStatus(value) {
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
}
function validateStatusMessage(value) {
    if (typeof value !== "string") {
        throw new Error("AnboEnvironment status.message must be a string");
    }
    if (value !== value.trim() || /[\r\n]/.test(value)) {
        throw new Error("AnboEnvironment status.message must be a single-line string without surrounding whitespace");
    }
}
function validatePlainString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} is required`);
    }
    if (value !== value.trim() || /[\r\n]/.test(value)) {
        throw new Error(`${label} must be a single-line string without surrounding whitespace`);
    }
}
function validateKubernetesDnsLabel(value, label) {
    if (value.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
        throw new Error(`${label} must be a Kubernetes DNS label`);
    }
}
function validatePortNumber(value, label) {
    if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 65535) {
        throw new Error(`${label} must be an integer from 1 to 65535`);
    }
}
function validateImageReference(value, label) {
    validatePlainString(value, label);
    if (/\s/.test(value)) {
        throw new Error(`${label} must not contain whitespace`);
    }
    const lastSegment = value.slice(value.lastIndexOf("/") + 1);
    if (!lastSegment.includes(":") && !value.includes("@sha256:")) {
        throw new Error(`${label} must include an image tag or sha256 digest`);
    }
}
function validateS3BucketName(value, label) {
    validatePlainString(value, label);
    if (value.length < 3 ||
        value.length > 63 ||
        !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
        value.includes("..") ||
        value.includes(".-") ||
        value.includes("-.") ||
        /^\d+\.\d+\.\d+\.\d+$/.test(value)) {
        throw new Error(`${label} must be a valid S3 bucket name`);
    }
}
function validateS3Prefix(value, label) {
    validatePlainString(value, label);
    if (value.startsWith("/") || value.includes("//") || value.split("/").includes("..") || !value.endsWith("/")) {
        throw new Error(`${label} must be a relative S3 prefix ending in /`);
    }
}
function validateOriginBaseUrl(value, label) {
    validatePlainString(value, label);
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`${label} must be an http or https URL`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        (url.pathname !== "" && url.pathname !== "/")) {
        throw new Error(`${label} must be an http or https origin URL`);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
