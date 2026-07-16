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
assert.equal(runtime.source, "ministackorg/ministack");
assert.match(runtime.digest, /^sha256:[a-f0-9]{64}$/);
assert.deepEqual(runtime.platforms, ["linux/amd64", "linux/arm64"]);
assert.deepEqual(runtime.compatibility, {
  "linux/arm64": {
    id: "openssl-armcap-zero-v1",
    environment: { OPENSSL_armcap: "0" },
    certification: "native-full-ed25519-asyncssh-kms-v1",
  },
});
assert.equal(runtime.certified_image, `ministackorg/ministack@${runtime.digest}`);
assert.match(runtime.upstream.commit, /^[a-f0-9]{40}$/);
assert.match(runtime.upstream.version, /^\d+\.\d+\.\d+$/);
assert.equal("downstream" in runtime, false);
