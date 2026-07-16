import assert from "node:assert/strict";
import test from "node:test";

import type { ServiceConfig } from "../src/types.js";
import type { CommandExecutor, RuntimeCommandOptions, RuntimeCommandResult } from "../src/runtime/ministack.js";
import {
  refreshRuntimeBoundServices,
  startDeclaredServices,
  type ServiceRuntimeContext,
} from "../src/runtime/services.js";

interface FakeContainer {
  labels: Record<string, string>;
  running: boolean;
  healthy: boolean;
  paused?: boolean;
  restarting?: boolean;
  dead?: boolean;
  nativeHealth?: string;
}

class ServiceExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[]; options?: RuntimeCommandOptions }> = [];
  readonly starts: string[] = [];
  private readonly containers = new Map<string, FakeContainer>();
  private readonly imageIdentities = new Map<string, string>();

  async run(command: string, argsValue: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
    const args = [...argsValue];
    this.calls.push({ command, args, ...(options === undefined ? {} : { options }) });
    if (args[0] === "image" && args[1] === "inspect") {
      const image = args.at(-1) ?? "missing";
      return { code: 0, stdout: `${this.imageIdentities.get(image) ?? `sha256:${image}`}\n`, stderr: "" };
    }
    if (args[0] === "inspect") {
      const container = this.containers.get(args[1] ?? "");
      if (container === undefined) return { code: 1, stdout: "", stderr: "No such container" };
      return {
        code: 0,
        stdout: JSON.stringify([{
          State: {
            Running: container.running,
            Paused: container.paused ?? false,
            Restarting: container.restarting ?? false,
            Dead: container.dead ?? false,
            Status: container.running ? "running" : "exited",
            ...(container.nativeHealth === undefined ? {} : { Health: { Status: container.nativeHealth } }),
          },
          Config: { Labels: container.labels },
        }]),
        stderr: "",
      };
    }
    if (args[0] === "rm") {
      this.containers.delete(args.at(-1) ?? "");
      return { code: 0, stdout: "removed\n", stderr: "" };
    }
    if (args[0] === "run" && args.includes("--detach")) {
      const name = valueAfter(args, "--name");
      const labels = Object.fromEntries(valuesAfter(args, "--label").map((label) => {
        const separator = label.indexOf("=");
        return [label.slice(0, separator), label.slice(separator + 1)];
      }));
      this.containers.set(name, { labels, running: true, healthy: true });
      this.starts.push(name);
      return { code: 0, stdout: `${name}-id\n`, stderr: "" };
    }
    if (args[0] === "exec") {
      const container = this.containers.get(args[1] ?? "");
      return { code: container?.healthy === true ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:8080\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  markUnhealthy(containerName: string): void {
    const container = this.containers.get(containerName);
    if (container !== undefined) container.healthy = false;
  }

  markPaused(containerName: string): void {
    const container = this.containers.get(containerName);
    if (container !== undefined) container.paused = true;
  }

  markNativeUnhealthy(containerName: string): void {
    const container = this.containers.get(containerName);
    if (container !== undefined) container.nativeHealth = "unhealthy";
  }

  changeImage(image: string): void {
    this.imageIdentities.set(image, `sha256:${image}-changed`);
  }
}

test("warm deploy reuses unchanged healthy services and restarts only changed dependency branches", async () => {
  const commands = new ServiceExecutor();
  const services: Record<string, ServiceConfig> = {
    api: { image: "api:test", environment: { MODE: "first" } },
    worker: { image: "worker:test", depends_on: ["api"] },
    sidecar: { image: "sidecar:test" },
  };
  const context = serviceContext();

  await startDeclaredServices(services, context, { commands });
  assert.deepEqual(commands.starts.sort(), ["anbo-checkout-api", "anbo-checkout-sidecar", "anbo-checkout-worker"]);

  commands.starts.length = 0;
  await startDeclaredServices(services, { ...context, runId: "run-second" }, { commands });
  assert.deepEqual(commands.starts, [], "an operation-only run ID change must not restart services");

  commands.starts.length = 0;
  await startDeclaredServices({
    ...services,
    api: { ...services.api!, environment: { MODE: "second" } },
  }, context, { commands });
  assert.deepEqual(commands.starts, ["anbo-checkout-api", "anbo-checkout-worker"]);

  commands.starts.length = 0;
  commands.changeImage("api:test");
  await startDeclaredServices({
    ...services,
    api: { ...services.api!, environment: { MODE: "second" } },
  }, context, { commands });
  assert.deepEqual(commands.starts, ["anbo-checkout-api", "anbo-checkout-worker"]);
});

test("test-only refresh reuses unchanged bindings and cascades a real binding change", async () => {
  const commands = new ServiceExecutor();
  const services: Record<string, ServiceConfig> = {
    api: { image: "api:test", environment: { TOKEN: "env://ROTATING_TOKEN" } },
    worker: { image: "worker:test", depends_on: ["api"] },
    static: { image: "static:test" },
  };
  const firstContext = serviceContext({ ROTATING_TOKEN: "first" });
  const deployed = await startDeclaredServices(services, firstContext, { commands });
  const apiStart = commands.calls.find((call) => call.args[0] === "run" && call.args.includes("anbo-checkout-api"));
  const fingerprintLabel = valuesAfter(apiStart?.args ?? [], "--label")
    .find((label) => label.startsWith("anbo.dev/service-fingerprint="));
  assert.match(fingerprintLabel ?? "", /^anbo\.dev\/service-fingerprint=[a-f0-9]{64}$/);
  assert.equal(fingerprintLabel?.includes("first"), false);

  commands.starts.length = 0;
  const unchanged = await refreshRuntimeBoundServices(
    services,
    { ...firstContext, runId: "test-run" },
    deployed,
    { commands },
  );
  assert.deepEqual(unchanged.restarted, []);
  assert.deepEqual(commands.starts, []);

  commands.starts.length = 0;
  const changed = await refreshRuntimeBoundServices(
    services,
    serviceContext({ ROTATING_TOKEN: "second" }),
    deployed,
    { commands },
  );
  assert.deepEqual(changed.restarted, ["api", "worker"]);
  assert.deepEqual(commands.starts, ["anbo-checkout-api", "anbo-checkout-worker"]);
});

test("a matching but unhealthy service is replaced instead of reused", async () => {
  const commands = new ServiceExecutor();
  const services: Record<string, ServiceConfig> = {
    api: { image: "api:test", healthcheck: { type: "command", command: ["check-health"] } },
  };
  const context = serviceContext();
  await startDeclaredServices(services, context, { commands });
  commands.starts.length = 0;
  commands.markUnhealthy("anbo-checkout-api");

  await startDeclaredServices(services, context, { commands });
  assert.deepEqual(commands.starts, ["anbo-checkout-api"]);
});

test("paused or Docker-unhealthy containers are never reused", async () => {
  const commands = new ServiceExecutor();
  const services: Record<string, ServiceConfig> = { api: { image: "api:test" } };
  const context = serviceContext();
  await startDeclaredServices(services, context, { commands });

  commands.starts.length = 0;
  commands.markPaused("anbo-checkout-api");
  await startDeclaredServices(services, context, { commands });
  assert.deepEqual(commands.starts, ["anbo-checkout-api"]);

  commands.starts.length = 0;
  commands.markNativeUnhealthy("anbo-checkout-api");
  await startDeclaredServices(services, context, { commands });
  assert.deepEqual(commands.starts, ["anbo-checkout-api"]);
});

test("cancelling a warm health probe never removes the reusable service", async () => {
  const commands = new ServiceExecutor();
  const services: Record<string, ServiceConfig> = {
    api: { image: "api:test", healthcheck: { type: "http", url: "http://api.test/health" } },
  };
  const context = serviceContext();
  await startDeclaredServices(services, context, {
    commands,
    fetch: async () => new Response(null, { status: 200 }),
  });
  const callOffset = commands.calls.length;
  const controller = new AbortController();

  await assert.rejects(startDeclaredServices(services, { ...context, signal: controller.signal }, {
    commands,
    fetch: async () => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw controller.signal.reason;
    },
  }), /cancelled/);

  const warmCalls = commands.calls.slice(callOffset);
  assert.equal(warmCalls.some((call) => call.args[0] === "rm"), false);
  assert.equal(warmCalls.some((call) => call.args[0] === "run"), false);
});

test("command healthchecks receive cancellation during readiness and warm reuse", async () => {
  const commands = new ServiceExecutor();
  const services: Record<string, ServiceConfig> = {
    api: { image: "api:test", healthcheck: { type: "command", command: ["check-health"] } },
  };
  const initialController = new AbortController();
  await startDeclaredServices(services, { ...serviceContext(), signal: initialController.signal }, { commands });
  const initialExec = commands.calls.find((call) => call.args[0] === "exec");
  assert.equal(initialExec?.options?.signal, initialController.signal);

  const warmController = new AbortController();
  const cancellation = new DOMException("cancelled command healthcheck", "AbortError");
  const callOffset = commands.calls.length;
  const abortingCommands: CommandExecutor = {
    run: async (command, args, options) => {
      if (args[0] === "exec") {
        assert.equal(options?.signal, warmController.signal);
        warmController.abort(cancellation);
        throw cancellation;
      }
      return await commands.run(command, args, options);
    },
  };
  await assert.rejects(startDeclaredServices(
    services,
    { ...serviceContext(), signal: warmController.signal },
    { commands: abortingCommands },
  ), (error: unknown) => error === cancellation);

  const warmCalls = commands.calls.slice(callOffset);
  assert.equal(warmCalls.some((call) => call.args[0] === "rm" || call.args[0] === "run"), false);
});

function serviceContext(environment: Readonly<NodeJS.ProcessEnv> = {}): ServiceRuntimeContext {
  return {
    runId: "run-first",
    projectId: "checkout",
    networkName: "anbo-checkout-app",
    miniStackEndpoint: "http://ministack:4566",
    terraformOutputs: {},
    clones: {},
    builds: {},
    environment,
  };
}

function valueAfter(args: readonly string[], flag: string): string {
  const value = args[args.indexOf(flag) + 1];
  assert.ok(value);
  return value;
}

function valuesAfter(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag && args[index + 1] !== undefined) values.push(args[index + 1]!);
  }
  return values;
}
