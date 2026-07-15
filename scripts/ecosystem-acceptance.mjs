import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installRoot = requiredEnvironment("ANBO_ECOSYSTEM_INSTALL_ROOT");
const ministackRoot = requiredEnvironment("ANBO_ECOSYSTEM_MINISTACK_ROOT");
const cloudRoot = requiredEnvironment("ANBO_ECOSYSTEM_CLOUD_ROOT");
const diagnosticsRoot = requiredEnvironment("ANBO_ECOSYSTEM_DIAGNOSTICS");
const binary = join(installRoot, "node_modules", ".bin", "anbo");
const testkit = await import(pathToFileURL(
  join(installRoot, "node_modules", "@getanbo", "plugin-testkit", "dist", "index.js"),
).href);
await mkdir(diagnosticsRoot, { recursive: true });

let ministackMayBeRunning = false;
try {
  invoke("plugin-list", ["plugin", "list", "--root", ministackRoot]);
  invoke("ministack-configure", ["configure", "--target", "ministack", "--root", ministackRoot]);
  ministackMayBeRunning = true;
  invoke("ministack-doctor", ["doctor", "--root", ministackRoot]);
  invoke("ministack-deploy-cold", ["deploy", "--root", ministackRoot], 20 * 60_000);
  invoke("ministack-status", ["status", "--root", ministackRoot]);
  invoke("ministack-test", ["test", "--root", ministackRoot], 10 * 60_000);
  invoke("ministack-logs", ["logs", "--root", ministackRoot]);
  invoke("ministack-debug", ["debug", "--root", ministackRoot]);
  invoke("ministack-deploy-warm", ["sandbox", "up", "--root", ministackRoot, "--no-test"], 20 * 60_000);
  invoke("ministack-down", ["down", "--root", ministackRoot, "--purge"], 10 * 60_000);
  ministackMayBeRunning = false;
  invoke("ministack-cache-prune", ["cache", "prune", "--root", ministackRoot]);

  invoke("cloud-configure", [
    "configure",
    "--target", "cloud",
    "--root", cloudRoot,
    "--api-url", "http://127.0.0.1:9",
    "--project", "ecosystem-acceptance",
    "--source", "acceptance-base",
    "--route-base-url", "http://127.0.0.1:9",
    "--base-bucket", "acceptance-base",
    "--base-prefix", "base/",
    "--overlay-bucket", "acceptance-overlay",
  ]);
  invoke("cloud-doctor", ["doctor", "--target", "cloud", "--root", cloudRoot]);
  invoke("cloud-capabilities", ["capabilities", "--target", "cloud", "--root", cloudRoot]);
  process.stdout.write("Cross-repository installed CLI acceptance passed.\n");
} catch (error) {
  if (ministackMayBeRunning) {
    try {
      invoke("ministack-cleanup", ["down", "--root", ministackRoot, "--purge"], 10 * 60_000);
    } catch {
      // Preserve the original failure; cleanup diagnostics are already written.
    }
  }
  throw error;
}

function invoke(label, args, timeout = 5 * 60_000) {
  const machineArgs = [...args, "--output", "jsonl"];
  const result = spawnSync(binary, machineArgs, {
    cwd: installRoot,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = result.stdout ?? "";
  const errors = result.stderr ?? "";
  writeFileSync(resolve(diagnosticsRoot, `${label}.jsonl`), output);
  if (errors) writeFileSync(resolve(diagnosticsRoot, `${label}.stderr.log`), errors);
  assert.equal(result.error, undefined, `${label} process failed: ${String(result.error)}`);
  assert.equal(errors, "", `${label} leaked output to stderr`);
  const events = testkit.parseJsonLines(output);
  testkit.assertEventStream(events);
  assert.equal(result.status, 0, `${label} failed:\n${output}`);
  return events;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}
