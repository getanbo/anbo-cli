import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const digest = process.env.ANBO_MINISTACK_DIGEST;
const upstreamSha = process.env.ANBO_MINISTACK_UPSTREAM_SHA;
const version = process.env.ANBO_MINISTACK_VERSION;
assert.match(digest ?? "", /^sha256:[a-f0-9]{64}$/);
assert.match(upstreamSha ?? "", /^[a-f0-9]{40}$/);
assert.match(version ?? "", /^\d+\.\d+\.\d+$/);

const runtimeUrl = new URL("../runtime-manifest.json", import.meta.url);
const runtime = JSON.parse(await readFile(runtimeUrl, "utf8"));
const platforms = process.env.ANBO_MINISTACK_PLATFORMS === undefined
  ? runtime.platforms
  : process.env.ANBO_MINISTACK_PLATFORMS.split(",").map((value) => value.trim()).filter(Boolean);
assert.deepEqual(
  [...new Set(platforms)].sort(),
  ["linux/amd64", "linux/arm64"],
  "the certified index must publish native amd64 and arm64 images",
);
runtime.source = "ministackorg/ministack";
runtime.upstream.version = version;
runtime.upstream.commit = upstreamSha;
delete runtime.downstream;
runtime.certified_image = `ministackorg/ministack@${digest}`;
runtime.digest = digest;
runtime.platforms = ["linux/amd64", "linux/arm64"];
runtime.compatibility = {
  "linux/arm64": {
    id: "openssl-armcap-zero-v1",
    environment: { OPENSSL_armcap: "0" },
    certification: "native-full-ed25519-asyncssh-kms-v1",
  },
};
await writeFile(runtimeUrl, `${JSON.stringify(runtime, null, 2)}\n`);

const fixtureUrl = new URL("../fixtures/terraform-smoke/.anbo/sandbox.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
fixture.ministack.image = runtime.certified_image;
fixture.ministack.digest = digest;
await writeFile(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);
