import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const plugin = process.argv[2];
if (!new Set(["ministack", "cloud"]).has(plugin)) {
  throw new Error("usage: check-plugin-version.mjs <ministack|cloud>");
}

const root = `plugins/${plugin}`;
const pkg = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
const descriptor = JSON.parse(await readFile(`${root}/anbo.plugin.json`, "utf8"));
const requested = process.env.RELEASE_VERSION?.replace(/^v/u, "");

assert.ok(requested, "RELEASE_VERSION is required");
assert.equal(pkg.version, requested, "requested release must match package.json");
assert.equal(descriptor.version, pkg.version, "descriptor and package versions must match");
