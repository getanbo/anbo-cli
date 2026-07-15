import { readdir, rm } from "node:fs/promises";

for (const group of ["packages", "plugins"]) {
  for (const entry of await readdir(group, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await rm(`${group}/${entry.name}/dist`, { recursive: true, force: true });
  }
}
