import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginContextV1 } from "@getanbo/plugin-sdk";

import { runDeploy } from "../src/deploy.js";
import {
  CERTIFIED_MINISTACK_DIGEST,
  CERTIFIED_MINISTACK_IMAGE,
} from "../src/distribution.js";
import { PluginEventSink } from "../src/event-sink.js";
import { buildDeclaredImages } from "../src/runtime/cache.js";
import {
  startMiniStack,
  type CommandExecutor,
  type RuntimeCommandOptions,
  type RuntimeCommandResult,
} from "../src/runtime/ministack.js";
import { deriveRuntimeProjectId, ProjectSupervisor } from "../src/supervisor.js";
import { AnboError, type SandboxManifest } from "../src/types.js";

class TestExecutor implements CommandExecutor {
  readonly calls: Array<{ args: string[]; options?: RuntimeCommandOptions }> = [];

  constructor(private readonly respond: (
    args: readonly string[],
    options?: RuntimeCommandOptions,
  ) => RuntimeCommandResult | Promise<RuntimeCommandResult>) {}

  async run(_command: string, args: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
    this.calls.push({ args: [...args], ...(options === undefined ? {} : { options }) });
    return await this.respond(args, options);
  }
}

for (const serverPlatform of ["linux/amd64", "linux/arm64"] as const) {
  test(`certified runtime selects native ${serverPlatform} with exact Docker arguments`, async () => {
    let runArguments: readonly string[] = [];
    let created = false;
    const compatibilityEvents: Array<{ certificationCacheHit: boolean }> = [];
    const executor = new TestExecutor(async (args) => {
      if (args[0] === "version") return { code: 0, stdout: `${serverPlatform}\n`, stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") {
        return { code: 0, stdout: `${CERTIFIED_MINISTACK_DIGEST}\n`, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "inspect") {
        return created
          ? { code: 0, stdout: runningInspection(runArguments), stderr: "" }
          : { code: 1, stdout: "", stderr: "No such container" };
      }
      if (args[0] === "run") {
        created = true;
        runArguments = args;
        return { code: 0, stdout: "container-id\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const runtime = await startMiniStack({
      projectId: "platform-selection",
      image: CERTIFIED_MINISTACK_IMAGE,
      digest: CERTIFIED_MINISTACK_DIGEST,
      persistence: false,
      stateRoot: "/tmp/unused",
    }, {
      commands: executor,
      fetch: async () => Response.json({ edition: "full" }),
      onCompatibility: async (metadata) => { compatibilityEvents.push(metadata); },
    });

    const runtimeConfigLabel = runArguments.find((value) => value.startsWith("anbo.dev/runtime-config="));
    const compatibilityLabel = runArguments.find((value) => value.startsWith("anbo.dev/ministack-compatibility="));
    const publishedPort = runArguments.find((value) => value.startsWith("127.0.0.1:") && value.endsWith(":4566"));
    assert.ok(runtimeConfigLabel);
    assert.ok(publishedPort);
    assert.deepEqual(runArguments, [
      "run", "--detach", "--name", "anbo-platform-selection-ministack",
      "--platform", serverPlatform,
      "--label", "anbo.dev/managed=true",
      "--label", "anbo.dev/project=platform-selection",
      "--label", "anbo.dev/component=ministack",
      ...(serverPlatform === "linux/arm64" ? ["--label", compatibilityLabel] : []),
      "--label", runtimeConfigLabel,
      "--network", "anbo-platform-selection-runtime",
      "--add-host", "host.docker.internal:host-gateway",
      "--publish", publishedPort,
      "--volume", "/var/run/docker.sock:/var/run/docker.sock",
      "--env", "DOCKER_NETWORK=anbo-platform-selection-runtime",
      "--env", "LAMBDA_EXECUTOR=docker",
      "--env", "LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway",
      "--env", "MINISTACK_REGION=us-east-1",
      "--env", "MINISTACK_ACCOUNT_ID=000000000000",
      ...(serverPlatform === "linux/arm64" ? ["--env", "OPENSSL_armcap=0"] : []),
      CERTIFIED_MINISTACK_IMAGE,
    ]);
    assert.deepEqual(executor.calls[0]?.args, ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
    assert.equal(runtime.platform, serverPlatform);
    assert.equal(runtime.serverPlatform, serverPlatform);
    if (serverPlatform === "linux/arm64") {
      assert.ok(compatibilityLabel);
      assert.equal(runtime.compatibility?.certificationCacheHit, true);
      assert.deepEqual(compatibilityEvents.map((event) => event.certificationCacheHit), [true]);
    } else {
      assert.equal(compatibilityLabel, undefined);
      assert.equal(runArguments.includes("OPENSSL_armcap=0"), false);
      assert.equal(runtime.compatibility, undefined);
      assert.deepEqual(compatibilityEvents, []);
    }
  });
}

test("ARM64 compatibility probes once and reuses only the exact certified image", async () => {
  let runArguments: readonly string[] = [];
  let created = false;
  let certified = false;
  const cacheHits: boolean[] = [];
  const executor = new TestExecutor(async (args) => {
    if (args[0] === "version") return { code: 0, stdout: "linux/arm64\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    if (args[0] === "inspect") {
      return created
        ? { code: 0, stdout: runningInspection(runArguments), stderr: "" }
        : { code: 1, stdout: "", stderr: "No such container" };
    }
    if (args[0] === "run") {
      created = true;
      runArguments = args;
      return { code: 0, stdout: "container-id\n", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return certified
        ? { code: 0, stdout: `${CERTIFIED_MINISTACK_DIGEST}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "No such image" };
    }
    if (args[0] === "exec") {
      const script = args.at(-1) ?? "";
      assert.match(script, /Ed25519PrivateKey/);
      assert.match(script, /import asyncssh/);
      assert.match(script, /generate_data_key/);
      assert.match(script, /kms\.encrypt/);
      assert.match(script, /kms\.decrypt/);
      return {
        code: 0,
        stdout: '{"architecture":"aarch64","asyncssh":"2.24.0","ed25519":true,"kms":true}\n',
        stderr: "",
      };
    }
    if (args[0] === "image" && args[1] === "tag") {
      certified = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const request = {
    projectId: "arm64-certification",
    image: CERTIFIED_MINISTACK_IMAGE,
    digest: CERTIFIED_MINISTACK_DIGEST,
    persistence: false,
    stateRoot: "/tmp/unused",
  };
  const dependencies = {
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
    onCompatibility: async (metadata: { certificationCacheHit: boolean }) => {
      cacheHits.push(metadata.certificationCacheHit);
    },
  };

  const cold = await startMiniStack(request, dependencies);
  const warm = await startMiniStack(request, dependencies);

  assert.equal(cold.compatibility?.certificationCacheHit, false);
  assert.equal(warm.compatibility?.certificationCacheHit, true);
  assert.equal(warm.reused, true);
  assert.deepEqual(cacheHits, [false, true]);
  assert.equal(executor.calls.filter((call) => call.args[0] === "exec").length, 1);
  assert.equal(executor.calls.filter((call) => call.args[0] === "image" && call.args[1] === "tag").length, 1);
});

test("ARM64 compatibility certification fails clearly and never records a cache tag", async () => {
  let runArguments: readonly string[] = [];
  let created = false;
  const executor = new TestExecutor(async (args) => {
    if (args[0] === "version") return { code: 0, stdout: "linux/arm64\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    if (args[0] === "inspect") {
      return created
        ? { code: 0, stdout: runningInspection(runArguments), stderr: "" }
        : { code: 1, stdout: "", stderr: "No such container" };
    }
    if (args[0] === "run") {
      created = true;
      runArguments = args;
      return { code: 0, stdout: "container-id\n", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "No such image" };
    }
    if (args[0] === "exec") return { code: 132, stdout: "", stderr: "Illegal instruction" };
    return { code: 0, stdout: "", stderr: "" };
  });

  await assert.rejects(startMiniStack({
    projectId: "arm64-certification-failure",
    image: CERTIFIED_MINISTACK_IMAGE,
    digest: CERTIFIED_MINISTACK_DIGEST,
    persistence: false,
    stateRoot: "/tmp/unused",
  }, {
    commands: executor,
    fetch: async () => Response.json({ edition: "full" }),
  }), /ARM64 compatibility certification failed: Illegal instruction/);
  assert.equal(executor.calls.some((call) => call.args[0] === "image" && call.args[1] === "tag"), false);
});

for (const scenario of [
  {
    name: "unsupported",
    reported: "linux/riscv64",
    message: /unsupported platform linux\/riscv64; MiniStack requires linux\/amd64 or linux\/arm64/,
  },
  {
    name: "malformed",
    reported: "linux-arm64",
    message: /malformed platform linux-arm64; expected os\/architecture/,
  },
] as const) {
  test(`certified runtime rejects ${scenario.name} Docker server platform before mutation`, async () => {
    const executor = new TestExecutor(async (args) => args[0] === "version"
      ? { code: 0, stdout: `${scenario.reported}\n`, stderr: "" }
      : { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` });

    await assert.rejects(startMiniStack({
      projectId: "platform-rejection",
      image: CERTIFIED_MINISTACK_IMAGE,
      digest: CERTIFIED_MINISTACK_DIGEST,
      persistence: false,
      stateRoot: "/tmp/unused",
    }, { commands: executor }), scenario.message);

    assert.deepEqual(executor.calls.map((call) => call.args), [
      ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
    ]);
  });
}

test("dead MiniStack containers fail immediately with bounded redacted evidence", async () => {
  let created = false;
  let sleeps = 0;
  const accessKey = `AKIA${"A".repeat(16)}`;
  const executor = new TestExecutor(async (args) => {
    if (args[0] === "version") return { code: 0, stdout: "linux/amd64\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "inspect") {
      return created
        ? {
            code: 0,
            stdout: JSON.stringify([{ State: { Running: false, ExitCode: 132, Error: "illegal instruction" } }]),
            stderr: "",
          }
        : { code: 1, stdout: "", stderr: "No such container" };
    }
    if (args[0] === "run") {
      created = true;
      return { code: 0, stdout: "container-id\n", stderr: "" };
    }
    if (args[0] === "logs") return {
      code: 0,
      stdout: `${"startup noise\n".repeat(1_000)}fatal SIGILL ${accessKey}\n`,
      stderr: "",
    };
    return { code: 0, stdout: "", stderr: "" };
  });

  await assert.rejects(startMiniStack({
    projectId: "dead-container",
    image: "ministackorg/ministack:1.4.2-full",
    digest: `sha256:${"a".repeat(64)}`,
    persistence: false,
    stateRoot: "/tmp/unused",
  }, {
    commands: executor,
    fetch: async () => { throw new Error("fetch failed"); },
    sleep: async () => { sleeps += 1; },
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /exit code 132/);
    assert.match(error.message, /fatal SIGILL/);
    assert.match(error.message, /\[REDACTED\]/);
    assert.doesNotMatch(error.message, new RegExp(accessKey));
    assert.ok(error.message.length < 8_500);
    return true;
  });
  assert.equal(sleeps, 0);
  assert.ok(executor.calls.some((call) => call.args.join(" ") === "logs --tail 80 anbo-dead-container-ministack"));
});

test("Docker builds safely fall back when the Buildx plugin is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-buildx-fallback-"));
  try {
    await writeFile(join(directory, "Dockerfile"), "FROM scratch\n");
    const executor = new TestExecutor(async (args) => {
      if (args[0] === "image") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "buildx" && args[1] === "version") {
        return { code: 1, stdout: "", stderr: "docker: 'buildx' is not a docker command." };
      }
      if (args[0] === "build") return { code: 0, stdout: "Successfully built image\n", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
    });

    const result = await buildDeclaredImages({
      projectId: "fallback",
      root: directory,
      builds: { api: { context: ".", inputs: ["Dockerfile"] } },
      cacheRoot: join(directory, "cache"),
    }, { commands: executor });

    const build = executor.calls.find((call) => call.args[0] === "build");
    assert.ok(build);
    assert.equal(build.args.includes("--cache-to"), false);
    assert.equal(result.api?.metadata["build_engine"], "docker");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Docker build fingerprints include executable mode changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-build-mode-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "anbo-build-mode-cache-"));
  try {
    await writeFile(join(directory, "Dockerfile"), "FROM scratch\nCOPY entrypoint.sh /entrypoint.sh\n");
    await writeFile(join(directory, "entrypoint.sh"), "#!/bin/sh\n", { mode: 0o644 });
    const executor = buildSuccessExecutor();
    const request = {
      projectId: "mode-fingerprint",
      root: directory,
      builds: { api: { context: ".", dockerfile: "Dockerfile" } },
      cacheRoot,
    };

    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, false);
    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, true);
    await chmod(join(directory, "entrypoint.sh"), 0o755);
    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, false);
    assert.equal(dockerBuildCount(executor), 2);
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(cacheRoot, { recursive: true, force: true }),
    ]);
  }
});

