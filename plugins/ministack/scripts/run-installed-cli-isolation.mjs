import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const options = parseArguments(process.argv.slice(2));
const image = options.ministackImage;
if (!/^[^@\s]+@sha256:[a-f0-9]{64}$/u.test(image)) {
  throw new Error("--ministack-image must be a full image reference pinned to a sha256 digest");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(options.repoRoot ?? join(pluginRoot, "..", ".."));
const diagnosticsRoot = options.diagnosticsRoot === undefined ? undefined : resolve(options.diagnosticsRoot);
const temporaryRoot = await mkdtemp(join(tmpdir(), "anbo-installed-cli-isolation-"));
const artifactRoot = join(temporaryRoot, "artifacts");
const installRoot = join(temporaryRoot, "install");
const sandboxRoot = join(temporaryRoot, "sandboxes");
const sharedEnvironment = {
  ...process.env,
  CI: "1",
  XDG_STATE_HOME: join(temporaryRoot, "state"),
  XDG_CACHE_HOME: join(temporaryRoot, "cache"),
};

let binary;
const cleanupTargets = [];
const timeline = [];
let primaryError;

if (diagnosticsRoot !== undefined) mkdirSync(diagnosticsRoot, { recursive: true });

try {
  const artifacts = await packInstalledArtifacts();
  await installPackedCli(artifacts);
  binary = join(installRoot, "node_modules", ".bin", "anbo");
  assert.ok((await realpath(binary)).startsWith(installRoot), "acceptance must execute the CLI from the temporary install prefix");
  const installedPluginPackage = await realpath(
    join(installRoot, "node_modules", "@getanbo", "plugin-ministack", "package.json"),
  );
  assert.ok(
    installedPluginPackage.startsWith(installRoot),
    "acceptance must resolve the MiniStack plugin from the temporary install prefix",
  );

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const sandboxA = await prepareSandbox("a", suffix);
  const sandboxB = await prepareSandbox("b", suffix);

  runAnbo("setup-a", ["setup", "--target", "ministack", "--root", sandboxA.root]);
  cleanupTargets.push(sandboxA);
  runAnbo("deploy-a", ["deploy", "--target", "ministack", "--root", sandboxA.root, "--verify", "none"], 20 * 60_000);
  smokeLambda("a-initial", sandboxA.root);
  const lambdaA = lambdaChildEvidence("a-initial", sandboxA.root);

  runAnbo("setup-b", ["setup", "--target", "ministack", "--root", sandboxB.root]);
  cleanupTargets.push(sandboxB);
  runAnbo("deploy-b", ["deploy", "--target", "ministack", "--root", sandboxB.root, "--verify", "none"], 20 * 60_000);
  smokeLambda("b-initial", sandboxB.root);

  const [parentA, parentB] = [parentEvidence("a-coexists", sandboxA.root), parentEvidence("b-coexists", sandboxB.root)];
  assert.notEqual(parentA.id, parentB.id, "the two sandboxes must own different parent containers");
  smokeLambda("a-after-b-deploy", sandboxA.root);
  assertLambdaChildSurvived("b deploy", sandboxA.root, lambdaA.id);

  await forceMiniStackReplacement(sandboxB.root);
  runAnbo("redeploy-b", ["deploy", "--target", "ministack", "--root", sandboxB.root, "--verify", "none"], 20 * 60_000);
  const replacedParentB = parentEvidence("b-after-redeploy", sandboxB.root);
  assert.notEqual(
    replacedParentB.id,
    parentB.id,
    "B runtime configuration changed, but its MiniStack parent was not replaced",
  );
  smokeLambda("b-after-redeploy", sandboxB.root);
  smokeLambda("a-after-b-redeploy", sandboxA.root);
  assertLambdaChildSurvived("b redeploy", sandboxA.root, lambdaA.id);

  runAnbo("down-b", ["down", "--target", "ministack", "--root", sandboxB.root, "--purge"], 10 * 60_000);
  smokeLambda("a-after-b-down", sandboxA.root);
  assertLambdaChildSurvived("b down", sandboxA.root, lambdaA.id);
} catch (error) {
  primaryError = error;
} finally {
  const diagnosticErrors = [];
  if (primaryError !== undefined) {
    for (const sandbox of cleanupTargets) {
      try {
        runAnbo(`failure-debug-${sandbox.name}`, ["debug", "--target", "ministack", "--root", sandbox.root]);
      } catch (error) {
        diagnosticErrors.push(error);
        recordCheck(`failure-debug-${sandbox.name}`, false, { error: serializeError(error) });
      }
    }
  }

  const cleanupErrors = [];
  for (const sandbox of [...cleanupTargets].reverse()) {
    try {
      runAnbo(`cleanup-${sandbox.name}`, ["down", "--target", "ministack", "--root", sandbox.root, "--purge"], 10 * 60_000);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const failed = primaryError !== undefined || cleanupErrors.length > 0;
  recordResult({
    status: failed ? "failed" : "passed",
    ...(primaryError === undefined ? {} : { error: serializeError(primaryError) }),
    cleanup_errors: cleanupErrors.map(serializeError),
    diagnostic_errors: diagnosticErrors.map(serializeError),
  });
  await rm(temporaryRoot, { recursive: true, force: true });

  if (failed) {
    const failures = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "installed CLI isolation acceptance and cleanup failed");
  }
}

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--ministack-image") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--ministack-image requires a value");
      result.ministackImage = value;
      index += 1;
    } else if (argument === "--repo-root") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--repo-root requires a path");
      result.repoRoot = value;
      index += 1;
    } else if (argument === "--diagnostics-root") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--diagnostics-root requires a path");
      result.diagnosticsRoot = value;
      index += 1;
    } else {
      throw new Error(
        "usage: run-installed-cli-isolation.mjs --ministack-image <image@sha256:digest> " +
        "[--repo-root <path>] [--diagnostics-root <path>]",
      );
    }
  }
  if (typeof result.ministackImage !== "string" || result.ministackImage.length === 0) {
    throw new Error("--ministack-image is required");
  }
  if (result.repoRoot !== undefined && (typeof result.repoRoot !== "string" || result.repoRoot.length === 0)) {
    throw new Error("--repo-root requires a path");
  }
  if (
    result.diagnosticsRoot !== undefined &&
    (typeof result.diagnosticsRoot !== "string" || result.diagnosticsRoot.length === 0)
  ) {
    throw new Error("--diagnostics-root requires a path");
  }
  return result;
}

