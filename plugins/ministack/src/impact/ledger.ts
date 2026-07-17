import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, type ImpactCertainty, type ImpactDigest } from "./fingerprint.js";
import type { ImpactGraph, ImpactNodeKind } from "./graph.js";

export const IMPACT_LEDGER_SCHEMA_VERSION = 1 as const;

export type ImpactLedgerNodeStatus = "succeeded" | "failed" | "dirty";

export interface ImpactLedgerNode {
  id: string;
  kind: ImpactNodeKind;
  fingerprint: ImpactDigest;
  effective_fingerprint: ImpactDigest;
  output_fingerprint: ImpactDigest;
  certainty: ImpactCertainty;
  status: ImpactLedgerNodeStatus;
  dependencies: string[];
  updated_at: string;
}

export interface ImpactLedger {
  schema_version: typeof IMPACT_LEDGER_SCHEMA_VERSION;
  graph_fingerprint?: ImpactDigest;
  updated_at?: string;
  nodes: Record<string, ImpactLedgerNode>;
}

export interface ImpactLedgerReadResult {
  ledger: ImpactLedger;
  status: "loaded" | "missing" | "invalid";
  issues: readonly string[];
}

export interface ImpactExecutionResult {
  id: string;
  status: ImpactLedgerNodeStatus | "removed";
  effectiveFingerprint?: ImpactDigest;
  outputFingerprint?: ImpactDigest;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NODE_STATUSES = new Set<ImpactLedgerNodeStatus>(["succeeded", "failed", "dirty"]);
const NODE_KINDS = new Set<ImpactNodeKind>(["runtime", "build", "terraform", "clone", "adapter", "service", "test"]);

export function emptyImpactLedger(): ImpactLedger {
  return { schema_version: IMPACT_LEDGER_SCHEMA_VERSION, nodes: {} };
}

/**
 * Invalid state never creates a cache hit. Callers receive an empty ledger and
 * diagnostics so a corrupt or newer ledger degrades to a conservative run.
 */
export async function readImpactLedger(path: string): Promise<ImpactLedgerReadResult> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ledger: emptyImpactLedger(), status: "missing", issues: [] };
    }
    return {
      ledger: emptyImpactLedger(),
      status: "invalid",
      issues: [`could not read impact ledger: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  try {
    const value = JSON.parse(source) as unknown;
    return { ledger: parseImpactLedger(value), status: "loaded", issues: [] };
  } catch (error) {
    return {
      ledger: emptyImpactLedger(),
      status: "invalid",
      issues: [`impact ledger is invalid: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function parseImpactLedger(value: unknown): ImpactLedger {
  if (!isRecord(value) || value["schema_version"] !== IMPACT_LEDGER_SCHEMA_VERSION || !isRecord(value["nodes"])) {
    throw new Error(`schema_version must equal ${IMPACT_LEDGER_SCHEMA_VERSION} and nodes must be an object`);
  }
  if (value["graph_fingerprint"] !== undefined && !isDigest(value["graph_fingerprint"])) {
    throw new Error("graph_fingerprint must be a sha256 digest");
  }
  if (value["updated_at"] !== undefined && !validDate(value["updated_at"])) {
    throw new Error("updated_at must be an ISO timestamp");
  }
  const nodes: Record<string, ImpactLedgerNode> = {};
  for (const [id, candidate] of Object.entries(value["nodes"]).sort(([left], [right]) => compareText(left, right))) {
    if (!isRecord(candidate)
      || candidate["id"] !== id
      || !NODE_KINDS.has(candidate["kind"] as ImpactNodeKind)
      || !isDigest(candidate["fingerprint"])
      || !isDigest(candidate["effective_fingerprint"])
      || !isDigest(candidate["output_fingerprint"])
      || (candidate["certainty"] !== "exact" && candidate["certainty"] !== "unknown")
      || !NODE_STATUSES.has(candidate["status"] as ImpactLedgerNodeStatus)
      || !Array.isArray(candidate["dependencies"])
      || candidate["dependencies"].some((dependency) => typeof dependency !== "string")
      || !validDate(candidate["updated_at"])) {
      throw new Error(`nodes.${id} is invalid`);
    }
    nodes[id] = {
      id,
      kind: candidate["kind"] as ImpactNodeKind,
      fingerprint: candidate["fingerprint"],
      effective_fingerprint: candidate["effective_fingerprint"],
      output_fingerprint: candidate["output_fingerprint"],
      certainty: candidate["certainty"],
      status: candidate["status"] as ImpactLedgerNodeStatus,
      dependencies: [...new Set(candidate["dependencies"] as string[])].sort(compareText),
      updated_at: candidate["updated_at"],
    };
  }
  return {
    schema_version: IMPACT_LEDGER_SCHEMA_VERSION,
    ...(value["graph_fingerprint"] === undefined ? {} : { graph_fingerprint: value["graph_fingerprint"] }),
    ...(value["updated_at"] === undefined ? {} : { updated_at: value["updated_at"] }),
    nodes,
  };
}

export async function writeImpactLedger(path: string, ledger: ImpactLedger): Promise<void> {
  const parsed = parseImpactLedger(ledger);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${canonicalJson(parsed)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Apply phase results independently. Successful infrastructure nodes may be
 * committed even when a later test fails, allowing the next run to retry only
 * the failed test.
 */
export function updateImpactLedger(
  previous: ImpactLedger,
  graph: ImpactGraph,
  results: readonly ImpactExecutionResult[],
  options: { updatedAt?: string } = {},
): ImpactLedger {
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  if (!validDate(updatedAt)) throw new Error("updatedAt must be an ISO timestamp");
  const nodes = structuredClone(previous.nodes);
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.id)) throw new Error(`duplicate impact result: ${result.id}`);
    seen.add(result.id);
    if (result.status === "removed") {
      if (graph.nodes.has(result.id)) throw new Error(`cannot remove current impact node: ${result.id}`);
      delete nodes[result.id];
      continue;
    }
    const node = graph.nodes.get(result.id);
    if (node === undefined) throw new Error(`impact result references unknown node: ${result.id}`);
    if (result.effectiveFingerprint === undefined || !isDigest(result.effectiveFingerprint)) {
      throw new Error(`impact result ${result.id} requires an effective fingerprint`);
    }
    const output = result.outputFingerprint ?? result.effectiveFingerprint;
    if (!isDigest(output)) throw new Error(`impact result ${result.id} has an invalid output fingerprint`);
    nodes[result.id] = {
      id: result.id,
      kind: node.kind,
      fingerprint: node.fingerprint,
      effective_fingerprint: result.effectiveFingerprint,
      output_fingerprint: output,
      certainty: node.certainty,
      status: result.status,
      dependencies: [...node.dependencies],
      updated_at: updatedAt,
    };
  }
  return {
    schema_version: IMPACT_LEDGER_SCHEMA_VERSION,
    graph_fingerprint: graph.fingerprint,
    updated_at: updatedAt,
    nodes: Object.fromEntries(Object.entries(nodes).sort(([left], [right]) => compareText(left, right))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value: unknown): value is ImpactDigest {
  return typeof value === "string" && DIGEST.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
