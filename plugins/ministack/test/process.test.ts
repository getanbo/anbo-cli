import assert from "node:assert/strict";
import { test } from "node:test";

import { spawnStreaming } from "../src/process.js";

test("streams asynchronous stdout and stderr in bounded chunks", async () => {
  const chunks: Array<{ stream: string; chunk: string }> = [];
  const result = await spawnStreaming(
    process.execPath,
    ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    {
      captureOutput: true,
      onOutput: ({ stream, chunk }) => {
        chunks.push({ stream, chunk });
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.deepEqual(new Set(chunks.map((chunk) => chunk.stream)), new Set(["stdout", "stderr"]));
});

test("cancels a running process through AbortSignal", async () => {
  const controller = new AbortController();
  const running = spawnStreaming(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
    cancelGraceMs: 100,
  });
  setTimeout(() => controller.abort(), 50);

  const result = await running;
  assert.equal(result.cancelled, true);
  assert.notEqual(result.signal, null);
});

test("does not inherit ambient variables when inheritEnv is false", async () => {
  process.env.ANBO_AMBIENT_CANARY = "do-not-inherit";
  try {
    const result = await spawnStreaming(
      process.execPath,
      ["-e", "process.stdout.write(process.env.ANBO_AMBIENT_CANARY || 'clean')"],
      { inheritEnv: false, env: {}, captureOutput: true },
    );
    assert.equal(result.stdout, "clean");
  } finally {
    delete process.env.ANBO_AMBIENT_CANARY;
  }
});
