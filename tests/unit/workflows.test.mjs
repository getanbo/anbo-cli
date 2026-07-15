import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("official plugin acceptance packs one commit and installs only exact workspace artifacts", async () => {
  const workflow = await readFile(".github/workflows/ecosystem-acceptance.yml", "utf8");
  const installLines = workflow.split(/\r?\n/u).filter((line) => line.includes("npm install"));
  const artifactInstalls = installLines.filter((line) => line.includes("artifacts/"));

  assert.equal(artifactInstalls.length, 1);
  for (const line of artifactInstalls) {
    assert.match(line, /"\$GITHUB_WORKSPACE"\/artifacts\/\*\.tgz/u);
    assert.doesNotMatch(line, /(?:^|\s)artifacts\//u);
  }
  for (const workspace of [
    "packages/plugin-sdk",
    "packages/plugin-testkit",
    "packages/cli",
    "plugins/ministack",
    "plugins/cloud",
  ]) {
    assert.match(workflow, new RegExp(`npm pack --workspace ${workspace.replace("/", "\\/")}`, "u"));
  }
  assert.doesNotMatch(workflow, /getanbo\/(?:cli|anbo-plugin-ministack|anbo-plugin-cloud)/u);
  assert.match(workflow, /\{"monorepo":"%s"\}\\n.*"\$GITHUB_SHA"/u);
});