test("Docker build fingerprints include symbolic-link targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-build-symlink-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "anbo-build-symlink-cache-"));
  try {
    await writeFile(join(directory, "Dockerfile"), "FROM scratch\nCOPY current.txt /current.txt\n");
    await writeFile(join(directory, "first.txt"), "first\n");
    await writeFile(join(directory, "second.txt"), "second\n");
    await symlink("first.txt", join(directory, "current.txt"));
    const executor = buildSuccessExecutor();
    const request = {
      projectId: "symlink-fingerprint",
      root: directory,
      builds: { api: { context: ".", dockerfile: "Dockerfile" } },
      cacheRoot,
    };

    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, false);
    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, true);
    await unlink(join(directory, "current.txt"));
    await symlink("second.txt", join(directory, "current.txt"));
    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, false);
    assert.equal(dockerBuildCount(executor), 2);
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(cacheRoot, { recursive: true, force: true }),
    ]);
  }
});

test("Docker build fingerprints follow .dockerignore without hardcoded directory exclusions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-build-ignore-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "anbo-build-ignore-cache-"));
  try {
    await mkdir(join(directory, "ignored"));
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "Dockerfile"), "FROM scratch\nCOPY . /context\n");
    await writeFile(join(directory, ".dockerignore"), "ignored\n");
    await writeFile(join(directory, "ignored", "noise.txt"), "first\n");
    await writeFile(join(directory, "node_modules", "dependency.js"), "first\n");
    const executor = buildSuccessExecutor();
    const request = {
      projectId: "ignore-fingerprint",
      root: directory,
      builds: { api: { context: ".", dockerfile: "Dockerfile" } },
      cacheRoot,
    };

    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, false);
    await writeFile(join(directory, "ignored", "noise.txt"), "second\n");
    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, true);
    await writeFile(join(directory, "node_modules", "dependency.js"), "second\n");
    assert.equal((await buildDeclaredImages(request, { commands: executor })).api?.cacheHit, false);
    assert.equal(dockerBuildCount(executor), 2);
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(cacheRoot, { recursive: true, force: true }),
    ]);
  }
});

