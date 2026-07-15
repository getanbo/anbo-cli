import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const workspace = process.argv[2];
if (!workspace) throw new Error("usage: publish-if-missing.mjs <workspace>");
const metadata = JSON.parse(await readFile(`${workspace}/package.json`, "utf8"));
const specifier = `${metadata.name}@${metadata.version}`;
const existing = spawnSync("npm", ["view", specifier, "version", "--json"], { encoding: "utf8" });
if (existing.status === 0) {
  const published = JSON.parse(existing.stdout);
  if (published !== metadata.version) throw new Error(`registry returned an unexpected version for ${specifier}`);
  process.stdout.write(`${specifier} is already published; leaving it unchanged.\n`);
  process.exit(0);
}
const failure = `${existing.stdout}\n${existing.stderr}`;
if (!failure.includes("E404")) {
  throw new Error(`could not determine whether ${specifier} exists:\n${failure}`);
}
const published = spawnSync(
  "npm",
  ["publish", "--workspace", workspace, "--access", "public", "--provenance"],
  { stdio: "inherit" },
);
if (published.status !== 0) process.exit(published.status ?? 1);
