import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packages = await Promise.all([
  readPackage("packages/cli/package.json"),
  readPackage("packages/plugin-sdk/package.json"),
  readPackage("packages/plugin-testkit/package.json"),
]);
const versions = new Set(packages.map((entry) => entry.version));
assert.equal(versions.size, 1, "all canonical packages must share one release version");
const version = packages[0].version;
const tag = process.env.GITHUB_REF_NAME;
const requestedVersion = process.env.RELEASE_VERSION?.replace(/^v/u, "");
if (tag?.startsWith("v")) assert.equal(tag, `v${version}`, `tag ${tag} must match package version ${version}`);
if (requestedVersion) assert.equal(requestedVersion, version, `requested release must match ${version}`);

const cli = packages.find((entry) => entry.name === "anbo");
for (const packageName of ["@getanbo/plugin-ministack", "@getanbo/plugin-cloud"]) {
  const dependencyVersion = cli.optionalDependencies?.[packageName];
  assert.match(dependencyVersion ?? "", /^\d+\.\d+\.\d+$/u, `${packageName} must be pinned exactly`);
}

async function readPackage(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
