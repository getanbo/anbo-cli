import { readdir, rm } from "node:fs/promises";

for (const entry of await readdir("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await rm(`packages/${entry.name}/dist`, { recursive: true, force: true });
}
