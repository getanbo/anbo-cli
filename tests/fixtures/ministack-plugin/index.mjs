const descriptor = {
  schema_version: 1,
  plugin_api: 1,
  id: "anbo.ministack",
  name: "Anbo MiniStack acceptance fixture",
  package: "@getanbo/plugin-ministack",
  version: "0.1.0",
  entrypoint: "./index.mjs",
  engines: { anbo: ">=0.2.0 <0.3.0", node: ">=20.0.0" },
  kinds: ["target"],
  targets: ["ministack"],
  actions: ["configure", "deploy", "status", "test", "logs", "debug", "down", "capabilities", "cache"],
  config: { schema: "./config.schema.json", schema_version: 1 },
  capabilities: ["acceptance.fixture"],
};

function activate(context) {
  return {
    targets: [{
      id: "ministack",
      async execute(request) {
        const phase = await context.events.startPhase(request.action, { source: "anbo.ministack" });
        if (request.action === "configure") {
          await context.state.set("configured", true);
          await phase.finish("fixture configured");
          return { status: "succeeded", data: { configured: true } };
        }
        if (request.action === "deploy") {
          const fingerprint = "fixture-sha256-001";
          const previous = await context.state.get("fingerprint");
          const cache_hit = previous === fingerprint;
          await context.state.set("fingerprint", fingerprint);
          await context.events.emit({
            kind: "terraform.applied",
            phase: "terraform",
            source: "anbo.ministack",
            level: "info",
            message: cache_hit ? "Terraform has no changes" : "Terraform applied",
            fields: { changes: cache_hit ? 0 : 1, cache_hit, fingerprint },
          });
          await phase.finish("fixture deployed", { cache_hit });
          return { status: "succeeded", data: { cache_hit, fingerprint, terraform_changes: cache_hit ? 0 : 1 } };
        }
        if (request.action === "test") {
          await context.events.emit({
            kind: "test.finished",
            phase: "test",
            source: "anbo.ministack",
            level: "info",
            message: "fixture smoke passed",
            test_id: "fixture-smoke",
            fields: { args: request.args, passthrough: request.passthrough ?? [] },
          });
          await phase.finish("fixture tests passed");
          return { status: "succeeded", data: { args: request.args, passthrough: request.passthrough ?? [] } };
        }
        if (request.action === "logs") {
          await context.events.emit({
            kind: "log.line",
            phase: "logs",
            source: "fixture.service",
            level: "info",
            message: "fixture log line",
            correlation_id: "fixture-correlation",
          });
          if (request.flags.follow === true) {
            await context.events.emit({
              kind: "logs.following",
              phase: "logs",
              source: "anbo.ministack",
              level: "info",
              message: "following fixture logs",
            });
            await new Promise((resolve) => {
              const keepAlive = setInterval(() => {}, 1_000);
              const stop = () => {
                clearInterval(keepAlive);
                resolve();
              };
              if (context.signal.aborted) stop();
              else context.signal.addEventListener("abort", stop, { once: true });
            });
            return { status: "cancelled" };
          }
          await phase.finish("fixture logs complete");
          return { status: "succeeded" };
        }
        if (request.action === "debug" && typeof request.flags["probe-secret"] === "string") {
          const secret = await context.secrets.resolve(request.flags["probe-secret"]);
          await context.events.emit({
            kind: "debug.secret",
            phase: "debug",
            source: "anbo.ministack",
            level: "info",
            message: `resolved ${secret}`,
            fields: { token: secret },
          });
        }
        if (request.action === "down") await context.state.delete("fingerprint");
        await phase.finish(`fixture ${request.action} complete`);
        return { status: "succeeded", data: { action: request.action, args: request.args } };
      },
    }],
  };
}

export default { descriptor, activate };
