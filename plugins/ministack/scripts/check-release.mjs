import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(await readFile(new URL("../anbo.plugin.json", import.meta.url), "utf8"));
const runtime = JSON.parse(await readFile(new URL("../runtime-manifest.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_NAME;
const requested = process.env.RELEASE_VERSION?.replace(/^v/u, "");
const upstreamSource = "ministackorg/ministack";
const downstreamSource = "getanbo/anbo-ministack";
const downstreamImage = "ghcr.io/getanbo/anbo-ministack";

const assertCommonRuntime = () => {
  assert.match(runtime.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(runtime.platforms, ["linux/amd64", "linux/arm64"]);
  assert.deepEqual(runtime.compatibility, {
    "linux/arm64": {
      id: "openssl-armcap-zero-v1",
      environment: { OPENSSL_armcap: "0" },
      certification: "native-full-ed25519-asyncssh-kms-v1",
    },
  });
  assert.match(runtime.upstream.commit, /^[a-f0-9]{40}$/);
  assert.match(runtime.upstream.version, /^\d+\.\d+\.\d+$/);
};

if (tag?.startsWith("plugin-ministack-v")) {
  assert.equal(tag, `plugin-ministack-v${pkg.version}`, "release tag must equal package.json version");
}
if (requested) assert.equal(requested, pkg.version, "requested release must match package.json version");
assert.equal(descriptor.version, pkg.version, "descriptor and package versions must match");
assertCommonRuntime();

if (runtime.source === downstreamSource) {
  assert.equal(runtime.certified_image, `${downstreamImage}@${runtime.digest}`);
  assert.equal(runtime.upstream.repository, upstreamSource);
  assert.match(runtime.downstream?.version, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.match(runtime.downstream?.commit, /^[a-f0-9]{40}$/);
  assert.equal(runtime.instance_isolation?.contractVersion, 1);
  assert.equal(runtime.instance_isolation?.environment, "MINISTACK_INSTANCE_ID");
  assert.equal(runtime.instance_isolation?.healthField, "instance_isolation");
} else {
  // Temporary compatibility for the currently committed upstream pin. Remove
  // this branch immediately after the first Anbo MiniStack release is promoted.
  assert.equal(runtime.source, upstreamSource);
  assert.equal(runtime.certified_image, `${upstreamSource}@${runtime.digest}`);
  assert.equal("downstream" in runtime, false);
  assert.equal("instance_isolation" in runtime, false);
}
