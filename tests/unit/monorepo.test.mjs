import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("the monorepo owns both first-party plugins without coupling them to the CLI binary", async () => {
  const [root, cli, ministack, cloud] = await Promise.all([
    readJson("package.json"),
    readJson("packages/cli/package.json"),
    readJson("plugins/ministack/package.json"),
    readJson("plugins/cloud/package.json"),
  ]);

  assert.deepEqual(root.workspaces, ["packages/*", "plugins/*"]);
  for (const [directory, plugin] of [
    ["plugins/ministack", ministack],
    ["plugins/cloud", cloud],
  ]) {
    assert.equal(plugin.bin, undefined);
    assert.equal(plugin.repository.url, "git+https://github.com/getanbo/anbo-cli.git");
    assert.equal(plugin.repository.directory, directory);
    assert.equal(cli.optionalDependencies[plugin.name], plugin.version);
  }
});
