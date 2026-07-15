import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../../packages/cli/dist/index.js";

test("JSONL output is pure and has one terminal event", async () => {
  let output = "";
  const exitCode = await runCli(["version", "--output", "jsonl"], {
    stdout: (chunk) => (output += chunk),
  });
  assert.equal(exitCode, 0);
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events.filter((event) => event.type === "run.finished").length, 1);
  assert.equal(events.at(-1).data.exitCode, 0);
});
