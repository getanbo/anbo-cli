import {
  assertValidAnboK8sEnvId,
  validateAnboEnvironment,
  type AnboK8sEnvironmentArtifactStatus,
  type AnboK8sEnvironmentBranchStatus,
  type AnboK8sEnvironmentCondition,
  type AnboK8sEnvironmentDynamoDBStatus,
  type AnboK8sEnvironmentOpenSearchStatus,
  type AnboK8sEnvironmentRuntimeStatus,
  type AnboK8sEnvironmentResourceSnapshots,
  type AnboK8sEnvironmentTimings,
  type AnboK8sEnvironmentResource,
  type AnboK8sEnvironmentStatus
} from "./contracts.js";
import {
  buildSourceCheckResponse,
  type SourceCheckContext,
  type SourceCheckPolicy,
  type SourceCheckResponse,
  type SourceCompatibilityProbeResults,
  type SourceProbeStatus
} from "./source-check.js";

type JsonRecord = Record<string, unknown>;

export type EnvApiMethod = "GET" | "POST" | "DELETE";

export type EnvApiRouteName =
  | "postSourceCheck"
  | "postEnv"
  | "getEnv"
  | "deleteEnv"
  | "postEnvSql"
  | "postTestRun"
  | "getTestRun"
  | "getTestRunLogs"
  | "getTestRunReport"
  | "deleteTestRun"
  | "postSmoke"
  | "postSuspend"
  | "postResume";

export type EnvApiRouteDefinition = {
  method: EnvApiMethod;
  path: string;
  handler: EnvApiRouteName;
};

export const ENV_API_ROUTES: readonly EnvApiRouteDefinition[] = [
  { method: "POST", path: "/source/check", handler: "postSourceCheck" },
  { method: "POST", path: "/envs", handler: "postEnv" },
  { method: "GET", path: "/envs/:env_id", handler: "getEnv" },
  { method: "DELETE", path: "/envs/:env_id", handler: "deleteEnv" },
  { method: "POST", path: "/envs/:env_id/sql", handler: "postEnvSql" },
  { method: "POST", path: "/envs/:env_id/test-runs", handler: "postTestRun" },
  { method: "GET", path: "/envs/:env_id/test-runs/:run_id", handler: "getTestRun" },
  { method: "GET", path: "/envs/:env_id/test-runs/:run_id/logs", handler: "getTestRunLogs" },
  { method: "GET", path: "/envs/:env_id/test-runs/:run_id/report", handler: "getTestRunReport" },
  { method: "DELETE", path: "/envs/:env_id/test-runs/:run_id", handler: "deleteTestRun" },
  { method: "POST", path: "/envs/:env_id/smoke", handler: "postSmoke" },
  { method: "POST", path: "/envs/:env_id/suspend", handler: "postSuspend" },
  { method: "POST", path: "/envs/:env_id/resume", handler: "postResume" }
] as const;

export type EnvApiPathParams = {
  env_id?: unknown;
  run_id?: unknown;
};

export type EnvApiResponse<T> = {
  status: number;
  body: T;
};

export type EnvApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export class EnvApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "EnvApiError";
  }
}

