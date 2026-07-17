import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AdapterResponse } from "../adapters.js";
import type {
  BuildConfig,
  SandboxManifest,
  ServiceConfig,
  TestConfig,
} from "../types.js";
import { inspectDeclaredBuildFingerprint } from "../runtime/cache.js";
import { routeTerraformVariableFiles } from "../terraform-layout.js";
import {
  fingerprintImpactNode,
  fingerprintValue,
  type ImpactDigest,
} from "./fingerprint.js";
import {
  createImpactGraph,
  impactNodeId,
  type ImpactGraph,
  type ImpactNode,
} from "./graph.js";

const IMPACT_ENGINE_VERSION = 2;
const DEFAULT_EXCLUDES = [
  ".git/**",
  "**/.git/**",
  ".anbo/**",
  "**/.anbo/**",
  ".terraform/**",
  "**/.terraform/**",
  "node_modules/**",
  "**/node_modules/**",
  "coverage/**",
  "**/coverage/**",
  "artifacts/**",
  "**/artifacts/**",
  "evidence/**",
  "**/evidence/**",
];

export interface ProjectImpactGraphOptions {
  root: string;
  manifest: SandboxManifest;
  adapterResponses?: Readonly<Record<string, AdapterResponse>>;
  /** Reuse fingerprints already produced by build/Terraform reconciliation. */
  nodeFingerprints?: Readonly<Record<string, ImpactDigest>>;
  /** Runtime identity changes invalidate Terraform, services, and tests. */
  runtimeGeneration?: string;
}

/**
 * Build the host-owned graph from the manifest and project-relative inputs.
 * Runtime credentials and absolute checkout paths never enter a fingerprint.
 */
export async function createProjectImpactGraph(
  options: ProjectImpactGraphOptions,
): Promise<ImpactGraph> {
  const { root, manifest } = options;
  const nodes: ImpactNode[] = [];
  const variableFilesByRoot = routeTerraformVariableFiles(
    root,
    manifest.terraform.roots,
    manifest.terraform.variable_files,
  );
  const runtimeId = impactNodeId("runtime", "ministack");
  nodes.push({
    id: runtimeId,
    kind: "runtime",
    fingerprint: options.nodeFingerprints?.[runtimeId] ?? fingerprintValue({
      engine_version: IMPACT_ENGINE_VERSION,
      ministack: manifest.ministack,
      network: manifest.network,
      runtime_generation: options.runtimeGeneration ?? null,
      }, "anbo.impact.runtime.v1"),
    metadata: { runtime: "ministack" },
  });

  for (const [name, config] of sortedEntries(manifest.builds)) {
    const id = impactNodeId("build", name);
    const fingerprint = options.nodeFingerprints?.[id];
    nodes.push(fingerprint === undefined
      ? await buildNode(root, name, config)
      : {
          id,
          kind: "build",
          fingerprint,
          metadata: { context: config.context },
        });
  }

  for (const [index, rootPath] of manifest.terraform.roots.entries()) {
    const variableFiles = variableFilesByRoot.get(rootPath) ?? [];
    const id = impactNodeId("terraform", rootPath);
    const fingerprint = options.nodeFingerprints?.[id];
    nodes.push(fingerprint === undefined
      ? await fingerprintImpactNode({
          root,
          id,
          kind: "terraform",
          inputs: [rootPath, ...variableFiles],
          exclude: DEFAULT_EXCLUDES,
          definition: {
            engine_version: IMPACT_ENGINE_VERSION,
            index,
            root: rootPath,
            variable_files: variableFiles,
          },
          dependencies: [runtimeId],
          metadata: { root: rootPath, index },
        })
      : {
          id,
          kind: "terraform",
          fingerprint,
          dependencies: [runtimeId],
          metadata: { root: rootPath, index },
        });
  }

  for (const engine of ["postgres", "dynamodb"] as const) {
    const config = manifest.data[engine];
    if (config === undefined) continue;
    nodes.push({
      id: impactNodeId("clone", engine),
      kind: "clone",
      fingerprint: fingerprintValue({
        engine_version: IMPACT_ENGINE_VERSION,
        engine,
        config,
      }, "anbo.impact.clone.v1"),
      metadata: { engine, provider: config.provider },
    });
  }

  const contributed = adapterContributions(options.adapterResponses ?? {});
  for (const [name, config] of sortedEntries(manifest.adapters)) {
    const rootNodeId = impactNodeId("adapter", name);
    const suppliedRoot = contributed.find((node) => node.id === rootNodeId);
    if (suppliedRoot !== undefined) {
      nodes.push(suppliedRoot);
      continue;
    }
    const executableInput = adapterExecutableInput(root, config.executable);
    const stableExecutable = isAbsolute(config.executable)
      ? executableInput[0] ?? "<external-absolute-executable>"
      : config.executable;
    const fingerprinted = await fingerprintImpactNode({
      root,
      id: rootNodeId,
      kind: "adapter",
      inputs: executableInput,
      exclude: DEFAULT_EXCLUDES,
      definition: {
        engine_version: IMPACT_ENGINE_VERSION,
        executable: stableExecutable,
        protocol: config.protocol ?? 2,
        digest: config.digest ?? null,
        args: config.args ?? [],
        capabilities: config.capabilities ?? [],
        environment: config.environment ?? {},
        allowed_hosts: config.allowed_hosts ?? [],
      },
      metadata: { adapter: name },
    });
    nodes.push(config.digest === undefined && executableInput.length === 0
      ? {
          ...fingerprinted,
          certainty: "unknown",
          issues: [`Adapter ${name} is resolved through PATH without an immutable digest.`],
        }
      : fingerprinted);
  }
  nodes.push(...contributed.filter((node) => !nodes.some((entry) => entry.id === node.id)));

  for (const [name, config] of sortedEntries(manifest.services)) {
    nodes.push(serviceNode(name, config, manifest));
  }

  for (const [name, config] of sortedEntries(manifest.tests)) {
    nodes.push(await testNode(root, name, config, manifest));
  }

  return createImpactGraph(nodes);
}

