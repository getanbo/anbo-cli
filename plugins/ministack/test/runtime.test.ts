import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginContextV1 } from "@getanbo/plugin-sdk";

import { classifyRuntimeError, runDeploy } from "../src/deploy.js";
import { PluginEventSink } from "../src/event-sink.js";
import { buildDeclaredImages, pruneBuildCache } from "../src/runtime/cache.js";
import { acquireClone, acquireConfiguredClones, readCloneState } from "../src/runtime/clones.js";
import {
  resolveMiniStackImage,
  startMiniStack,
  stopMiniStack,
  type CommandExecutor,
  type MiniStackRuntimeConfig,
  type RuntimeCommandOptions,
  type RuntimeCommandResult,
} from "../src/runtime/ministack.js";
import {
  refreshRuntimeBoundServices,
  resolveServiceEnvironment,
  runConfiguredTests,
  runtimeBoundServiceNames,
  stopDeclaredServices,
  type ServiceRuntimeContext,
} from "../src/runtime/services.js";
import {
  runTerraform,
  scrubTerraformEnvironment,
  terraformWorkerUserArguments,
  validateTerraformHcl,
  type TerraformLifecycleEvent,
} from "../src/runtime/terraform.js";
import {
  terraformReconciliationFingerprint,
  terraformRootStateKey,
} from "../src/runtime/terraform-reconciliation.js";
import { deriveRuntimeProjectId, OperationLockedError, ProjectSupervisor } from "../src/supervisor.js";
import { AnboError, ExitCode, type SandboxManifest } from "../src/types.js";

class RecordingExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[]; options?: RuntimeCommandOptions }> = [];

  constructor(private readonly responder: (command: string, args: readonly string[], options?: RuntimeCommandOptions) => RuntimeCommandResult | Promise<RuntimeCommandResult>) {}

  async run(command: string, args: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
    this.calls.push({ command, args: [...args], ...(options === undefined ? {} : { options }) });
    return await this.responder(command, args, options);
  }
}

class IncrementalDeployExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[]; options?: RuntimeCommandOptions }> = [];
  readonly terraformCommands: Array<{ command: string; stateKey: string }> = [];
  planCode: 0 | 2 = 2;
  failApplicationNetwork = false;
  private containerExists = false;
  private containerRunning = true;
  private containerId = "ministack-container-1";
  private runtimeGeneration = "generation-1";
  private image = "";
  private configLabel = "";
  private hostPort = "4566";
  private controlNetwork = "";
  private runtimeNetwork = "";
  private stateSerial = 0;
  private generationSerial = 1;
  private containerSerial = 1;

  async run(command: string, args: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
    this.calls.push({ command, args: [...args], ...(options === undefined ? {} : { options }) });
    if (args[0] === "network" && args[1] === "inspect") {
      if (this.failApplicationNetwork && args[2]?.endsWith("-app") === true) {
        return { code: 1, stdout: "", stderr: "missing" };
      }
      return {
        code: 0,
        stdout: JSON.stringify([{ Internal: args[2]?.endsWith("-control") === true }]),
        stderr: "",
      };
    }
    if (this.failApplicationNetwork && args[0] === "network" && args[1] === "create" && args.at(-1)?.endsWith("-app") === true) {
      return { code: 1, stdout: "", stderr: "injected application network failure" };
    }
    if (args[0] === "network" && args[1] === "connect" && args[3]?.endsWith("-ministack") === true) {
      if (args[2]?.endsWith("-control") === true) this.controlNetwork = args[2];
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") return { code: 0, stdout: "[]", stderr: "" };
    if (args[0] === "inspect") {
      return this.containerExists
        ? { code: 0, stdout: this.inspection(), stderr: "" }
        : { code: 1, stdout: "", stderr: "No such container" };
    }
    if (args[0] === "run" && args.includes("--rm")) return await this.runTerraform(args);
    if (args[0] === "run" && args.includes("--detach") && args.some((value) => value.endsWith("-ministack"))) {
      this.containerExists = true;
      this.containerRunning = true;
      this.image = args.at(-1) ?? "";
      this.configLabel = args.find((value) => value.startsWith("anbo.dev/runtime-config="))?.split("=")[1] ?? "";
      this.hostPort = args.find((value) => value.startsWith("127.0.0.1:") && value.endsWith(":4566"))?.split(":")[1] ?? "4566";
      const networkIndex = args.indexOf("--network");
      this.runtimeNetwork = networkIndex < 0 ? "" : args[networkIndex + 1] ?? "";
      return { code: 0, stdout: `${this.containerId}\n`, stderr: "" };
    }
    if (args[0] === "start") {
      this.containerRunning = true;
      this.runtimeGeneration = `generation-${++this.generationSerial}`;
      return { code: 0, stdout: `${this.containerId}\n`, stderr: "" };
    }
    if (args[0] === "stop") {
      this.containerRunning = false;
      return { code: 0, stdout: `${this.containerId}\n`, stderr: "" };
    }
    if (args[0] === "rm" && args.some((value) => value.endsWith("-ministack"))) {
      this.containerExists = false;
      return { code: 0, stdout: this.containerId, stderr: "" };
    }
    if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  restartOutOfBand(): void {
    this.containerRunning = true;
    this.runtimeGeneration = `generation-${++this.generationSerial}`;
  }

  recreateOutOfBand(): void {
    this.containerExists = true;
    this.containerRunning = true;
    this.containerId = `ministack-container-${++this.containerSerial}`;
    this.runtimeGeneration = `generation-${++this.generationSerial}`;
  }

  private async runTerraform(args: readonly string[]): Promise<RuntimeCommandResult> {
    const command = ["init", "validate", "plan", "show", "apply", "output"].find((candidate) => args.includes(candidate));
    assert.ok(command);
    const stateMount = args.find((value) => value.startsWith("type=bind,src=") && value.endsWith(",dst=/anbo-state"));
    assert.ok(stateMount);
    const stateDirectory = stateMount.slice("type=bind,src=".length, -",dst=/anbo-state".length);
    const stateKey = stateDirectory.split("/").at(-1) ?? "unknown";
    this.terraformCommands.push({ command, stateKey });
    if (command === "plan") return {
      code: this.planCode,
      stdout: this.planCode === 0 ? "No changes.\n" : "Plan: 1 to add, 0 to change, 0 to destroy.\n",
      stderr: "",
    };
    if (command === "show") return {
      code: 0,
      stdout: JSON.stringify({ resource_changes: [{ change: { actions: ["create"] } }] }),
      stderr: "",
    };
    if (command === "apply") {
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(join(stateDirectory, "terraform.tfstate"), JSON.stringify({ serial: ++this.stateSerial, root: stateKey }));
      return { code: 0, stdout: "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.\n", stderr: "" };
    }
    if (command === "output") return {
      code: 0,
      stdout: JSON.stringify({ [`output_${stateKey.slice(0, 8)}`]: { sensitive: false, value: stateKey } }),
      stderr: "",
    };
    return { code: 0, stdout: "", stderr: "" };
  }

  private inspection(): string {
    return JSON.stringify([{
      Id: this.containerId,
      Config: {
        Image: this.image,
        Env: ["LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway"],
        Labels: { "anbo.dev/runtime-config": this.configLabel },
      },
      State: { Running: this.containerRunning, ExitCode: 0, StartedAt: this.runtimeGeneration },
      HostConfig: {
        PortBindings: { "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: this.hostPort }] },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
      NetworkSettings: {
        Networks: {
          [this.controlNetwork]: {},
          [this.runtimeNetwork]: {},
        },
      },
    }]);
  }
}

function eventSink(output: string[] = []): PluginEventSink {
  const context = {
    signal: new AbortController().signal,
    events: {
      emit: async (event: unknown) => { output.push(`${JSON.stringify(event)}\n`); },
    },
  } as unknown as PluginContextV1;
  return new PluginEventSink(context, `test_${Math.random().toString(36).slice(2)}`);
}

test("MiniStack accepts only digest-pinned full images", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const certifiedDigest = "sha256:cf29ce9cacd3982531b5f5bd48a7b46c10acaf4f44a10fb25831b3073c26b204";
  const certifiedImage = `ghcr.io/getanbo/anbo-ministack@${certifiedDigest}`;
  assert.equal(resolveMiniStackImage(certifiedImage, certifiedDigest), certifiedImage);
  assert.equal(
    resolveMiniStackImage("ministackorg/ministack:1.4.2-full", digest),
    `ministackorg/ministack:1.4.2-full@${digest}`,
  );
  assert.equal(resolveMiniStackImage(`ministackorg/ministack:full@${digest}`), `ministackorg/ministack:full@${digest}`);
  assert.throws(() => resolveMiniStackImage(certifiedImage, `sha256:${"b".repeat(64)}`), /does not match/);
  assert.throws(() => resolveMiniStackImage("ministackorg/ministack:1.4.2"), /pinned/);
  assert.throws(() => resolveMiniStackImage("ministackorg/ministack:1.4.2", digest), /full tag/);
});

test("MiniStack separates the egress runtime network from the internal Terraform control network", async () => {
  let created = false;
  const executor = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "inspect") return created
      ? { code: 0, stdout: basicMiniStackInspection("container-id", "generation-1", "4566"), stderr: "" }
      : { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "run") created = true;
    return { code: 0, stdout: "container-id\n", stderr: "" };
  });
  const runtime = await startMiniStack({
    projectId: "checkout",
    image: "ministackorg/ministack:1.4.2-full",
    digest: `sha256:${"a".repeat(64)}`,
    persistence: false,
    stateRoot: "/tmp/unused",
    platform: "linux/amd64",
  }, {
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
  });

  const creates = executor.calls.filter((call) => call.args[0] === "network" && call.args[1] === "create");
  const controlCreate = creates.find((call) => call.args.includes("anbo-checkout-control"));
  const runtimeCreate = creates.find((call) => call.args.includes("anbo-checkout-runtime"));
  assert.ok(controlCreate?.args.includes("--internal"));
  assert.equal(runtimeCreate?.args.includes("--internal"), false);

  const run = executor.calls.find((call) => call.args[0] === "run");
  assert.ok(run?.args.includes("anbo-checkout-runtime"));
  assert.ok(run?.args.includes("DOCKER_NETWORK=anbo-checkout-runtime"));
  assert.ok(run?.args.includes("host.docker.internal:host-gateway"));
  assert.ok(run?.args.includes("LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway"));
  assert.ok(executor.calls.some((call) => call.args.join(" ") === "network connect anbo-checkout-control anbo-checkout-ministack"));
  assert.equal(runtime.networkName, "anbo-checkout-control");
  assert.equal(runtime.runtimeNetworkName, "anbo-checkout-runtime");
});