export type EnvApiEnvironmentSummary = {
  envId: string;
  state: AnboK8sEnvironmentStatus;
  expiresAt?: string;
  routePath?: string;
  previewUrl?: string;
  message?: string;
  observedGeneration?: number;
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

export type EnvApiSourceCheckRequest = {
  source: string;
  checked_at?: string;
  probes?: SourceCompatibilityProbeResults;
  policy?: SourceCheckPolicy;
};

export type EnvApiSourceCheckRunInput = {
  source: string;
  checkedAt: string;
  policy?: SourceCheckPolicy;
};

export const ENV_API_TEST_RUN_TYPES = ["migration", "smoke", "test", "ci"] as const;
export const ENV_API_TEST_RUN_EXECUTIONS = ["cluster_job", "external"] as const;
export const ENV_API_TEST_RUN_STATUSES = ["Pending", "Starting", "Running", "Passed", "Failed", "Canceled", "TimedOut"] as const;

export type EnvApiTestRunType = typeof ENV_API_TEST_RUN_TYPES[number];
export type EnvApiTestRunExecution = typeof ENV_API_TEST_RUN_EXECUTIONS[number];
export type EnvApiTestRunStatus = typeof ENV_API_TEST_RUN_STATUSES[number];

export type EnvApiTestRunRequest = {
  type: EnvApiTestRunType;
  execution: EnvApiTestRunExecution;
  image: string;
  command: string[];
  shards: number;
  timeout_seconds: number;
  migration_hash?: string;
};

export type EnvApiTestRunJobStatus = {
  name: string;
  status: EnvApiTestRunStatus;
  podName?: string;
  exitCode?: number;
  reason?: string;
  message?: string;
  startedAt?: string;
  endedAt?: string;
};

export type EnvApiTestRunSummary = {
  envId: string;
  runId: string;
  type: EnvApiTestRunType;
  execution: EnvApiTestRunExecution;
  status: EnvApiTestRunStatus;
  image: string;
  command: string[];
  shards: number;
  timeout_seconds: number;
  migration_hash?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  reason?: string;
  message?: string;
  failedJob?: string;
  jobNames?: string[];
  jobs?: EnvApiTestRunJobStatus[];
  logTail?: string[];
  external?: {
    databaseUrlSecretRef?: string;
    previewUrl?: string;
  };
};

export type EnvApiTestRunLogEntry = {
  jobName: string;
  podName?: string;
  container?: string;
  text: string;
};

export type EnvApiTestRunLogs = {
  envId: string;
  runId: string;
  status: EnvApiTestRunStatus;
  truncated: boolean;
  entries: EnvApiTestRunLogEntry[];
};

export type EnvApiTestRunReport = {
  schemaVersion: 1;
  generatedAt: string;
  summary: EnvApiTestRunSummary;
  logs: EnvApiTestRunLogs;
};

export type EnvApiSqlRequest = {
  sql: string;
};

export type EnvApiSqlResponse = {
  envId: string;
  rowCount: number;
  fields: string[];
  rows: JsonRecord[];
  truncated: boolean;
  durationMs: number;
};

type Awaitable<T> = T | Promise<T>;

export type EnvApiDependencies = {
  now: () => string;
  createEnvironment: (manifest: AnboK8sEnvironmentResource) => Awaitable<EnvApiEnvironmentSummary>;
  getEnvironment: (envId: string) => Awaitable<EnvApiEnvironmentSummary | null>;
  deleteEnvironment: (envId: string) => Awaitable<EnvApiEnvironmentSummary>;
  createTestRun?: (envId: string, request: EnvApiTestRunRequest) => Awaitable<EnvApiTestRunSummary>;
  getTestRun?: (envId: string, runId: string) => Awaitable<EnvApiTestRunSummary | null>;
  getTestRunLogs?: (envId: string, runId: string) => Awaitable<EnvApiTestRunLogs | null>;
  getTestRunReport?: (envId: string, runId: string) => Awaitable<EnvApiTestRunReport | null>;
  deleteTestRun?: (envId: string, runId: string) => Awaitable<EnvApiTestRunSummary>;
  runSql?: (envId: string, request: EnvApiSqlRequest) => Awaitable<EnvApiSqlResponse>;
  runSmoke: (envId: string) => Awaitable<EnvApiEnvironmentSummary>;
  suspendEnvironment: (envId: string) => Awaitable<EnvApiEnvironmentSummary>;
  resumeEnvironment: (envId: string) => Awaitable<EnvApiEnvironmentSummary>;
  runSourceCheck?: (input: EnvApiSourceCheckRunInput) => Awaitable<SourceCheckResponse>;
  recordSourceCheck?: (result: SourceCheckResponse) => Awaitable<void>;
};

export type EnvApiHandlers = {
  postSourceCheck: (body: unknown) => Promise<EnvApiResponse<SourceCheckResponse | EnvApiErrorBody>>;
  postEnv: (body: unknown) => Promise<EnvApiResponse<EnvApiEnvironmentSummary | EnvApiErrorBody>>;
  getEnv: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiEnvironmentSummary | EnvApiErrorBody>>;
  deleteEnv: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiEnvironmentSummary | EnvApiErrorBody>>;
  postEnvSql: (params: EnvApiPathParams, body: unknown) => Promise<EnvApiResponse<EnvApiSqlResponse | EnvApiErrorBody>>;
  postTestRun: (params: EnvApiPathParams, body: unknown) => Promise<EnvApiResponse<EnvApiTestRunSummary | EnvApiErrorBody>>;
  getTestRun: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiTestRunSummary | EnvApiErrorBody>>;
  getTestRunLogs: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiTestRunLogs | EnvApiErrorBody>>;
  getTestRunReport: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiTestRunReport | EnvApiErrorBody>>;
  deleteTestRun: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiTestRunSummary | EnvApiErrorBody>>;
  postSmoke: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiEnvironmentSummary | EnvApiErrorBody>>;
  postSuspend: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiEnvironmentSummary | EnvApiErrorBody>>;
  postResume: (params: EnvApiPathParams) => Promise<EnvApiResponse<EnvApiEnvironmentSummary | EnvApiErrorBody>>;
};

export function createEnvApiHandlers(dependencies: EnvApiDependencies): EnvApiHandlers {
  return {
    async postSourceCheck(body) {
      let request: EnvApiSourceCheckRequest;
      try {
        request = parseSourceCheckRequest(body);
      } catch (error) {
        return errorResponse(400, "bad_request", getErrorMessage(error));
      }

      const context: SourceCheckContext = {
        source: request.source,
        checkedAt: request.checked_at ?? dependencies.now()
      };
      if (request.policy !== undefined) {
        context.policy = request.policy;
      }
      let result: SourceCheckResponse;
      if (dependencies.runSourceCheck !== undefined) {
        if (request.probes !== undefined) {
          return errorResponse(
            400,
            "bad_request",
            "POST /source/check probes are not accepted when live source checks are configured"
          );
        }
        const input: EnvApiSourceCheckRunInput = {
          source: request.source,
          checkedAt: context.checkedAt
        };
        if (request.policy !== undefined) {
          input.policy = request.policy;
        }
        result = await dependencies.runSourceCheck(input);
      } else if (request.probes !== undefined) {
        result = buildSourceCheckResponse(request.probes, context);
      } else {
        return errorResponse(400, "bad_request", "POST /source/check probes are required unless live source checks are configured");
      }
      if (dependencies.recordSourceCheck !== undefined) {
        await dependencies.recordSourceCheck(result);
      }
      return {
        status: 200,
        body: result
      };
    },

    async postEnv(body) {
      let manifest: AnboK8sEnvironmentResource;
      try {
        manifest = validateAnboEnvironment(body);
      } catch (error) {
        return errorResponse(400, "bad_request", getErrorMessage(error));
      }
      try {
        return {
          status: 202,
          body: await dependencies.createEnvironment(manifest)
        };
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },

    async getEnv(params) {
      const envId = parseEnvIdOrError(params);
      if (!envId.ok) {
        return envId.response;
      }
      let env: EnvApiEnvironmentSummary | null;
      try {
        env = await dependencies.getEnvironment(envId.value);
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
      if (env === null) {
        return errorResponse(404, "not_found", `AnboEnvironment ${envId.value} was not found`);
      }
      return {
        status: 200,
        body: env
      };
    },

    async deleteEnv(params) {
      return envAction(params, 202, dependencies.deleteEnvironment);
    },

    async postEnvSql(params, body) {
      const envId = parseEnvIdOrError(params);
      if (!envId.ok) {
        return envId.response;
      }
      let request: EnvApiSqlRequest;
      try {
        request = parseSqlRequest(body);
      } catch (error) {
        return errorResponse(400, "bad_request", getErrorMessage(error));
      }
      if (dependencies.runSql === undefined) {
        return errorResponse(501, "not_implemented", "preview SQL execution is not configured");
      }
      try {
        return {
          status: 200,
          body: await dependencies.runSql(envId.value, request)
        };
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },

    async postTestRun(params, body) {
      const envId = parseEnvIdOrError(params);
      if (!envId.ok) {
        return envId.response;
      }
      let request: EnvApiTestRunRequest;
      try {
        request = parseTestRunRequest(body);
      } catch (error) {
        return errorResponse(400, "bad_request", getErrorMessage(error));
      }
      const createTestRun = dependencies.createTestRun;
      if (createTestRun === undefined) {
        return errorResponse(501, "not_implemented", "test-run creation is not configured");
      }
      try {
        return {
          status: 202,
          body: await createTestRun(envId.value, request)
        };
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },

    async getTestRun(params) {
      const parsed = parseEnvAndRunIdOrError(params);
      if (!parsed.ok) {
        return parsed.response;
      }
      const getTestRun = dependencies.getTestRun;
      if (getTestRun === undefined) {
        return errorResponse(501, "not_implemented", "test-run reads are not configured");
      }
      try {
        const run = await getTestRun(parsed.envId, parsed.runId);
        if (run === null) {
          return errorResponse(404, "not_found", `Anbo test run ${parsed.runId} for ${parsed.envId} was not found`);
        }
        return {
          status: 200,
          body: run
        };
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },

    async getTestRunLogs(params) {
      const parsed = parseEnvAndRunIdOrError(params);
      if (!parsed.ok) {
        return parsed.response;
      }
      const getTestRunLogs = dependencies.getTestRunLogs;
      if (getTestRunLogs === undefined) {
        return errorResponse(501, "not_implemented", "test-run logs are not configured");
      }
      try {
        const logs = await getTestRunLogs(parsed.envId, parsed.runId);
        if (logs === null) {
          return errorResponse(404, "not_found", `Anbo test run ${parsed.runId} for ${parsed.envId} was not found`);
        }
        return {
          status: 200,
          body: logs
        };
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },

    async getTestRunReport(params) {
      const parsed = parseEnvAndRunIdOrError(params);
      if (!parsed.ok) {
        return parsed.response;
      }
      try {
        if (dependencies.getTestRunReport !== undefined) {
          const report = await dependencies.getTestRunReport(parsed.envId, parsed.runId);
          if (report === null) {
            return errorResponse(404, "not_found", `Anbo test run ${parsed.runId} for ${parsed.envId} was not found`);
          }
          return {
            status: 200,
            body: report
          };
        }
        if (dependencies.getTestRun === undefined || dependencies.getTestRunLogs === undefined) {
          return errorResponse(501, "not_implemented", "test-run reports are not configured");
        }
        const summary = await dependencies.getTestRun(parsed.envId, parsed.runId);
        const logs = await dependencies.getTestRunLogs(parsed.envId, parsed.runId);
        if (summary === null || logs === null) {
          return errorResponse(404, "not_found", `Anbo test run ${parsed.runId} for ${parsed.envId} was not found`);
        }
        return {
          status: 200,
          body: {
            schemaVersion: 1,
            generatedAt: dependencies.now(),
            summary,
            logs
          }
        };
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },

    async deleteTestRun(params) {
      const parsed = parseEnvAndRunIdOrError(params);
      if (!parsed.ok) {
        return parsed.response;
      }
      const deleteTestRun = dependencies.deleteTestRun;
      if (deleteTestRun === undefined) {
        return errorResponse(501, "not_implemented", "test-run deletion is not configured");
      }
      try {
        return {
          status: 202,
          body: await deleteTestRun(parsed.envId, parsed.runId)
        };
      } catch (error) {
        const response = envApiErrorResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
    },

    async postSmoke(params) {
      return envAction(params, 202, dependencies.runSmoke);
    },

    async postSuspend(params) {
      return envAction(params, 202, dependencies.suspendEnvironment);
    },

    async postResume(params) {
      return envAction(params, 202, dependencies.resumeEnvironment);
    }
  };
}

function parseEnvAndRunIdOrError(
  params: EnvApiPathParams
): { ok: true; envId: string; runId: string } | { ok: false; response: EnvApiResponse<EnvApiErrorBody> } {
  const envId = parseEnvIdOrError(params);
  if (!envId.ok) {
    return envId;
  }
  if (typeof params.run_id !== "string" || params.run_id.length === 0) {
    return {
      ok: false,
      response: errorResponse(400, "bad_request", "run_id path parameter is required")
    };
  }
  if (!/^run-[a-z0-9][a-z0-9-]{2,54}$/.test(params.run_id)) {
    return {
      ok: false,
      response: errorResponse(400, "bad_request", "run_id must match run-[a-z0-9][a-z0-9-]{2,54}")
    };
  }
  return { ok: true, envId: envId.value, runId: params.run_id };
}

async function envAction(
  params: EnvApiPathParams,
  acceptedStatus: number,
  action: (envId: string) => Awaitable<EnvApiEnvironmentSummary>
): Promise<EnvApiResponse<EnvApiEnvironmentSummary | EnvApiErrorBody>> {
  const envId = parseEnvIdOrError(params);
  if (!envId.ok) {
    return envId.response;
  }
  try {
    return {
      status: acceptedStatus,
      body: await action(envId.value)
    };
  } catch (error) {
    const response = envApiErrorResponse(error);
    if (response !== undefined) {
      return response;
    }
    throw error;
  }
}

function parseEnvIdOrError(
  params: EnvApiPathParams
): { ok: true; value: string } | { ok: false; response: EnvApiResponse<EnvApiErrorBody> } {
  if (typeof params.env_id !== "string" || params.env_id.length === 0) {
    return {
      ok: false,
      response: errorResponse(400, "bad_request", "env_id path parameter is required")
    };
  }
  try {
    assertValidAnboK8sEnvId(params.env_id);
  } catch (error) {
    return {
      ok: false,
      response: errorResponse(400, "bad_request", getErrorMessage(error))
    };
  }
  return {
    ok: true,
    value: params.env_id
  };
}

function parseSourceCheckRequest(body: unknown): EnvApiSourceCheckRequest {
  if (!isRecord(body)) {
    throw new Error("POST /source/check body must be an object");
  }
  if (typeof body["source"] !== "string" || body["source"].trim().length === 0) {
    throw new Error("POST /source/check source is required");
  }
  const probes = body["probes"];

  const request: EnvApiSourceCheckRequest = {
    source: body["source"]
  };
  if (probes !== undefined) {
    assertProbeResults(probes);
    request.probes = probes;
  }
  if (typeof body["checked_at"] === "string" && body["checked_at"].length > 0) {
    request.checked_at = body["checked_at"];
  }
  if (body["policy"] !== undefined) {
    request.policy = parsePolicy(body["policy"]);
  }
  return request;
}

function parseTestRunRequest(body: unknown): EnvApiTestRunRequest {
  if (!isRecord(body)) {
    throw new Error("POST /envs/:env_id/test-runs body must be an object");
  }
  const type = parseStringEnum(body["type"], ENV_API_TEST_RUN_TYPES, "type");
  const execution = parseStringEnum(body["execution"], ENV_API_TEST_RUN_EXECUTIONS, "execution");
  const image = parseImageReference(body["image"], "image");
  const command = parseCommand(body["command"], "command");
  const shards = parseOptionalInteger(body["shards"], "shards", 1, 100, 1);
  const timeoutSeconds = parseOptionalInteger(body["timeout_seconds"], "timeout_seconds", 1, 86_400, 900);
  const request: EnvApiTestRunRequest = {
    type,
    execution,
    image,
    command,
    shards,
    timeout_seconds: timeoutSeconds
  };
  if (body["migration_hash"] !== undefined) {
    if (typeof body["migration_hash"] !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body["migration_hash"])) {
      throw new Error("POST /envs/:env_id/test-runs migration_hash must be a safe non-empty string");
    }
    request.migration_hash = body["migration_hash"];
  }
  return request;
}

function parseSqlRequest(body: unknown): EnvApiSqlRequest {
  if (!isRecord(body)) {
    throw new Error("POST /envs/:env_id/sql body must be an object");
  }
  const sql = body["sql"];
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("POST /envs/:env_id/sql sql is required");
  }
  if (Buffer.byteLength(sql, "utf8") > 10 * 1024) {
    throw new Error("POST /envs/:env_id/sql sql must be at most 10240 bytes");
  }
  return { sql };
}

function parseStringEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`POST /envs/:env_id/test-runs ${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function parseImageReference(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || /\s/.test(value)) {
    throw new Error(`POST /envs/:env_id/test-runs ${label} must be a non-empty image reference without whitespace`);
  }
  const lastSegment = value.slice(value.lastIndexOf("/") + 1);
  if (!lastSegment.includes(":") && !value.includes("@sha256:")) {
    throw new Error(`POST /envs/:env_id/test-runs ${label} must include an image tag or sha256 digest`);
  }
  return value;
}

function parseCommand(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`POST /envs/:env_id/test-runs ${label} must be a non-empty string array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry !== entry.trim() || /[\r\n]/.test(entry)) {
      throw new Error(`POST /envs/:env_id/test-runs ${label}[${index}] must be a single-line non-empty string`);
    }
    return entry;
  });
}

function parseOptionalInteger(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`POST /envs/:env_id/test-runs ${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function assertProbeResults(value: unknown): asserts value is SourceCompatibilityProbeResults {
  if (!isRecord(value)) {
    throw new Error("POST /source/check probes are required");
  }
  for (const probeName of [
    "connectivity",
    "replicationUser",
    "pgBasebackup",
    "walStream",
    "postgresVersion",
    "extensions",
    "diskSize",
    "replicaLag",
    "walPressureMetrics"
  ]) {
    const probe = value[probeName];
    if (!isRecord(probe)) {
      throw new Error(`POST /source/check probes.${probeName} must be an object`);
    }
    if (!isProbeStatus(probe["status"])) {
      throw new Error(`POST /source/check probes.${probeName}.status must be pass, fail, or unknown`);
    }
  }
}

function parsePolicy(value: unknown): SourceCheckPolicy {
  if (!isRecord(value)) {
    throw new Error("POST /source/check policy must be an object");
  }
  const policy: SourceCheckPolicy = {};
  setOptionalNonNegativeNumber(policy, "maxReplicaLagSeconds", value["maxReplicaLagSeconds"]);
  setOptionalNonNegativeNumber(policy, "maxSlotLagBytes", value["maxSlotLagBytes"]);
  setOptionalNonNegativeNumber(policy, "maxUnconsumedWalBytes", value["maxUnconsumedWalBytes"]);
  return policy;
}

function setOptionalNonNegativeNumber<T extends SourceCheckPolicy, K extends keyof SourceCheckPolicy>(
  target: T,
  key: K,
  value: unknown
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`POST /source/check policy.${String(key)} must be a non-negative number`);
  }
  target[key] = value as T[K];
}

function errorResponse(status: number, code: string, message: string): EnvApiResponse<EnvApiErrorBody> {
  return {
    status,
    body: {
      error: {
        code,
        message
      }
    }
  };
}

function envApiErrorResponse(error: unknown): EnvApiResponse<EnvApiErrorBody> | undefined {
  return error instanceof EnvApiError ? errorResponse(error.status, error.code, error.message) : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProbeStatus(value: unknown): value is SourceProbeStatus {
  return value === "pass" || value === "fail" || value === "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
