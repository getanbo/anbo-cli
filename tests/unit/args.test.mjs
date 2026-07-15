import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../../packages/cli/dist/args.js";

test("sandbox up aliases deploy without losing machine options", () => {
  const parsed = parseCliArgs(["sandbox", "up", "--output", "jsonl", "--no-test"]);
  assert.equal(parsed.command, "deploy");
  assert.equal(parsed.target, "ministack");
  assert.equal(parsed.output, "jsonl");
  assert.equal(parsed.flags.test, false);
  assert.equal(parsed.flags["no-test"], true);
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

test("reconcile is a boolean deploy flag and preserves following positionals", () => {
  const parsed = parseCliArgs(["deploy", "--reconcile", "smoke"]);
  assert.equal(parsed.flags.reconcile, true);
  assert.deepEqual(parsed.positionals, ["smoke"]);

  const alias = parseCliArgs(["sandbox", "up", "--reconcile"]);
  assert.equal(alias.command, "deploy");
  assert.equal(alias.target, "ministack");
  assert.equal(alias.flags.reconcile, true);
});
