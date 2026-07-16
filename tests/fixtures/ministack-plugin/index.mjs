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
  actions: ["configure", "deploy", "status", "test", "logs", "debug", "run", "reset", "down", "capabilities", "cache"],
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
            if (request.flags["simulate-uncertain-cancel"] === true) {
              return {
                status: "cancelled",
                failure: {
                  code: "ANBO_FIXTURE_CANCEL_UNCERTAIN",
                  message: "fixture cancellation left an uncertain operation",
                  remediation: "Reconcile the fixture operation before retrying.",
                  retryable: true,
                  safe_to_retry: false,
                  evidence: { operation: "fixture-create" },
                  exit_code: 130,
                },
              };
            }
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
        if (request.action === "debug" && request.flags["simulate-failure"] === true) {
          await context.state.set("last_failure_run_id", request.run_id);
          return {
            status: "failed",
            data: { action: "debug", exit_code: 6 },
            failure: {
              code: "ANBO_FIXTURE_TERRAFORM",
              message: "fixture Terraform failed",
              remediation: "Correct the fixture Terraform and retry.",
              phase: "terraform.plan",
              retryable: true,
              safe_to_retry: true,
              evidence: { address: "aws_sqs_queue.fixture" },
              exit_code: 6,
            },
            diagnostics: [{
              code: "ANBO_FIXTURE_TERRAFORM",
              message: "fixture Terraform failed",
              remediation: "Correct the fixture Terraform and retry.",
            }],
          };
        }
        if (request.action === "debug" && request.flags["verify-run-id"] === true) {
          const recorded = await context.state.get("last_failure_run_id");
          if (request.args[0] !== recorded || request.run_id === undefined) {
            return {
              status: "failed",
              failure: { code: "ANBO_FIXTURE_RUN_ID_MISMATCH", message: "canonical run ID mismatch", exit_code: 8 },
            };
          }
          await phase.finish("fixture canonical run ID verified");
          return { status: "succeeded", data: { inspected_run_id: request.args[0], current_run_id: request.run_id } };
        }
        if (request.action === "debug" && request.flags["simulate-cancelled-wrong-exit"] === true) {
          return {
            status: "cancelled",
            failure: {
              code: "ANBO_FIXTURE_CANCELLED",
              message: "fixture cancelled with a bad plugin exit",
              exit_code: 6,
            },
          };
        }
        if (request.action === "debug" && request.flags["simulate-failed-cancel-exit"] === true) {
          return {
            status: "failed",
            failure: {
              code: "ANBO_FIXTURE_FAILED",
              message: "fixture failed with the cancellation exit",
              exit_code: 130,
            },
          };
        }
        if (request.action === "debug" && request.flags["simulate-stream"] === true) {
          await context.process.run(process.execPath, [
            "-e",
            'process.stdout.write("stream-one\\n");setTimeout(()=>process.stdout.write("stream-two\\n"),500)',
          ], {
            on_output: async (stream, chunk) => context.events.emit({
              kind: "fixture.stream",
              phase: "debug.stream",
              source: "anbo.ministack",
              level: "info",
              message: chunk.trim(),
              fields: { stream },
            }),
          });
        }
        if (request.action === "debug" && request.flags["simulate-sigterm-trap"] === true) {
          const result = await context.process.run(process.execPath, [
            "-e",
            'process.on("SIGTERM",()=>{});process.stdout.write("trap-ready\\n");setInterval(()=>{},1_000)',
          ], {
            allow_failure: true,
            timeout_ms: 150,
          });
          await phase.finish("fixture trapped process stopped", { exit_code: result.exit_code });
          return {
            status: "succeeded",
            data: { exit_code: result.exit_code, duration_ms: result.duration_ms },
          };
        }
        if (request.action === "debug" && request.flags["simulate-malformed-evidence"] === true) {
          const eventFields = { count: 2n };
          eventFields.self = eventFields;
          const eventData = { total: 3n };
          eventData.self = eventData;
          await context.events.emit({
            kind: "fixture.odd-event",
            phase: "debug.odd-event",
            source: "anbo.ministack",
            level: "warn",
            message: "fixture emitted non-JSON fields",
            fields: eventFields,
            data: eventData,
          });
          const phaseFields = { attempts: 4n };
          phaseFields.self = phaseFields;
          await phase.fail("fixture phase returned non-JSON fields", phaseFields);
          const evidence = { count: 1n };
          evidence.self = evidence;
          return {
            status: "failed",
            failure: {
              code: "ANBO_FIXTURE_ODD_EVIDENCE",
              message: "fixture returned non-JSON evidence",
              exit_code: 7,
              evidence,
            },
          };
        }
        if (request.action === "down") await context.state.delete("fingerprint");
        await phase.finish(`fixture ${request.action} complete`);
        return { status: "succeeded", data: { action: request.action, args: request.args } };
      },
    }],
  };
}

export default { descriptor, activate };