test("MiniStack reuses only an exact deterministic create-time configuration", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const baseConfig: MiniStackRuntimeConfig = {
    projectId: "checkout-reuse",
    image: "ministackorg/ministack:1.4.2-full",
    digest,
    persistence: false,
    stateRoot: "/tmp/unused",
    platform: "linux/amd64",
    environment: { Z_FLAG: "last", OPENSEARCH_DATAPLANE: "0" },
  };
  let initialCreated = false;
  const missingExecutor = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "inspect") return initialCreated
      ? { code: 0, stdout: basicMiniStackInspection("container-id", "generation-1", "4566"), stderr: "" }
      : { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "run") initialCreated = true;
    return { code: 0, stdout: "container-id\n", stderr: "" };
  });
  await startMiniStack(baseConfig, {
    commands: missingExecutor,
    fetch: async () => Response.json({ edition: "full" }),
  });

  const initialRun = missingExecutor.calls.find((call) => call.args[0] === "run");
  const initialConfigLabel = initialRun?.args.find((argument) => argument.startsWith("anbo.dev/runtime-config="));
  assert.match(initialConfigLabel ?? "", /^anbo\.dev\/runtime-config=[a-f0-9]{64}$/);
  const [configLabelName, configLabelValue] = initialConfigLabel!.split("=");
  const image = resolveMiniStackImage(baseConfig.image, digest);
  const inspection = JSON.stringify([{
    Id: "existing-container-id",
    Config: {
      Image: image,
      Env: ["LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway"],
      Labels: { [configLabelName!]: configLabelValue! },
    },
    State: { Running: true, ExitCode: 0, StartedAt: "generation-1" },
    HostConfig: {
      PortBindings: { "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: "4566" }] },
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
    NetworkSettings: {
      Networks: {
        "anbo-checkout-reuse-control": {},
        "anbo-checkout-reuse-runtime": {},
      },
    },
  }]);

  const existingExecutor = (persistence: boolean): RecordingExecutor => {
    let removed = false;
    return new RecordingExecutor(async (_command, args) => {
      if (args[0] === "network" && args[1] === "inspect") {
        return {
          code: 0,
          stdout: JSON.stringify([{ Internal: args[2]?.endsWith("-control") === true }]),
          stderr: "",
        };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        return persistence
          ? { code: 1, stdout: "", stderr: "missing" }
          : { code: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "inspect") {
        return removed
          ? { code: 1, stdout: "", stderr: "missing" }
          : { code: 0, stdout: inspection, stderr: "" };
      }
      if (args[0] === "rm") removed = true;
      if (args[0] === "run") removed = false;
      return { code: 0, stdout: "container-id\n", stderr: "" };
    });
  };

  const reorderedExecutor = existingExecutor(false);
  const reorderedRuntime = await startMiniStack({
    ...baseConfig,
    environment: { OPENSEARCH_DATAPLANE: "0", Z_FLAG: "last" },
  }, {
    commands: reorderedExecutor,
    fetch: async () => Response.json({ edition: "full" }),
  });
  assert.equal(reorderedExecutor.calls.some((call) => call.args[0] === "rm"), false);
  assert.equal(reorderedExecutor.calls.some((call) => call.args[0] === "run"), false);
  assert.equal(reorderedRuntime.reused, true);
  assert.equal(reorderedRuntime.containerId, "existing-container-id");
  assert.equal(reorderedRuntime.runtimeGeneration, "generation-1");

  const environmentChangeExecutor = existingExecutor(false);
  await startMiniStack({
    ...baseConfig,
    environment: { OPENSEARCH_DATAPLANE: "1", Z_FLAG: "last" },
  }, {
    commands: environmentChangeExecutor,
    fetch: async () => Response.json({ edition: "full" }),
  });
  assert.equal(environmentChangeExecutor.calls.some((call) => call.args[0] === "rm"), true);
  const environmentChangeRun = environmentChangeExecutor.calls.find((call) => call.args[0] === "run");
  assert.ok(environmentChangeRun?.args.includes("OPENSEARCH_DATAPLANE=1"));
  assert.notEqual(
    environmentChangeRun?.args.find((argument) => argument.startsWith("anbo.dev/runtime-config=")),
    initialConfigLabel,
  );

  const persistenceChangeExecutor = existingExecutor(true);
  await startMiniStack({ ...baseConfig, persistence: true }, {
    commands: persistenceChangeExecutor,
    fetch: async () => Response.json({ edition: "full" }),
  });
  assert.equal(persistenceChangeExecutor.calls.some((call) => call.args[0] === "rm"), true);
  const persistenceChangeRun = persistenceChangeExecutor.calls.find((call) => call.args[0] === "run");
  assert.ok(persistenceChangeRun?.args.includes("anbo-checkout-reuse-ministack-data:/var/lib/anbo/ministack"));
  assert.notEqual(
    persistenceChangeRun?.args.find((argument) => argument.startsWith("anbo.dev/runtime-config=")),
    initialConfigLabel,
  );

  const inspectionAt = (running: boolean, generation: string): string => {
    const parsed = JSON.parse(inspection) as Array<Record<string, unknown>>;
    parsed[0]!["State"] = { Running: running, ExitCode: 0, StartedAt: generation };
    return JSON.stringify(parsed);
  };
  let started = false;
  const stoppedExecutor = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "network" && args[1] === "inspect") {
      return { code: 0, stdout: JSON.stringify([{ Internal: args[2]?.endsWith("-control") === true }]), stderr: "" };
    }
    if (args[0] === "inspect") {
      return { code: 0, stdout: inspectionAt(started, started ? "generation-2" : "generation-1"), stderr: "" };
    }
    if (args[0] === "start") started = true;
    return { code: 0, stdout: "", stderr: "" };
  });
  const restartedRuntime = await startMiniStack(baseConfig, {
    commands: stoppedExecutor,
    fetch: async () => Response.json({ edition: "full" }),
  });
  assert.equal(restartedRuntime.reused, false);
  assert.equal(restartedRuntime.runtimeGeneration, "generation-2");

  let restartedDuringHealth = false;
  const raceExecutor = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "network" && args[1] === "inspect") {
      return { code: 0, stdout: JSON.stringify([{ Internal: args[2]?.endsWith("-control") === true }]), stderr: "" };
    }
    if (args[0] === "inspect") {
      return { code: 0, stdout: inspectionAt(true, restartedDuringHealth ? "generation-2" : "generation-1"), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const racedRuntime = await startMiniStack(baseConfig, {
    commands: raceExecutor,
    fetch: async () => {
      restartedDuringHealth = true;
      return Response.json({ edition: "full" });
    },
  });
  assert.equal(racedRuntime.reused, false);
  assert.equal(racedRuntime.runtimeGeneration, "generation-2");
});

test("runtime cleanup reports Docker failures and forwards cancellation", async () => {
  const controller = new AbortController();
  const services = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "ps") return { code: 0, stdout: "service-id\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "permission denied" };
  });
  await assert.rejects(
    stopDeclaredServices("checkout", services, controller.signal),
    /could not remove declared service containers: permission denied/,
  );
  assert.equal(services.calls.every((call) => call.options?.signal === controller.signal), true);

  const ministack = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "rm" && args[1] === "-f" && args[2] === "anbo-checkout-ministack") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "network" && args[1] === "rm") return { code: 1, stdout: "", stderr: "active endpoints" };
    return { code: 0, stdout: "", stderr: "" };
  });
  await assert.rejects(
    stopMiniStack("checkout", { purge: true, commands: ministack, signal: controller.signal }),
    /docker network failed: active endpoints/,
  );
  assert.equal(ministack.calls.every((call) => call.options?.signal === controller.signal), true);
});

test("cache prune fails when managed images cannot be removed", async () => {
  const executor = new RecordingExecutor(async (_command, args) => args[1] === "ls"
    ? { code: 0, stdout: "image-id\n", stderr: "" }
    : { code: 1, stdout: "", stderr: "image is in use" });
  await assert.rejects(pruneBuildCache("checkout", executor), /could not remove managed build images: image is in use/);
});

test("Terraform environment uses an allowlist and safety validation permits aliases", () => {
  assert.deepEqual(scrubTerraformEnvironment({
    LANG: "C.UTF-8",
    ANBO_TOKEN: "never-enter-worker",
    GITHUB_TOKEN: "also-never",
    TF_VAR_password: "never",
    AWS_PROFILE: "production",
  }, true), {
    LANG: "C.UTF-8",
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
  });
  validateTerraformHcl(`
    provider "aws" { alias = "west" region = "us-west-2" }
    module "inside" { source = "./modules/inside" providers = { aws = aws.west } }
    resource "aws_s3_bucket" "ok" { bucket = "ok" }
  `);
  assert.throws(() => validateTerraformHcl(`data "external" "bad" { program = ["sh"] }`), /forbidden data source/);
  assert.throws(() => validateTerraformHcl(`resource "x" "bad" { provisioner "local-exec" {} }`), /provisioner/);
  assert.throws(() => validateTerraformHcl(`provider "aws" { endpoints { s3 = "https://aws.example" } }`), /exclusively control/);
  assert.throws(() => validateTerraformHcl(`module "outside" { source = "../shared" }`), /outside its Terraform root/);
});

