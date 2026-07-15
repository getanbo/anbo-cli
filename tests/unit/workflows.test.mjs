import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ecosystem npm installs use unambiguous candidate tarball paths", async () => {
  const workflow = await readFile(".github/workflows/ecosystem-acceptance.yml", "utf8");
  const installLines = workflow.split(/\r?\n/u).filter((line) => line.includes("npm install"));
  const artifactInstalls = installLines.filter((line) => line.includes("artifacts/"));

  assert.equal(artifactInstalls.length, 3);
  for (const line of artifactInstalls) {
    assert.match(line, /"\$GITHUB_WORKSPACE"\/artifacts\//u);
    assert.doesNotMatch(line, /(?:^|\s)artifacts\//u);
  }
});
