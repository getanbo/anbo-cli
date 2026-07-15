#!/usr/bin/env node
import { runCli } from "./cli.js";

const controller = new AbortController();
let interrupted = false;
const cancel = () => {
  if (interrupted) {
    process.exitCode = 130;
    return;
  }
  interrupted = true;
  controller.abort(new Error("interrupted"));
};

process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

const exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
process.exitCode = exitCode;
process.removeListener("SIGINT", cancel);
process.removeListener("SIGTERM", cancel);
