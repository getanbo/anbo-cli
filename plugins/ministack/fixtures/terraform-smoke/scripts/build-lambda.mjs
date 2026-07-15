import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "infra", "dist", "smoke.zip");
mkdirSync(resolve(output, ".."), { recursive: true });
rmSync(output, { force: true });
const result = spawnSync("zip", ["-q", output, "handler.py"], {
  cwd: resolve(root, "lambda"),
  stdio: "inherit"
});
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`${JSON.stringify({ artifact: output })}\n`);
