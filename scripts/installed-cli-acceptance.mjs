import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliTarball = requiredTarball("ANBO_CLI_TARBALL");
const sdkTarball = requiredTarball("ANBO_PLUGIN_SDK_TARBALL");
const temporaryRoot = await mkdtemp(join(tmpdir(), "anbo-cloud-installed-cli-"));
const artifactRoot = join(temporaryRoot, "artifacts");
const installRoot = join(temporaryRoot, "install");
const environmentRoot = join(temporaryRoot, "environment-project");
const branchRoot = join(temporaryRoot, "branch-project");
const homeRoot = join(temporaryRoot, "home");
const diagnosticsRoot = process.env.ANBO_ACCEPTANCE_DIAGNOSTICS
  ? resolve(process.env.ANBO_ACCEPTANCE_DIAGNOSTICS)
  : join(temporaryRoot, "diagnostics");
const selfHostedToken = "cloud-config-token-should-never-appear";
const previewToken = "cloud-preview-token-should-never-appear";
const logToken = "cloud-log-token-should-never-appear";
const logPassword = "cloud-log-password-should-never-appear";
const branchPassword = "branch-password";
const secrets = [selfHostedToken, previewToken, logToken, logPassword, branchPassword];
let mockApi;

try {
  await Promise.all([
    artifactRoot,
    installRoot,
    environmentRoot,
    branchRoot,
    homeRoot,
    diagnosticsRoot,
  ].map((path) => mkdir(path, { recursive: true })));

  const pluginTarball = packPluginCandidate();
  await writeFile(
    join(installRoot, "package.json"),
    '{"name":"anbo-cloud-installed-cli-acceptance","private":true}\n',
  );
  runSetupCommand("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    cliTarball,
    sdkTarball,
    pluginTarball,
  ], installRoot);

  const binary = join(installRoot, "node_modules", ".bin", "anbo");
  await access(binary, constants.X_OK);
  mockApi = await startMockEnvApi({ selfHostedToken, previewToken, logToken, logPassword });

  const baseEnvironment = withoutAnboCredentials({
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
  });
  const invoke = (label, args, options = {}) => invokeInstalledAnbo({
    binary,
    label,
    args,
    cwd: installRoot,
    diagnosticsRoot,
    env: { ...baseEnvironment, ...options.env },
    secrets,
  });

  const configured = await invoke("configure", [
    "configure",
    "--target", "cloud",
    "--root", environmentRoot,
    "--api-url", mockApi.url,
    "--project", "cloud-acceptance",
    "--source", "postgres-main",
    "--route-base-url", mockApi.url,
    "--base-bucket", "cloud-acceptance-base",
    "--base-prefix", "snapshots/",
    "--overlay-bucket", "cloud-acceptance-overlay",
    "--token", selfHostedToken,
  ]);
  assert.match(configured.stdout, /\[REDACTED\]/u, "configure must visibly redact its token argument");

  const credentialsPath = join(homeRoot, ".config", "anbo", "credentials.json");
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(credentials.endpoints[mockApi.url].token, selfHostedToken);
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);

  await invoke("deploy", [
    "deploy",
    "--target", "cloud",
    "--root", environmentRoot,
    "--image", "ghcr.io/getanbo/cloud-acceptance:sha-123",
    "--sha", "sha-123",
    "--env-id", "env-cloud-acceptance",
    "--poll-interval-ms", "1",
    "--timeout-seconds", "5",
  ]);
  await invoke("status", [
    "status",
    "--target", "cloud",
    "--root", environmentRoot,
    "env-cloud-acceptance",
  ]);
  await invoke("test-run", [
    "test-run",
    "--target", "cloud",
    "--root", environmentRoot,
    "env-cloud-acceptance",
    "--type", "smoke",
    "--image", "ghcr.io/getanbo/cloud-acceptance:sha-123",
    "--wait",
    "--poll-interval-ms", "1",
    "--timeout-seconds", "5",
    "--",
    "npm", "run", "smoke",
  ]);
  await invoke("test-status", [
    "cloud", "test-status",
    "--root", environmentRoot,
    "env-cloud-acceptance", "run-cloud-acceptance",
  ]);
  await invoke("logs", [
    "logs",
    "--target", "cloud",
    "--root", environmentRoot,
    "env-cloud-acceptance",
    "--test-run", "run-cloud-acceptance",
    "--tail", "10",
  ]);
  await invoke("report", [
    "cloud", "report",
    "--root", environmentRoot,
    "env-cloud-acceptance",
    "--test-run", "run-cloud-acceptance",
    "--out", "reports/run-cloud-acceptance.json",
  ]);
  const report = JSON.parse(await readFile(
    join(environmentRoot, "reports", "run-cloud-acceptance.json"),
    "utf8",
  ));
  assert.equal(report.summary.status, "Passed");
  await invoke("down", [
    "down",
    "--target", "cloud",
    "--root", environmentRoot,
    "env-cloud-acceptance",
    "--wait",
    "--poll-interval-ms", "1",
    "--timeout-seconds", "5",
  ]);

  const previewEnvironment = { ANBO_TOKEN: previewToken };
  for (const engine of ["postgres", "dynamodb"]) {
    const result = await invoke(`configure-${engine}`, [
      "configure",
      "--target", "cloud",
      "--root", branchRoot,
      engine,
      "--demo",
      "--api-url", mockApi.url,
      "--project", "branch-acceptance",
      "--route-base-url", mockApi.url,
      "--token", previewToken,
    ], { env: previewEnvironment });
    assert.match(result.stdout, /\[REDACTED\]/u);
  }
  for (const [name, source] of [
    ["postgres-clone-acceptance", "postgres-clone"],
    ["dynamodb-clone-acceptance", "dynamodb-clone"],
  ]) {
    await invoke(`branch-${name}`, [
      "cloud", "branch", "create", name,
      "--root", branchRoot,
      "--from", source,
      "--no-credentials",
      "--poll-interval-ms", "1",
      "--timeout-seconds", "5",
    ], { env: previewEnvironment });
  }

  const branchConfig = JSON.parse(await readFile(join(branchRoot, ".anbo", "config.json"), "utf8"));
  assert.deepEqual(branchConfig.sources.map(({ type, link }) => ({ type, link })), [
    { type: "postgres", link: "postgres-clone" },
    { type: "dynamodb", link: "dynamodb-clone" },
  ]);
  assertAcceptanceRequests(mockApi.requests, { selfHostedToken, previewToken });
  assert.equal(mockApi.errors.length, 0, mockApi.errors.join("\n"));

  process.stdout.write("Cloud installed-CLI acceptance passed.\n");
} finally {
  await mockApi?.close();
  if (process.env.ANBO_KEEP_ACCEPTANCE === "1") {
    process.stdout.write(`Acceptance files retained at ${temporaryRoot}\n`);
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function packPluginCandidate() {
  const output = runSetupCommand("npm", [
    "pack",
    "--json",
    "--pack-destination", artifactRoot,
  ], repositoryRoot);
  const [{ filename }] = JSON.parse(output);
  return join(artifactRoot, filename);
}

function runSetupCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `${command} failed to start: ${String(result.error)}`);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function invokeInstalledAnbo({ binary, label, args, cwd, diagnosticsRoot, env, secrets }) {
  const boundary = args.indexOf("--");
  const machineArgs = boundary < 0
    ? [...args, "--output", "jsonl"]
    : [...args.slice(0, boundary), "--output", "jsonl", ...args.slice(boundary)];
  const result = await runProcess(binary, machineArgs, cwd, env);
  await Promise.all([
    writeFile(join(diagnosticsRoot, `${label}.jsonl`), result.stdout),
    writeFile(join(diagnosticsRoot, `${label}.stderr.log`), result.stderr),
  ]);
  assert.equal(result.signal, null, `${label} terminated by ${result.signal}`);
  assert.equal(result.exitCode, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", `${label} leaked machine-readable output to stderr`);
  for (const secret of secrets) {
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(secret),
      false,
      `${label} exposed a credential`,
    );
  }
  const events = parseEventStream(result.stdout, label);
  return { ...result, events };
}

function runProcess(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal, stdout, stderr }));
  });
}

