import assert from "node:assert/strict";
import { access, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    const first = run(["deploy", "--target", "ministack", "--output", "jsonl"]);
    const second = run(["deploy", "--target", "ministack", "--no-test", "--output", "jsonl"]);
    assert.match(first, /"cache_hit":false/);
    assert.match(first, /"kind":"test.assertion"/);
    assert.match(second, /"cache_hit":true/);
    assert.doesNotMatch(second, /"kind":"test.assertion"/);
    run(["status", "--target", "ministack", "--output", "jsonl"]);
    run(["test", "--target", "ministack", "--output", "jsonl"]);
    run(["debug", "--target", "ministack", "--output", "jsonl"]);
    run(["down", "--target", "ministack", "--purge", "--output", "jsonl"]);
    run(["cache", "prune", "--target", "ministack", "--output", "jsonl"]);
  }
} finally {
  await rm(pluginTarball, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
