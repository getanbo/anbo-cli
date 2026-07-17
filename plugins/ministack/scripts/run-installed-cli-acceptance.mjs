import assert from "node:assert/strict";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cliTarball = process.env.ANBO_CLI_TARBALL;
if (!cliTarball) throw new Error("ANBO_CLI_TARBALL must point to a packed canonical CLI artifact");
const sdkTarball = process.env.ANBO_SDK_TARBALL;
const expectedTests = ["lambda-invoke", "terraform-resources"];

const root = resolve(new URL("../", import.meta.url).pathname);
try {
  await access(join(root, "dist", "src", "plugin.js"));
} catch {
  throw new Error("Plugin artifact is missing; run npm run build before installed-CLI acceptance");
}
const packed = spawnSync("npm", ["pack", "--silent", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
const pluginTarball = join(root, packed.stdout.trim().split(/\s+/).at(-1));
const temporary = await mkdtemp(join(tmpdir(), "anbo-installed-acceptance-"));
const project = join(temporary, "project");
const anbo = join(temporary, "node_modules", ".bin", "anbo");
const timings = [];

function execute(args) {
  const result = spawnSync(anbo, args, {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_STATE_HOME: join(temporary, "state"),
      XDG_CACHE_HOME: join(temporary, "cache"),
    },
  });
  const events = parseJsonl(result.stdout, `anbo ${args.join(" ")}`);
  const finished = events.findLast((event) => event.type === "run.finished");
  timings.push({
    command: args.join(" "),
    status: result.status,
    duration_ms: typeof finished?.data?.duration_ms === "number" ? finished.data.duration_ms : null,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    events,
  };
}

function run(args) {
  const result = execute(args);
  assert.equal(
    result.status,
    0,
    `anbo ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function runFailure(args) {
  const result = execute(args);
  assert.notEqual(
    result.status,
    0,
    `anbo ${args.join(" ")} unexpectedly succeeded\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function parseJsonl(output, label) {
  return output.trim().length === 0
    ? []
    : output.trim().split("\n").map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (cause) {
        throw new Error(`${label} emitted invalid JSONL at line ${index + 1}: ${line}`, { cause });
      }
    });
}

function commandResult(result) {
  const event = result.events.findLast((candidate) => candidate.type === "command.result");
  assert.ok(event, `command.result missing from output:\n${result.stdout}`);
  assert.ok(event.data && typeof event.data === "object", "command.result must contain structured data");
  return event.data;
}

function testIds(result) {
  return [...new Set(
    result.events
      .filter((event) => event.type === "test.started" && typeof event.data?.test_id === "string")
      .map((event) => event.data.test_id),
  )].sort();
}

function assertTestIds(result, expected, label) {
  assert.deepEqual(testIds(result), [...expected].sort(), `${label} selected the wrong test suites`);
}

function impactDocument(result) {
  const data = commandResult(result);
  const document = data.plan ?? data.impact ?? data;
  assert.ok(document && typeof document === "object", "impact must return a structured plan");
  assert.ok(Array.isArray(document.nodes), "impact plan must contain a nodes array");
  assert.match(document.graph_fingerprint, /^sha256:[a-f0-9]{64}$/);
  return document;
}

function impactNode(document, id) {
  const node = document.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `impact plan is missing ${id}`);
  assert.ok(Array.isArray(node.reasons), `impact node ${id} must explain its decision`);
  return node;
}

function assertImpactDecision(document, id, action, reason) {
  const node = impactNode(document, id);
  assert.equal(node.action, action, `${id} should be planned as ${action}`);
  assert.ok(
    node.reasons.some((candidate) => candidate.code === reason),
    `${id} should include reason ${reason}; received ${JSON.stringify(node.reasons)}`,
  );
}

function assertFullAttestation(result) {
  const data = commandResult(result);
  const attestation = data.attestation ?? data.verification?.attestation;
  assert.ok(attestation && typeof attestation === "object", "verify --full must return its attestation");
  assert.equal(attestation.schema_version, 1);
  assert.equal(attestation.mode, "full");
  assert.match(attestation.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(attestation.graph_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(attestedTestIds(attestation.tests), expectedTests);
}

function attestedTestIds(tests) {
  if (Array.isArray(tests)) {
    return tests.map((entry) => typeof entry === "string" ? entry : entry.id ?? entry.name).sort();
  }
  assert.ok(tests && typeof tests === "object", "attestation tests must be an array or object");
  return Object.keys(tests).sort();
}

async function setForcedLambdaFailure(enabled) {
  const path = join(project, ".anbo", "sandbox.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.tests["lambda-invoke"].environment.ANBO_FORCE_TEST_FAILURE = enabled ? "1" : "0";
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function setAcceptanceAdapter(enabled) {
  const path = join(project, ".anbo", "sandbox.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (enabled) {
    manifest.adapters.acceptance = {
      executable: "./acceptance-adapter.mjs",
      protocol: 2,
      capabilities: ["acceptance.cleanup"],
    };
  } else {
    delete manifest.adapters.acceptance;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeChangedInput(name, revision) {
  await writeFile(
    join(project, "acceptance-inputs", `${name}.txt`),
    `${name} acceptance contract ${revision}\n`,
  );
}

async function projectStateDirectory() {
  const directory = join(
    project,
    ".anbo",
    "state",
    "plugins",
    "anbo.ministack",
    "anbo",
    "projects",
  );
  const entries = await readdir(directory, { withFileTypes: true });
  const projects = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.equal(projects.length, 1, `expected one isolated project state directory, found ${projects.join(", ")}`);
  return join(directory, projects[0]);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

try {
  await mkdir(project, { recursive: true });
  await cp(join(root, "fixtures", "terraform-smoke"), project, { recursive: true });
  await writeFile(join(temporary, "package.json"), '{"private":true}\n');
  const install = spawnSync("npm", [
    "install",
    "--ignore-scripts",
    ...(sdkTarball === undefined ? [] : [resolve(sdkTarball)]),
    resolve(cliTarball),
    pluginTarball,
  ], {
    cwd: temporary,
    encoding: "utf8",
  });
  if (install.status !== 0) throw new Error(install.stderr || install.stdout);
  const installedRuntime = JSON.parse(await readFile(
    join(temporary, "node_modules", "@getanbo", "plugin-ministack", "runtime-manifest.json"),
    "utf8",
  ));
  assert.deepEqual(installedRuntime.platforms, ["linux/amd64", "linux/arm64"]);
  assert.equal(installedRuntime.compatibility["linux/arm64"].environment.OPENSSL_armcap, "0");
  assert.equal(
    installedRuntime.certified_image,
    `ministackorg/ministack@${installedRuntime.digest}`,
  );

  await mkdir(join(project, ".anbo"), { recursive: true });
  await writeFile(join(project, "acceptance-adapter.mjs"), [
    "#!/usr/bin/env node",
    "let source = '';",
    "for await (const chunk of process.stdin) source += chunk;",
    "JSON.parse(source);",
    "process.stdout.write(JSON.stringify({",
    "  schema_version: 2,",
    "  adapter: 'acceptance',",
    "  capabilities: ['acceptance.cleanup'],",
    "  bindings: [],",
    "  diagnostics: [],",
    "}) + '\\n');",
    "",
  ].join("\n"));
  await chmod(join(project, "acceptance-adapter.mjs"), 0o755);
  await writeFile(join(project, ".anbo", "project.json"), `${JSON.stringify({
    apiVersion: "anbo.dev/project/v1",
    defaultTarget: "ministack",
    plugins: {
      ministack: { package: "@getanbo/plugin-ministack", config: { manifest: ".anbo/sandbox.json" } },
    },
  }, null, 2)}\n`);

  run(["configure", "--target", "ministack", "--output", "jsonl"]);

  if (process.env.ANBO_ACCEPTANCE_RUNTIME === "1") {
    let runtimeError;
    try {
      const coldDeploy = run(["deploy", "--target", "ministack", "--output", "jsonl"]);
      assertTestIds(coldDeploy, expectedTests, "cold default deploy");
      const coldSummary = commandResult(coldDeploy);
      assert.equal(coldSummary.impact.mode, "cold");
      assert.deepEqual([...coldSummary.verification.selected_tests].sort(), expectedTests);
      assert.match(coldDeploy.stdout, /"cache_hit":false/);
      assert.match(coldDeploy.stdout, /"server_platform":"linux\/(?:amd64|arm64)"/);
      const arm64Runtime = coldDeploy.stdout.includes('"server_platform":"linux/arm64"');
      if (arm64Runtime) assert.match(coldDeploy.stdout, /"phase":"ministack.compatibility"/);
      else assert.doesNotMatch(coldDeploy.stdout, /"phase":"ministack.compatibility"/);

      if (arm64Runtime) assert.equal(coldSummary.ministack.compatibility.id, "openssl-armcap-zero-v1");
      else assert.equal(coldSummary.ministack.compatibility, undefined);
      assert.match(coldDeploy.stdout, /"name":"kms.generate-data-key"/);
      assert.match(coldDeploy.stdout, /"name":"lambda.invoke"/);

      const unchangedDeploy = run(["deploy", "--target", "ministack", "--output", "jsonl"]);
      assertTestIds(unchangedDeploy, [], "unchanged default deploy");
      const unchangedSummary = commandResult(unchangedDeploy);
      assert.equal(unchangedSummary.fast_path, "graph-cache-hit");
      assert.deepEqual(unchangedSummary.verification.selected_tests, []);
      assert.equal(unchangedSummary.terraform_reconciliation.skipped, true);
      assert.match(unchangedDeploy.stdout, /"cache_hit":true/);
      assert.doesNotMatch(unchangedDeploy.stdout, /"source":"buildkit"/);
      assert.doesNotMatch(unchangedDeploy.stdout, /"phase":"terraform\./);
      assert.doesNotMatch(unchangedDeploy.stdout, /"workaround":"openssl-armcap-zero-v1"/);

      const unchangedImpact = impactDocument(run(["impact", "--target", "ministack", "--output", "jsonl"]));
      assertImpactDecision(unchangedImpact, "test:terraform-resources", "reuse", "cache_hit");
      assertImpactDecision(unchangedImpact, "test:lambda-invoke", "reuse", "cache_hit");

      await writeChangedInput("lambda-invoke", "v2");
      const changedImpact = impactDocument(run(["impact", "--target", "ministack", "--output", "jsonl"]));
      assertImpactDecision(changedImpact, "test:lambda-invoke", "execute", "fingerprint_changed");
      assertImpactDecision(changedImpact, "test:terraform-resources", "reuse", "cache_hit");
      const changedDeploy = run(["deploy", "--target", "ministack", "--output", "jsonl"]);
      assertTestIds(changedDeploy, ["lambda-invoke"], "lambda-only affected deploy");
      assert.equal(commandResult(changedDeploy).fast_path, "tests-only");
      assert.deepEqual(commandResult(changedDeploy).verification.selected_tests, ["lambda-invoke"]);
      assert.equal(commandResult(changedDeploy).terraform_reconciliation.skipped, true);
      assert.doesNotMatch(changedDeploy.stdout, /"source":"buildkit"/);
      assert.doesNotMatch(changedDeploy.stdout, /"phase":"terraform\./);

      const allTests = run(["test", "--target", "ministack", "--all", "--output", "jsonl"]);
      assertTestIds(allTests, expectedTests, "test --all");
      assert.deepEqual([...commandResult(allTests).selected_tests].sort(), expectedTests);

      await writeChangedInput("terraform-resources", "v2");
      const affectedTests = run(["test", "--target", "ministack", "--affected", "--output", "jsonl"]);
      assertTestIds(affectedTests, ["terraform-resources"], "test --affected");
      assert.deepEqual(commandResult(affectedTests).selected_tests, ["terraform-resources"]);

      const noVerification = run(["deploy", "--target", "ministack", "--verify", "none", "--output", "jsonl"]);
      assertTestIds(noVerification, [], "deploy --verify none");
      const skippedStatus = commandResult(run(["status", "--target", "ministack", "--output", "jsonl"]));
      assert.equal(skippedStatus.sandbox.verification.status, "skipped");
      assert.equal(skippedStatus.sandbox.verification.mode, "none");
      assert.equal(skippedStatus.sandbox.verification.attestation, undefined);

      const verification = run(["verify", "--target", "ministack", "--full", "--output", "jsonl"]);
      assertTestIds(verification, expectedTests, "verify --full");
      assertFullAttestation(verification);

      await setForcedLambdaFailure(true);
      const failed = runFailure(["test", "lambda-invoke", "--target", "ministack", "--output", "jsonl"]);
      assertTestIds(failed, ["lambda-invoke"], "forced lambda test failure");
      const diagnostic = failed.events.findLast(
        (event) => event.type === "diagnostic" && event.data?.code === "ANBO_TEST_FAILED",
      );
      assert.ok(diagnostic, `structured ANBO_TEST_FAILED diagnostic missing:\n${failed.stdout}`);
      assert.equal(diagnostic.data.evidence.test_id, "lambda-invoke");
      assert.equal(diagnostic.data.evidence.service, "runner");
      assert.equal(diagnostic.data.evidence.exit_code, 42);
      assert.equal(
        diagnostic.data.evidence.rerun,
        "anbo test lambda-invoke --target ministack",
      );
      assert.match(diagnostic.data.evidence.correlation_id, /:lambda-invoke$/);
      assert.equal(diagnostic.data.evidence.last_event.status, "failed");

      const readyStatus = commandResult(run(["status", "--target", "ministack", "--output", "jsonl"]));
      assert.equal(readyStatus.sandbox.status, "ready", "a test failure must not invalidate deployed infrastructure");
      assert.equal(readyStatus.sandbox.deployment.status, "ready");
      assert.equal(readyStatus.sandbox.verification.status, "failed");

      await setForcedLambdaFailure(false);
      const failedRetry = run(["test", "--target", "ministack", "--failed", "--output", "jsonl"]);
      assertTestIds(failedRetry, ["lambda-invoke"], "test --failed");

      const stateDirectory = await projectStateDirectory();
      const lockPath = join(stateDirectory, "operation.lock");
      const staleTime = "2000-01-01T00:00:00.000Z";
      await writeFile(lockPath, `${JSON.stringify({
        schema_version: 2,
        operation_id: "acceptance_stale_lock",
        kind: "deploy",
        pid: 2147483647,
        project_root: await realpath(project),
        created_at: staleTime,
        heartbeat_at: staleTime,
        process_start_time: "acceptance:dead",
        lease_expires_at: staleTime,
      })}\n`, { mode: 0o600 });
      const recovered = run(["recover", "--target", "ministack", "--stale", "--output", "jsonl"]);
      assert.equal(commandResult(recovered).action, "recover");
      assert.equal(await exists(lockPath), false, "recover must remove the stale operation lock");

      run(["debug", "--target", "ministack", "--output", "jsonl"]);

      await setAcceptanceAdapter(true);
      const adapterDeploy = run(["deploy", "--target", "ministack", "--verify", "none", "--output", "jsonl"]);
      assertTestIds(adapterDeploy, [], "adapter setup deploy");
      await setAcceptanceAdapter(false);
      const rejectedRemoval = runFailure([
        "deploy", "--target", "ministack", "--verify", "none", "--output", "jsonl",
      ]);
      const removalDiagnostic = rejectedRemoval.events.findLast(
        (event) => event.type === "diagnostic" &&
          event.data?.code === "ANBO_ADAPTER_REMOVAL_REQUIRES_DOWN",
      );
      assert.ok(removalDiagnostic, `adapter removal preflight diagnostic missing:\n${rejectedRemoval.stdout}`);
      assert.equal(
        rejectedRemoval.events.some((event) => event.data?.phase === "infrastructure"),
        false,
        "adapter removal must fail before infrastructure mutation",
      );
      await setAcceptanceAdapter(true);
    } catch (error) {
      runtimeError = error;
    }
    const cleanupErrors = [];
    try {
      const down = run(["down", "--target", "ministack", "--purge", "--output", "jsonl"]);
      assert.equal(commandResult(down).local_state_purged, true);
      const afterDown = commandResult(run(["debug", "--target", "ministack", "--output", "jsonl"]));
      assert.deepEqual(afterDown.evidence.containers, [], "down --purge must remove every managed project container");
      assert.deepEqual(afterDown.evidence.networks, [], "down --purge must remove every managed project network");
      assert.deepEqual(afterDown.evidence.volumes, [], "down --purge must remove every managed project volume");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      run(["cache", "prune", "--target", "ministack", "--output", "jsonl"]);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (runtimeError !== undefined || cleanupErrors.length > 0) {
      const failures = [...(runtimeError === undefined ? [] : [runtimeError]), ...cleanupErrors];
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "installed CLI acceptance and cleanup both failed");
    }
  }
  console.log(JSON.stringify({ acceptance: "installed-cli", timings }));
} finally {
  await rm(pluginTarball, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