test("command build outputs invalidate downstream command builds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-command-dependency-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "anbo-command-dependency-cache-"));
  try {
    const source = join(directory, "source.txt");
    const generated = join(directory, "generated.txt");
    const consumed = join(directory, "consumed.txt");
    await writeFile(source, "first\n");
    const executor = new TestExecutor(async (args) => {
      if (args[0] === "producer") {
        await writeFile(generated, await readFile(source));
        return { code: 0, stdout: "generated\n", stderr: "" };
      }
      if (args[0] === "consumer") {
        await writeFile(consumed, await readFile(generated));
        return { code: 0, stdout: "consumed\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command args: ${args.join(" ")}` };
    });
    const request = {
      projectId: "command-dependency",
      root: directory,
      builds: {
        producer: {
          context: ".",
          inputs: ["source.txt"],
          command: ["node", "producer"],
          outputs: ["generated.txt"],
        },
        consumer: {
          context: ".",
          inputs: ["generated.txt"],
          command: ["node", "consumer"],
          outputs: ["consumed.txt"],
        },
      },
      cacheRoot,
    };

    const first = await buildDeclaredImages(request, { commands: executor });
    assert.equal(first.producer?.cacheHit, false);
    assert.equal(first.consumer?.cacheHit, false);
    const unchanged = await buildDeclaredImages(request, { commands: executor });
    assert.equal(unchanged.producer?.cacheHit, true);
    assert.equal(unchanged.consumer?.cacheHit, true);

    await writeFile(source, "second\n");
    const changed = await buildDeclaredImages(request, { commands: executor });
    assert.equal(changed.producer?.cacheHit, false);
    assert.equal(changed.consumer?.cacheHit, false);
    assert.equal(await readFile(consumed, "utf8"), "second\n");
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(cacheRoot, { recursive: true, force: true }),
    ]);
  }
});