test("runtime errors preserve lock and Docker prerequisite exit contracts", () => {
  const locked = classifyRuntimeError(new OperationLockedError("/tmp/anbo-operation.lock"), "deploy");
  assert.equal(locked.exitCode, ExitCode.LockConflict);
  assert.equal(locked.code, "ANBO_PROJECT_LOCKED");
  assert.match(locked.details?.remediation ?? "", /active Anbo operation/);

  const missingDocker = Object.assign(new Error("spawn docker ENOENT"), {
    code: "ENOENT",
    path: "docker",
    syscall: "spawn docker",
  });
  const prerequisite = classifyRuntimeError(missingDocker, "ministack");
  assert.equal(prerequisite.exitCode, ExitCode.Prerequisite);
  assert.equal(prerequisite.code, "ANBO_DOCKER_UNAVAILABLE");
  assert.match(prerequisite.details?.remediation ?? "", /docker info/);

  const daemon = classifyRuntimeError(new Error("Cannot connect to the Docker daemon. Is the docker daemon running?"), "build");
  assert.equal(daemon.exitCode, ExitCode.Prerequisite);
  assert.equal(daemon.code, "ANBO_DOCKER_UNAVAILABLE");
});

test("external clone state contains metadata and never the PostgreSQL URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-clone-test-"));
  const statePath = join(directory, "clones.json");
  const databaseUrl = "postgresql://agent:very-secret@example.invalid/demo?sslmode=require";
  const lease = await acquireClone({
    projectId: "checkout",
    engine: "postgres",
    config: { provider: "external", endpoint: "env://TEST_DATABASE_URL" },
    statePath,
    environment: { TEST_DATABASE_URL: databaseUrl },
  });
  assert.equal(lease.engine, "postgres");
  assert.equal(lease.databaseUrl, databaseUrl);
  const persisted = await readFile(statePath, "utf8");
  assert.doesNotMatch(persisted, /very-secret|postgresql:\/\//);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("anbo-cloud acquires independent PostgreSQL and DynamoDB branches without persisting credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-cloud-clone-test-"));
  const statePath = join(directory, "clones.json");
  const branchRequests: Record<string, unknown>[] = [];
  const registeredSecrets: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path === "/v1/branches" && init?.method === "POST") {
      branchRequests.push(body);
      const source = String(body["from"]);
      const engine = source.startsWith("ddb") ? "dynamodb" : "postgres";
      return Response.json({ id: `${engine}-id`, name: String(body["name"]), status: "ready", ready: true, source: { type: engine, link: source }, expires_at: "2030-01-01T00:00:00.000Z" }, { status: 201 });
    }
    if (path.endsWith("/url")) {
      return Response.json({ database_url: "postgresql://agent:cloud-password@db.example/demo?sslmode=require" });
    }
    if (path.endsWith("/dynamodb/credentials")) return Response.json({
      version: 1,
      branch_id: "dynamodb-id",
      branch_name: "checkout-dynamodb",
      endpoint_url: "https://ddb.example",
      region: "us-east-1",
      access_key_id: ["ASIA", "1111111111111111"].join(""),
      secret_access_key: "cloud-secret-key",
      session_token: "cloud-session-token",
      expires_at: "2030-01-01T00:00:00.000Z",
      supported_api_level: "2026-01",
      tables: ["Carts"],
    });
    return Response.json({ error: "not found" }, { status: 404 });
  };
  const leases = await acquireConfiguredClones({
    projectId: "checkout",
    statePath,
    environment: { ANBO_TOKEN: "cloud-api-token" },
    apiUrl: "https://api.example",
    tokenReference: "env://ANBO_TOKEN",
    postgres: { provider: "anbo-cloud", source: "pg-production", ttl_seconds: 900 },
    dynamodb: { provider: "anbo-cloud", source: "ddb-production", region: "us-east-1", ttl_seconds: 1_800 },
  }, {
    fetch: fetcher,
    now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    registerSecret: (value) => registeredSecrets.push(value),
  });
  assert.equal(leases.postgres?.engine, "postgres");
  assert.equal(leases.dynamodb?.engine, "dynamodb");
  assert.deepEqual(
    Object.fromEntries(branchRequests.map((request) => [String(request["from"]), request["ttl_seconds"]])),
    { "pg-production": 900, "ddb-production": 1_800 },
  );
  assert.ok(registeredSecrets.includes("https://ddb.example"));
  const persisted = await readFile(statePath, "utf8");
  for (const secret of ["cloud-api-token", "cloud-password", "cloud-secret-key", "cloud-session-token", ["ASIA", "1111111111111111"].join("")]) {
    assert.equal(persisted.includes(secret), false, `state contained ${secret}`);
  }
  assert.deepEqual(Object.keys((await readCloneState(statePath))?.clones ?? {}).sort(), ["dynamodb", "postgres"]);
});

