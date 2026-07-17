import { fingerprintValue, type ImpactDigest } from "./fingerprint.js";
import type { ImpactGraph, ImpactNodeKind, NormalizedImpactNode } from "./graph.js";
import type { ImpactLedger, ImpactLedgerNode } from "./ledger.js";

export type ImpactPlanMode = "affected" | "full" | "cold";
export type ImpactPlanAction = "execute" | "reuse" | "remove";

export type ImpactReasonCode =
  | "new_node"
  | "cold_run"
  | "fingerprint_changed"
  | "dependency_fingerprint_changed"
  | "dependency_selected"
  | "previous_failed"
  | "previous_dirty"
  | "unknown_inputs"
  | "cache_disabled"
  | "always_run"
  | "forced"
  | "full_verification"
  | "cache_hit"
  | "removed_node";

export interface ImpactPlanReason {
  code: ImpactReasonCode;
  source?: string;
  detail: string;
}

export interface ImpactPlanItem {
  id: string;
  kind: ImpactNodeKind;
  action: Exclude<ImpactPlanAction, "remove">;
  fingerprint: ImpactDigest;
  effectiveFingerprint: ImpactDigest;
  reasons: readonly ImpactPlanReason[];
  dependencies: readonly string[];
}

export interface RemovedImpactPlanItem {
  id: string;
  kind: ImpactNodeKind;
  action: "remove";
  reasons: readonly ImpactPlanReason[];
  dependencies: readonly string[];
}

export interface ImpactPlan {
  schemaVersion: 1;
  mode: ImpactPlanMode;
  fingerprint: ImpactDigest;
  graphFingerprint: ImpactDigest;
  items: ReadonlyMap<string, ImpactPlanItem>;
  removed: ReadonlyMap<string, RemovedImpactPlanItem>;
  executionOrder: readonly string[];
  removalOrder: readonly string[];
  summary: {
    execute: number;
    reuse: number;
    remove: number;
  };
}

export interface ImpactPlanDocument {
  schema_version: 1;
  mode: ImpactPlanMode;
  fingerprint: ImpactDigest;
  graph_fingerprint: ImpactDigest;
  summary: ImpactPlan["summary"];
  execution_order: readonly string[];
  removal_order: readonly string[];
  nodes: readonly {
    id: string;
    kind: ImpactNodeKind;
    action: "execute" | "reuse";
    fingerprint: ImpactDigest;
    effective_fingerprint: ImpactDigest;
    dependencies: readonly string[];
    reasons: readonly ImpactPlanReason[];
  }[];
  removed: readonly {
    id: string;
    kind: ImpactNodeKind;
    action: "remove";
    dependencies: readonly string[];
    reasons: readonly ImpactPlanReason[];
  }[];
}

export interface PlanImpactOptions {
  mode?: ImpactPlanMode;
  /** Full mode forces these kinds; defaults to tests while reusing healthy infrastructure. */
  fullKinds?: readonly ImpactNodeKind[];
  forceNodeIds?: readonly string[];
  /** `all` is available for adapters that cannot describe a safe affected subtree. */
  unknownPolicy?: "downstream" | "all";
}

