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
  await cli(["configure", "--target", "ministack", "--root", projectRoot]);
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

  const logged = await cli(["logs", "--root", projectRoot]);
  assert.equal(logged.events.some((event) => event.type === "log.line"), true);
  const secret = "anbo-acceptance-token-value";
  const debugged = await cli(["debug", "--root", projectRoot, "--probe-secret", "env://ANBO_ACCEPTANCE_SECRET"], {
    env: { ...process.env, ANBO_ACCEPTANCE_SECRET: secret },
  });
  assert.equal(debugged.stdout.includes(secret), false, "resolved secrets must be redacted");
  assert.equal(debugged.stdout.includes("[REDACTED]"), true);

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
  const child = spawn(binary, ["logs", "--follow", "--root", projectRoot, "--output", "jsonl"], {
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
}