test("standalone test refreshes clone credentials for Lambda overlays and smoke tests without persisting them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-test-clone-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let overlayBody: Record<string, unknown> | undefined;
  const cloneAuthorizations: string[] = [];
  let cloudCredentials = {
    endpoint_url: "https://old-dynamodb.example.invalid",
    access_key_id: "old-access-key",
    secret_access_key: "old-secret-key",
    session_token: "old-session-token",
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if ((request.method === "POST" && request.url === "/v1/branches") ||
        (request.method === "GET" && request.url === "/v1/branches/dynamodb-id")) {
      cloneAuthorizations.push(request.headers.authorization ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "dynamodb-id",
        name: "checkout-dynamodb",
        status: "ready",
        ready: true,
        source: { type: "dynamodb", link: "ddb-production" },
        expires_at: "2099-01-01T00:00:00.000Z",
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/branches/dynamodb-id/dynamodb/credentials") {
      cloneAuthorizations.push(request.headers.authorization ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        version: 1,
        branch_id: "dynamodb-id",
        branch_name: "checkout-dynamodb",
        ...cloudCredentials,
        region: "eu-west-1",
        expires_at: "2099-01-01T00:00:00.000Z",
        supported_api_level: "2026-01",
        tables: ["Orders"],
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/2015-03-31/functions/") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        Functions: [{
          FunctionName: "checkout",
          Environment: { Variables: { ANBO_CLONE_REQUIRED: "postgres,dynamodb", MODE: "test" } },
        }],
      }));
      return;
    }
    if (request.method === "PUT" && request.url === "/2015-03-31/functions/checkout/configuration") {
      overlayBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ FunctionName: "checkout" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise<void>((resolveClose) => server.close(() => resolveClose())); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const hostEndpoint = `http://127.0.0.1:${address.port}`;

  const binDirectory = join(directory, "bin");
  const dockerCapture = join(directory, "docker-args.txt");
  await mkdir(binDirectory);
  const dockerPath = join(binDirectory, "docker");
  await writeFile(dockerPath, [
    "#!/bin/sh",
    "printf 'CALL' >> \"$ANBO_CAPTURE_FILE\"",
    "for argument in \"$@\"; do printf '\\t%s' \"$argument\" >> \"$ANBO_CAPTURE_FILE\"; done",
    "printf '\\n' >> \"$ANBO_CAPTURE_FILE\"",
    "printf '%s\\n' \"$@\"",
    "",
  ].join("\n"));
  await chmod(dockerPath, 0o755);
  const credentialPath = join(binDirectory, "clone-credential");
  await writeFile(credentialPath, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  postgres) printf '%s' \"$TEST_DATABASE_URL\" ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  await chmod(credentialPath, 0o755);
  const adapterPath = join(binDirectory, "rotating-adapter");
  await writeFile(adapterPath, [
    "#!/bin/sh",
    "IFS= read -r request || exit 2",
    "printf '{\"schema_version\":2,\"adapter\":\"rotating\",\"capabilities\":[\"runtime.binding\"],\"bindings\":[{\"name\":\"api\",\"kind\":\"http\",\"endpoint\":\"%s\",\"secret_handle\":\"%s\"}],\"diagnostics\":[]}\\n' \"$ADAPTER_ENDPOINT\" \"$ADAPTER_SECRET\"",
    "",
  ].join("\n"));
  await chmod(adapterPath, 0o755);
  const previousPath = process.env["PATH"];
  const previousCapture = process.env["ANBO_CAPTURE_FILE"];
  process.env["PATH"] = `${binDirectory}:${previousPath ?? ""}`;
  process.env["ANBO_CAPTURE_FILE"] = dockerCapture;
  t.after(() => {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    if (previousCapture === undefined) delete process.env["ANBO_CAPTURE_FILE"];
    else process.env["ANBO_CAPTURE_FILE"] = previousCapture;
  });

  const stateHome = join(directory, "state");
  const runtimeProjectId = deriveRuntimeProjectId("checkout", directory);
  const supervisor = new ProjectSupervisor({ projectRoot: directory, projectId: runtimeProjectId, stateHome });
  const cloneStatePath = join(supervisor.stateDirectory, "clones.json");
  const execReference = (name: string): `exec://${string}` =>
    `exec://${encodeURIComponent(JSON.stringify([credentialPath, name]))}`;
  const data: SandboxManifest["data"] = {
    postgres: { provider: "external", endpoint: execReference("postgres") },
    dynamodb: {
      provider: "anbo-cloud",
      source: "ddb-production",
      region: "eu-west-1",
    },
  };
  await acquireConfiguredClones({
    projectId: runtimeProjectId,
    statePath: cloneStatePath,
    environment: {
      TEST_DATABASE_URL: "postgresql://old-user:old-password@old.example.invalid/orders?sslmode=require",
      ANBO_TOKEN: "old-cloud-token",
    },
    apiUrl: hostEndpoint,
    tokenReference: "env://ANBO_TOKEN",
    postgres: data.postgres,
    dynamodb: data.dynamodb,
  });
  await supervisor.writeState({
    status: "ready",
    ministack: {
      container_name: `anbo-${runtimeProjectId}-ministack`,
      network_name: `anbo-${runtimeProjectId}-control`,
      runtime_network_name: `anbo-${runtimeProjectId}-runtime`,
      host_endpoint: hostEndpoint,
      container_endpoint: `http://anbo-${runtimeProjectId}-ministack:4566`,
      image: "ministackorg/ministack:1.4.2-full",
    },
    terraform: {
      outputs: { secret_arn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:application" },
      roots: ["."],
    },
    services: {
      runner: { name: "runner", containerName: `anbo-${runtimeProjectId}-runner`, image: "runner:test", ports: {} },
      rotating: { name: "rotating", containerName: `anbo-${runtimeProjectId}-rotating`, image: "rotating:previous-build", ports: {} },
      static: { name: "static", containerName: `anbo-${runtimeProjectId}-static`, image: "static:deployed", ports: {} },
    },
    clones: (await readCloneState(cloneStatePath))?.clones ?? {},
  });

  const databaseUrl = "postgresql://current-user:current-password@current.example.invalid/orders?sslmode=require";
  const dynamodbEndpoint = "https://current-dynamodb.example.invalid";
  const dynamodbAccessKey = "current-access-key";
  const dynamodbSecretKey = "current-secret-key";
  const dynamodbSessionToken = "current-session-token";
  const cloudToken = "current-cloud-token";
  const runtimeToken = "current-runtime-service-token";
  const adapterEndpoint = "https://adapter.example.invalid/current-endpoint-secret";
  const adapterSecret = "current-adapter-secret-handle";
  cloudCredentials = {
    endpoint_url: dynamodbEndpoint,
    access_key_id: dynamodbAccessKey,
    secret_access_key: dynamodbSecretKey,
    session_token: dynamodbSessionToken,
  };
  const manifest = minimalManifest();
  manifest.data = data;
  manifest.adapters = {
    rotating: {
      executable: adapterPath,
      capabilities: ["runtime.binding"],
      environment: {
        ADAPTER_ENDPOINT: "env://TEST_ADAPTER_ENDPOINT",
        ADAPTER_SECRET: "env://TEST_ADAPTER_SECRET",
      },
    },
  };
  manifest.services = {
    rotating: {
      build: "rotating",
      depends_on: ["static"],
      dynamodb_plane: "clone",
      environment: {
        DATABASE_URL: "${clone.postgres.database_url}",
        RUNTIME_TOKEN: "env://RUNTIME_SERVICE_TOKEN",
        ADAPTER_ENDPOINT: "${adapter.rotating.api.endpoint}",
        ADAPTER_SECRET_HANDLE: "${adapter.rotating.api.secret_handle}",
      },
    },
    static: {
      image: "static:manifest",
      environment: { MODE: "unchanged" },
    },
  };
  manifest.tests = {
    smoke: {
      command: ["smoke"],
      service: "runner",
      environment: {
        DATABASE_URL: "${clone.postgres.database_url}",
        SECRET_ARN: "${terraform.secret_arn}",
      },
      default: true,
    },
  };
  const output: string[] = [];
  const result = await runDeploy({
    root: directory,
    manifestPath: join(directory, ".anbo", "sandbox.json"),
    manifest,
    action: "test",
    args: [],
    flags: {},
    env: {
      XDG_STATE_HOME: stateHome,
      TEST_DATABASE_URL: databaseUrl,
      ANBO_API_URL: hostEndpoint,
      ANBO_TOKEN: cloudToken,
      RUNTIME_SERVICE_TOKEN: runtimeToken,
      TEST_ADAPTER_ENDPOINT: adapterEndpoint,
      TEST_ADAPTER_SECRET: adapterSecret,
    },
  }, eventSink(output));

  assert.deepEqual(result["clone_engines"], ["postgres", "dynamodb"]);
  const overlayEnvironment = ((overlayBody?.["Environment"] as Record<string, unknown>)?.["Variables"] as Record<string, string>);
  assert.equal(overlayEnvironment["ANBO_POSTGRES_URL"], databaseUrl);
  assert.equal(overlayEnvironment["ANBO_DYNAMODB_CLONE_ENDPOINT"], dynamodbEndpoint);
  assert.equal(overlayEnvironment["ANBO_DYNAMODB_CLONE_ACCESS_KEY_ID"], dynamodbAccessKey);
  assert.equal(overlayEnvironment["ANBO_DYNAMODB_CLONE_SECRET_ACCESS_KEY"], dynamodbSecretKey);
  assert.equal(overlayEnvironment["ANBO_DYNAMODB_CLONE_SESSION_TOKEN"], dynamodbSessionToken);
  assert.equal(cloneAuthorizations.at(-1), `Bearer ${cloudToken}`);

  const dockerArgs = await readFile(dockerCapture, "utf8");
  const escapedRuntimeProjectId = runtimeProjectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(dockerArgs, new RegExp(`DATABASE_URL=${databaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(dockerArgs, new RegExp(`rm\\t-f\\tanbo-${escapedRuntimeProjectId}-rotating`));
  assert.match(dockerArgs, /run[^\n]+\trotating:previous-build(?:\t|\n)/);
  assert.match(dockerArgs, new RegExp(`RUNTIME_TOKEN=${runtimeToken}`));
  assert.match(dockerArgs, new RegExp(`ADAPTER_ENDPOINT=${adapterEndpoint}`));
  assert.match(dockerArgs, new RegExp(`ADAPTER_SECRET_HANDLE=${adapterSecret}`));
  assert.match(dockerArgs, /SECRET_ARN=arn:aws:secretsmanager:us-east-1:000000000000:secret:application/);
  assert.match(dockerArgs, new RegExp(`ANBO_DYNAMODB_CLONE_SECRET_ACCESS_KEY=${dynamodbSecretKey}`));
  assert.doesNotMatch(dockerArgs, new RegExp(`rm\\t-f\\tanbo-${escapedRuntimeProjectId}-static`));
  assert.doesNotMatch(dockerArgs, /run[^\n]+\tstatic:(?:manifest|deployed)/);
  assert.match(dockerArgs, new RegExp(`network\\tconnect\\tanbo-${escapedRuntimeProjectId}-app\\tanbo-${escapedRuntimeProjectId}-ministack`));
  assert.deepEqual(result["refreshed_services"], ["rotating"]);
  assert.deepEqual(result["adapters"], {
    rotating: {
      capabilities: ["runtime.binding"],
      bindings: [{ name: "api", kind: "http" }],
    },
  });
  const rendered = output.join("");
  assert.match(rendered, /\[REDACTED\]/);
  assert.match(rendered, /"kind":"test.assertion"/);
  for (const secret of [runtimeToken, adapterEndpoint, adapterSecret]) assert.equal(rendered.includes(secret), false);
  const refreshedState = await supervisor.readState();
  const refreshedStateServices = refreshedState?.["services"] as Record<string, { image: string }>;
  assert.equal(refreshedStateServices["rotating"]?.image, "rotating:previous-build");
  assert.equal(refreshedStateServices["static"]?.image, "static:deployed");
  assert.equal(refreshedStateServices["runner"]?.image, "runner:test");
  const persistedPaths = [
    supervisor.statePath,
    cloneStatePath,
  ];
  for (const path of persistedPaths) {
    const contents = await readFile(path, "utf8");
    for (const secret of [databaseUrl, dynamodbEndpoint, dynamodbAccessKey, dynamodbSecretKey, dynamodbSessionToken, cloudToken, runtimeToken, adapterEndpoint, adapterSecret]) {
      assert.equal(contents.includes(secret), false, `${path} contained refreshed clone credential material`);
    }
  }
});

test("Terraform applies exactly the saved plan inside the isolated Docker network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-test-"));
  const source = join(directory, "source");
  await mkdir(join(source, "vars"), { recursive: true });
  await writeFile(join(source, "main.tf"), `resource "aws_s3_bucket" "example" { bucket = "example" }\n`);
  await writeFile(join(source, "vars", "local.tfvars"), `stage = "local"\n`);
  const executor = new RecordingExecutor(async (_command, args) => {
    if (args.includes("plan")) return { code: 2, stdout: "plan", stderr: "" };
    if (args.includes("show")) return { code: 0, stdout: JSON.stringify({ resource_changes: [{ change: { actions: ["create"] } }] }), stderr: "" };
    if (args.includes("output")) return {
      code: 0,
      stdout: JSON.stringify({
        bucket: { sensitive: false, value: "example" },
        secret_arn: { sensitive: false, value: "arn:aws:secretsmanager:us-east-1:000000000000:secret:application" },
        password: { sensitive: true, value: "sensitive-password" },
        unclassified: { value: "missing-sensitivity-metadata" },
      }),
      stderr: "",
    };
    return { code: 0, stdout: "", stderr: "" };
  });
  const outputPhases: string[] = [];
  const lifecycle: TerraformLifecycleEvent[] = [];
  const result = await runTerraform({
    projectDirectory: directory,
    sourceDirectory: source,
    privateDirectory: join(directory, "private"),
    statePath: join(directory, "state", "terraform.tfstate"),
    pluginCacheDirectory: join(directory, "plugins"),
    workerImage: `hashicorp/terraform@sha256:${"b".repeat(64)}`,
    networkName: "anbo-control",
    miniStackEndpoint: "http://ministack:4566",
    variableFiles: ["vars/local.tfvars"],
    environment: { ANBO_TOKEN: "must-not-appear", TF_VAR_password: "must-not-appear" },
  }, {
    commands: executor,
    onOutput: async (_stream, _text, phase) => { outputPhases.push(phase); },
    onLifecycle: async (event) => { lifecycle.push(event); },
  });
  assert.equal(result.changes.create, 1);
  assert.deepEqual(result.outputs, {
    bucket: "example",
    secret_arn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:application",
  });
  const outputSupervisor = new ProjectSupervisor({
    projectRoot: source,
    projectId: "terraform-output-state",
    stateHome: join(directory, "supervisor-state"),
  });
  await outputSupervisor.writeState({ terraform: { outputs: result.outputs } });
  const persistedOutputs = await readFile(outputSupervisor.statePath, "utf8");
  assert.match(persistedOutputs, /secret_arn/);
  assert.doesNotMatch(persistedOutputs, /sensitive-password|missing-sensitivity-metadata/);
  const apply = executor.calls.find((call) => call.args.includes("apply"));
  assert.ok(apply?.args.includes("/workspace/.anbo.plan"));
  assert.equal(executor.calls.some((call) => call.args.join(" ").includes("must-not-appear")), false);
  const plan = executor.calls.find((call) => call.args.includes("plan"));
  assert.ok(plan?.args.includes("anbo-control"));
  assert.ok(plan?.args.includes("-var-file=/workspace/vars/local.tfvars"));
  const workerCalls = executor.calls.filter((call) => call.args[0] === "run");
  const expectedUserArguments = terraformWorkerUserArguments();
  assert.ok(workerCalls.length > 0);
  for (const call of workerCalls) {
    const userIndex = call.args.indexOf("--user");
    if (expectedUserArguments.length === 0) assert.equal(userIndex, -1);
    else assert.deepEqual(call.args.slice(userIndex, userIndex + 2), expectedUserArguments);
    assert.ok(call.args.includes("HOME=/tmp"));
  }
  const providerOverride = await readFile(join(directory, "private", "zz_anbo_ministack_override.tf"), "utf8");
  assert.match(providerOverride, /s3_use_path_style\s+= true/);
  assert.match(providerOverride, /s3\s+= "http:\/\/ministack:4566"/);
  assert.ok(outputPhases.includes("terraform.plan"));
  assert.equal(outputPhases.includes("terraform.show"), false);
  assert.equal(outputPhases.includes("terraform.output"), false);
  const workerSequence = executor.calls
    .filter((call) => call.args[0] === "run")
    .map((call) => ["init", "validate", "plan", "show", "apply", "output"].find((command) => call.args.includes(command)));
  assert.deepEqual(workerSequence, ["init", "validate", "plan", "show", "apply", "output"]);
  for (const phase of ["terraform.workspace.prepare", "terraform.init", "terraform.validate", "terraform.plan", "terraform.show", "terraform.apply", "terraform.output"]) {
    assert.ok(lifecycle.some((event) => event.phase === phase && event.status === "started"));
    const completed = lifecycle.find((event) => event.phase === phase && event.status === "succeeded");
    assert.ok(completed);
    assert.ok(Number.isSafeInteger(completed.durationMs) && completed.durationMs! >= 0);
  }
  assert.equal(lifecycle.find((event) => event.phase === "terraform.plan" && event.status === "succeeded")?.exitCode, 2);
  assert.equal(JSON.stringify(lifecycle).includes("must-not-appear"), false);
});

test("Terraform skips apply for an empty detailed plan and still returns filtered outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-noop-"));
  const source = join(directory, "source");
  await mkdir(source);
  await writeFile(join(source, "main.tf"), `output "name" { value = "notes" }\n`);
  const lifecycle: TerraformLifecycleEvent[] = [];
  const executor = new RecordingExecutor(async (_command, args) => {
    if (args.includes("plan")) return { code: 0, stdout: "No changes. Your infrastructure matches the configuration.\n", stderr: "" };
    if (args.includes("output")) return {
      code: 0,
      stdout: JSON.stringify({
        name: { sensitive: false, value: "notes" },
        password: { sensitive: true, value: "do-not-persist" },
      }),
      stderr: "",
    };
    return { code: 0, stdout: "", stderr: "" };
  });
  const result = await runTerraform({
    projectDirectory: directory,
    sourceDirectory: source,
    privateDirectory: join(directory, "private"),
    statePath: join(directory, "state", "terraform.tfstate"),
    pluginCacheDirectory: join(directory, "plugins"),
    workerImage: `hashicorp/terraform@sha256:${"b".repeat(64)}`,
    networkName: "anbo-control",
    miniStackEndpoint: "http://ministack:4566",
  }, { commands: executor, onLifecycle: async (event) => { lifecycle.push(event); } });

  assert.deepEqual(result.changes, { create: 0, update: 0, delete: 0, replace: 0, noOp: 0 });
  assert.deepEqual(result.outputs, { name: "notes" });
  assert.equal(executor.calls.some((call) => call.args.includes("show")), false);
  assert.equal(executor.calls.some((call) => call.args.includes("apply")), false);
  assert.deepEqual(lifecycle.find((event) => event.phase === "terraform.apply"), {
    phase: "terraform.apply",
    status: "skipped",
    durationMs: 0,
    reason: "terraform_plan_empty",
  });
  assert.ok(lifecycle.some((event) => event.phase === "terraform.output" && event.status === "succeeded"));
  assert.equal(JSON.stringify(lifecycle).includes("do-not-persist"), false);
});

test("Terraform command failures emit metadata-only monotonic lifecycle events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-failure-"));
  const source = join(directory, "source");
  await mkdir(source);
  await writeFile(join(source, "main.tf"), `resource "aws_s3_bucket" "notes" {}\n`);
  const lifecycle: TerraformLifecycleEvent[] = [];
  const executor = new RecordingExecutor(async (_command, args) => args.includes("validate")
    ? { code: 1, stdout: "", stderr: "provider failed with forbidden-secret-value" }
    : { code: 0, stdout: "", stderr: "" });

  await assert.rejects(runTerraform({
    projectDirectory: directory,
    sourceDirectory: source,
    privateDirectory: join(directory, "private"),
    statePath: join(directory, "state", "terraform.tfstate"),
    pluginCacheDirectory: join(directory, "plugins"),
    workerImage: `hashicorp/terraform@sha256:${"b".repeat(64)}`,
    networkName: "anbo-control",
    miniStackEndpoint: "http://ministack:4566",
  }, { commands: executor, onLifecycle: async (event) => { lifecycle.push(event); } }), /forbidden-secret-value/);

  const failed = lifecycle.find((event) => event.phase === "terraform.validate" && event.status === "failed");
  assert.equal(failed?.exitCode, 1);
  assert.ok(Number.isSafeInteger(failed?.durationMs) && failed!.durationMs! >= 0);
  assert.equal(JSON.stringify(failed).includes("forbidden-secret-value"), false);
  assert.equal(executor.calls.some((call) => call.args.includes("plan") || call.args.includes("apply") || call.args.includes("output")), false);
});

test("Terraform reuses only init-augmented locks derived from the same source lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-lock-cache-"));
  const source = join(directory, "source");
  const privateDirectory = join(directory, "private");
  const lockCacheDirectory = join(directory, "locks", "project", "root");
  await mkdir(source);
  await writeFile(join(source, "main.tf"), `output "name" { value = "notes" }\n`);
  await writeFile(join(source, ".terraform.lock.hcl"), "source-lock-v1\n");
  const locksSeenByInit: Array<string | undefined> = [];
  const executor = new RecordingExecutor(async (_command, args) => {
    const workspaceMount = args.find((value) => value.startsWith("type=bind,src=") && value.endsWith(",dst=/workspace"));
    assert.ok(workspaceMount);
    const workspace = workspaceMount.slice("type=bind,src=".length, -",dst=/workspace".length);
    if (args.includes("init")) {
      let lock: string | undefined;
      try { lock = await readFile(join(workspace, ".terraform.lock.hcl"), "utf8"); } catch { /* No source lock. */ }
      locksSeenByInit.push(lock);
      await writeFile(join(workspace, ".terraform.lock.hcl"), "init-augmented-lock-v1\n");
    }
    if (args.includes("plan")) return { code: 0, stdout: "No changes.\n", stderr: "" };
    if (args.includes("output")) return { code: 0, stdout: "{}", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const config = {
    projectDirectory: directory,
    sourceDirectory: source,
    privateDirectory,
    statePath: join(directory, "state", "terraform.tfstate"),
    pluginCacheDirectory: join(directory, "plugins"),
    lockCacheDirectory,
    workerImage: `hashicorp/terraform@sha256:${"b".repeat(64)}`,
    networkName: "anbo-control",
    miniStackEndpoint: "http://ministack:4566",
  };

  await runTerraform(config, { commands: executor });
  await runTerraform(config, { commands: executor });
  assert.deepEqual(locksSeenByInit, ["source-lock-v1\n", "init-augmented-lock-v1\n"]);
  const cacheKeys = await readdir(lockCacheDirectory);
  assert.equal(cacheKeys.length, 1);
  const cachedLock = join(lockCacheDirectory, cacheKeys[0]!, ".terraform.lock.hcl");
  assert.equal(await readFile(cachedLock, "utf8"), "init-augmented-lock-v1\n");
  assert.equal((await stat(cachedLock)).mode & 0o777, 0o600);

  await writeFile(join(source, ".terraform.lock.hcl"), "source-lock-v2\n");
  await runTerraform(config, { commands: executor });
  assert.equal(locksSeenByInit.at(-1), "source-lock-v2\n", "a changed source lock must not receive the old overlay");
  assert.equal((await readdir(lockCacheDirectory)).length, 2);

  const unlockedSource = join(directory, "unlocked-source");
  await mkdir(unlockedSource);
  await writeFile(join(unlockedSource, "main.tf"), `output "name" { value = "unlocked" }\n`);
  await runTerraform({
    ...config,
    sourceDirectory: unlockedSource,
    privateDirectory: join(directory, "unlocked-private"),
    statePath: join(directory, "unlocked-state", "terraform.tfstate"),
  }, { commands: executor });
  await runTerraform({
    ...config,
    sourceDirectory: unlockedSource,
    privateDirectory: join(directory, "unlocked-private"),
    statePath: join(directory, "unlocked-state", "terraform.tfstate"),
  }, { commands: executor });
  assert.deepEqual(locksSeenByInit.slice(-2), [undefined, undefined]);
  assert.equal((await readdir(lockCacheDirectory)).length, 2, "a lockless root must not create a synthetic cache entry");
});

test("Terraform reconciliation fingerprints all semantic tree and runtime inputs deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-fingerprint-"));
  const source = join(directory, "source");
  const copied = join(directory, "copied");
  const excludedCache = join(source, "cache", "anbo", "v2");
  await mkdir(join(source, "modules", "queue"), { recursive: true });
  await mkdir(join(source, "vars"), { recursive: true });
  await mkdir(join(source, "dist"), { recursive: true });
  await mkdir(join(source, ".git"), { recursive: true });
  await mkdir(join(source, ".terraform"), { recursive: true });
  await mkdir(join(source, ".anbo"), { recursive: true });
  await mkdir(join(source, "node_modules", "generated"), { recursive: true });
  await mkdir(excludedCache, { recursive: true });
  await writeFile(join(source, "main.tf"), `module "queue" { source = "./modules/queue" }\n`);
  await writeFile(join(source, "modules", "queue", "main.tf"), `resource "aws_sqs_queue" "notes" {}\n`);
  await writeFile(join(source, "vars", "base.tfvars"), `stage = "base"\n`);
  await writeFile(join(source, "vars", "override.tfvars"), `stage = "override"\n`);
  await writeFile(join(source, ".terraform.lock.hcl"), `provider "registry.terraform.io/hashicorp/aws" {}\n`);
  await writeFile(join(source, "dist", "lambda.zip"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(source, ".git", "index"), "ignored-git-metadata");
  await writeFile(join(source, ".terraform", "provider.bin"), "ignored-provider-cache");
  await writeFile(join(source, ".anbo", "runtime.json"), "ignored-runtime-state");
  await writeFile(join(source, "node_modules", "generated", "module.tf"), "ignored-dependency-tree");
  await writeFile(join(source, "terraform.tfstate"), "ignored-tfstate");
  await writeFile(join(excludedCache, "provider.bin"), "explicitly-excluded-provider-cache");

  const fingerprint = async (
    rootDirectory: string,
    overrides: Partial<Parameters<typeof terraformReconciliationFingerprint>[0]> = {},
  ): Promise<string> => await terraformReconciliationFingerprint({
    projectDirectory: rootDirectory,
    sourceDirectory: rootDirectory,
    excludedPaths: [join(rootDirectory, "cache", "anbo", "v2")],
    root: "infra",
    variableFiles: ["vars/base.tfvars", "vars/override.tfvars"],
    workerImage: `hashicorp/terraform@sha256:${"b".repeat(64)}`,
    stateIdentity: { key: "root-state-key", filename: "terraform.tfstate" },
    miniStack: {
      containerName: "anbo-notes-ministack",
      containerId: "container-1",
      runtimeGeneration: "generation-1",
      networkName: "anbo-notes-control",
      containerEndpoint: "http://anbo-notes-ministack:4566",
      image: `ministack@sha256:${"a".repeat(64)}`,
      profile: "full",
      persistence: true,
      environment: { LOG_LEVEL: "INFO" },
    },
    terraform: { region: "us-east-1", accountId: "000000000000" },
    ...overrides,
  });
  const baseline = await fingerprint(source);
  assert.equal(await fingerprint(source), baseline);
  await cp(source, copied, { recursive: true });
  assert.equal(await fingerprint(copied), baseline, "absolute checkout path must not affect the fingerprint");

  const changes: Array<[string, string | Buffer]> = [
    ["main.tf", `module "queue" { source = "./modules/queue" }\noutput "changed" { value = true }\n`],
    ["modules/queue/main.tf", `resource "aws_sqs_queue" "changed" {}\n`],
    ["vars/base.tfvars", `stage = "changed"\n`],
    [".terraform.lock.hcl", `provider "registry.terraform.io/hashicorp/aws" { version = "6.0.0" }\n`],
    ["dist/lambda.zip", Buffer.from([4, 5, 6, 7])],
  ];
  for (const [path, contents] of changes) {
    const target = join(copied, path);
    const previous = await readFile(target);
    await writeFile(target, contents);
    assert.notEqual(await fingerprint(copied), baseline, `${path} must invalidate reconciliation`);
    await writeFile(target, previous);
  }

  await writeFile(join(copied, ".terraform", "provider.bin"), "changed-but-ignored");
  await writeFile(join(copied, ".anbo", "runtime.json"), "changed-but-ignored");
  await writeFile(join(copied, ".git", "index"), "changed-but-ignored");
  await writeFile(join(copied, "node_modules", "generated", "module.tf"), "changed-but-ignored");
  await writeFile(join(copied, "terraform.tfstate"), "changed-but-ignored");
  await writeFile(join(copied, "cache", "anbo", "v2", "provider.bin"), "changed-but-ignored");
  assert.equal(await fingerprint(copied), baseline);
  assert.notEqual(await fingerprint(copied, { variableFiles: ["vars/override.tfvars", "vars/base.tfvars"] }), baseline);
  assert.notEqual(await fingerprint(copied, { workerImage: `hashicorp/terraform@sha256:${"c".repeat(64)}` }), baseline);
  assert.notEqual(await fingerprint(copied, {
    miniStack: {
      containerName: "anbo-notes-ministack",
      containerId: "container-1",
      runtimeGeneration: "generation-2",
      networkName: "anbo-notes-control",
      containerEndpoint: "http://anbo-notes-ministack:4566",
      image: `ministack@sha256:${"a".repeat(64)}`,
      profile: "full",
      persistence: true,
    },
  }), baseline);
  await symlink(join(copied, "main.tf"), join(copied, "linked.tf"));
  await assert.rejects(fingerprint(copied), /may not contain symbolic links/);
  await rm(join(copied, "linked.tf"));
  const linkedRoot = join(directory, "linked-root");
  await symlink(source, linkedRoot, "dir");
  await assert.rejects(fingerprint(linkedRoot), /may not contain symbolic links/);
  const ancestorProject = join(directory, "ancestor-project");
  const outsideProject = join(directory, "outside-project");
  await mkdir(join(ancestorProject, "terraform"), { recursive: true });
  await mkdir(join(outsideProject, "infra"), { recursive: true });
  await writeFile(join(outsideProject, "infra", "main.tf"), `output "escaped" { value = true }\n`);
  await symlink(outsideProject, join(ancestorProject, "terraform", "linked"), "dir");
  const ancestorLinkedRoot = join(ancestorProject, "terraform", "linked", "infra");
  await assert.rejects(
    fingerprint(ancestorLinkedRoot, { projectDirectory: ancestorProject }),
    /may not contain symbolic links/,
  );
  const symlinkExecutor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
  await assert.rejects(runTerraform({
    projectDirectory: ancestorProject,
    sourceDirectory: ancestorLinkedRoot,
    privateDirectory: join(directory, "ancestor-private"),
    statePath: join(directory, "ancestor-state", "terraform.tfstate"),
    pluginCacheDirectory: join(directory, "ancestor-plugins"),
    workerImage: `hashicorp/terraform@sha256:${"b".repeat(64)}`,
    networkName: "anbo-control",
    miniStackEndpoint: "http://ministack:4566",
  }, { commands: symlinkExecutor }), /may not contain symbolic links/);
  assert.equal(symlinkExecutor.calls.length, 0, "copy preparation must reject the same ancestor symlink before a worker starts");
  assert.equal(terraformRootStateKey(directory, "source"), terraformRootStateKey(directory, "./source"));
  assert.notEqual(terraformRootStateKey(directory, "source"), terraformRootStateKey(directory, "copied"));
  assert.throws(() => terraformRootStateKey(source, "../copied"), /must remain inside the project/);
});

test("Terraform worker identity mapping is portable and rejects invalid host IDs", () => {
  assert.deepEqual(terraformWorkerUserArguments({ uid: 1001, gid: 121 }), ["--user", "1001:121"]);
  assert.deepEqual(terraformWorkerUserArguments({}), []);
  assert.deepEqual(terraformWorkerUserArguments({ uid: -1, gid: 121 }), []);
  assert.deepEqual(terraformWorkerUserArguments({ uid: 1001, gid: Number.NaN }), []);
});

test("configured smoke tests enforce their declared timeout", async () => {
  const executor = new RecordingExecutor(async (_command, _args, options) => await new Promise<RuntimeCommandResult>((_resolve, reject) => {
    const keepEventLoopAlive = setTimeout(() => undefined, 1_000);
    options?.signal?.addEventListener("abort", () => {
      clearTimeout(keepEventLoopAlive);
      reject(options.signal?.reason);
    }, { once: true });
  }));
  const context: ServiceRuntimeContext = {
    projectId: "checkout",
    networkName: "anbo-checkout-app",
    miniStackEndpoint: "http://ministack:4566",
    terraformOutputs: {},
    clones: {},
    builds: {},
    environment: {},
  };
  await assert.rejects(
    runConfiguredTests(
      { smoke: { command: ["sleep", "forever"], service: "runner", timeout_seconds: 0.01 } },
      ["smoke"],
      context,
      { runner: { name: "runner", containerName: "runner", image: "runner", ports: {} } },
      { commands: executor },
    ),
    (error: unknown) => error instanceof AnboError && error.exitCode === ExitCode.Deadline && error.code === "ANBO_TEST_TIMEOUT",
  );
});

test("runtime binding detection leaves static service test loops untouched", async () => {
  assert.deepEqual(runtimeBoundServiceNames({
    static: { image: "static:test", environment: { MODE: "test", TABLE: "${terraform.table}" } },
    environment: { image: "environment:test", environment: { TOKEN: "env://ROTATING_TOKEN" } },
    postgres: { image: "postgres:test", environment: { DATABASE_URL: "${clone.postgres.database_url}" } },
    dynamodb: { image: "dynamodb:test", dynamodb_plane: "clone" },
    adapter: { image: "adapter:test", environment: { ENDPOINT: "${adapter.example.api.endpoint}" } },
  }), ["environment", "postgres", "dynamodb", "adapter"]);

  const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
  const context: ServiceRuntimeContext = {
    projectId: "checkout",
    networkName: "anbo-checkout-app",
    miniStackEndpoint: "http://ministack:4566",
    terraformOutputs: { table: "orders" },
    clones: {},
    builds: {},
    environment: {},
  };
  const existing = {
    static: { name: "static", containerName: "anbo-checkout-static", image: "static:deployed", ports: {} },
    runner: { name: "runner", containerName: "anbo-checkout-runner", image: "runner:deployed", ports: {} },
  };
  const refreshed = await refreshRuntimeBoundServices({
    static: { image: "static:manifest", environment: { MODE: "test", TABLE: "${terraform.table}" } },
  }, context, existing, { commands: executor });
  assert.deepEqual(refreshed, { running: existing, restarted: [] });
  assert.equal(executor.calls.length, 0);
});

test("unchanged Docker builds are skipped and Terraform outputs are exported predictably", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-build-test-"));
  await writeFile(join(directory, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(directory, "notes.txt"), "unrelated\n");
  const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "#1 CACHED\n", stderr: "" }));
  const built = await buildDeclaredImages({
    projectId: "checkout",
    root: directory,
    builds: { api: { context: ".", inputs: ["Dockerfile"] } },
    cacheRoot: join(directory, "cache"),
  }, { commands: executor });
  assert.equal(built.api?.cacheHit, false);
  const buildArgs = executor.calls.find((call) => call.args.includes("buildx"))?.args ?? [];
  assert.ok(buildArgs.includes("--cache-to"));
  const buildCalls = executor.calls.length;
  await writeFile(join(directory, "notes.txt"), "still unrelated\n");
  const reused = await buildDeclaredImages({
    projectId: "checkout",
    root: directory,
    builds: { api: { context: ".", inputs: ["Dockerfile"] } },
    cacheRoot: join(directory, "cache"),
  }, { commands: executor });
  assert.equal(reused.api?.cacheHit, true);
  assert.equal(executor.calls.length, buildCalls + 1, "only docker image inspect should run on a cache hit");

  await writeFile(join(directory, "Dockerfile"), "FROM scratch\nLABEL changed=true\n");
  const rebuilt = await buildDeclaredImages({
    projectId: "checkout",
    root: directory,
    builds: { api: { context: ".", inputs: ["Dockerfile"] } },
    cacheRoot: join(directory, "cache"),
  }, { commands: executor });
  assert.equal(rebuilt.api?.cacheHit, false);

  const context: ServiceRuntimeContext = {
    projectId: "checkout",
    networkName: "anbo-checkout-app",
    miniStackEndpoint: "http://ministack:4566",
    terraformOutputs: { apiUrl: "http://api.example", order_table: "orders" },
    clones: {},
    builds: {},
    environment: {},
  };
  const environment = resolveServiceEnvironment({ API_URL: "${terraform.apiUrl}" }, context);
  assert.equal(environment.API_URL, "http://api.example");
  assert.equal(environment.ANBO_TERRAFORM_OUTPUT_API_URL, "http://api.example");
  assert.equal(environment.ANBO_TERRAFORM_OUTPUT_ORDER_TABLE, "orders");
});

test("deploy skips unchanged Terraform roots and reconciles only invalidated roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-incremental-deploy-test-"));
  const project = join(directory, "project");
  const stateHome = join(directory, "state");
  const cacheHome = join(directory, "cache");
  const firstRoot = join(project, "infra-a");
  const secondRoot = join(project, "infra-b");
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await writeFile(join(firstRoot, "main.tf"), `resource "aws_s3_bucket" "a" { bucket = "a" }\n`);
  await writeFile(join(secondRoot, "main.tf"), `resource "aws_sqs_queue" "b" { name = "b" }\n`);

  const manifest = minimalManifest();
  manifest.terraform.roots = ["infra-a", "infra-b"];
  const executor = new IncrementalDeployExecutor();
  const firstStateKey = terraformRootStateKey(project, "infra-a");
  const secondStateKey = terraformRootStateKey(project, "infra-b");
  const runAction = async (
    action: "deploy" | "reset" | "down",
    flags: Record<string, boolean> = {},
    events: string[] = [],
  ) => await runDeploy({
    root: project,
    runtimeProjectId: "incremental-runtime",
    manifestPath: join(project, ".anbo", "sandbox.json"),
    manifest,
    action,
    args: [],
    flags: { "no-test": true, ...flags },
    env: {},
    stateHome,
    cacheHome,
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
  }, eventSink(events));
  const deploy = async (flags: Record<string, boolean> = {}, events: string[] = []) =>
    await runAction("deploy", flags, events);

  const coldEvents: string[] = [];
  const cold = await deploy({}, coldEvents);
  assert.deepEqual(
    executor.terraformCommands,
    [firstStateKey, secondStateKey].flatMap((stateKey) =>
      ["init", "validate", "plan", "show", "apply", "output"].map((command) => ({ command, stateKey }))),
  );
  const coldReconciliation = cold["terraform_reconciliation"] as Record<string, unknown>;
  assert.equal(coldReconciliation["skipped"], false);
  assert.equal(coldReconciliation["reconciled"], true);
  assert.equal(JSON.stringify(coldReconciliation).includes("fingerprint"), false);
  const fingerprintEvents = coldEvents
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event["phase"] === "terraform.fingerprint" &&
      (event["fields"] as Record<string, unknown> | undefined)?.["status"] === "succeeded");
  assert.equal(fingerprintEvents.length, 2);
  for (const event of fingerprintEvents) {
    const fields = event["fields"] as Record<string, unknown>;
    assert.equal(typeof fields["duration_ms"], "number");
    assert.equal("fingerprint" in fields, false);
  }

  const coldOutputs = cold["endpoints"] as Record<string, unknown>;
  const warmStart = executor.terraformCommands.length;
  const warmEvents: string[] = [];
  const warm = await deploy({}, warmEvents);
  assert.equal(executor.terraformCommands.length, warmStart, "a true warm deploy must start no Terraform workers");
  assert.deepEqual(warm["endpoints"], coldOutputs);
  const warmReconciliation = warm["terraform_reconciliation"] as Record<string, unknown>;
  assert.equal(warmReconciliation["skipped"], true);
  assert.equal(warmReconciliation["reconciled"], false);
  assert.equal(warmReconciliation["reason"], "terraform_reconciliation_fingerprint_match");
  assert.equal(warmEvents.some((line) => line.includes('"phase":"terraform.init"')), false);

  await writeFile(join(firstRoot, "main.tf"), `resource "aws_s3_bucket" "a" { bucket = "a-changed" }\n`);
  const sourceChangeStart = executor.terraformCommands.length;
  const sourceChange = await deploy();
  assert.deepEqual(
    executor.terraformCommands.slice(sourceChangeStart),
    ["init", "validate", "plan", "show", "apply", "output"].map((command) => ({ command, stateKey: firstStateKey })),
  );
  assert.equal(
    (sourceChange["terraform_reconciliation"] as Record<string, unknown>)["reason"],
    "terraform_reconciliation_fingerprint_changed",
  );

  const supervisor = new ProjectSupervisor({
    projectRoot: project,
    projectId: "incremental-runtime",
    logicalProjectId: manifest.project.name,
    projectName: manifest.project.name,
    stateHome,
  });
  await writeFile(
    join(supervisor.stateDirectory, "terraform", "roots", secondStateKey, "terraform.tfstate"),
    JSON.stringify({ externally_modified: true }),
  );
  const stateChangeStart = executor.terraformCommands.length;
  const stateChange = await deploy();
  assert.deepEqual(
    executor.terraformCommands.slice(stateChangeStart),
    ["init", "validate", "plan", "show", "apply", "output"].map((command) => ({ command, stateKey: secondStateKey })),
  );
  assert.equal(
    (stateChange["terraform_reconciliation"] as Record<string, unknown>)["reason"],
    "terraform_state_metadata_changed",
  );

  executor.planCode = 0;
  const forcedStart = executor.terraformCommands.length;
  const forcedEvents: string[] = [];
  const forced = await deploy({ reconcile: true }, forcedEvents);
  assert.deepEqual(
    executor.terraformCommands.slice(forcedStart),
    [firstStateKey, secondStateKey].flatMap((stateKey) =>
      ["init", "validate", "plan", "output"].map((command) => ({ command, stateKey }))),
  );
  assert.equal(
    (forced["terraform_reconciliation"] as Record<string, unknown>)["reason"],
    "terraform_reconcile_requested",
  );
  assert.equal(forcedEvents.filter((line) => line.includes('"reason":"terraform_plan_empty"')).length, 2);

  executor.restartOutOfBand();
  const restartedStart = executor.terraformCommands.length;
  const restarted = await deploy();
  assert.equal(executor.terraformCommands.slice(restartedStart).length, 8);
  assert.equal(
    (restarted["terraform_reconciliation"] as Record<string, unknown>)["reason"],
    "ministack_runtime_generation_changed",
  );

  executor.planCode = 2;
  const resetStart = executor.terraformCommands.length;
  const reset = await runAction("reset");
  assert.equal(reset["action"], "reset");
  assert.equal(executor.terraformCommands.slice(resetStart).length, 12);
  assert.equal(
    (reset["terraform_reconciliation"] as Record<string, unknown>)["reason"],
    "terraform_non_deploy_action",
  );

  const preservedDirectory = join(supervisor.stateDirectory, "terraform");
  const down = await runAction("down");
  assert.equal(down["local_state_purged"], false);
  assert.ok((await stat(preservedDirectory)).isDirectory());
  const stoppedState = await supervisor.readState();
  assert.equal(stoppedState?.["status"], "stopped");
  assert.ok(stoppedState?.["terraform"] !== undefined);

  executor.planCode = 0;
  const afterDownStart = executor.terraformCommands.length;
  const afterDown = await deploy();
  assert.equal(executor.terraformCommands.slice(afterDownStart).length, 8);
  assert.equal(
    (afterDown["terraform_reconciliation"] as Record<string, unknown>)["reason"],
    "ministack_runtime_not_reused",
  );
  const purged = await runAction("down", { purge: true });
  assert.equal(purged["local_state_purged"], true);
  await assert.rejects(stat(preservedDirectory), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal((await supervisor.readState())?.["terraform"], undefined);
});

test("legacy index state migrates through its trusted root mapping without root aliasing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-state-migration-"));
  const project = join(directory, "project");
  const stateHome = join(directory, "state");
  const cacheHome = join(directory, "cache");
  await mkdir(join(project, "infra-a"), { recursive: true });
  await mkdir(join(project, "infra-b"), { recursive: true });
  await writeFile(join(project, "infra-a", "main.tf"), `output "root" { value = "a" }\n`);
  await writeFile(join(project, "infra-b", "main.tf"), `output "root" { value = "b" }\n`);
  const firstStateKey = terraformRootStateKey(project, "infra-a");
  const secondStateKey = terraformRootStateKey(project, "infra-b");
  const supervisor = new ProjectSupervisor({
    projectRoot: project,
    projectId: "migration-runtime",
    logicalProjectId: "checkout",
    projectName: "checkout",
    stateHome,
  });
  await supervisor.writeState({
    status: "ready",
    terraform: { outputs: {}, roots: ["infra-a", "infra-b"] },
  });
  await mkdir(join(supervisor.stateDirectory, "terraform", "0"), { recursive: true });
  await mkdir(join(supervisor.stateDirectory, "terraform", "1"), { recursive: true });
  await writeFile(join(supervisor.stateDirectory, "terraform", "0", "terraform.tfstate"), '{"legacy_root":"a"}\n');
  await writeFile(join(supervisor.stateDirectory, "terraform", "1", "terraform.tfstate"), '{"legacy_root":"b"}\n');

  const manifest = minimalManifest();
  manifest.terraform.roots = ["infra-b", "infra-a"];
  const executor = new IncrementalDeployExecutor();
  executor.planCode = 0;
  const deploy = async () => await runDeploy({
    root: project,
    runtimeProjectId: "migration-runtime",
    manifestPath: join(project, ".anbo", "sandbox.json"),
    manifest,
    action: "deploy",
    args: [],
    flags: { "no-test": true },
    env: {},
    stateHome,
    cacheHome,
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
  }, eventSink());

  await deploy();
  assert.deepEqual(
    executor.terraformCommands,
    [secondStateKey, firstStateKey].flatMap((stateKey) =>
      ["init", "validate", "plan", "output"].map((command) => ({ command, stateKey }))),
  );
  assert.equal(
    await readFile(join(supervisor.stateDirectory, "terraform", "roots", firstStateKey, "terraform.tfstate"), "utf8"),
    '{"legacy_root":"a"}\n',
  );
  assert.equal(
    await readFile(join(supervisor.stateDirectory, "terraform", "roots", secondStateKey, "terraform.tfstate"), "utf8"),
    '{"legacy_root":"b"}\n',
  );
  await assert.rejects(stat(join(supervisor.stateDirectory, "terraform", "0")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  await assert.rejects(stat(join(supervisor.stateDirectory, "terraform", "1")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");

  manifest.terraform.roots = ["infra-a", "infra-b"];
  const reorderStart = executor.terraformCommands.length;
  await deploy();
  assert.deepEqual(
    executor.terraformCommands.slice(reorderStart),
    [firstStateKey, secondStateKey].flatMap((stateKey) =>
      ["init", "validate", "plan", "output"].map((command) => ({ command, stateKey }))),
  );
  assert.match(await readFile(join(supervisor.stateDirectory, "terraform", "roots", firstStateKey, "terraform.tfstate"), "utf8"), /"a"/);
  assert.match(await readFile(join(supervisor.stateDirectory, "terraform", "roots", secondStateKey, "terraform.tfstate"), "utf8"), /"b"/);
  const warmStart = executor.terraformCommands.length;
  const warm = await deploy();
  assert.equal(executor.terraformCommands.length, warmStart, JSON.stringify(warm["terraform_reconciliation"]));
  assert.equal((warm["terraform_reconciliation"] as Record<string, unknown>)["skipped"], true);

  manifest.terraform.roots = ["infra-a"];
  const removalStart = executor.terraformCommands.length;
  await assert.rejects(deploy(), /down --purge.*removed roots cannot leave unmanaged resources/s);
  assert.equal(executor.terraformCommands.length, removalStart, "root removal must not run a worker against retained state");

  await mkdir(join(project, "infra-c"));
  await writeFile(join(project, "infra-c", "main.tf"), `output "root" { value = "c" }\n`);
  manifest.terraform.roots = ["infra-a", "infra-b", "infra-c"];
  executor.planCode = 2;
  executor.failApplicationNetwork = true;
  await assert.rejects(deploy(), /injected application network failure/);
  assert.deepEqual(
    ((await supervisor.readState())?.["terraform"] as Record<string, unknown>)["pending_roots"],
    ["infra-c"],
  );
  executor.failApplicationNetwork = false;
  manifest.terraform.roots = ["infra-a", "infra-b"];
  const failedAdditionRemovalStart = executor.terraformCommands.length;
  await assert.rejects(deploy(), /previously managed root "infra-c".*down --purge/s);
  assert.equal(executor.terraformCommands.length, failedAdditionRemovalStart);
});

test("legacy migration rejects numeric index aliases before moving any state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-state-alias-"));
  const project = join(directory, "project");
  const stateHome = join(directory, "state");
  await mkdir(join(project, "infra-a"), { recursive: true });
  await writeFile(join(project, "infra-a", "main.tf"), `output "root" { value = "a" }\n`);
  const supervisor = new ProjectSupervisor({
    projectRoot: project,
    projectId: "alias-runtime",
    logicalProjectId: "checkout",
    projectName: "checkout",
    stateHome,
  });
  await supervisor.writeState({
    status: "ready",
    terraform: { outputs: {}, roots: ["infra-a"] },
  });
  for (const index of ["0", "00"]) {
    await mkdir(join(supervisor.stateDirectory, "terraform", index), { recursive: true });
    await writeFile(join(supervisor.stateDirectory, "terraform", index, "terraform.tfstate"), `${index}\n`);
  }
  const manifest = minimalManifest();
  manifest.terraform.roots = ["infra-a"];
  const executor = new IncrementalDeployExecutor();

  await assert.rejects(runDeploy({
    root: project,
    runtimeProjectId: "alias-runtime",
    manifestPath: join(project, ".anbo", "sandbox.json"),
    manifest,
    action: "deploy",
    args: [],
    flags: { "no-test": true },
    env: {},
    stateHome,
    cacheHome: join(directory, "cache"),
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
  }, eventSink()), /legacy root index "00" is not canonical/);
  assert.equal(executor.terraformCommands.length, 0);
  assert.ok((await stat(join(supervisor.stateDirectory, "terraform", "0"))).isDirectory());
  assert.ok((await stat(join(supervisor.stateDirectory, "terraform", "00"))).isDirectory());
  await assert.rejects(stat(join(supervisor.stateDirectory, "terraform", "roots")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("ambiguous legacy Terraform state fails closed with purge remediation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-terraform-state-ambiguous-"));
  const project = join(directory, "project");
  const stateHome = join(directory, "state");
  await mkdir(project);
  await writeFile(join(project, "main.tf"), `output "root" { value = "ambiguous" }\n`);
  const supervisor = new ProjectSupervisor({
    projectRoot: project,
    projectId: "ambiguous-runtime",
    logicalProjectId: "checkout",
    projectName: "checkout",
    stateHome,
  });
  await supervisor.initialize();
  await mkdir(join(supervisor.stateDirectory, "terraform", "0"), { recursive: true });
  await writeFile(join(supervisor.stateDirectory, "terraform", "0", "terraform.tfstate"), "{}\n");
  const executor = new IncrementalDeployExecutor();

  await assert.rejects(runDeploy({
    root: project,
    runtimeProjectId: "ambiguous-runtime",
    manifestPath: join(project, ".anbo", "sandbox.json"),
    manifest: minimalManifest(),
    action: "deploy",
    args: [],
    flags: { "no-test": true },
    env: {},
    stateHome,
    cacheHome: join(directory, "cache"),
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
  }, eventSink()), /Run anbo down --purge, then anbo deploy/);
  assert.equal(executor.terraformCommands.length, 0);

  const duplicateManifest = minimalManifest();
  duplicateManifest.terraform.roots = [".", "./"];
  await assert.rejects(runDeploy({
    root: project,
    runtimeProjectId: "ambiguous-runtime",
    manifestPath: join(project, ".anbo", "sandbox.json"),
    manifest: duplicateManifest,
    action: "deploy",
    args: [],
    flags: { "no-test": true },
    env: {},
    stateHome,
    cacheHome: join(directory, "cache"),
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
  }, eventSink()), /resolve to the same directory|current Terraform root mapping is ambiguous/);
  assert.equal(executor.terraformCommands.length, 0);
});

test("capabilities runs through the target runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-deploy-test-"));
  const manifest = minimalManifest();
  const result = await runDeploy({
    root: directory,
    manifestPath: join(directory, ".anbo", "sandbox.json"),
    manifest,
    action: "capabilities",
    args: [],
    flags: {},
    env: { XDG_STATE_HOME: join(directory, "state") },
  }, eventSink());
  assert.equal(result.status, "succeeded");
  assert.equal((result["capabilities"] as Record<string, unknown>)["schema_version"], 1);
});

function minimalManifest(): SandboxManifest {
  return {
    schema_version: 2,
    project: { name: "checkout" },
    terraform: { roots: ["."], variable_files: [] },
    data: {},
    services: {},
    builds: {},
    tests: {},
    ministack: {
      image: "ministackorg/ministack:1.4.2-full",
      digest: `sha256:${"a".repeat(64)}`,
      profile: "full",
      persistence: true,
    },
    network: { allow_hosts: [], clone_egress: false },
    adapters: {},
  };
}

function basicMiniStackInspection(containerId: string, generation: string, hostPort: string): string {
  return JSON.stringify([{
    Id: containerId,
    State: { Running: true, ExitCode: 0, StartedAt: generation },
    HostConfig: {
      PortBindings: { "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] },
    },
  }]);
}