async function buildNode(root: string, name: string, config: BuildConfig): Promise<ImpactNode> {
  const fingerprint = await inspectDeclaredBuildFingerprint(root, config);
  return {
    id: impactNodeId("build", name),
    kind: "build",
    fingerprint: `sha256:${fingerprint.value}`,
    certainty: fingerprint.certainty,
    ...(fingerprint.issues.length === 0 ? {} : { issues: fingerprint.issues }),
    metadata: { context: config.context },
  };
}

function serviceNode(
  name: string,
  config: ServiceConfig,
  manifest: SandboxManifest,
): ImpactNode {
  const dependencies = new Set<string>([impactNodeId("runtime", "ministack")]);
  const issues: string[] = [];
  if (config.build !== undefined) {
    if (manifest.builds[config.build] === undefined) {
      issues.push(`Service ${name} references build ${config.build}, which is absent from the impact graph.`);
    } else {
      dependencies.add(impactNodeId("build", config.build));
    }
  }
  for (const dependency of config.depends_on ?? []) {
    dependencies.add(impactNodeId("service", dependency));
  }
  // Terraform outputs and runtime data bindings are made available to every
  // declared service, so their change conservatively invalidates the service.
  for (const root of manifest.terraform.roots) dependencies.add(impactNodeId("terraform", root));
  for (const engine of Object.keys(manifest.data)) {
    if (manifest.data[engine as keyof typeof manifest.data] !== undefined) {
      dependencies.add(impactNodeId("clone", engine));
    }
  }
  for (const adapter of Object.keys(manifest.adapters)) dependencies.add(impactNodeId("adapter", adapter));
  return {
    id: impactNodeId("service", name),
    kind: "service",
    fingerprint: fingerprintValue({
      engine_version: IMPACT_ENGINE_VERSION,
      config,
    }, "anbo.impact.service.v1"),
    dependencies: [...dependencies],
    ...(issues.length === 0 ? {} : { certainty: "unknown" as const, issues }),
    metadata: { service: name },
  };
}

async function testNode(
  root: string,
  name: string,
  config: TestConfig,
  manifest: SandboxManifest,
): Promise<ImpactNode> {
  const dependencies = new Set<string>(config.requires ?? []);
  const issues: string[] = [];
  if (config.service !== undefined) {
    if (manifest.services[config.service] === undefined) {
      issues.push(`Test ${name} uses deployed service ${config.service}, which is absent from the impact graph.`);
    } else {
      dependencies.add(impactNodeId("service", config.service));
    }
  }
  for (const service of config.depends_on ?? []) {
    if (manifest.services[service] === undefined) {
      issues.push(`Test ${name} depends on deployed service ${service}, which is absent from the impact graph.`);
    } else {
      dependencies.add(impactNodeId("service", service));
    }
  }
  const node = await fingerprintImpactNode({
    root,
    id: impactNodeId("test", name),
    kind: "test",
    inputs: config.inputs ?? [],
    exclude: DEFAULT_EXCLUDES,
    definition: {
      engine_version: IMPACT_ENGINE_VERSION,
      command: config.command,
      service: config.service ?? null,
      environment: config.environment ?? {},
      timeout_seconds: config.timeout_seconds ?? 300,
      tags: config.tags ?? [],
      default: config.default === true,
    },
    dependencies: [...dependencies],
    cacheable: config.cache !== false,
    alwaysRun: config.always_run === true,
    metadata: {
      test: name,
      default: config.default === true,
      tags: config.tags ?? [],
    },
  });
  return issues.length === 0
    ? node
    : {
        ...node,
        certainty: "unknown",
        issues: [...(node.issues ?? []), ...issues],
      };
}

function adapterContributions(
  responses: Readonly<Record<string, AdapterResponse>>,
): ImpactNode[] {
  const nodes: ImpactNode[] = [];
  for (const [adapter, response] of sortedEntries(responses)) {
    for (const node of response.impact?.nodes ?? []) {
      nodes.push({
        id: node.id,
        kind: node.kind,
        fingerprint: node.fingerprint as ImpactDigest,
        certainty: node.certainty ?? "exact",
        dependencies: node.dependencies ?? (
          node.id === impactNodeId("adapter", adapter)
            ? []
            : [impactNodeId("adapter", adapter)]
        ),
        ...(node.issues === undefined ? {} : { issues: node.issues }),
        ...(node.cacheable === undefined ? {} : { cacheable: node.cacheable }),
        ...(node.always_run === undefined ? {} : { alwaysRun: node.always_run }),
        metadata: { adapter, ...(node.metadata ?? {}) },
      });
    }
  }
  return nodes;
}

function adapterExecutableInput(root: string, executable: string): string[] {
  if (!executable.includes("/") && !isAbsolute(executable)) return [];
  if (!isAbsolute(executable)) return [executable];
  const projectRoot = resolve(root);
  const relativePath = relative(projectRoot, resolve(executable));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return [];
  return [relativePath];
}

function sortedEntries<T>(record: Readonly<Record<string, T>>): Array<[string, T]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}
