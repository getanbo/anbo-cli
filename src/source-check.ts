import { evaluateSourceCompatibility, type SourceCompatibilityInput, type SourceCompatibilityResult } from "./contracts.js";

export type SourceProbeStatus = "pass" | "fail" | "unknown";

export type SourceCheckProbeResult = {
  status: SourceProbeStatus;
  message?: string;
  details?: Record<string, unknown>;
};

export type SourceCompatibilityProbeResults = {
  connectivity: SourceCheckProbeResult & {
    endpoint?: string;
  };
  replicationUser: SourceCheckProbeResult & {
    user?: string;
  };
  pgBasebackup: SourceCheckProbeResult & {
    command?: string;
  };
  walStream: SourceCheckProbeResult & {
    slotName?: string;
  };
  postgresVersion: SourceCheckProbeResult & {
    version?: string;
    minimumVersion?: string;
  };
  extensions: SourceCheckProbeResult & {
    required?: string[];
    incompatible?: string[];
  };
  diskSize: SourceCheckProbeResult & {
    sizeBytes?: number;
  };
  replicaLag: SourceCheckProbeResult & {
    lagSeconds?: number;
  };
  walPressureMetrics: SourceCheckProbeResult & {
    slotLagBytes?: number;
    unconsumedWalBytes?: number;
  };
};

export type SourceCompatibilityCheckName = keyof SourceCompatibilityInput;
export type SourceProbeName = keyof SourceCompatibilityProbeResults;

export type SourceCheckPolicy = {
  maxReplicaLagSeconds?: number;
  maxSlotLagBytes?: number;
  maxUnconsumedWalBytes?: number;
};

export type SourceCheckContext = {
  source: string;
  checkedAt: string;
  policy?: SourceCheckPolicy;
};

export type SourceCheckDetail = {
  name: SourceCompatibilityCheckName;
  probe: SourceProbeName;
  label: string;
  ok: boolean;
  status: SourceProbeStatus;
  message?: string;
  details?: Record<string, unknown>;
};

export type SourceCheckBlockingReason =
  | SourceCompatibilityCheckName
  | "replica_lag_exceeds_max"
  | "slot_lag_exceeds_max"
  | "unconsumed_wal_exceeds_max";

export type SourceCheckPolicyViolation = {
  reason: SourceCheckBlockingReason;
  message: string;
  observed: number;
  threshold: number;
  blocksEnvCreation: true;
};

export type SourceCheckAlertReason =
  | "replica_lag_exceeds_max"
  | "source_wal_pressure_alarm";

export type SourceCheckAlert = {
  reason: SourceCheckAlertReason;
  message: string;
  observed: number;
  threshold: number;
  blocksEnvCreation: true;
};

export type SourceCheckMetrics = {
  postgresVersion?: string;
  sourceDiskBytes?: number;
  replicaLagSeconds?: number;
  slotLagBytes?: number;
  unconsumedWalBytes?: number;
};

export type SourceCheckResponse = {
  source: string;
  checkedAt: string;
  ok: boolean;
  envCreationAllowed: boolean;
  compatibility: SourceCompatibilityResult;
  failedChecks: SourceCompatibilityCheckName[];
  blockingReasons: SourceCheckBlockingReason[];
  checks: SourceCheckDetail[];
  policyViolations: SourceCheckPolicyViolation[];
  alerts: SourceCheckAlert[];
  metrics: SourceCheckMetrics;
  sourceCompatibilityInput: SourceCompatibilityInput;
};

type SourceCheckDefinition = {
  input: SourceCompatibilityCheckName;
  probe: SourceProbeName;
  label: string;
};

export const SOURCE_CHECK_DEFINITIONS: readonly SourceCheckDefinition[] = [
  {
    input: "canConnect",
    probe: "connectivity",
    label: "source/read-replica connectivity"
  },
  {
    input: "replicationUserExists",
    probe: "replicationUser",
    label: "replication user exists"
  },
  {
    input: "pgBasebackupWorks",
    probe: "pgBasebackup",
    label: "pg_basebackup works"
  },
  {
    input: "walStreamWorks",
    probe: "walStream",
    label: "WAL stream works"
  },
  {
    input: "supportedPostgresVersion",
    probe: "postgresVersion",
    label: "Postgres version is supported"
  },
  {
    input: "extensionsCompatible",
    probe: "extensions",
    label: "required extensions are compatible"
  },
  {
    input: "diskSizeKnown",
    probe: "diskSize",
    label: "source disk size is known"
  },
  {
    input: "replicaLagObservable",
    probe: "replicaLag",
    label: "replay lag can be observed"
  },
  {
    input: "walPressureMetricsAvailable",
    probe: "walPressureMetrics",
    label: "replication slot/WAL pressure metrics are available"
  }
] as const;

export function buildSourceCompatibilityInput(probes: SourceCompatibilityProbeResults): SourceCompatibilityInput {
  return {
    canConnect: probePassed(probes.connectivity),
    replicationUserExists: probePassed(probes.replicationUser),
    pgBasebackupWorks: probePassed(probes.pgBasebackup),
    walStreamWorks: probePassed(probes.walStream),
    supportedPostgresVersion: probePassed(probes.postgresVersion),
    extensionsCompatible: probePassed(probes.extensions),
    diskSizeKnown: probePassed(probes.diskSize),
    replicaLagObservable: probePassed(probes.replicaLag),
    walPressureMetricsAvailable: probePassed(probes.walPressureMetrics)
  };
}

