import { cp, mkdir } from "node:fs/promises";

const destination = new URL("../dist/schemas/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("../schemas/", import.meta.url), destination, { recursive: true });
