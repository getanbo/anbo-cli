import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireClone } from "../src/runtime/clones.js";

test("remote PostgreSQL clones require an explicit secure sslmode", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-clone-security-"));
  const request = {
    projectId: "tls-test",
    engine: "postgres" as const,
    config: { provider: "external" as const, endpoint: "env://DATABASE_URL" as const },
    statePath: join(root, "clones.json"),
  };

  try {
    await assert.rejects(
      acquireClone({ ...request, environment: { DATABASE_URL: "postgresql://user:password@db.example.test/app" } }),
      /must set sslmode=require, verify-ca, or verify-full/,
    );
    await assert.rejects(
      acquireClone({ ...request, environment: { DATABASE_URL: "postgresql://user:password@db.example.test/app?sslmode=disable" } }),
      /must set sslmode=require, verify-ca, or verify-full/,
    );
    await assert.rejects(
      acquireClone({
        ...request,
        environment: { DATABASE_URL: "postgresql://user:password@db.example.test/app?sslmode=require&sslmode=disable" },
      }),
      /must set sslmode=require, verify-ca, or verify-full/,
    );

    const lease = await acquireClone({
      ...request,
      environment: { DATABASE_URL: "postgresql://user:password@db.example.test/app?sslmode=verify-full" },
    });
    assert.equal(lease.engine, "postgres");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local PostgreSQL clone URLs may opt out of TLS", async () => {
  const root = await mkdtemp(join(tmpdir(), "anbo-clone-local-"));
  try {
    const lease = await acquireClone({
      projectId: "local-tls-test",
      engine: "postgres",
      config: { provider: "external", endpoint: "env://DATABASE_URL" },
      statePath: join(root, "clones.json"),
      environment: { DATABASE_URL: "postgresql://user:password@localhost:5432/app?sslmode=disable" },
    });
    assert.equal(lease.engine, "postgres");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