export function buildSourceCheckResponse(
  probes: SourceCompatibilityProbeResults,
  context: SourceCheckContext
): SourceCheckResponse {
  const sourceCompatibilityInput = buildSourceCompatibilityInput(probes);
  const compatibility = evaluateSourceCompatibility(sourceCompatibilityInput);
  const failedChecks = compatibility.failedChecks as SourceCompatibilityCheckName[];
  const policyViolations = evaluatePolicyViolations(probes, context.policy);
  const alerts = buildSourceCheckAlerts(policyViolations);
  const blockingReasons = [
    ...failedChecks,
    ...policyViolations.map((violation) => violation.reason)
  ];
  const ok = compatibility.ok && policyViolations.length === 0;

  return {
    source: context.source,
    checkedAt: context.checkedAt,
    ok,
    envCreationAllowed: ok,
    compatibility,
    failedChecks,
    blockingReasons,
    checks: buildCheckDetails(probes, sourceCompatibilityInput),
    policyViolations,
    alerts,
    metrics: extractMetrics(probes),
    sourceCompatibilityInput
  };
}

function buildCheckDetails(
  probes: SourceCompatibilityProbeResults,
  input: SourceCompatibilityInput
): SourceCheckDetail[] {
  return SOURCE_CHECK_DEFINITIONS.map((definition) => {
    const probe = probes[definition.probe];
    const detail: SourceCheckDetail = {
      name: definition.input,
      probe: definition.probe,
      label: definition.label,
      ok: input[definition.input],
      status: probe.status
    };
    if (probe.message !== undefined) {
      detail.message = probe.message;
    }
    if (probe.details !== undefined) {
      detail.details = probe.details;
    }
    return detail;
  });
}

function evaluatePolicyViolations(
  probes: SourceCompatibilityProbeResults,
  policy: SourceCheckPolicy | undefined
): SourceCheckPolicyViolation[] {
  if (policy === undefined) {
    return [];
  }
  const violations: SourceCheckPolicyViolation[] = [];
  addMaxViolation(violations, {
    observed: probes.replicaLag.lagSeconds,
    threshold: policy.maxReplicaLagSeconds,
    reason: "replica_lag_exceeds_max",
    metricLabel: "replica lag seconds"
  });
  addMaxViolation(violations, {
    observed: probes.walPressureMetrics.slotLagBytes,
    threshold: policy.maxSlotLagBytes,
    reason: "slot_lag_exceeds_max",
    metricLabel: "replication slot lag bytes"
  });
  addMaxViolation(violations, {
    observed: probes.walPressureMetrics.unconsumedWalBytes,
    threshold: policy.maxUnconsumedWalBytes,
    reason: "unconsumed_wal_exceeds_max",
    metricLabel: "unconsumed WAL bytes"
  });
  return violations;
}

function addMaxViolation(
  violations: SourceCheckPolicyViolation[],
  input: {
    observed: number | undefined;
    threshold: number | undefined;
    reason: SourceCheckPolicyViolation["reason"];
    metricLabel: string;
  }
): void {
  if (input.observed === undefined || input.threshold === undefined || input.observed <= input.threshold) {
    return;
  }
  violations.push({
    reason: input.reason,
    message: `${input.metricLabel} ${input.observed} exceeds ${input.threshold}`,
    observed: input.observed,
    threshold: input.threshold,
    blocksEnvCreation: true
  });
}

function buildSourceCheckAlerts(violations: readonly SourceCheckPolicyViolation[]): SourceCheckAlert[] {
  return violations.map((violation) => ({
    reason: violation.reason === "replica_lag_exceeds_max"
      ? "replica_lag_exceeds_max"
      : "source_wal_pressure_alarm",
    message: violation.message,
    observed: violation.observed,
    threshold: violation.threshold,
    blocksEnvCreation: true
  }));
}

function extractMetrics(probes: SourceCompatibilityProbeResults): SourceCheckMetrics {
  const metrics: SourceCheckMetrics = {};
  if (probes.postgresVersion.version !== undefined) {
    metrics.postgresVersion = probes.postgresVersion.version;
  }
  if (probes.diskSize.sizeBytes !== undefined) {
    metrics.sourceDiskBytes = probes.diskSize.sizeBytes;
  }
  if (probes.replicaLag.lagSeconds !== undefined) {
    metrics.replicaLagSeconds = probes.replicaLag.lagSeconds;
  }
  if (probes.walPressureMetrics.slotLagBytes !== undefined) {
    metrics.slotLagBytes = probes.walPressureMetrics.slotLagBytes;
  }
  if (probes.walPressureMetrics.unconsumedWalBytes !== undefined) {
    metrics.unconsumedWalBytes = probes.walPressureMetrics.unconsumedWalBytes;
  }
  return metrics;
}

function probePassed(probe: SourceCheckProbeResult): boolean {
  return probe.status === "pass";
}