test("infrastructure setup cancels MiniStack readiness when an image build fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anbo-fail-fast-"));
  try {
    await writeFile(join(directory, "Dockerfile"), "FROM scratch\n");
    let created = false;
    let healthStarted = false;
    let healthCancelled = false;
    let runArguments: readonly string[] = [];
    const executor = new TestExecutor(async (args) => {
      if (args[0] === "version") return { code: 0, stdout: "linux/arm64\n", stderr: "" };
      if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "volume" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "inspect") {
        return created
          ? { code: 0, stdout: runningInspection(runArguments), stderr: "" }
          : { code: 1, stdout: "", stderr: "No such container" };
      }
      if (args[0] === "run") {
        created = true;
        runArguments = args;
        return { code: 0, stdout: "container-id\n", stderr: "" };
      }
      if (args[0] === "image") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "buildx" && args[1] === "version") return { code: 0, stdout: "buildx v1\n", stderr: "" };
      if (args[0] === "buildx" && args[1] === "build") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { code: 1, stdout: "", stderr: "invalid Dockerfile" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetcher: typeof globalThis.fetch = async (_input, init) => {
      healthStarted = true;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          healthCancelled = true;
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => {
          healthCancelled = true;
          reject(signal.reason);
        }, { once: true });
      });
    };
    const manifest = testManifest();
    manifest.builds = { api: { context: ".", inputs: ["Dockerfile"] } };
    const startedAt = performance.now();

    await assert.rejects(runDeploy({
      root: directory,
      manifestPath: join(directory, ".anbo", "sandbox.json"),
      manifest,
      action: "deploy",
      args: [],
      flags: { "no-test": true },
      env: {},
      stateHome: join(directory, "state"),
      cacheHome: join(directory, "cache"),
      commands: executor,
      fetch: fetcher,
    }, testEventSink()), (error: unknown) => {
      assert.ok(error instanceof AnboError);
      assert.equal(error.code, "ANBO_BUILD_FAILED");
      assert.match(error.message, /invalid Dockerfile/);
      assert.equal(error.details?.retryable, false);
      assert.equal(error.details?.safe_to_retry, true);
      return true;
    });

    assert.ok(performance.now() - startedAt < 1_000, "failure should not wait for the 60 second health deadline");
    assert.equal(healthStarted, true);
    assert.equal(healthCancelled, true);
    const supervisor = new ProjectSupervisor({
      projectRoot: directory,
      projectId: deriveRuntimeProjectId(manifest.project.name, directory),
      stateHome: join(directory, "state"),
    });
    const failedState = await supervisor.readState();
    assert.equal(failedState?.["status"], "failed");
    assert.equal((failedState?.["last_operation"] as Record<string, unknown> | undefined)?.["action"], "deploy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runningInspection(runArguments: readonly string[]): string {
  const runtimeConfig = runArguments.find((value) => value.startsWith("anbo.dev/runtime-config="))?.split("=")[1] ?? "";
  const publish = runArguments.find((value) => value.startsWith("127.0.0.1:") && value.endsWith(":4566"));
  const hostPort = publish?.split(":")[1] ?? "4566";
  const networkIndex = runArguments.indexOf("--network");
  const runtimeNetwork = runArguments[networkIndex + 1] ?? "anbo-platform-selection-runtime";
  const containerNameIndex = runArguments.indexOf("--name");
  const containerName = runArguments[containerNameIndex + 1] ?? "anbo-platform-selection-ministack";
  const projectId = containerName.replace(/^anbo-/, "").replace(/-ministack$/, "");
  return JSON.stringify([{
    Id: "container-id",
    Image: CERTIFIED_MINISTACK_DIGEST,
    Config: {
      Image: runArguments.at(-1),
      Env: ["LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway"],
      Labels: { "anbo.dev/runtime-config": runtimeConfig },
    },
    State: { Running: true, ExitCode: 0, StartedAt: "generation-1" },
    HostConfig: {
      PortBindings: { "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] },
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
    NetworkSettings: { Networks: { [`anbo-${projectId}-control`]: {}, [runtimeNetwork]: {} } },
  }]);
}

function buildSuccessExecutor(): TestExecutor {
  return new TestExecutor(async (args) => {
    if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: "image-id\n", stderr: "" };
    if (args[0] === "buildx" && args[1] === "version") return { code: 0, stdout: "buildx v1\n", stderr: "" };
    if (args[0] === "buildx" && args[1] === "build") return { code: 0, stdout: "built\n", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
  });
}

function dockerBuildCount(executor: TestExecutor): number {
  return executor.calls.filter((call) => call.args[0] === "buildx" && call.args[1] === "build").length;
}

function testManifest(): SandboxManifest {
  return {
    schema_version: 2,
    project: { name: "fail-fast" },
    terraform: { roots: ["."], variable_files: [] },
    data: {},
    services: {},
    builds: {},
    tests: {},
    ministack: {
      image: CERTIFIED_MINISTACK_IMAGE,
      digest: CERTIFIED_MINISTACK_DIGEST,
      profile: "full",
      persistence: false,
    },
    network: { allow_hosts: [], clone_egress: false },
    adapters: {},
  };
}

function testEventSink(): PluginEventSink {
  return new PluginEventSink({
    signal: new AbortController().signal,
    events: { emit: async () => undefined },
  } as unknown as PluginContextV1);
}