export function planImpact(
  graph: ImpactGraph,
  ledger: ImpactLedger,
  options: PlanImpactOptions = {},
): ImpactPlan {
  const mode = options.mode ?? "affected";
  const fullKinds = new Set(options.fullKinds ?? ["test"]);
  const forceNodeIds = new Set(options.forceNodeIds ?? []);
  const unknownPolicy = options.unknownPolicy ?? "downstream";
  for (const id of forceNodeIds) {
    if (!graph.nodes.has(id)) throw new Error(`forced impact node does not exist: ${id}`);
  }

  const effective = effectiveFingerprints(graph);
  const reasons = new Map<string, ImpactPlanReason[]>();
  const select = (id: string, reason: ImpactPlanReason): void => {
    const entries = reasons.get(id) ?? [];
    if (!entries.some((entry) => entry.code === reason.code && entry.source === reason.source)) {
      entries.push(reason);
      reasons.set(id, entries);
    }
  };

  for (const id of graph.topologicalOrder) {
    const node = graph.nodes.get(id)!;
    const previous = ledger.nodes[id];
    if (mode === "cold") {
      select(id, reason("cold_run", "Cold mode does not reuse prior results."));
    }
    if (mode === "full" && fullKinds.has(node.kind)) {
      select(id, reason("full_verification", `Full verification forces every ${node.kind} node.`));
    }
    if (forceNodeIds.has(id)) {
      select(id, reason("forced", "The caller explicitly selected this node."));
    }
    if (node.alwaysRun) {
      select(id, reason("always_run", "The node is configured to run on every plan."));
    }
    if (!node.cacheable) {
      select(id, reason("cache_disabled", "Caching is disabled for this node."));
    }
    if (node.certainty === "unknown") {
      select(id, reason("unknown_inputs", node.issues.join("; ") || "The node's inputs could not be fingerprinted exactly."));
    }
    if (previous === undefined) {
      select(id, reason("new_node", "No successful prior result exists for this node."));
      continue;
    }
    if (previous.status === "failed") {
      select(id, reason("previous_failed", "The previous execution failed."));
    } else if (previous.status === "dirty") {
      select(id, reason("previous_dirty", "The previous execution was interrupted or left dirty."));
    }
    if (previous.fingerprint !== node.fingerprint) {
      select(id, reason("fingerprint_changed", "The node definition or one of its direct inputs changed."));
    } else if (previous.effective_fingerprint !== effective.get(id)) {
      select(id, reason("dependency_fingerprint_changed", "At least one dependency fingerprint changed."));
    }
  }

  if (unknownPolicy === "all" && [...graph.nodes.values()].some((node) => node.certainty === "unknown")) {
    for (const id of graph.topologicalOrder) {
      select(id, reason("unknown_inputs", "An adapter requested a conservative full-graph fallback for unknown inputs."));
    }
  }

  // Selection propagates to the dependent subtree. This is conservative when
  // outputs happen to remain identical, and the next plan recovers the cache.
  for (const id of graph.topologicalOrder) {
    if (!reasons.has(id)) continue;
    for (const dependent of graph.dependents.get(id) ?? []) {
      select(dependent, {
        code: "dependency_selected",
        source: id,
        detail: `Dependency ${id} must execute in this plan.`,
      });
    }
  }

  const items = new Map<string, ImpactPlanItem>();
  for (const id of graph.topologicalOrder) {
    const node = graph.nodes.get(id)!;
    const nodeReasons = reasons.get(id);
    items.set(id, {
      id,
      kind: node.kind,
      action: nodeReasons === undefined ? "reuse" : "execute",
      fingerprint: node.fingerprint,
      effectiveFingerprint: effective.get(id)!,
      reasons: nodeReasons ?? [reason("cache_hit", "The successful prior result matches all current inputs.")],
      dependencies: node.dependencies,
    });
  }

  const removed = removedItems(graph, ledger);
  const removalOrder = removalSequence(removed);
  const executionOrder = graph.topologicalOrder.filter((id) => items.get(id)?.action === "execute");
  const summary = {
    execute: executionOrder.length,
    reuse: graph.nodes.size - executionOrder.length,
    remove: removalOrder.length,
  };
  const fingerprint = fingerprintValue({
    schema_version: 1,
    mode,
    graph_fingerprint: graph.fingerprint,
    items: graph.topologicalOrder.map((id) => {
      const item = items.get(id)!;
      return {
        id,
        action: item.action,
        effective_fingerprint: item.effectiveFingerprint,
        reasons: item.reasons.map(({ code, source }) => ({ code, ...(source === undefined ? {} : { source }) })),
      };
    }),
    removals: removalOrder,
  }, "anbo.impact.plan.v1");

  return {
    schemaVersion: 1,
    mode,
    fingerprint,
    graphFingerprint: graph.fingerprint,
    items,
    removed,
    executionOrder,
    removalOrder,
    summary,
  };
}

/** JSON-safe representation used by `anbo impact --json` and JSONL events. */
export function impactPlanDocument(plan: ImpactPlan): ImpactPlanDocument {
  return {
    schema_version: 1,
    mode: plan.mode,
    fingerprint: plan.fingerprint,
    graph_fingerprint: plan.graphFingerprint,
    summary: plan.summary,
    execution_order: plan.executionOrder,
    removal_order: plan.removalOrder,
    nodes: [...plan.items.values()].map((item) => ({
      id: item.id,
      kind: item.kind,
      action: item.action,
      fingerprint: item.fingerprint,
      effective_fingerprint: item.effectiveFingerprint,
      dependencies: item.dependencies,
      reasons: item.reasons,
    })),
    removed: [...plan.removed.values()].map((item) => ({
      id: item.id,
      kind: item.kind,
      action: item.action,
      dependencies: item.dependencies,
      reasons: item.reasons,
    })),
  };
}

function effectiveFingerprints(graph: ImpactGraph): Map<string, ImpactDigest> {
  const result = new Map<string, ImpactDigest>();
  for (const id of graph.topologicalOrder) {
    const node = graph.nodes.get(id)!;
    result.set(id, fingerprintValue({
      schema_version: 1,
      id,
      kind: node.kind,
      fingerprint: node.fingerprint,
      dependencies: node.dependencies.map((dependency) => ({
        id: dependency,
        effective_fingerprint: result.get(dependency)!,
      })),
    }, "anbo.impact.effective.v1"));
  }
  return result;
}

function removedItems(
  graph: ImpactGraph,
  ledger: ImpactLedger,
): Map<string, RemovedImpactPlanItem> {
  const removed = new Map<string, RemovedImpactPlanItem>();
  for (const [id, previous] of Object.entries(ledger.nodes).sort(([left], [right]) => compareText(left, right))) {
    if (graph.nodes.has(id)) continue;
    removed.set(id, {
      id,
      kind: previous.kind,
      action: "remove",
      reasons: [reason("removed_node", "The node no longer exists in the current graph.")],
      dependencies: previous.dependencies,
    });
  }
  return removed;
}

function removalSequence(removed: ReadonlyMap<string, RemovedImpactPlanItem>): string[] {
  const pending = new Set(removed.keys());
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((id) => {
        // Remove dependents before their dependencies.
        return ![...pending].some((candidate) =>
          candidate !== id && (removed.get(candidate)?.dependencies ?? []).includes(id)
        );
      })
      .sort(compareText);
    if (ready.length === 0) {
      // A corrupt historical dependency cycle must not make planning hang.
      order.push(...[...pending].sort(compareText).reverse());
      break;
    }
    for (const id of ready) {
      pending.delete(id);
      order.push(id);
    }
  }
  return order;
}

function reason(code: ImpactReasonCode, detail: string): ImpactPlanReason {
  return { code, detail };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
