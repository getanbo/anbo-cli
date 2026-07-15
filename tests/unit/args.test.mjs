import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../../packages/cli/dist/args.js";

test("sandbox up aliases deploy without losing machine options", () => {
  const parsed = parseCliArgs(["sandbox", "up", "--output", "jsonl", "--no-test"]);
  assert.equal(parsed.command, "deploy");
  assert.equal(parsed.target, "ministack");
  assert.equal(parsed.output, "jsonl");
  assert.equal(parsed.flags.test, false);
});

test("plugin child command boundary remains explicit", () => {
  const parsed = parseCliArgs(["test", "smoke", "--", "npm", "test"]);
  assert.deepEqual(parsed.positionals, ["smoke", "--", "npm", "test"]);
  assert.deepEqual(parsed.passthrough, ["npm", "test"]);
});

test("known boolean flags do not consume a following positional", () => {
  const parsed = parseCliArgs(["logs", "--follow", "api"]);
  assert.equal(parsed.flags.follow, true);
  assert.deepEqual(parsed.positionals, ["api"]);
});