async function packInstalledArtifacts() {
  await mkdir(artifactRoot, { recursive: true });
  run("npm", ["run", "build", "--workspace", "@getanbo/plugin-sdk"], repositoryRoot);
  run("npm", ["run", "build", "--workspace", "anbo"], repositoryRoot);
  run("npm", ["run", "build", "--workspace", "@getanbo/plugin-ministack"], repositoryRoot);

  return {
    sdk: packWorkspace("packages/plugin-sdk"),
    cli: packWorkspace("packages/cli"),
    plugin: packWorkspace("plugins/ministack"),
  };
}

function packWorkspace(workspace) {
  const output = run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--workspace",
    workspace,
    "--pack-destination",
    artifactRoot,
  ], repositoryRoot);
  const [{ filename }] = JSON.parse(output);
  return join(artifactRoot, filename);
}

async function installPackedCli(artifacts) {
  await writeFile(join(temporaryRoot, "package.json"), "{\"private\":true}\n");
  run("npm", [
    "install",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    artifacts.sdk,
    artifacts.cli,
    artifacts.plugin,
  ], temporaryRoot);
}

async function prepareSandbox(name, suffix) {
  const root = join(sandboxRoot, name);
  await cp(join(pluginRoot, "fixtures", "terraform-smoke"), root, { recursive: true });
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);

  const resourcePrefix = `anbo-isolation-${name}-${suffix}`;
  const manifestPath = join(root, ".anbo", "sandbox.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.project.name = resourcePrefix;
  manifest.ministack.image = image;
  manifest.ministack.digest = image.slice(image.lastIndexOf("@") + 1);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const terraformPath = join(root, "infra", "main.tf");
  const terraform = await readFile(terraformPath, "utf8");
  await writeFile(terraformPath, terraform.replaceAll("anbo-terraform-smoke", resourcePrefix));
  return { name, root };
}

function smokeLambda(label, root) {
  const result = runAnbo(`smoke-${label}`, ["test", "lambda-invoke", "--target", "ministack", "--root", root], 10 * 60_000);
  const assertions = result.events
    .filter((event) => event.type === "test.assertion")
    .map((event) => ({ test_id: event.data?.test_id, fields: event.data?.fields }))
    .filter((assertion) => assertion.fields !== undefined);
  const passed = assertions.some((assertion) =>
    assertion.test_id === "lambda-invoke" &&
    assertion.fields.name === "lambda.invoke" &&
    assertion.fields.status === "passed");
  const summaryEvent = result.events.findLast((event) => event.type === "command.result");
  const summary = summaryEvent?.data;
  recordCheck(`lambda-contract-${label}`, passed &&
    summary !== null &&
    typeof summary === "object" &&
    summary.selected_tests?.length === 1 &&
    summary.selected_tests[0] === "lambda-invoke" &&
    summary.tests?.["lambda-invoke"]?.passed === true, {
    assertions,
    selected_tests: summary?.selected_tests,
    suite: summary?.tests?.["lambda-invoke"],
  });
  assert.ok(
    passed,
    `sandbox ${label} did not prove that its Terraform-created Lambda survived; observed assertions: ${
      JSON.stringify(assertions)
    }`,
  );
  assert.ok(summary !== null && typeof summary === "object", `sandbox ${label} has no structured command result`);
  assert.deepEqual(summary.selected_tests, ["lambda-invoke"], `sandbox ${label} ran the wrong smoke suite`);
  assert.equal(summary.tests?.["lambda-invoke"]?.passed, true, `sandbox ${label} did not report a passed Lambda suite`);
}

