import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "anbo-cli-acceptance-"));
const tarballRoot = join(temporaryRoot, "tarballs");
const installRoot = join(temporaryRoot, "install");
const projectRoot = join(installRoot, "ministack-project");
const cloudRoot = join(installRoot, "cloud-project");

try {
  await Promise.all([tarballRoot, installRoot, projectRoot, cloudRoot].map((path) => mkdir(path, { recursive: true })));
  const tarballs = [
    packWorkspace("packages/plugin-sdk"),
    packWorkspace("packages/plugin-testkit"),
    packWorkspace("packages/cli"),
    packFixture("tests/fixtures/ministack-plugin"),
    packFixture("tests/fixtures/cloud-plugin"),
  ];
  await writeFile(join(installRoot, "package.json"), '{"name":"anbo-installed-acceptance","private":true}\n');
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], installRoot);

  const testkitUrl = pathToFileURL(
    join(installRoot, "node_modules", "@getanbo", "plugin-testkit", "dist", "index.js"),
  ).href;
  const { assertEventStream, runInstalledAnbo } = await import(testkitUrl);
  const cli = async (args, options = {}) => {
    const boundary = args.indexOf("--");
    const machineArgs = boundary < 0
      ? [...args, "--output", "jsonl"]
      : [...args.slice(0, boundary), "--output", "jsonl", ...args.slice(boundary)];
    const result = await runInstalledAnbo(installRoot, machineArgs, {
      cwd: options.cwd ?? installRoot,
      env: options.env,
    });
    assert.equal(result.exitCode, options.exitCode ?? 0, result.stdout || result.stderr);
    assert.equal(result.stderr, "", "machine-readable CLI output must not leak to stderr");
    assertEventStream(result.events);
    return result;
  };

  const listed = await cli(["plugin", "list"]);
  const listEvent = listed.events.find((event) => event.type === "plugin.list");
  assert.equal(listEvent.data.plugins.every((plugin) => plugin.installed), true);

  await cli(["doctor", "--root", projectRoot]);
  const configureToken = "acceptance-configure-token-value";
  const configured = await cli([
    "configure", "--target", "ministack", "--root", projectRoot, "--token", configureToken,
  ]);
  assert.equal(`${configured.stdout}${configured.stderr}`.includes(configureToken), false);
  assert.equal(configured.stdout.includes("[REDACTED]"), true);
  const lock = JSON.parse(await readFile(join(projectRoot, ".anbo", "plugins.lock.json"), "utf8"));
  assert.equal(lock.plugins.ministack.version, "0.1.0");
  assert.match(lock.plugins.ministack.integrity, /^sha512-/u);

  await cli(["doctor", "--root", projectRoot]);
  const cold = await cli(["deploy", "--root", projectRoot]);
  const coldResult = cold.events.find((event) => event.type === "command.result");
  assert.equal(coldResult.data.cache_hit, false);
  assert.equal(coldResult.data.terraform_changes, 1);

  await cli(["status", "--root", projectRoot]);
  const tested = await cli(["test", "smoke", "--root", projectRoot, "--", "npm", "test"]);
  const testResult = tested.events.find((event) => event.type === "command.result");
  assert.deepEqual(testResult.data.passthrough, ["npm", "test"]);
  assert.deepEqual(testResult.data.args, ["smoke", "--", "npm", "test"]);

  const ran = await cli(["run", "--root", projectRoot, "--", "echo", "ready"]);
  assert.equal(ran.events.find((event) => event.type === "command.result").data.action, "run");
  const reset = await cli(["reset", "--root", projectRoot, "--no-test"]);
  assert.equal(reset.events.find((event) => event.type === "command.result").data.action, "reset");

  const logged = await cli(["logs", "--root", projectRoot]);
  assert.equal(logged.events.some((event) => event.type === "log.line"), true);
  const secret = "anbo-acceptance-token-value";
  const debugged = await cli(["debug", "--root", projectRoot, "--probe-secret", "env://ANBO_ACCEPTANCE_SECRET"], {
    env: { ...process.env, ANBO_ACCEPTANCE_SECRET: secret },
  });
  assert.equal(debugged.stdout.includes(secret), false, "resolved secrets must be redacted");
  assert.equal(debugged.stdout.includes("[REDACTED]"), true);

  const failed = await cli(["debug", "--root", projectRoot, "--simulate-failure"], { exitCode: 6 });
  const failureDiagnostics = failed.events.filter((event) =>
    event.type === "diagnostic" && event.data?.code === "ANBO_FIXTURE_TERRAFORM"
  );
  assert.equal(failureDiagnostics.length, 1, "the canonical plugin failure must be emitted exactly once");
  assert.equal(failureDiagnostics[0].message, "fixture Terraform failed");
  assert.equal(failureDiagnostics[0].data.remediation, "Correct the fixture Terraform and retry.");
  assert.equal(failureDiagnostics[0].data.phase, "terraform.plan");
  assert.equal(failureDiagnostics[0].data.retryable, true);
  assert.equal(failureDiagnostics[0].data.safe_to_retry, true);
  assert.deepEqual(failureDiagnostics[0].data.evidence, { address: "aws_sqs_queue.fixture" });
  const failedRunId = failed.events[0].runId;
  const debuggedFailedRun = await cli([
    "debug", failedRunId, "--root", projectRoot, "--verify-run-id",
  ]);
  const debuggedFailedRunResult = debuggedFailedRun.events.find((event) => event.type === "command.result");
  assert.equal(debuggedFailedRunResult.data.inspected_run_id, failedRunId);
  assert.notEqual(debuggedFailedRunResult.data.current_run_id, failedRunId);

  const cancelledWrongExit = await cli([
    "debug", "--root", projectRoot, "--simulate-cancelled-wrong-exit",
  ], { exitCode: 130 });
  assert.equal(cancelledWrongExit.events.at(-1).data.status, "cancelled");
  assert.equal(cancelledWrongExit.events.at(-1).data.exitCode, 130);
  const failedCancellationExit = await cli([
    "debug", "--root", projectRoot, "--simulate-failed-cancel-exit",
  ], { exitCode: 5 });
  assert.equal(failedCancellationExit.events.at(-1).data.status, "failed");
  assert.equal(failedCancellationExit.events.at(-1).data.exitCode, 5);

  await assertStreamingOutput(installRoot, projectRoot);

  const trappedStartedAt = Date.now();
  const trapped = await cli(["debug", "--root", projectRoot, "--simulate-sigterm-trap"]);
  const trappedDuration = Date.now() - trappedStartedAt;
  const trappedResult = trapped.events.find((event) => event.type === "command.result");
  assert.equal(trappedResult.data.exit_code, 128);
  assert.ok(trappedResult.data.duration_ms >= 150, "the process timeout fired too early");
  assert.ok(trappedDuration < 2_000, "a child trapping SIGTERM blocked the installed CLI");

  const oddEvidence = await cli(["debug", "--root", projectRoot, "--simulate-malformed-evidence"], { exitCode: 7 });
  const oddEvent = oddEvidence.events.find((event) => event.type === "fixture.odd-event");
  assert.deepEqual(oddEvent.data.fields, { count: "2", self: "[CIRCULAR]" });
  assert.equal(oddEvent.data.total, "3");
  assert.equal(oddEvent.data.self, "[CIRCULAR]");
  const oddPhase = oddEvidence.events.find((event) => event.type === "phase.failed");
  assert.deepEqual(oddPhase.data.fields, { attempts: "4", self: "[CIRCULAR]" });
  const oddDiagnostic = oddEvidence.events.find((event) => event.data?.code === "ANBO_FIXTURE_ODD_EVIDENCE");
  assert.deepEqual(oddDiagnostic.data.evidence, { count: "1", self: "[CIRCULAR]" });
  assert.equal(oddEvidence.events.at(-1).type, "run.finished");

  const warm = await cli(["sandbox", "up", "--root", projectRoot, "--no-test"]);
  const warmResult = warm.events.find((event) => event.type === "command.result");
  assert.equal(warmResult.data.cache_hit, true);
  assert.equal(warmResult.data.terraform_changes, 0);
  assert.equal(warmResult.data.fingerprint, coldResult.data.fingerprint);

  await assertCancellation(installRoot, projectRoot, assertEventStream);
  await cli(["down", "--root", projectRoot, "--purge"]);
  await cli(["cache", "prune", "--root", projectRoot]);
  await cli(["deploy", "--target", "missing", "--root", projectRoot], { exitCode: 3 });

  await cli(["configure", "--target", "cloud", "--root", cloudRoot]);
  const legacyCloud = await cli(["branch", "list", "--root", cloudRoot]);
  const namespacedCloud = await cli(["cloud", "branch", "list", "--root", cloudRoot]);
  for (const result of [legacyCloud, namespacedCloud]) {
    const commandResult = result.events.find((event) => event.type === "command.result");
    assert.equal(commandResult.data.name, "cloud.branch");
    assert.deepEqual(commandResult.data.args, ["list"]);
  }
  for (const command of ["login", "logout", "auth", "demo"]) {
    const legacy = await cli([command, "--root", cloudRoot]);
    const namespaced = await cli(["cloud", command, "--root", cloudRoot]);
    for (const result of [legacy, namespaced]) {
      const commandResult = result.events.find((event) => event.type === "command.result");
      assert.equal(commandResult.data.name, `cloud.${command}`);
    }
  }
  const cloudTestRun = await cli(["cloud", "test-run", "--root", cloudRoot]);
  assert.equal(
    cloudTestRun.events.find((event) => event.type === "command.result").data.name,
    "cloud.test-run",
  );

  process.stdout.write("Installed CLI acceptance passed.\n");
} finally {
  if (process.env.ANBO_KEEP_ACCEPTANCE !== "1") await rm(temporaryRoot, { recursive: true, force: true });
  else process.stdout.write(`Acceptance files retained at ${temporaryRoot}\n`);
}

