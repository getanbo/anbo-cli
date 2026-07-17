import { fingerprintValue, type ImpactCertainty, type ImpactDigest } from "./fingerprint.js";

export const IMPACT_GRAPH_SCHEMA_VERSION = 1 as const;

export type ImpactNodeKind =
  | "runtime"
  | "build"
  | "terraform"
  | "clone"
  | "adapter"
  | "service"
  | "test";

export interface ImpactNode {
  id: string;
  kind: ImpactNodeKind;
  /** Content fingerprint for this node's own definition and filesystem inputs. */
  fingerprint: ImpactDigest;
  certainty?: ImpactCertainty;
  dependencies?: readonly string[];
  issues?: readonly string[];
  cacheable?: boolean;
  alwaysRun?: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface NormalizedImpactNode {
  id: string;
  kind: ImpactNodeKind;
  fingerprint: ImpactDigest;
  certainty: ImpactCertainty;
  dependencies: readonly string[];
  issues: readonly string[];
  cacheable: boolean;
  alwaysRun: boolean;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ImpactGraph {
  schemaVersion: typeof IMPACT_GRAPH_SCHEMA_VERSION;
  fingerprint: ImpactDigest;
  nodes: ReadonlyMap<string, NormalizedImpactNode>;
  topologicalOrder: readonly string[];
  dependents: ReadonlyMap<string, readonly string[]>;
}

const NODE_KINDS = new Set<ImpactNodeKind>([
  "runtime",
  "build",
  "terraform",
  "clone",
  "adapter",
  "service",
  "test",
]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function impactNodeId(kind: ImpactNodeKind, name: string): string {
  if (!NODE_KINDS.has(kind)) throw new Error(`unsupported impact node kind: ${kind}`);
  if (name.length === 0 || name.includes("\0") || /[\r\n]/.test(name)) {
    throw new Error("impact node names must be non-empty and contain no control line breaks");
  }
  return `${kind}:${name}`;
}

export function createImpactGraph(input: readonly ImpactNode[]): ImpactGraph {
  const nodes = new Map<string, NormalizedImpactNode>();
  for (const candidate of [...input].sort((left, right) => compareText(left.id, right.id))) {
    validateNode(candidate);
    if (nodes.has(candidate.id)) throw new Error(`duplicate impact node: ${candidate.id}`);
    nodes.set(candidate.id, {
      id: candidate.id,
      kind: candidate.kind,
      fingerprint: candidate.fingerprint,
      certainty: candidate.certainty ?? "exact",
      dependencies: [...new Set(candidate.dependencies ?? [])].sort(compareText),
      issues: [...new Set(candidate.issues ?? [])].sort(compareText),
      cacheable: candidate.cacheable ?? true,
      alwaysRun: candidate.alwaysRun ?? false,
      metadata: candidate.metadata ?? {},
    });
  }

  const dependents = new Map<string, string[]>(
    [...nodes.keys()].map((id) => [id, []]),
  );
  for (const node of nodes.values()) {
    for (const dependency of node.dependencies) {
      if (dependency === node.id) throw new Error(`impact node ${node.id} cannot depend on itself`);
      if (!nodes.has(dependency)) throw new Error(`impact node ${node.id} references missing dependency ${dependency}`);
      dependents.get(dependency)!.push(node.id);
    }
  }
  for (const entries of dependents.values()) entries.sort(compareText);

  const topologicalOrder = topologicalSort(nodes, dependents);
  const fingerprint = fingerprintValue({
    schema_version: IMPACT_GRAPH_SCHEMA_VERSION,
    nodes: topologicalOrder.map((id) => {
      const node = nodes.get(id)!;
      return {
        id: node.id,
        kind: node.kind,
        fingerprint: node.fingerprint,
        certainty: node.certainty,
        dependencies: node.dependencies,
        cacheable: node.cacheable,
        always_run: node.alwaysRun,
      };
    }),
  }, "anbo.impact.graph.v1");

  return {
    schemaVersion: IMPACT_GRAPH_SCHEMA_VERSION,
    fingerprint,
    nodes,
    topologicalOrder,
    dependents,
  };
}

function validateNode(node: ImpactNode): void {
  if (!NODE_KINDS.has(node.kind)) throw new Error(`unsupported impact node kind: ${String(node.kind)}`);
  if (!node.id.startsWith(`${node.kind}:`) || node.id.length === node.kind.length + 1 || /[\0\r\n]/.test(node.id)) {
    throw new Error(`impact node id must use the ${node.kind}:<name> namespace: ${node.id}`);
  }
  if (!DIGEST.test(node.fingerprint)) throw new Error(`impact node ${node.id} has an invalid sha256 fingerprint`);
  if (node.certainty !== undefined && node.certainty !== "exact" && node.certainty !== "unknown") {
    throw new Error(`impact node ${node.id} has invalid certainty`);
  }
  if (node.certainty === "unknown" && (node.issues?.length ?? 0) === 0) {
    throw new Error(`impact node ${node.id} must explain why its fingerprint is unknown`);
  }
}

function topologicalSort(
  nodes: ReadonlyMap<string, NormalizedImpactNode>,
  dependents: ReadonlyMap<string, readonly string[]>,
): string[] {
  const remaining = new Map([...nodes].map(([id, node]) => [id, node.dependencies.length]));
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id).sort(compareText);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) insertSorted(ready, dependent);
    }
  }
  if (order.length !== nodes.size) {
    const cyclic = [...remaining].filter(([, count]) => count > 0).map(([id]) => id).sort(compareText);
    throw new Error(`impact graph contains a dependency cycle: ${cyclic.join(", ")}`);
  }
  return order;
}

function insertSorted(values: string[], value: string): void {
  let index = 0;
  while (index < values.length && compareText(values[index]!, value) < 0) index += 1;
  values.splice(index, 0, value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