function parentEvidence(label, root) {
  const containers = containerEvidence(label, root).filter(
    (container) => container.component === "ministack",
  );
  assert.equal(containers.length, 1, `sandbox ${label} must have exactly one MiniStack parent`);
  return containers[0];
}

async function forceMiniStackReplacement(root) {
  const manifestPath = join(root, ".anbo", "sandbox.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.ministack.environment ??= {};
  manifest.ministack.environment.OPENSEARCH_DATAPLANE = "0";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function lambdaChildEvidence(label, root) {
  const children = containerEvidence(label, root).filter(
    (container) => container.component === "ministack-child" &&
      container.service === "lambda" &&
      container.running === true,
  );
  assert.ok(children.length > 0, `sandbox ${label} has no running Lambda child evidence`);
  return children[0];
}

function assertLambdaChildSurvived(stage, root, expectedId) {
  const containers = containerEvidence(`a-after-${stage.replaceAll(" ", "-")}`, root);
  assert.ok(
    containers.some((container) =>
      container.id === expectedId &&
      container.component === "ministack-child" &&
      container.service === "lambda" &&
      container.running === true
    ),
    `sandbox A Lambda child ${expectedId} did not survive ${stage}`,
  );
}

function containerEvidence(label, root) {
  const result = commandResult(runAnbo(`debug-${label}`, ["debug", "--target", "ministack", "--root", root]));
  const containers = result.evidence?.containers;
  assert.ok(Array.isArray(containers), `sandbox ${label} has no structured container evidence`);
  return containers;
}

function runAnbo(label, arguments_, timeout = 5 * 60_000) {
  const startedAt = Date.now();
  const result = spawnSync(binary, [...arguments_, "--output", "jsonl"], {
    cwd: installRoot,
    encoding: "utf8",
    env: sharedEnvironment,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stage = {
    kind: "command",
    stage: label,
    status: result.error === undefined && result.status === 0 ? "passed" : "failed",
    duration_ms: Date.now() - startedAt,
    command: ["anbo", ...arguments_],
    exit_code: result.status,
    signal: result.signal,
    ...(result.error === undefined ? {} : { error: String(result.error) }),
  };
  recordStage(stage);
  writeCommandDiagnostics(label, stage, stdout, stderr);
  assert.equal(result.error, undefined, `${label} process failed: ${String(result.error)}`);
  const events = parseJsonl(stdout, label);
  assert.equal(result.status, 0, `${label} failed:\n${stdout}\n${stderr}`);
  return { events, stdout };
}

function recordCheck(label, passed, evidence) {
  const stage = {
    kind: "assertion",
    stage: label,
    status: passed ? "passed" : "failed",
    evidence,
  };
  recordStage(stage);
  writeDiagnosticFile(`${diagnosticName(label)}.assertion.json`, `${JSON.stringify(stage, null, 2)}\n`);
}

function recordStage(stage) {
  timeline.push(stage);
  process.stdout.write(`${JSON.stringify({ acceptance: "installed-cli-isolation", ...stage })}\n`);
}

function writeCommandDiagnostics(label, stage, stdout, stderr) {
  const name = diagnosticName(label);
  writeDiagnosticFile(`${name}.jsonl`, stdout);
  writeDiagnosticFile(`${name}.stderr.log`, stderr);
  writeDiagnosticFile(`${name}.meta.json`, `${JSON.stringify(stage, null, 2)}\n`);
}

function recordResult(result) {
  const document = {
    schema_version: 1,
    acceptance: "installed-cli-isolation",
    ministack_image: image,
    ...result,
    timeline,
  };
  writeDiagnosticFile("acceptance-result.json", `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    acceptance: document.acceptance,
    ministack_image: document.ministack_image,
    status: document.status,
  })}\n`);
}

function writeDiagnosticFile(name, contents) {
  if (diagnosticsRoot === undefined) return;
  try {
    writeFileSync(join(diagnosticsRoot, name), contents);
  } catch (error) {
    process.stderr.write(`Failed to write acceptance diagnostic ${name}: ${String(error)}\n`);
  }
}

function diagnosticName(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: "NonError", message: String(error) };
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
  assert.ok(event?.data && typeof event.data === "object", "anbo did not emit a structured command.result");
  return event.data;
}

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8", env: sharedEnvironment });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
