import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../../packages/cli/dist/process.js";

const trapSigterm = [
  "-e",
  'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1_000)',
];

test("process timeouts escalate to SIGKILL without changing the failure contract", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runProcess(process.execPath, trapSigterm, { timeout_ms: 150 }),
    (error) => error?.code === "ANBO_PROCESS_FAILED",
  );
  assert.ok(Date.now() - startedAt < 2_000, "the timed-out process did not stop within the kill grace");
});

test("process cancellation escalates to SIGKILL and preserves allow_failure results", async () => {
  const controller = new AbortController();
  let cancelledAt;
  const result = await runProcess(process.execPath, trapSigterm, {
    allow_failure: true,
    signal: controller.signal,
    on_output: (_stream, chunk) => {
      if (cancelledAt === undefined && chunk.includes("ready")) {
        cancelledAt = Date.now();
        controller.abort();
      }
    },
  });

  assert.ok(cancelledAt !== undefined, "the child never became ready for cancellation");
  assert.ok(Date.now() - cancelledAt < 2_000, "the cancelled process did not stop within the kill grace");
  assert.equal(result.exit_code, 128);
});
