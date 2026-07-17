import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(await readFile(new URL("../anbo.plugin.json", import.meta.url), "utf8"));
const runtime = JSON.parse(await readFile(new URL("../runtime-manifest.json", import.meta.url), "utf8"));
const upstreamSource = "ministackorg/ministack";
const downstreamSource = "getanbo/anbo-ministack";
const downstreamImage = "ghcr.io/getanbo/anbo-ministack";

assert.equal(pkg.name, "@getanbo/plugin-ministack");
assert.equal(pkg.bin, undefined, "plugins must not declare an anbo binary");
assert.equal(descriptor.id, "anbo.ministack");
assert.equal(descriptor.version, pkg.version);
assert.equal(descriptor.entrypoint, "./dist/src/plugin.js");
assert.equal(pkg.peerDependencies["@getanbo/plugin-sdk"], ">=0.2.0 <0.3.0");
assert.deepEqual(runtime.platforms, ["linux/amd64", "linux/arm64"]);
assert.equal(runtime.compatibility["linux/arm64"].environment.OPENSSL_armcap, "0");
assert.equal(runtime.compatibility["linux/arm64"].certification, "native-full-ed25519-asyncssh-kms-v1");
if (runtime.source === downstreamSource) {
  assert.equal(runtime.certified_image, `${downstreamImage}@${runtime.digest}`);
  assert.equal(runtime.upstream.repository, upstreamSource);
  assert.match(runtime.downstream?.version, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.match(runtime.downstream?.commit, /^[a-f0-9]{40}$/);
  assert.equal(runtime.instance_isolation?.contractVersion, 1);
  assert.equal(runtime.instance_isolation?.environment, "MINISTACK_INSTANCE_ID");
  assert.equal(runtime.instance_isolation?.healthField, "instance_isolation");
} else {
  // Temporary compatibility for the current upstream pin; promotion makes the
  // downstream branch above mandatory.
  assert.equal(runtime.source, upstreamSource);
  assert.equal(runtime.certified_image, `${upstreamSource}@${runtime.digest}`);
  assert.equal("downstream" in runtime, false);
  assert.equal("instance_isolation" in runtime, false);
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
});
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
const report = JSON.parse(packed.stdout)[0];
const files = new Set(report.files.map((entry) => entry.path));
for (const required of [
  "anbo.plugin.json",
  "dist/src/plugin.js",
  "dist/src/plugin.d.ts",
  "dist/runtime-manifest.json",
  "schemas/plugin-config.v1.schema.json",
  "schemas/sandbox.v2.schema.json",
]) assert.ok(files.has(required), `packed package is missing ${required}`);
assert.equal([...files].some((path) => /(?:^|\/)bin\/anbo(?:\.js)?$/.test(path)), false);
assert.equal([...files].some((path) => path.startsWith("test/") || path.startsWith("fixtures/")), false);