function packWorkspace(workspace) {
  const output = run("npm", ["pack", "--json", "--workspace", workspace, "--pack-destination", tarballRoot], repositoryRoot);
  const [{ filename }] = JSON.parse(output);
  return join(tarballRoot, filename);
}

function packFixture(path) {
  const output = run("npm", ["pack", "--json", resolve(repositoryRoot, path), "--pack-destination", tarballRoot], repositoryRoot);
  const [{ filename }] = JSON.parse(output);
  return join(tarballRoot, filename);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function assertCancellation(installRoot, projectRoot, assertEventStream) {
  const binary = join(installRoot, "node_modules", ".bin", "anbo");
  const child = spawn(binary, [
    "logs", "--follow", "--simulate-uncertain-cancel", "--root", projectRoot, "--output", "jsonl",
  ], {
    cwd: installRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let signalSent = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!signalSent && stdout.includes('"type":"logs.following"')) {
      signalSent = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("cancellation acceptance timed out"));
    }, 10_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 130, stdout || stderr);
  assert.equal(stderr, "");
  const events = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assertEventStream(events);
  assert.equal(events.some((event) => event.type === "run.cancellation_requested"), true);
  const diagnostic = events.find((event) => event.data?.code === "ANBO_FIXTURE_CANCEL_UNCERTAIN");
  assert.equal(diagnostic?.data.safe_to_retry, false);
  assert.equal(diagnostic?.data.retryable, true);
  assert.deepEqual(diagnostic?.data.evidence, { operation: "fixture-create" });
}

async function assertStreamingOutput(installRoot, projectRoot) {
  const binary = join(installRoot, "node_modules", ".bin", "anbo");
  const child = spawn(binary, ["debug", "--simulate-stream", "--root", projectRoot, "--output", "jsonl"], {
    cwd: installRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let firstChunkAt;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (firstChunkAt === undefined && stdout.includes("stream-one")) firstChunkAt = Date.now();
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("streaming acceptance timed out"));
    }, 10_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  const finishedAt = Date.now();
  assert.equal(exitCode, 0, stdout || stderr);
  assert.equal(stderr, "");
  assert.ok(firstChunkAt !== undefined, "the first process chunk was not emitted");
  assert.ok(finishedAt - firstChunkAt >= 300, "the CLI did not expose output while the child was running");
  assert.match(stdout, /stream-two/);
}