function parseEventStream(stdout, label) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.ok(lines.length >= 2, `${label} did not emit a complete event stream`);
  const events = lines.map((line) => JSON.parse(line));
  const runId = events[0].runId;
  assert.equal(events[0].type, "run.started");
  assert.equal(events.at(-1).type, "run.finished");
  assert.equal(events.at(-1).data.exitCode, 0);
  for (const [index, event] of events.entries()) {
    assert.equal(event.apiVersion, "anbo.dev/event/v1");
    assert.equal(event.runId, runId);
    assert.equal(event.sequence, index + 1);
  }
  return events;
}

async function startMockEnvApi({ selfHostedToken, previewToken, logToken, logPassword }) {
  const requests = [];
  const errors = [];
  const branches = new Map();
  let environmentPolls = 0;
  let testRunPolls = 0;
  let deleting = false;
  let testRunRequest;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      const body = await readRequestBody(request);
      requests.push({
        method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.authorization,
        body,
      });
      const authorized = request.headers.authorization === `Bearer ${selfHostedToken}`
        || request.headers.authorization === `Bearer ${previewToken}`;
      if (!authorized) return sendJson(response, 401, { error: { message: "unauthorized" } });

      if (method === "POST" && url.pathname === "/envs") {
        return sendJson(response, 202, environmentSummary("Pending"));
      }
      if (url.pathname === "/envs/env-cloud-acceptance") {
        if (method === "DELETE") {
          deleting = true;
          return sendJson(response, 202, environmentSummary("Deleting"));
        }
        if (method === "GET") {
          if (deleting) return sendJson(response, 200, environmentSummary("Deleted"));
          environmentPolls += 1;
          return sendJson(response, 200, environmentSummary(
            environmentPolls === 1 ? "BranchCreating" : "ReadyForFirstTest",
          ));
        }
      }
      if (method === "POST" && url.pathname === "/envs/env-cloud-acceptance/test-runs") {
        testRunRequest = body;
        return sendJson(response, 202, testRunSummary("Pending", body));
      }
      if (method === "GET" && url.pathname === "/envs/env-cloud-acceptance/test-runs/run-cloud-acceptance/logs") {
        return sendJson(response, 200, testRunLogs(logToken, logPassword));
      }
      if (method === "GET" && url.pathname === "/envs/env-cloud-acceptance/test-runs/run-cloud-acceptance/report") {
        return sendJson(response, 200, {
          schemaVersion: 1,
          generatedAt: "2026-07-15T12:00:04.000Z",
          summary: testRunSummary("Passed", testRunRequest),
          logs: testRunLogs("redacted-before-storage", "redacted-before-storage"),
        });
      }
      if (method === "GET" && url.pathname === "/envs/env-cloud-acceptance/test-runs/run-cloud-acceptance") {
        testRunPolls += 1;
        return sendJson(response, 200, testRunSummary(testRunPolls === 1 ? "Running" : "Passed", testRunRequest));
      }
      if (method === "GET" && url.pathname === "/v1/database-links") {
        const type = url.searchParams.get("type");
        if (type !== "postgres" && type !== "dynamodb") {
          return sendJson(response, 400, { error: { message: "type is required" } });
        }
        return sendJson(response, 200, databaseLinks(type));
      }
      if (method === "POST" && url.pathname === "/v1/branches") {
        const sourceType = body?.from === "dynamodb-clone" ? "dynamodb" : "postgres";
        const id = `branch-${body?.name}`;
        const branch = { id, name: body?.name, sourceType, source: body?.from, polls: 0 };
        branches.set(id, branch);
        return sendJson(response, 201, branchSummary(branch, false));
      }
      const branchMatch = url.pathname.match(/^\/v1\/branches\/([^/]+)$/u);
      if (method === "GET" && branchMatch) {
        const branch = branches.get(decodeURIComponent(branchMatch[1]));
        if (!branch) return sendJson(response, 404, { error: { message: "branch not found" } });
        branch.polls += 1;
        return sendJson(response, 200, branchSummary(branch, true));
      }
      return sendJson(response, 404, { error: { message: `unexpected ${method} ${url.pathname}` } });
    } catch (error) {
      errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
      return sendJson(response, 500, { error: { message: "mock API failure" } });
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

function environmentSummary(state) {
  return {
    envId: "env-cloud-acceptance",
    state,
    previewUrl: "https://preview.example.test/e/env-cloud-acceptance",
    message: state === "BranchCreating" ? "cloning PostgreSQL source" : undefined,
    branch: {
      allocation: "prepared_pool",
      baseSnapshot: "snapshot-cloud-acceptance",
      readyAt: state === "ReadyForFirstTest" ? "2026-07-15T12:00:02.000Z" : undefined,
    },
  };
}

function testRunSummary(status, request = {}) {
  return {
    envId: "env-cloud-acceptance",
    runId: "run-cloud-acceptance",
    type: request?.type ?? "smoke",
    execution: request?.execution ?? "cluster_job",
    status,
    image: request?.image ?? "ghcr.io/getanbo/cloud-acceptance:sha-123",
    command: request?.command ?? ["npm", "run", "smoke"],
    shards: request?.shards ?? 1,
    timeout_seconds: request?.timeout_seconds ?? 5,
    durationMs: status === "Passed" ? 2400 : undefined,
    jobs: [{ name: "run-cloud-acceptance-s0", status }],
  };
}

function testRunLogs(logToken, logPassword) {
  return {
    envId: "env-cloud-acceptance",
    runId: "run-cloud-acceptance",
    status: "Passed",
    truncated: false,
    entries: [{
      jobName: "run-cloud-acceptance-s0",
      podName: "run-cloud-acceptance-s0-pod",
      container: "test",
      text: [
        "smoke test passed",
        `Authorization: Bearer ${logToken}`,
        `DATABASE_URL=postgresql://acceptance:${logPassword}@database.example.test/branch`,
      ].join("\n"),
    }],
  };
}

function databaseLinks(type) {
  return {
    version: 1,
    type,
    checked_at: "2026-07-15T12:00:00.000Z",
    ready: true,
    defaults: {
      ...(type === "postgres" ? { postgres_link: "postgres-clone" } : { dynamodb_link: "dynamodb-clone" }),
    },
    postgres: type === "postgres" ? [{
      link: "postgres-clone",
      ready: true,
      source_check_ok: true,
      snapshot_ref: "snapshot-postgres-clone",
      snapshot_id: "snapshot-postgres-clone",
      snapshot_ready: true,
      replica_lag_seconds: 0,
      message: null,
    }] : [],
    dynamodb: type === "dynamodb" ? [{
      link: "dynamodb-clone",
      ready: true,
      mirror_ref: "mirror-dynamodb-clone",
      phase: "Ready",
      lag_seconds: 0,
      region: "eu-west-2",
      logical_tables: ["Notes"],
      supported_api_level: "mvp-2026-07-expressions",
      snapshot_ready: true,
      gateway_ready: true,
      last_checkpoint_at: "2026-07-15T12:00:00.000Z",
      message: null,
    }] : [],
  };
}

function branchSummary(branch, ready) {
  const dynamodb = branch.sourceType === "dynamodb" ? {
    link: branch.source,
    phase: ready ? "Ready" : "CreatingStore",
    endpoint: ready ? "https://dynamodb.example.test" : null,
    region: "eu-west-2",
    supported_api_level: "mvp-2026-07-expressions",
  } : undefined;
  return {
    id: branch.id,
    name: branch.name,
    status: ready ? "ready" : "creating",
    state: ready ? "Ready" : "BranchCreating",
    ready,
    preview_url: ready ? `https://preview.example.test/b/${branch.id}` : null,
    database_url: branch.sourceType === "postgres" && ready
      ? `postgresql://acceptance:${branchPassword}@database.example.test/branch`
      : null,
    source: { type: branch.sourceType, link: branch.source },
    ...(dynamodb ? { dynamodb } : {}),
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const value = Buffer.concat(chunks).toString("utf8");
  return value.length === 0 ? undefined : JSON.parse(value);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function assertAcceptanceRequests(requests, { selfHostedToken, previewToken }) {
  const byRoute = requests.map(({ method, path }) => `${method} ${path}`);
  for (const route of [
    "POST /envs",
    "GET /envs/env-cloud-acceptance",
    "POST /envs/env-cloud-acceptance/test-runs",
    "GET /envs/env-cloud-acceptance/test-runs/run-cloud-acceptance",
    "GET /envs/env-cloud-acceptance/test-runs/run-cloud-acceptance/logs",
    "GET /envs/env-cloud-acceptance/test-runs/run-cloud-acceptance/report",
    "DELETE /envs/env-cloud-acceptance",
  ]) assert.ok(byRoute.includes(route), `missing Env API behavior: ${route}`);

  const createEnvironment = requests.find(({ method, path }) => method === "POST" && path === "/envs");
  assert.equal(createEnvironment.authorization, `Bearer ${selfHostedToken}`);
  assert.equal(createEnvironment.body.spec.postgres.source, "postgres-main");
  assert.equal(createEnvironment.body.spec.tests.auto_run, "none");
  const createTestRun = requests.find(({ method, path }) => method === "POST" && path.endsWith("/test-runs"));
  assert.deepEqual(createTestRun.body.command, ["npm", "run", "smoke"]);

  const databasePreflights = requests.filter(({ path }) => path === "/v1/database-links");
  assert.deepEqual(databasePreflights.map(({ query }) => query), ["?type=postgres", "?type=dynamodb"]);
  assert.ok(databasePreflights.every(({ authorization }) => authorization === `Bearer ${previewToken}`));
  const cloneRequests = requests.filter(({ method, path }) => method === "POST" && path === "/v1/branches");
  assert.deepEqual(cloneRequests.map(({ body }) => body), [
    { name: "postgres-clone-acceptance", from: "postgres-clone" },
    { name: "dynamodb-clone-acceptance", from: "dynamodb-clone" },
  ]);
  assert.ok(cloneRequests.every(({ authorization }) => authorization === `Bearer ${previewToken}`));
}

function withoutAnboCredentials(environment) {
  const result = { ...environment };
  for (const key of [
    "ANBO_TOKEN",
    "ANBO_PREVIEW_API_TOKEN",
    "ANBO_DEMO_API_TOKEN",
    "ANBO_ENV_API_TOKEN",
    "ANBO_K8S_ENV_API_TOKEN",
  ]) delete result[key];
  return result;
}

function requiredTarball(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point to a packed candidate tarball`);
  return resolve(value);
}
