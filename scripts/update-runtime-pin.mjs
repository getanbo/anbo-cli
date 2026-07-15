import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const digest = process.env.ANBO_MINISTACK_DIGEST;
const upstreamSha = process.env.ANBO_MINISTACK_UPSTREAM_SHA;
const downstreamSha = process.env.ANBO_MINISTACK_DOWNSTREAM_SHA;
const version = process.env.ANBO_MINISTACK_VERSION;
assert.match(digest ?? "", /^sha256:[a-f0-9]{64}$/);
assert.match(upstreamSha ?? "", /^[a-f0-9]{40}$/);
assert.match(downstreamSha ?? "", /^[a-f0-9]{40}$/);
assert.match(version ?? "", /^\d+\.\d+\.\d+-anbo\.(?:candidate\.)?[A-Za-z0-9._-]+$/);
const upstreamVersion = version.match(/^(\d+\.\d+\.\d+)-anbo\./)?.[1];
assert.ok(upstreamVersion);

const runtimeUrl = new URL("../runtime-manifest.json", import.meta.url);
const runtime = JSON.parse(await readFile(runtimeUrl, "utf8"));
runtime.source = "anbo-ministack";
runtime.upstream.version = upstreamVersion;
runtime.upstream.commit = upstreamSha;
runtime.downstream = {
  repository: "getanbo/anbo-ministack",
  version,
  commit: downstreamSha,
};
runtime.certified_image = `ghcr.io/getanbo/anbo-ministack@${digest}`;
runtime.digest = digest;
await writeFile(runtimeUrl, `${JSON.stringify(runtime, null, 2)}\n`);

const fixtureUrl = new URL("../fixtures/terraform-smoke/.anbo/sandbox.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
fixture.ministack.image = runtime.certified_image;
fixture.ministack.digest = digest;
await writeFile(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);
