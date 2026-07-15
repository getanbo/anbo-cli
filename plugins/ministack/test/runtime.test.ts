import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { runTerraform, scrubTerraformEnvironment, terraformWorkerUserArguments, validateTerraformHcl } from "../src/runtime/terraform.js";
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
  const executor = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
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
  const missingExecutor = new RecordingExecutor(async (_command, args) => {
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
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
    Config: {
      Image: image,
      Env: ["LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway"],
      Labels: { [configLabelName!]: configLabelValue! },
    },
    State: { Running: true, ExitCode: 0 },
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
      return { code: 0, stdout: "container-id\n", stderr: "" };
    });
  };

  const reorderedExecutor = existingExecutor(false);
  await startMiniStack({
    ...baseConfig,
    environment: { OPENSEARCH_DATAPLANE: "0", Z_FLAG: "last" },
  }, {
    commands: reorderedExecutor,
    fetch: async () => Response.json({ edition: "full" }),
  });
  assert.equal(reorderedExecutor.calls.some((call) => call.args[0] === "rm"), false);
  assert.equal(reorderedExecutor.calls.some((call) => call.args[0] === "run"), false);

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
  const result = await runTerraform({
    sourceDirectory: source,
    privateDirectory: join(directory, "private"),
    statePath: join(directory, "state", "terraform.tfstate"),
    pluginCacheDirectory: join(directory, "plugins"),
    workerImage: `hashicorp/terraform@sha256:${"b".repeat(64)}`,
    networkName: "anbo-control",
    miniStackEndpoint: "http://ministack:4566",
    variableFiles: ["vars/local.tfvars"],
    environment: { ANBO_TOKEN: "must-not-appear", TF_VAR_password: "must-not-appear" },
  }, { commands: executor, onOutput: async (_stream, _text, phase) => { outputPhases.push(phase); } });
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
