import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const DOWNSTREAM_SOURCE = "getanbo/anbo-ministack";
const FULL_IMAGE_REPOSITORY = "ghcr.io/getanbo/anbo-ministack";
const releaseManifestPath = process.env.ANBO_MINISTACK_RELEASE_MANIFEST;
const releaseTag = process.env.ANBO_MINISTACK_RELEASE_TAG;
assert.match(releaseTag ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "ANBO_MINISTACK_RELEASE_TAG must be a release version or tag");
assert.ok(releaseManifestPath, "ANBO_MINISTACK_RELEASE_MANIFEST must name a downloaded release-manifest.json");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const requireObject = (value, name) => {
  assert.ok(isObject(value), `${name} must be an object`);
  return value;
};
const requireSha = (value, name) => {
  assert.match(value ?? "", /^[a-f0-9]{40}$/, `${name} must be a full 40-character commit`);
  return value;
};
const requireVersion = (value, name) => {
  assert.match(value ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${name} must be a version or tag`);
  return value;
};

const release = JSON.parse(await readFile(releaseManifestPath, "utf8"));
assert.equal(release.schemaVersion, 1, "release schemaVersion must be 1");
assert.equal(release.distribution, "Anbo MiniStack", "release distribution must be Anbo MiniStack");
assert.match(release.version ?? "", /^\d+\.\d+\.\d+-anbo\.[1-9]\d*$/, "release version must be X.Y.Z-anbo.N");
assert.ok(
  releaseTag === release.version || releaseTag === `v${release.version}`,
  "downloaded release manifest version must match ANBO_MINISTACK_RELEASE_TAG",
);
const source = requireObject(release.source, "release source");
const upstream = requireObject(release.upstream, "release upstream");
const images = requireObject(release.images, "release images");
const full = requireObject(images.full, "release images.full");
const runtimeCompatibility = requireObject(release.runtimeCompatibility, "release runtimeCompatibility");
const instanceIsolation = requireObject(
  runtimeCompatibility.instanceIsolation,
  "release runtimeCompatibility.instanceIsolation",
);

assert.equal(source.repository, `https://github.com/${DOWNSTREAM_SOURCE}`, "release source repository must be the Anbo MiniStack fork");
const downstreamVersion = requireVersion(release.version, "release version");
const downstreamCommit = requireSha(source.commit, "release source.commit");
assert.equal(upstream.repository, "https://github.com/ministackorg/ministack", "release upstream.repository must identify MiniStack");
assert.match(upstream.ref ?? "", /^v\d+\.\d+\.\d+$/, "release upstream.ref must be a MiniStack release tag");
const upstreamVersion = requireVersion(upstream.ref.replace(/^v/u, ""), "release upstream.ref");
const upstreamCommit = requireSha(upstream.commit, "release upstream.commit");
assert.match(full.digest ?? "", /^sha256:[a-f0-9]{64}$/, "release images.full.digest must be immutable");
assert.equal(
  full.reference,
  `${FULL_IMAGE_REPOSITORY}@${full.digest}`,
  "release images.full.reference must bind the Anbo full image to its digest",
);
assert.equal(full.tag, `${FULL_IMAGE_REPOSITORY}:${release.version}-full`, "release images.full.tag must identify the Anbo full image");
assert.equal(
  instanceIsolation.contractVersion,
  1,
  "release runtimeCompatibility.instanceIsolation must declare contractVersion 1",
);
assert.equal(instanceIsolation.environment, "MINISTACK_INSTANCE_ID");
assert.equal(instanceIsolation.healthField, "instance_isolation");

const runtimeUrl = new URL("../runtime-manifest.json", import.meta.url);
const runtime = JSON.parse(await readFile(runtimeUrl, "utf8"));
runtime.source = DOWNSTREAM_SOURCE;
runtime.downstream = { version: downstreamVersion, commit: downstreamCommit };
runtime.upstream = {
  repository: "ministackorg/ministack",
  version: upstreamVersion,
  commit: upstreamCommit,
};
runtime.certified_image = full.reference;
runtime.digest = full.digest;
runtime.instance_isolation = instanceIsolation;
await writeFile(runtimeUrl, `${JSON.stringify(runtime, null, 2)}\n`);

const fixtureUrl = new URL("../fixtures/terraform-smoke/.anbo/sandbox.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
fixture.ministack.image = full.reference;
fixture.ministack.digest = full.digest;
await writeFile(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);
