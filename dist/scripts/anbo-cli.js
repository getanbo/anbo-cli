#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateAnboEnvironment } from "../anbo-k8s/controllers/src/contracts.js";
const CONFIG_PATH = ".anbo/config.json";
const DEFAULT_PREVIEW_API_URL = "https://app.getanbo.com";
const DEFAULT_PREVIEW_ROUTE_BASE_URL = "https://preview.getanbo.com";
const READY_STATES = new Set(["ReadyForFirstTest", "Ready", "Passed"]);
const TERMINAL_FAILURE_STATES = new Set(["Failed", "Deleted"]);
const TEST_RUN_TERMINAL_STATES = new Set(["Passed", "Failed", "TimedOut", "Canceled"]);
const TEST_RUN_FAILURE_STATES = new Set(["Failed", "TimedOut", "Canceled"]);
const VALID_ALLOCATIONS = new Set(["pool_required", "pool_preferred", "fresh_required"]);
const VALID_TEST_TYPES = new Set(["migration", "smoke", "test", "ci"]);
const WAIT_PROGRESS_INTERVAL_MS = 10_000;
const CLI_VERSION_FALLBACK = "0.1.0";
const REQUIRED_SERVICES = [
    "query-api",
    "ingest-gateway",
    "processor-worker",
    "status-rollup-worker"
];
const SERVICE_PORTS = {
    "query-api": 3001,
    "ingest-gateway": 3000,
    "processor-worker": undefined,
    "status-rollup-worker": undefined
};
export async function runAnboCli(args, dependencies = {}) {
    const runtimeDependencies = {
        ...dependencies,
        env: dependencies.env ?? process.env
    };
    const parsed = parseArgs(args);
    const command = parsed.command ?? "help";
    try {
        switch (command) {
            case "setup":
                await runSetup(parsed, runtimeDependencies);
                return 0;
            case "login":
                await runLogin(parsed, runtimeDependencies);
                return 0;
            case "logout":
                await runLogout(parsed, runtimeDependencies);
                return 0;
            case "auth":
                await runAuth(parsed, runtimeDependencies);
                return 0;
            case "demo":
                await runDemo(parsed, runtimeDependencies);
                return 0;
            case "branch":
                await runBranch(parsed, runtimeDependencies);
                return 0;
            case "token":
                await runToken(parsed, runtimeDependencies);
                return 0;
            case "version":
            case "--version":
            case "-v":
                printVersion(parsed, runtimeDependencies);
                return 0;
            case "create":
                await runCreate(parsed, runtimeDependencies);
                return 0;
            case "status":
                await runStatus(parsed, runtimeDependencies);
                return 0;
            case "destroy":
                await runDestroy(parsed, runtimeDependencies);
                return 0;
            case "sql":
                await runSql(parsed, runtimeDependencies);
                return 0;
            case "test":
            case "test-run":
                await runTest(parsed, runtimeDependencies);
                return 0;
            case "test-status":
                await runTestStatus(parsed, runtimeDependencies);
                return 0;
            case "logs":
                await runLogs(parsed, runtimeDependencies);
                return 0;
            case "report":
                await runReport(parsed, runtimeDependencies);
                return 0;
            case "help":
            case "--help":
            case "-h":
                printHelp(runtimeDependencies);
                return 0;
            default:
                throw new Error(`unknown anbo command ${command}`);
        }
    }
    catch (error) {
        writeErr(runtimeDependencies, redactSensitiveText(getErrorMessage(error)));
        return 1;
    }
}
export function buildAnboEnvironmentManifest(config, input) {
    const envId = input.envId ?? defaultEnvId(config.project, input.sha);
    const services = {};
    for (const serviceName of REQUIRED_SERVICES) {
        const service = {
            image: input.image,
            replicas: 0
        };
        const port = SERVICE_PORTS[serviceName];
        if (port !== undefined) {
            service.port = port;
        }
        services[serviceName] = service;
    }
    return validateAnboEnvironment({
        apiVersion: "k8s.anbo.dev/v1",
        kind: "AnboEnvironment",
        metadata: {
            name: envId
        },
        spec: {
            ttl: input.ttl ?? config.defaults.ttl,
            repo: config.repo.name,
            sha: input.sha,
            tenant_id: config.project,
            services,
            postgres: {
                mode: "wal_replica_cow_branch",
                source: input.source ?? config.source,
                base_snapshot: input.snapshot ?? config.defaults.baseSnapshot,
                branch_compute: {
                    allocation: input.allocation
                }
            },
            s3: {
                mode: "overlay",
                base_bucket: config.s3.baseBucket,
                base_prefix: config.s3.basePrefix,
                overlay_bucket: config.s3.overlayBucket,
                overlay_prefix: `envs/${envId}/`
            },
            queues: {
                mode: "sqs_namespace",
                names: ["ingest_shard", "agent_jobs", "dlq"]
            },
            side_effects: {
                slack: "capture",
                webhooks: "record_only",
                llm: "deterministic_stub"
            },
            route: {
                base_url: config.routeBaseUrl,
                path: `/e/${envId}`
            },
            tests: {
                migration: "explicit test-run",
                smoke: "explicit test-run",
                auto_run: "none"
            }
        }
    });
}
export function buildAnboTestRunRequest(input) {
    return {
        type: input.type,
        execution: input.execution,
        image: input.image,
        command: input.command,
        shards: input.shards,
        timeout_seconds: input.timeoutSeconds
    };
}
async function runSetup(parsed, dependencies) {
    const cwd = dependencies.cwd ?? process.cwd();
    const detected = detectRepo(cwd);
    if (boolFlag(parsed, "demo") || boolFlag(parsed, "preview")) {
        const apiUrl = previewApiUrlFromArgs(parsed, dependencies);
        const config = {
            version: 1,
            mode: "demo",
            apiUrl,
            project: stringFlag(parsed, "project") ?? "free-preview",
            repo: {
                name: detected.name,
                ...(detected.remoteUrl === undefined ? {} : { remoteUrl: detected.remoteUrl })
            },
            source: stringFlag(parsed, "source") ?? "billing-service",
            routeBaseUrl: (stringFlag(parsed, "route-base-url")
                ?? stringFlag(parsed, "demo-url")
                ?? stringFlag(parsed, "preview-url")
                ?? dependencies.env?.ANBO_PREVIEW_ROUTE_BASE_URL
                ?? DEFAULT_PREVIEW_ROUTE_BASE_URL).replace(/\/+$/, ""),
            s3: {
                baseBucket: stringFlag(parsed, "base-bucket") ?? "anbo-preview-base",
                basePrefix: normalizeS3Prefix(stringFlag(parsed, "base-prefix") ?? "preview/"),
                overlayBucket: stringFlag(parsed, "overlay-bucket") ?? "anbo-preview-overlays"
            },
            defaults: {
                ttl: stringFlag(parsed, "ttl") ?? "1h",
                baseSnapshot: stringFlag(parsed, "snapshot") ?? "latest_safe",
                allocation: allocationFromFlag(stringFlag(parsed, "allocation") ?? "pool_required")
            }
        };
        writeRepoConfig(cwd, config);
        writeOut(dependencies, `wrote ${CONFIG_PATH}`);
        writeOut(dependencies, `configured demo API ${apiUrl}`);
        writeOut(dependencies, `configured demo branches under ${config.routeBaseUrl}`);
        if (readPreviewCredential(dependencies, apiUrl) === undefined) {
            writeOut(dependencies, "no Anbo credentials found; run anbo login before creating a database branch");
        }
        return;
    }
    const input = {
        apiUrl: apiBaseUrlFromUrl(await requiredSetupValue(parsed, dependencies, "api-url", "Env API URL"), "Env API URL"),
        project: await requiredSetupValue(parsed, dependencies, "project", "Project name", detected.name),
        source: await requiredSetupValue(parsed, dependencies, "source", "Source Postgres alias"),
        routeBaseUrl: await requiredSetupValue(parsed, dependencies, "route-base-url", "Preview route base URL"),
        baseBucket: await requiredSetupValue(parsed, dependencies, "base-bucket", "Base raw S3 bucket"),
        basePrefix: normalizeS3Prefix(await requiredSetupValue(parsed, dependencies, "base-prefix", "Base raw S3 prefix")),
        overlayBucket: await requiredSetupValue(parsed, dependencies, "overlay-bucket", "Overlay S3 bucket"),
        allocation: allocationFromFlag(stringFlag(parsed, "allocation") ?? "pool_required"),
        ttl: stringFlag(parsed, "ttl") ?? "2h",
        baseSnapshot: stringFlag(parsed, "snapshot") ?? "latest_safe"
    };
    const token = stringFlag(parsed, "token");
    if (token !== undefined) {
        input.token = token;
    }
    const config = {
        version: 1,
        apiUrl: input.apiUrl,
        project: input.project,
        repo: {
            name: detected.name,
            ...(detected.remoteUrl === undefined ? {} : { remoteUrl: detected.remoteUrl })
        },
        source: input.source,
        routeBaseUrl: input.routeBaseUrl,
        s3: {
            baseBucket: input.baseBucket,
            basePrefix: input.basePrefix,
            overlayBucket: input.overlayBucket
        },
        defaults: {
            ttl: input.ttl,
            baseSnapshot: input.baseSnapshot,
            allocation: input.allocation
        }
    };
    writeRepoConfig(cwd, config);
    if (input.token !== undefined) {
        writeCredential(dependencies, input.apiUrl, input.token);
    }
    writeOut(dependencies, `wrote ${CONFIG_PATH}`);
    if (input.token !== undefined) {
        writeOut(dependencies, `stored credentials in ${credentialsPath(dependencies)}`);
    }
    else {
        writeOut(dependencies, "no token stored; set ANBO_ENV_API_TOKEN or rerun setup with --token");
    }
}
async function runLogin(parsed, dependencies) {
    const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
    const start = await previewApiRequest(dependencies, previewUrl, "POST", "/v1/cli/device/start");
    const verificationUrl = validateLoginVerificationUrl(start.verification_uri, previewUrl, dependencies);
    writeOut(dependencies, `verification_url: ${verificationUrl}`);
    writeOut(dependencies, `user_code: ${start.user_code}`);
    if (!boolFlag(parsed, "no-browser")) {
        if (openUrlInBrowser(verificationUrl, dependencies)) {
            writeOut(dependencies, "opened browser for Auth0 login");
        }
        else {
            writeOut(dependencies, "could not open a browser automatically; open verification_url manually");
        }
    }
    writeOut(dependencies, "waiting for browser approval...");
    const deadline = Date.now() + start.expires_in * 1000;
    let latestError = "authorization pending";
    while (Date.now() < deadline) {
        const token = await previewApiRequestOrError(dependencies, previewUrl, "POST", "/v1/cli/device/token", { device_code: start.device_code });
        if (token.ok) {
            writePreviewCredential(dependencies, previewUrl, token.body.access_token);
            writeOut(dependencies, `stored Anbo credentials for ${previewUrl}`);
            return;
        }
        latestError = token.message;
        if (token.status !== 428) {
            break;
        }
        await sleep(Math.max(1, start.interval) * 1000);
    }
    throw new Error(`login failed: ${latestError}`);
}
function validateLoginVerificationUrl(verificationUri, previewUrl, dependencies) {
    let parsed;
    try {
        parsed = new URL(verificationUri);
    }
    catch {
        throw new Error("login verification_url must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("login verification_url must use http or https");
    }
    if (/[\u0000-\u001F\u007F\s"'`<>\\|;&]/.test(verificationUri) || verificationUri.includes("$(") || verificationUri.includes("${")) {
        throw new Error("login verification_url contains unsafe shell metacharacters");
    }
    const allowedOrigins = loginVerificationAllowedOrigins(previewUrl, dependencies);
    if (!allowedOrigins.has(parsed.origin)) {
        throw new Error(`login verification_url origin ${parsed.origin} does not match ${Array.from(allowedOrigins).join(" or ")}`);
    }
    return parsed.href;
}
function loginVerificationAllowedOrigins(previewUrl, dependencies) {
    const origins = new Set([httpOriginFromUrl(previewUrl, "preview API URL")]);
    for (const candidate of [
        dependencies.env?.ANBO_PUBLIC_BASE_URL,
        dependencies.env?.ANBO_PUBLIC_ORIGIN,
        dependencies.env?.ANBO_APP_URL,
        dependencies.env?.ANBO_K8_PUBLIC_BASE_URL
    ]) {
        const origin = optionalHttpOriginFromUrl(candidate);
        if (origin !== undefined) {
            origins.add(origin);
        }
    }
    return origins;
}
function httpOriginFromUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`${label} must be a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${label} must use http or https`);
    }
    if (parsed.protocol === "http:" && !isLocalHttpHost(parsed.hostname)) {
        throw new Error(`${label} must use https unless it targets localhost`);
    }
    return parsed.origin;
}
function optionalHttpOriginFromUrl(value) {
    if (value === undefined || value.trim().length === 0) {
        return undefined;
    }
    try {
        return httpOriginFromUrl(value, "public origin URL");
    }
    catch {
        return undefined;
    }
}
function apiBaseUrlFromUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`${label} must be a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${label} must use http or https`);
    }
    if (parsed.protocol === "http:" && !isLocalHttpHost(parsed.hostname)) {
        throw new Error(`${label} must use https unless it targets localhost`);
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
        throw new Error(`${label} must not include embedded credentials`);
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
        throw new Error(`${label} must not include query strings or fragments`);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
}
function isLocalHttpHost(hostname) {
    const normalized = hostname.toLowerCase();
    return normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1" ||
        normalized === "[::1]" ||
        normalized.endsWith(".localhost");
}
function openUrlInBrowser(url, dependencies) {
    if (dependencies.openBrowser !== undefined) {
        return dependencies.openBrowser(url);
    }
    const platform = dependencies.platform ?? process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const spawnBrowser = dependencies.browserSpawn ?? spawnSync;
    const result = spawnBrowser(command, args, {
        stdio: "ignore",
        timeout: 3000
    });
    return result.status === 0;
}
async function runLogout(parsed, dependencies) {
    const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
    deletePreviewCredential(dependencies, previewUrl);
    writeOut(dependencies, `removed Anbo credentials for ${previewUrl}`);
}
async function runAuth(parsed, dependencies) {
    const subcommand = requiredPositional(parsed, 0, "auth command");
    const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
    if (subcommand === "login") {
        await runLogin(withoutFirstPositional(parsed), dependencies);
        return;
    }
    if (subcommand === "logout") {
        await runLogout(withoutFirstPositional(parsed), dependencies);
        return;
    }
    throw new Error(`unknown auth command ${subcommand}`);
}
async function runDemo(parsed, dependencies) {
    const subcommand = requiredPositional(parsed, 0, "demo command");
    if (subcommand === "sql") {
        throw new Error("hosted SQL is not available in demo mode; use anbo branch url NAME and run psql, migrations, or tests with DATABASE_URL");
    }
    throw new Error("anbo demo subcommands are deprecated; use anbo branch create/info/url/list/delete");
}
async function runBranch(parsed, dependencies) {
    const subcommand = requiredPositional(parsed, 0, "branch command");
    const config = readRepoConfig(dependencies);
    if (!isPreviewConfig(config)) {
        throw new Error("anbo branch is only available after anbo setup --demo");
    }
    const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
    const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
    if (subcommand === "create") {
        const name = requiredPositional(parsed, 1, "branch name");
        const json = boolFlag(parsed, "json");
        if (!json) {
            writeOut(dependencies, `creating branch ${name}...`);
        }
        let branch = await previewApiRequest(dependencies, previewUrl, "POST", "/v1/branches", { name }, token);
        if (!boolFlag(parsed, "no-wait")) {
            branch = await waitForDemoBranchReady(dependencies, previewUrl, token, name, branch, json);
        }
        printDemoBranch(dependencies, branch, json, true);
        return;
    }
    if (subcommand === "info") {
        const name = requiredPositional(parsed, 1, "branch name or id");
        const branch = await previewApiRequest(dependencies, previewUrl, "GET", `/v1/branches/${encodeURIComponent(name)}`, undefined, token);
        printDemoBranch(dependencies, branch, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
        return;
    }
    if (subcommand === "url") {
        const name = requiredPositional(parsed, 1, "branch name or id");
        const result = await requestDemoBranchUrl(dependencies, previewUrl, token, name);
        if (boolFlag(parsed, "json")) {
            writeOut(dependencies, JSON.stringify(result, null, 2));
        }
        else {
            writeOut(dependencies, result.database_url);
        }
        return;
    }
    if (subcommand === "list") {
        const result = await previewApiRequest(dependencies, previewUrl, "GET", "/v1/branches", undefined, token);
        printDemoBranchList(dependencies, result, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
        return;
    }
    if (subcommand === "delete") {
        const name = requiredPositional(parsed, 1, "branch name or id");
        const branch = await previewApiRequest(dependencies, previewUrl, "DELETE", `/v1/branches/${encodeURIComponent(name)}`, undefined, token);
        printDemoBranch(dependencies, branch, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
        return;
    }
    throw new Error(`unknown branch command ${subcommand}`);
}
async function waitForDemoBranchReady(dependencies, previewUrl, token, name, initial, quiet) {
    let latest = initial;
    const pollId = initial.id;
    const deadline = Date.now() + 180_000;
    let lastStatus = "";
    while (Date.now() < deadline) {
        if (latest.ready) {
            return latest;
        }
        if (latest.status === "failed" || latest.status === "deleted" || latest.status === "deleting") {
            throw new Error(`branch ${name} reached terminal status ${latest.status}`);
        }
        const statusLine = latest.status;
        if (!quiet && statusLine !== lastStatus) {
            writeOut(dependencies, `waiting for branch ${name}: ${statusLine}`);
            lastStatus = statusLine;
        }
        await sleepFor(dependencies, 2_000);
        latest = await previewApiRequest(dependencies, previewUrl, "GET", `/v1/branches/${encodeURIComponent(pollId)}`, undefined, token);
    }
    throw new Error(`timed out waiting for branch ${name}; latest status was ${latest.status}`);
}
async function requestDemoBranchUrl(dependencies, previewUrl, token, name) {
    const deadline = Date.now() + 90_000;
    let latestError = "branch database URL is not ready";
    while (Date.now() < deadline) {
        const response = await previewApiRequestOrError(dependencies, previewUrl, "GET", `/v1/branches/${encodeURIComponent(name)}/url`, undefined, token);
        if (response.ok) {
            return response.body;
        }
        latestError = response.message;
        if (response.status !== 409 && response.status !== 502 && response.status !== 503) {
            throw new Error(`GET /v1/branches/${name}/url failed ${response.status}: ${response.message}`);
        }
        await sleepFor(dependencies, 2_000);
    }
    throw new Error(`branch database URL is not ready: ${latestError}`);
}
async function runToken(parsed, dependencies) {
    const subcommand = requiredPositional(parsed, 0, "token command");
    const previewUrl = previewApiUrlFromArgs(parsed, dependencies);
    const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
    if (subcommand === "create") {
        const created = await previewApiRequest(dependencies, previewUrl, "POST", "/v1/tokens", {}, token);
        if (boolFlag(parsed, "json")) {
            writeOut(dependencies, JSON.stringify(created, null, 2));
        }
        else {
            writeOut(dependencies, created.token);
        }
        return;
    }
    throw new Error(`unknown token command ${subcommand}`);
}
async function runCreate(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    if (config.mode === "demo") {
        throw new Error("anbo create is not available in demo mode; use anbo branch create NAME");
    }
    if (config.mode === "preview") {
        await runPreviewCreate(parsed, dependencies, config);
        return;
    }
    const input = createInputFromArgs(parsed, config);
    const manifest = buildAnboEnvironmentManifest(config, input);
    const client = envApiClient(config, parsed, dependencies);
    let summary = await client.request("POST", "/envs", manifest);
    if (input.wait) {
        summary = await waitForEnvState(client, manifest.metadata.name, input.timeoutSeconds, input.pollIntervalMs, (state) => READY_STATES.has(state) || TERMINAL_FAILURE_STATES.has(state), input.json ? undefined : envWaitProgressReporter(dependencies));
    }
    printEnvironmentSummary(dependencies, summary, input.json);
    if (input.wait && !READY_STATES.has(summary.state)) {
        throw new Error(`environment ${manifest.metadata.name} reached ${summary.state}, not ReadyForFirstTest`);
    }
}
async function runStatus(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    if (config.mode === "demo") {
        throw new Error("anbo status is not available in demo mode; use anbo branch info NAME or anbo branch list");
    }
    if (config.mode === "preview") {
        await runPreviewStatus(parsed, dependencies, config);
        return;
    }
    const envId = requiredPositional(parsed, 0, "env_id");
    const json = boolFlag(parsed, "json");
    const client = envApiClient(config, parsed, dependencies);
    const summary = await client.request("GET", `/envs/${encodeURIComponent(envId)}`);
    printEnvironmentSummary(dependencies, summary, json);
}
async function runDestroy(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    if (config.mode === "demo") {
        throw new Error("anbo destroy is not available in demo mode; use anbo branch delete NAME");
    }
    if (config.mode === "preview") {
        await runPreviewDestroy(parsed, dependencies, config);
        return;
    }
    const input = destroyInputFromArgs(parsed);
    const client = envApiClient(config, parsed, dependencies);
    let summary = await client.request("DELETE", `/envs/${encodeURIComponent(input.envId)}`);
    if (input.wait) {
        summary = await waitForEnvState(client, input.envId, input.timeoutSeconds, input.pollIntervalMs, (state) => state === "Deleted", input.json ? undefined : envWaitProgressReporter(dependencies));
    }
    printEnvironmentSummary(dependencies, summary, input.json);
}
async function runSql(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    const sql = parsed.afterDoubleDash.length > 0 ? parsed.afterDoubleDash.join(" ") : requiredFlag(parsed, "sql");
    if (config.mode === "demo") {
        throw new Error("anbo sql is not available in demo mode; use anbo branch url NAME and run psql, migrations, or tests with DATABASE_URL");
    }
    if (config.mode === "preview") {
        const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
        const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
        const sessionId = previewSessionIdFromArgs(parsed, dependencies, previewUrl, 0);
        const result = await previewApiRequest(dependencies, previewUrl, "POST", `/v1/demo/sessions/${encodeURIComponent(sessionId)}/sql`, { sql }, token);
        printPreviewSqlResult(dependencies, result, boolFlag(parsed, "json"));
        return;
    }
    const envId = requiredPositional(parsed, 0, "env_id");
    const client = envApiClient(config, parsed, dependencies);
    const result = await client.request("POST", `/envs/${encodeURIComponent(envId)}/sql`, { sql });
    printPreviewSqlResult(dependencies, result, boolFlag(parsed, "json"));
}
async function runPreviewCreate(parsed, dependencies, config) {
    const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
    const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
    let session = await previewApiRequest(dependencies, previewUrl, "POST", "/v1/demo/sessions", undefined, token);
    if (!boolFlag(parsed, "no-wait")) {
        session = await waitForPreviewSession(dependencies, previewUrl, token, session.id);
    }
    writeActivePreviewSession(dependencies, previewUrl, session.id);
    printPreviewSession(dependencies, session, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
    if (!boolFlag(parsed, "no-wait") && session.status === "failed") {
        throw new Error(`preview environment ${session.env_id} failed: ${session.message ?? "unknown error"}`);
    }
}
async function runPreviewStatus(parsed, dependencies, config) {
    const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
    const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
    const sessionId = previewSessionIdFromArgs(parsed, dependencies, previewUrl, 0);
    const session = await previewApiRequest(dependencies, previewUrl, "GET", `/v1/demo/sessions/${encodeURIComponent(sessionId)}`, undefined, token);
    printPreviewSession(dependencies, session, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
}
async function runPreviewDestroy(parsed, dependencies, config) {
    const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
    const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
    const sessionId = previewSessionIdFromArgs(parsed, dependencies, previewUrl, 0);
    let session = await previewApiRequest(dependencies, previewUrl, "DELETE", `/v1/demo/sessions/${encodeURIComponent(sessionId)}`, undefined, token);
    if (boolFlag(parsed, "wait")) {
        session = await waitForPreviewSession(dependencies, previewUrl, token, sessionId, (candidate) => candidate.status === "deleted");
    }
    clearActivePreviewSession(dependencies, previewUrl, sessionId);
    printPreviewSession(dependencies, session, boolFlag(parsed, "json"), boolFlag(parsed, "show-secrets"));
}
async function runTest(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    const input = testInputFromArgs(parsed);
    const client = envApiClient(config, parsed, dependencies);
    let summary = await client.request("POST", `/envs/${encodeURIComponent(input.envId)}/test-runs`, buildAnboTestRunRequest(input));
    if (input.wait) {
        summary = await waitForTestRunState(client, input.envId, summary.runId, input.timeoutSeconds, input.pollIntervalMs, (status) => TEST_RUN_TERMINAL_STATES.has(status), input.json ? undefined : testRunWaitProgressReporter(dependencies));
    }
    printTestRunSummary(dependencies, summary, input.json);
    if (input.wait && TEST_RUN_FAILURE_STATES.has(summary.status)) {
        throw new Error(testRunFailureMessage(summary));
    }
}
async function runTestStatus(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    const input = testStatusInputFromArgs(parsed);
    const client = envApiClient(config, parsed, dependencies);
    const summary = await client.request("GET", `/envs/${encodeURIComponent(input.envId)}/test-runs/${encodeURIComponent(input.runId)}`);
    printTestRunSummary(dependencies, summary, input.json);
    if (TEST_RUN_FAILURE_STATES.has(summary.status)) {
        throw new Error(testRunFailureMessage(summary));
    }
}
async function runLogs(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    const input = logsInputFromArgs(parsed);
    const client = envApiClient(config, parsed, dependencies);
    const logs = await client.request("GET", `/envs/${encodeURIComponent(input.envId)}/test-runs/${encodeURIComponent(input.runId)}/logs`);
    printTestRunLogs(dependencies, withTail(logs, input.tail), input.json);
}
async function runReport(parsed, dependencies) {
    const config = readRepoConfig(dependencies);
    const runId = stringFlag(parsed, "test-run");
    if (isPreviewConfig(config) && runId === undefined) {
        const previewUrl = previewApiUrlFromConfig(parsed, dependencies, config);
        const token = previewTokenFromArgs(parsed, dependencies, previewUrl);
        if (config.mode === "demo") {
            const branchName = requiredPositional(parsed, 0, "branch name or id");
            const report = await previewApiRequest(dependencies, previewUrl, "GET", `/v1/branches/${encodeURIComponent(branchName)}/report`, undefined, token);
            writeJsonReport(dependencies, report, stringFlag(parsed, "out"));
            return;
        }
        const sessionId = previewSessionIdFromArgs(parsed, dependencies, previewUrl, 0);
        const report = await previewApiRequest(dependencies, previewUrl, "GET", `/v1/demo/sessions/${encodeURIComponent(sessionId)}/report`, undefined, token);
        writeJsonReport(dependencies, report, stringFlag(parsed, "out"));
        return;
    }
    if (runId === undefined) {
        const envId = requiredPositional(parsed, 0, "env_id");
        const client = envApiClient(config, parsed, dependencies);
        const summary = await client.request("GET", `/envs/${encodeURIComponent(envId)}`);
        writeJsonReport(dependencies, buildEnvironmentUsageReport(summary, config, dependencies.now?.() ?? new Date()), stringFlag(parsed, "out"));
        return;
    }
    const input = reportInputFromArgs(parsed);
    const client = envApiClient(config, parsed, dependencies);
    const report = await client.request("GET", `/envs/${encodeURIComponent(input.envId)}/test-runs/${encodeURIComponent(input.runId)}/report`);
    writeJsonReport(dependencies, report, input.out);
    writeOut(dependencies, `status: ${report.summary.status}`);
    if (report.summary.failedJob !== undefined) {
        writeOut(dependencies, `failed_job: ${report.summary.failedJob}`);
    }
}
function writeJsonReport(dependencies, report, out) {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (out === undefined) {
        writeOut(dependencies, JSON.stringify(redactJsonSecrets(report), null, 2));
        return;
    }
    const outPath = resolve(dependencies.cwd ?? process.cwd(), out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json);
    writeOut(dependencies, `wrote ${outPath}`);
}
function buildEnvironmentUsageReport(summary, config, generatedAt) {
    const generatedAtIso = generatedAt.toISOString();
    const startedAt = earliestIso([
        summary.timings?.sourceCheckStartedAt,
        summary.timings?.branchRequestedAt,
        summary.timings?.readyForFirstTestAt
    ]) ?? generatedAtIso;
    const branchStartedAt = summary.timings?.branchRequestedAt ?? startedAt;
    const branchReadyAt = summary.branch?.readyAt ?? summary.timings?.branchReadyObservedAt ?? null;
    return {
        schema_version: 1,
        type: "anbo_preview_environment_usage",
        generated_at: generatedAtIso,
        env_id: summary.envId,
        project_id: config.project,
        source: config.source,
        status: summary.state,
        preview_url: summary.previewUrl ?? `${config.routeBaseUrl.replace(/\/+$/, "")}/e/${summary.envId}`,
        branch: {
            allocation: summary.branch?.allocation ?? null,
            prepared_branch_name: summary.branch?.preparedBranchName ?? null,
            base_snapshot: summary.branch?.baseSnapshot ?? null,
            base_lsn: summary.branch?.baseLsn ?? null,
            ready_at: branchReadyAt,
            ready_observation_lag_ms: summary.branch?.branchReadyObservationLagMs ?? null
        },
        usage: {
            env_runtime_seconds: secondsBetween(startedAt, generatedAtIso),
            branch_runtime_seconds: secondsBetween(branchStartedAt, generatedAtIso),
            sql_query_count: null,
            sql_failed_count: null,
            sql_row_count: null
        },
        telemetry: {
            deploy_env: summary.runtime?.deployEnv ?? null,
            isolation_mode: summary.runtime?.isolationMode ?? null,
            sqs_endpoint_configured: summary.runtime?.sqsEndpointConfigured ?? null,
            timings: summary.timings ?? {},
            raw_env_api_sql_counts_tracked: false,
            hosted_preview_sql_counts_tracked: true
        }
    };
}
function earliestIso(values) {
    let earliest;
    let earliestMs = Number.POSITIVE_INFINITY;
    for (const value of values) {
        if (value === undefined) {
            continue;
        }
        const ms = Date.parse(value);
        if (Number.isFinite(ms) && ms < earliestMs) {
            earliest = value;
            earliestMs = ms;
        }
    }
    return earliest;
}
function secondsBetween(start, end) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return 0;
    }
    return Math.round((endMs - startMs) / 1000);
}
function createInputFromArgs(parsed, config) {
    if (boolFlag(parsed, "fresh") && boolFlag(parsed, "pool-preferred")) {
        throw new Error("--fresh and --pool-preferred cannot be used together");
    }
    const allocation = boolFlag(parsed, "fresh")
        ? "fresh_required"
        : boolFlag(parsed, "pool-preferred")
            ? "pool_preferred"
            : config.defaults.allocation;
    return {
        image: requiredFlag(parsed, "image"),
        sha: requiredFlag(parsed, "sha"),
        ...(stringFlag(parsed, "env-id") === undefined ? {} : { envId: stringFlag(parsed, "env-id") }),
        ...(stringFlag(parsed, "source") === undefined ? {} : { source: stringFlag(parsed, "source") }),
        ...(stringFlag(parsed, "snapshot") === undefined ? {} : { snapshot: stringFlag(parsed, "snapshot") }),
        ...(stringFlag(parsed, "ttl") === undefined ? {} : { ttl: stringFlag(parsed, "ttl") }),
        allocation,
        wait: !boolFlag(parsed, "no-wait"),
        json: boolFlag(parsed, "json"),
        timeoutSeconds: positiveIntFlag(parsed, "timeout-seconds", 300),
        pollIntervalMs: positiveIntFlag(parsed, "poll-interval-ms", 1000)
    };
}
function testInputFromArgs(parsed) {
    const type = testTypeFromFlag(stringFlag(parsed, "type") ?? "test");
    return {
        envId: requiredPositional(parsed, 0, "env_id"),
        type,
        execution: boolFlag(parsed, "external") ? "external" : "cluster_job",
        image: requiredFlag(parsed, "image"),
        command: parsed.afterDoubleDash.length > 0 ? parsed.afterDoubleDash : commandFromFlag(parsed),
        shards: positiveIntFlag(parsed, "shards", 1),
        timeoutSeconds: positiveIntFlag(parsed, "timeout-seconds", 900),
        wait: boolFlag(parsed, "wait"),
        pollIntervalMs: positiveIntFlag(parsed, "poll-interval-ms", 1000),
        json: boolFlag(parsed, "json")
    };
}
function testStatusInputFromArgs(parsed) {
    return {
        envId: requiredPositional(parsed, 0, "env_id"),
        runId: requiredPositional(parsed, 1, "run_id"),
        json: boolFlag(parsed, "json")
    };
}
function logsInputFromArgs(parsed) {
    const tail = stringFlag(parsed, "tail");
    return {
        envId: requiredPositional(parsed, 0, "env_id"),
        runId: requiredFlag(parsed, "test-run"),
        ...(tail === undefined ? {} : { tail: positiveIntFromRaw(tail, "tail") }),
        json: boolFlag(parsed, "json")
    };
}
function reportInputFromArgs(parsed) {
    const out = stringFlag(parsed, "out");
    return {
        envId: requiredPositional(parsed, 0, "env_id"),
        runId: requiredFlag(parsed, "test-run"),
        ...(out === undefined ? {} : { out })
    };
}
function destroyInputFromArgs(parsed) {
    return {
        envId: requiredPositional(parsed, 0, "env_id"),
        wait: boolFlag(parsed, "wait"),
        json: boolFlag(parsed, "json"),
        timeoutSeconds: positiveIntFlag(parsed, "timeout-seconds", 300),
        pollIntervalMs: positiveIntFlag(parsed, "poll-interval-ms", 1000)
    };
}
function isPreviewConfig(config) {
    return config.mode === "demo" || config.mode === "preview";
}
function previewApiUrlFromConfig(parsed, dependencies, config) {
    return apiBaseUrlFromUrl(stringFlag(parsed, "api-url")
        ?? stringFlag(parsed, "preview-api-url")
        ?? stringFlag(parsed, "app-url")
        ?? stringFlag(parsed, "demo-url")
        ?? dependencies.env?.ANBO_PREVIEW_API_URL
        ?? dependencies.env?.ANBO_APP_URL
        ?? dependencies.env?.ANBO_DEMO_API_URL
        ?? config.apiUrl
        ?? DEFAULT_PREVIEW_API_URL, "Preview API URL");
}
function previewApiUrlFromArgs(parsed, dependencies) {
    return apiBaseUrlFromUrl(stringFlag(parsed, "api-url")
        ?? stringFlag(parsed, "preview-api-url")
        ?? stringFlag(parsed, "app-url")
        ?? stringFlag(parsed, "demo-url")
        ?? dependencies.env?.ANBO_PREVIEW_API_URL
        ?? dependencies.env?.ANBO_APP_URL
        ?? dependencies.env?.ANBO_DEMO_API_URL
        ?? dependencies.env?.ANBO_K8_DEMO_API_URL
        ?? DEFAULT_PREVIEW_API_URL, "Preview API URL");
}
function previewTokenFromArgs(parsed, dependencies, previewUrl) {
    const token = stringFlag(parsed, "token")
        ?? dependencies.env?.ANBO_TOKEN
        ?? dependencies.env?.ANBO_PREVIEW_API_TOKEN
        ?? dependencies.env?.ANBO_DEMO_API_TOKEN
        ?? readPreviewCredential(dependencies, previewUrl)?.token;
    if (token === undefined || token.length === 0) {
        throw new Error(`Demo credentials are required; run ${loginCommandHint(previewUrl)}`);
    }
    return token;
}
function loginCommandHint(previewUrl) {
    return previewUrl === DEFAULT_PREVIEW_API_URL
        ? "anbo login"
        : `anbo login --app-url ${previewUrl}`;
}
function previewSessionIdFromArgs(parsed, dependencies, previewUrl, positionalIndex) {
    return parsed.positional[positionalIndex]
        ?? readPreviewCredential(dependencies, previewUrl)?.activeSessionId
        ?? requiredPositional(parsed, positionalIndex, "preview_session_id");
}
async function waitForPreviewSession(dependencies, previewUrl, token, sessionId, done = (session) => session.ready || session.status === "failed" || session.status === "deleted") {
    const startedAt = Date.now();
    const deadline = startedAt + 300_000;
    let latest;
    while (Date.now() < deadline) {
        latest = await previewApiRequest(dependencies, previewUrl, "GET", `/v1/demo/sessions/${encodeURIComponent(sessionId)}`, undefined, token);
        if (done(latest)) {
            return latest;
        }
        writeOut(dependencies, `waiting preview: session_id=${latest.id} env_id=${latest.env_id} status=${latest.status} state=${latest.state ?? "unknown"}`);
        await sleep(2000);
    }
    throw new Error(`timed out waiting for preview session ${sessionId}; latest status was ${latest?.status ?? "unknown"}`);
}
async function previewApiRequest(dependencies, previewUrl, method, path, body, token) {
    const response = await previewApiRequestOrError(dependencies, previewUrl, method, path, body, token);
    if (!response.ok) {
        throw new Error(`${method} ${path} failed ${response.status}: ${response.message}`);
    }
    return response.body;
}
async function previewApiRequestOrError(dependencies, previewUrl, method, path, body, token) {
    const headers = {
        accept: "application/json"
    };
    if (body !== undefined) {
        headers["content-type"] = "application/json";
    }
    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const response = await fetchImpl(`${previewUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let parsed = {};
    if (text.length > 0) {
        try {
            parsed = JSON.parse(text);
        }
        catch {
            return {
                ok: false,
                status: response.status,
                message: text.replace(/\s+/g, " ").trim().slice(0, 500) || `non-JSON response from ${previewUrl}${path}`
            };
        }
    }
    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            message: errorMessageFromBody(parsed, text)
        };
    }
    return { ok: true, body: parsed };
}
function envApiClient(config, parsed, dependencies) {
    const apiUrl = apiBaseUrlFromUrl(stringFlag(parsed, "api-url")
        ?? dependencies.env?.ANBO_ENV_API_URL
        ?? dependencies.env?.ANBO_K8S_ENV_API_URL
        ?? config.apiUrl, "Env API URL");
    const token = stringFlag(parsed, "token")
        ?? dependencies.env?.ANBO_ENV_API_TOKEN
        ?? dependencies.env?.ANBO_K8S_ENV_API_TOKEN
        ?? readCredential(dependencies, apiUrl);
    if (token === undefined || token.length === 0) {
        throw new Error("Env API token is required; set ANBO_ENV_API_TOKEN or run anbo setup --token <token>");
    }
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    return {
        async request(method, path, body) {
            const response = await fetchImpl(`${apiUrl}${path}`, {
                method,
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${token}`
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
            const text = await response.text();
            if (!response.ok) {
                throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 500)}`);
            }
            return (text.length === 0 ? {} : JSON.parse(text));
        }
    };
}
async function waitForEnvState(client, envId, timeoutSeconds, pollIntervalMs, done, onProgress) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1000;
    let latest;
    while (Date.now() < deadline) {
        latest = await client.request("GET", `/envs/${encodeURIComponent(envId)}`);
        if (done(latest.state)) {
            return latest;
        }
        onProgress?.(latest, Date.now() - startedAt);
        await sleep(pollIntervalMs);
    }
    throw new Error(`timed out waiting for ${envId}; latest state was ${latest?.state ?? "unknown"}`);
}
async function waitForTestRunState(client, envId, runId, timeoutSeconds, pollIntervalMs, done, onProgress) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1000;
    let latest;
    while (Date.now() < deadline) {
        latest = await client.request("GET", `/envs/${encodeURIComponent(envId)}/test-runs/${encodeURIComponent(runId)}`);
        if (done(latest.status)) {
            return latest;
        }
        onProgress?.(latest, Date.now() - startedAt);
        await sleep(pollIntervalMs);
    }
    throw new Error(`timed out waiting for test-run ${runId} in ${envId}; latest status was ${latest?.status ?? "unknown"}`);
}
function readRepoConfig(dependencies) {
    const cwd = dependencies.cwd ?? process.cwd();
    const path = resolve(cwd, CONFIG_PATH);
    if (!existsSync(path)) {
        throw new Error(`${CONFIG_PATH} not found; run anbo setup first`);
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return assertRepoConfig(parsed);
}
function readCredentials(dependencies) {
    const path = credentialsPath(dependencies);
    if (!existsSync(path)) {
        return { version: 1, endpoints: {} };
    }
    return assertCredentials(JSON.parse(readFileSync(path, "utf8")));
}
function writeCredentials(dependencies, credentials) {
    const path = credentialsPath(dependencies);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        throw new Error(`refusing to write Anbo credentials through a symlink: ${path}`);
    }
    writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}
function writeRepoConfig(cwd, config) {
    const path = resolve(cwd, CONFIG_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
function readCredential(dependencies, apiUrl) {
    const credentials = readCredentials(dependencies);
    return credentials.endpoints[apiUrl]?.token;
}
function writeCredential(dependencies, apiUrl, token) {
    const existing = readCredentials(dependencies);
    existing.endpoints[apiUrl] = { token };
    writeCredentials(dependencies, existing);
}
function readPreviewCredential(dependencies, previewUrl) {
    const credentials = readCredentials(dependencies);
    return credentials.previewEndpoints?.[previewUrl] ?? credentials.demoEndpoints?.[previewUrl];
}
function writePreviewCredential(dependencies, previewUrl, token) {
    const credentials = readCredentials(dependencies);
    const existing = credentials.previewEndpoints?.[previewUrl] ?? credentials.demoEndpoints?.[previewUrl];
    credentials.previewEndpoints ??= {};
    credentials.previewEndpoints[previewUrl] = {
        token,
        ...(existing?.activeSessionId === undefined ? {} : { activeSessionId: existing.activeSessionId })
    };
    writeCredentials(dependencies, credentials);
}
function writeActivePreviewSession(dependencies, previewUrl, sessionId) {
    const credentials = readCredentials(dependencies);
    credentials.previewEndpoints ??= {};
    const existing = credentials.previewEndpoints[previewUrl] ?? credentials.demoEndpoints?.[previewUrl];
    if (existing === undefined) {
        return;
    }
    credentials.previewEndpoints[previewUrl] = { ...existing, activeSessionId: sessionId };
    writeCredentials(dependencies, credentials);
}
function clearActivePreviewSession(dependencies, previewUrl, sessionId) {
    const credentials = readCredentials(dependencies);
    const existing = credentials.previewEndpoints?.[previewUrl] ?? credentials.demoEndpoints?.[previewUrl];
    if (existing === undefined || existing.activeSessionId !== sessionId) {
        return;
    }
    delete existing.activeSessionId;
    if (credentials.previewEndpoints?.[previewUrl] !== undefined) {
        delete credentials.previewEndpoints[previewUrl].activeSessionId;
    }
    if (credentials.demoEndpoints?.[previewUrl] !== undefined) {
        delete credentials.demoEndpoints[previewUrl].activeSessionId;
    }
    writeCredentials(dependencies, credentials);
}
function deletePreviewCredential(dependencies, previewUrl) {
    const credentials = readCredentials(dependencies);
    if (credentials.previewEndpoints !== undefined) {
        delete credentials.previewEndpoints[previewUrl];
    }
    if (credentials.demoEndpoints !== undefined) {
        delete credentials.demoEndpoints[previewUrl];
    }
    writeCredentials(dependencies, credentials);
}
function credentialsPath(dependencies) {
    const env = dependencies.env ?? process.env;
    if ((dependencies.platform ?? process.platform) === "win32") {
        const windowsConfigRoot = env.APPDATA?.trim() || env.LOCALAPPDATA?.trim() || env.USERPROFILE?.trim();
        if (windowsConfigRoot) {
            return join(windowsConfigRoot, "anbo", "credentials.json");
        }
    }
    const homeDir = dependencies.homeDir ?? env.HOME;
    if (homeDir === undefined || homeDir.trim().length === 0) {
        throw new Error("Cannot determine Anbo credentials directory; set HOME or pass a platform config directory");
    }
    return join(homeDir, ".config", "anbo", "credentials.json");
}
function assertRepoConfig(value) {
    if (!isRecord(value) || value["version"] !== 1) {
        throw new Error(`${CONFIG_PATH} must contain an Anbo CLI config with version 1`);
    }
    const config = value;
    for (const key of ["apiUrl", "project", "source", "routeBaseUrl"]) {
        if (typeof config[key] !== "string" || config[key].length === 0) {
            throw new Error(`${CONFIG_PATH} is missing ${key}`);
        }
    }
    if (!isRecord(config.repo) || typeof config.repo["name"] !== "string" || config.repo["name"].length === 0) {
        throw new Error(`${CONFIG_PATH} is missing repo.name`);
    }
    if (!isRecord(config.s3)) {
        throw new Error(`${CONFIG_PATH} is missing s3 config`);
    }
    if (!isRecord(config.defaults)) {
        throw new Error(`${CONFIG_PATH} is missing defaults`);
    }
    return value;
}
function assertCredentials(value) {
    if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["endpoints"])) {
        throw new Error(`${credentialsPath({})} must contain Anbo CLI credentials with version 1`);
    }
    return value;
}
async function requiredSetupValue(parsed, dependencies, flag, label, fallback) {
    const value = stringFlag(parsed, flag) ?? fallback;
    if (value !== undefined && value.length > 0) {
        return value;
    }
    if (dependencies.prompt !== undefined) {
        const prompted = await dependencies.prompt(label);
        if (prompted.trim().length > 0) {
            return prompted.trim();
        }
    }
    if (process.stdin.isTTY && process.stdout.isTTY) {
        const { createInterface } = await import("node:readline/promises");
        const readline = createInterface({
            input: process.stdin,
            output: process.stdout
        });
        try {
            const prompted = await readline.question(`${label}: `);
            if (prompted.trim().length > 0) {
                return prompted.trim();
            }
        }
        finally {
            readline.close();
        }
    }
    throw new Error(`--${flag} is required for anbo setup`);
}
function parseArgs(args) {
    const separator = args.indexOf("--");
    const before = separator === -1 ? args : args.slice(0, separator);
    const afterDoubleDash = separator === -1 ? [] : args.slice(separator + 1);
    const [command, ...rest] = before;
    const positional = [];
    const flags = {};
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === undefined) {
            continue;
        }
        if (!arg.startsWith("--")) {
            positional.push(arg);
            continue;
        }
        const raw = arg.slice(2);
        if (raw.includes("=")) {
            const [key, value] = raw.split(/=(.*)/s, 2);
            if (key !== undefined && key.length > 0) {
                flags[key] = value ?? "";
            }
            continue;
        }
        const next = rest[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
            flags[raw] = next;
            index += 1;
        }
        else {
            flags[raw] = true;
        }
    }
    return {
        ...(command === undefined ? {} : { command }),
        positional,
        flags,
        afterDoubleDash
    };
}
function withoutFirstPositional(parsed) {
    return {
        ...parsed,
        positional: parsed.positional.slice(1)
    };
}
function detectRepo(cwd) {
    const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 3000
    });
    const root = rootResult.status === 0 ? rootResult.stdout.trim() : cwd;
    const remoteResult = spawnSync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 3000
    });
    const remoteUrl = remoteResult.status === 0 ? remoteResult.stdout.trim() : undefined;
    return {
        name: safeSegment(basename(root), "repo"),
        ...(remoteUrl === undefined || remoteUrl.length === 0 ? {} : { remoteUrl })
    };
}
function defaultEnvId(project, sha) {
    const candidate = `env-${safeSegment(project, "project")}-${safeSegment(sha, "sha")}`;
    if (candidate.length <= 54 && /^env-[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/.test(candidate)) {
        return candidate;
    }
    return `env-${safeSegment(project, "project").slice(0, 24)}-${hashText(`${project}:${sha}`).slice(0, 12)}`;
}
function normalizeS3Prefix(value) {
    const normalized = value.replace(/^\/+/, "");
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
}
function requiredFlag(parsed, name) {
    const value = stringFlag(parsed, name);
    if (value === undefined || value.length === 0) {
        throw new Error(`--${name} is required`);
    }
    return value;
}
function requiredPositional(parsed, index, label) {
    const value = parsed.positional[index];
    if (value === undefined || value.length === 0) {
        throw new Error(`${label} is required`);
    }
    return value;
}
function stringFlag(parsed, name) {
    const value = parsed.flags[name];
    return typeof value === "string" ? value : undefined;
}
function boolFlag(parsed, name) {
    return parsed.flags[name] === true || parsed.flags[name] === "true";
}
function positiveIntFlag(parsed, name, fallback) {
    const raw = stringFlag(parsed, name);
    if (raw === undefined) {
        return fallback;
    }
    return positiveIntFromRaw(raw, name);
}
function positiveIntFromRaw(raw, name) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--${name} must be a positive integer`);
    }
    return value;
}
function allocationFromFlag(value) {
    if (!VALID_ALLOCATIONS.has(value)) {
        throw new Error(`allocation must be one of ${Array.from(VALID_ALLOCATIONS).join(", ")}`);
    }
    return value;
}
function testTypeFromFlag(value) {
    if (!VALID_TEST_TYPES.has(value)) {
        throw new Error(`--type must be one of ${Array.from(VALID_TEST_TYPES).join(", ")}`);
    }
    return value;
}
function commandFromFlag(parsed) {
    const command = stringFlag(parsed, "command");
    if (command === undefined || command.length === 0) {
        throw new Error("test command is required after --, for example: anbo test env-id --image repo/app:tag -- npm test");
    }
    return command.split(" ").filter((part) => part.length > 0);
}
function printEnvironmentSummary(dependencies, summary, json) {
    if (json) {
        writeOut(dependencies, JSON.stringify(summary, null, 2));
        return;
    }
    writeOut(dependencies, `env_id: ${summary.envId}`);
    writeOut(dependencies, `state: ${summary.state}`);
    const readyDuration = readyForFirstTestDuration(summary);
    if (readyDuration !== undefined) {
        writeOut(dependencies, `ready_for_first_test: ${readyDuration}`);
    }
    if (summary.previewUrl !== undefined) {
        writeOut(dependencies, `preview_url: ${summary.previewUrl}`);
    }
    if (summary.branch?.allocation !== undefined) {
        writeOut(dependencies, `allocation: ${summary.branch.allocation}`);
    }
    if (summary.branch?.baseSnapshot !== undefined) {
        writeOut(dependencies, `base_snapshot: ${summary.branch.baseSnapshot}`);
    }
}
function printTestRunSummary(dependencies, summary, json) {
    if (json) {
        writeOut(dependencies, JSON.stringify(redactJsonSecrets(summary), null, 2));
        return;
    }
    writeOut(dependencies, `env_id: ${summary.envId}`);
    writeOut(dependencies, `run_id: ${summary.runId}`);
    writeOut(dependencies, `status: ${summary.status}`);
    writeOut(dependencies, `execution: ${summary.execution}`);
    const duration = testRunDuration(summary);
    if (duration !== undefined) {
        writeOut(dependencies, `duration: ${duration}`);
    }
    if (summary.jobs !== undefined && summary.jobs.length > 0) {
        writeOut(dependencies, `jobs: ${summary.jobs.map((job) => `${job.name}=${job.status}`).join(", ")}`);
    }
    else if (summary.jobNames !== undefined && summary.jobNames.length > 0) {
        writeOut(dependencies, `jobs: ${summary.jobNames.join(", ")}`);
    }
    if (summary.failedJob !== undefined) {
        writeOut(dependencies, `failed_job: ${summary.failedJob}`);
    }
    if (summary.reason !== undefined) {
        writeOut(dependencies, `reason: ${summary.reason}`);
    }
    if (summary.message !== undefined) {
        writeOut(dependencies, `message: ${summary.message}`);
    }
    if (summary.external?.databaseUrlSecretRef !== undefined) {
        writeOut(dependencies, `database_url_secret: ${summary.external.databaseUrlSecretRef}`);
    }
    if (summary.logTail !== undefined && summary.logTail.length > 0) {
        writeOut(dependencies, "log_tail:");
        for (const line of summary.logTail.slice(-20)) {
            writeOut(dependencies, `  ${redactSensitiveText(line)}`);
        }
    }
}
function printTestRunLogs(dependencies, logs, json) {
    if (json) {
        writeOut(dependencies, JSON.stringify(redactJsonSecrets(logs), null, 2));
        return;
    }
    writeOut(dependencies, `env_id: ${logs.envId}`);
    writeOut(dependencies, `run_id: ${logs.runId}`);
    writeOut(dependencies, `status: ${logs.status}`);
    for (const entry of logs.entries) {
        const pod = entry.podName === undefined ? "" : ` pod=${entry.podName}`;
        const container = entry.container === undefined ? "" : ` container=${entry.container}`;
        writeOut(dependencies, `--- job=${entry.jobName}${pod}${container}`);
        for (const line of entry.text.split(/\r?\n/)) {
            writeOut(dependencies, redactSensitiveText(line));
        }
    }
}
function printPreviewSession(dependencies, session, json, showSecrets = false) {
    if (json) {
        writeOut(dependencies, JSON.stringify(showSecrets ? session : redactJsonSecrets(session), null, 2));
        return;
    }
    writeOut(dependencies, `session_id: ${session.id}`);
    writeOut(dependencies, `env_id: ${session.env_id}`);
    writeOut(dependencies, `status: ${session.status}`);
    writeOut(dependencies, `state: ${session.state ?? "n/a"}`);
    writeOut(dependencies, `ready: ${session.ready ? "true" : "false"}`);
    if (session.preview_url !== null) {
        writeOut(dependencies, `preview_url: ${session.preview_url}`);
    }
    if (session.database_url !== null) {
        writeOut(dependencies, showSecrets ? `database_url: ${session.database_url}` : "database_url: [redacted; use anbo branch url NAME]");
    }
    if (session.message !== null) {
        writeOut(dependencies, `message: ${session.message}`);
    }
}
function printDemoBranch(dependencies, branch, json, showSecrets = false) {
    if (json) {
        writeOut(dependencies, JSON.stringify(showSecrets ? branch : redactJsonSecrets(branch), null, 2));
        return;
    }
    writeOut(dependencies, `branch_id: ${branch.id}`);
    writeOut(dependencies, `name: ${branch.name}`);
    writeOut(dependencies, `status: ${branch.status}`);
    writeOut(dependencies, `ready: ${branch.ready ? "true" : "false"}`);
    if (branch.database_url !== null) {
        writeOut(dependencies, showSecrets ? `database_url: ${branch.database_url}` : "database_url: [redacted; use anbo branch url NAME]");
    }
}
function printDemoBranchList(dependencies, result, json, showSecrets = false) {
    if (json) {
        writeOut(dependencies, JSON.stringify(showSecrets ? result : redactJsonSecrets(result), null, 2));
        return;
    }
    if (result.branches.length === 0) {
        writeOut(dependencies, "no branches");
        return;
    }
    for (const branch of result.branches) {
        const url = branch.database_url === null ? "" : showSecrets ? ` database_url=${branch.database_url}` : " database_url=[redacted]";
        writeOut(dependencies, `${branch.name} branch_id=${branch.id} status=${branch.status}${url}`);
    }
}
function printPreviewSqlResult(dependencies, result, json) {
    if (json) {
        writeOut(dependencies, JSON.stringify(result, null, 2));
        return;
    }
    writeOut(dependencies, `request_id: ${result.request_id ?? "n/a"}`);
    writeOut(dependencies, `row_count: ${result.rowCount ?? result.row_count ?? 0}`);
    writeOut(dependencies, `truncated: ${result.truncated === true ? "true" : "false"}`);
    if (Array.isArray(result.rows) && result.rows.length > 0) {
        writeOut(dependencies, "rows:");
        for (const row of result.rows) {
            writeOut(dependencies, `  ${JSON.stringify(row)}`);
        }
    }
}
function envWaitProgressReporter(dependencies) {
    let lastKey;
    let lastPrintedElapsedMs = -WAIT_PROGRESS_INTERVAL_MS;
    return (summary, elapsedMs) => {
        const key = [
            summary.state,
            summary.message ?? "",
            summary.branch?.allocation ?? "",
            summary.branch?.poolMissReason ?? "",
            summary.branch?.baseSnapshot ?? ""
        ].join("|");
        if (key === lastKey && elapsedMs - lastPrintedElapsedMs < WAIT_PROGRESS_INTERVAL_MS) {
            return;
        }
        lastKey = key;
        lastPrintedElapsedMs = elapsedMs;
        const parts = [
            `waiting env: env_id=${summary.envId}`,
            `state=${summary.state}`,
            `elapsed=${formatDurationMs(elapsedMs)}`
        ];
        if (summary.branch?.allocation !== undefined) {
            parts.push(`allocation=${summary.branch.allocation}`);
        }
        if (summary.branch?.baseSnapshot !== undefined) {
            parts.push(`base_snapshot=${summary.branch.baseSnapshot}`);
        }
        if (summary.branch?.poolMissReason !== undefined) {
            parts.push(`pool=${summary.branch.poolMissReason}`);
        }
        if (summary.message !== undefined) {
            parts.push(`message=${summary.message}`);
        }
        writeOut(dependencies, parts.join(" "));
    };
}
function testRunWaitProgressReporter(dependencies) {
    let lastKey;
    let lastPrintedElapsedMs = -WAIT_PROGRESS_INTERVAL_MS;
    return (summary, elapsedMs) => {
        const jobStatus = summary.jobs?.map((job) => `${job.name}=${job.status}`).join(",")
            ?? summary.jobNames?.join(",")
            ?? "";
        const key = [
            summary.status,
            summary.failedJob ?? "",
            summary.reason ?? "",
            summary.message ?? "",
            jobStatus
        ].join("|");
        if (key === lastKey && elapsedMs - lastPrintedElapsedMs < WAIT_PROGRESS_INTERVAL_MS) {
            return;
        }
        lastKey = key;
        lastPrintedElapsedMs = elapsedMs;
        const parts = [
            `waiting test-run: env_id=${summary.envId}`,
            `run_id=${summary.runId}`,
            `status=${summary.status}`,
            `elapsed=${formatDurationMs(elapsedMs)}`
        ];
        if (jobStatus.length > 0) {
            parts.push(`jobs=${jobStatus}`);
        }
        if (summary.failedJob !== undefined) {
            parts.push(`failed_job=${summary.failedJob}`);
        }
        if (summary.reason !== undefined) {
            parts.push(`reason=${summary.reason}`);
        }
        writeOut(dependencies, parts.join(" "));
    };
}
function withTail(logs, tail) {
    if (tail === undefined) {
        return logs;
    }
    return {
        ...logs,
        entries: logs.entries.map((entry) => ({
            ...entry,
            text: entry.text.split(/\r?\n/).slice(-tail).join("\n")
        }))
    };
}
function testRunFailureMessage(summary) {
    const parts = [`test-run ${summary.runId} in ${summary.envId} ended ${summary.status}`];
    if (summary.failedJob !== undefined) {
        parts.push(`failed_job=${summary.failedJob}`);
    }
    if (summary.reason !== undefined) {
        parts.push(`reason=${summary.reason}`);
    }
    return parts.join("; ");
}
function testRunDuration(summary) {
    if (summary.durationMs !== undefined) {
        return formatDurationMs(summary.durationMs);
    }
    const start = summary.startedAt ?? summary.createdAt;
    const end = summary.endedAt;
    if (start === undefined || end === undefined) {
        return undefined;
    }
    const durationMs = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return undefined;
    }
    return formatDurationMs(durationMs);
}
function formatDurationMs(durationMs) {
    return `${(durationMs / 1000).toFixed(1)}s`;
}
function readyForFirstTestDuration(summary) {
    const start = summary.timings?.sourceCheckStartedAt ?? summary.timings?.branchRequestedAt;
    const end = summary.timings?.readyForFirstTestAt ?? summary.branch?.readyAt;
    if (start === undefined || end === undefined) {
        return undefined;
    }
    const durationMs = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return undefined;
    }
    return `${(durationMs / 1000).toFixed(1)}s`;
}
function printHelp(dependencies) {
    writeOut(dependencies, [
        "Usage:",
        "  anbo version [--json]",
        "  anbo login [--no-browser] [--app-url URL]",
        "  anbo logout [--app-url URL]",
        "  anbo setup --demo [--app-url URL] [--demo-url URL]",
        "  anbo branch create NAME [--json] [--no-wait]",
        "  anbo branch info NAME [--json]",
        "  anbo branch url NAME",
        "  anbo branch list [--json]",
        "  anbo branch delete NAME [--json]",
        "  anbo token create",
        "  anbo report BRANCH_NAME [--out FILE]",
        "  anbo setup --api-url URL --project NAME --source SOURCE --route-base-url URL --base-bucket BUCKET --base-prefix PREFIX --overlay-bucket BUCKET [--token TOKEN]",
        "  anbo create --image IMAGE --sha SHA [--fresh|--pool-preferred] [--no-wait]",
        "  anbo status ENV_ID",
        "  anbo test ENV_ID --image IMAGE [--type migration|smoke|test|ci] [--shards N] [--wait] -- COMMAND...",
        "  anbo test-status ENV_ID RUN_ID",
        "  anbo logs ENV_ID --test-run RUN_ID [--tail N]",
        "  anbo report ENV_ID --test-run RUN_ID --out FILE",
        "  anbo destroy ENV_ID [--wait]"
    ].join("\n"));
}
function printVersion(parsed, dependencies) {
    const version = readCliVersion();
    if (boolFlag(parsed, "json")) {
        writeOut(dependencies, JSON.stringify({ name: "anbo", version }, null, 2));
        return;
    }
    writeOut(dependencies, version);
}
function readCliVersion() {
    const here = dirname(fileURLToPath(import.meta.url));
    const packageJsonPaths = [
        resolve(here, "../package.json"),
        resolve(here, "../../package.json"),
        resolve(process.cwd(), "package.json")
    ];
    for (const packageJsonPath of packageJsonPaths) {
        try {
            const value = JSON.parse(readFileSync(packageJsonPath, "utf8"));
            if (typeof value["version"] === "string" && value["version"].length > 0) {
                return value["version"];
            }
        }
        catch {
            // Try the next likely package root.
        }
    }
    return CLI_VERSION_FALLBACK;
}
function safeSegment(value, fallback) {
    const segment = value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return segment.length === 0 ? fallback : segment;
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function redactJsonSecrets(value) {
    if (typeof value === "string") {
        return redactSensitiveText(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactJsonSecrets(item));
    }
    if (isRecord(value)) {
        const redacted = {};
        for (const [key, entry] of Object.entries(value)) {
            const normalizedKey = key.toLowerCase();
            if (normalizedKey === "database_url" || normalizedKey.includes("authorization") || normalizedKey.endsWith("token") || normalizedKey.includes("password") || normalizedKey.includes("secret")) {
                redacted[key] = entry === null || entry === undefined ? entry : "[redacted]";
            }
            else {
                redacted[key] = redactJsonSecrets(entry);
            }
        }
        return redacted;
    }
    return value;
}
function redactSensitiveText(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]")
        .replace(/\banbo_[A-Za-z0-9._-]+\b/g, "anbo_[redacted]")
        .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgres://[redacted]")
        .replace(/(database_url=)[^\s]+/gi, "$1[redacted]");
}
function writeOut(dependencies, line) {
    (dependencies.stdout ?? console.log)(line);
}
function writeErr(dependencies, line) {
    (dependencies.stderr ?? console.error)(line);
}
function sleep(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function sleepFor(dependencies, ms) {
    return dependencies.sleep?.(ms) ?? sleep(ms);
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function errorMessageFromBody(body, fallback) {
    if (isRecord(body)) {
        const error = body["error"];
        if (typeof error === "string") {
            return error;
        }
        if (isRecord(error) && typeof error["message"] === "string") {
            return error["message"];
        }
    }
    return fallback.slice(0, 500);
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
    runAnboCli(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }).catch((error) => {
        console.error(redactSensitiveText(getErrorMessage(error)));
        process.exitCode = 1;
    });
}
