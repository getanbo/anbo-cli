import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(await readFile(new URL("../anbo.plugin.json", import.meta.url), "utf8"));
const runtime = JSON.parse(await readFile(new URL("../runtime-manifest.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_NAME;
const requested = process.env.RELEASE_VERSION?.replace(/^v/u, "");

if (tag?.startsWith("plugin-ministack-v")) {
  assert.equal(tag, `plugin-ministack-v${pkg.version}`, "release tag must equal package.json version");
}
if (requested) assert.equal(requested, pkg.version, "requested release must match package.json version");
assert.equal(descriptor.version, pkg.version, "descriptor and package versions must match");
assert.equal(runtime.source, "anbo-ministack", "release is blocked until the bootstrap pin is promoted to an Anbo MiniStack candidate");
assert.match(runtime.digest, /^sha256:[a-f0-9]{64}$/);
assert.equal(runtime.certified_image, `ghcr.io/getanbo/anbo-ministack@${runtime.digest}`);
assert.match(runtime.upstream.commit, /^[a-f0-9]{40}$/);
assert.match(runtime.downstream.commit, /^[a-f0-9]{40}$/);
assert.match(runtime.downstream.version, /^\d+\.\d+\.\d+-anbo\.(?:candidate\.)?[A-Za-z0-9._-]+$/);
