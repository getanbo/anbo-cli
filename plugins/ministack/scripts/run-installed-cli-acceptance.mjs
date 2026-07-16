import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cliTarball = process.env.ANBO_CLI_TARBALL;
if (!cliTarball) throw new Error("ANBO_CLI_TARBALL must point to a packed canonical CLI artifact");
const sdkTarball = process.env.ANBO_SDK_TARBALL;

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

function run(args, options = {}) {
  const result = spawnSync(join(temporary, "node_modules", ".bin", "anbo"), args, {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, XDG_STATE_HOME: join(temporary, "state"), XDG_CACHE_HOME: join(temporary, "cache") },
    ...options,
  });
  if (result.status !== 0) throw new Error(`anbo ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
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
  await writeFile(join(project, ".anbo", "project.json"), JSON.stringify({
    apiVersion: "anbo.dev/project/v1",
    defaultTarget: "ministack",
    plugins: {
      ministack: { package: "@getanbo/plugin-ministack", config: { manifest: ".anbo/sandbox.json" } },
    },
  }, null, 2) + "\n");

  const configured = run(["configure", "--target", "ministack", "--output", "jsonl"]);
  for (const line of configured.trim().split("\n")) JSON.parse(line);

  if (process.env.ANBO_ACCEPTANCE_RUNTIME === "1") {
    let runtimeError;
    try {
      const first = run(["deploy", "--target", "ministack", "--output", "jsonl"]);
      const second = run(["deploy", "--target", "ministack", "--no-test", "--output", "jsonl"]);
      assert.match(first, /"cache_hit":false/);
      assert.match(first, /"server_platform":"linux\/(?:amd64|arm64)"/);
      const arm64Runtime = first.includes('"server_platform":"linux/arm64"');
      if (arm64Runtime) assert.match(first, /"phase":"ministack.compatibility"/);
      else assert.doesNotMatch(first, /"phase":"ministack.compatibility"/);
      const runtimeId = createHash("sha256").update(await realpath(project)).digest("hex").slice(0, 12);
      const inspected = spawnSync("docker", [
        "inspect",
        "--format", "{{json .Config.Env}}",
        `anbo-${runtimeId}-ministack`,
      ], { encoding: "utf8" });
      assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
      const containerEnvironment = JSON.parse(inspected.stdout);
      assert.ok(Array.isArray(containerEnvironment));
      if (arm64Runtime) assert.ok(containerEnvironment.includes("OPENSSL_armcap=0"));
      else assert.equal(containerEnvironment.includes("OPENSSL_armcap=0"), false);
      assert.match(first, /"name":"kms.generate-data-key"/);
      assert.match(first, /"name":"kms.encrypt-decrypt"/);
      assert.match(second, /"cache_hit":true/);
      if (arm64Runtime) assert.match(second, /"workaround":"openssl-armcap-zero-v1".*"cache_hit":true/);
      else assert.doesNotMatch(second, /"workaround":"openssl-armcap-zero-v1"/);
      assert.doesNotMatch(second, /"kind":"test.assertion"/);
      run(["status", "--target", "ministack", "--output", "jsonl"]);
      const test = run(["test", "--target", "ministack", "--output", "jsonl"]);
      assert.match(test, /"name":"kms.encrypt-decrypt"/);
      run(["debug", "--target", "ministack", "--output", "jsonl"]);
    } catch (error) {
      runtimeError = error;
      throw error;
    } finally {
      try {
        run(["down", "--target", "ministack", "--purge", "--output", "jsonl"]);
      } catch (cleanupError) {
        if (runtimeError === undefined) throw cleanupError;
      }
    }
    run(["cache", "prune", "--target", "ministack", "--output", "jsonl"]);
  }
} finally {
  await rm(pluginTarball, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
