import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv[2];
if (requested !== undefined && !["ministack", "cloud"].includes(requested)) {
  throw new Error("usage: official-plugins-acceptance.mjs [ministack|cloud]");
}

const targets = requested === undefined ? ["ministack", "cloud"] : [requested];
const temporaryRoot = await mkdtemp(join(tmpdir(), "anbo-official-plugins-"));
const artifactRoot = join(temporaryRoot, "artifacts");
const diagnosticsRoot = join(temporaryRoot, "diagnostics");

try {
  await Promise.all([
    mkdir(artifactRoot, { recursive: true }),
    mkdir(diagnosticsRoot, { recursive: true }),
  ]);
  const sdkTarball = packWorkspace("packages/plugin-sdk");
  const cliTarball = packWorkspace("packages/cli");

  for (const target of targets) {
    const environment = {
      ...process.env,
      ANBO_CLI_TARBALL: cliTarball,
      ANBO_ACCEPTANCE_DIAGNOSTICS: join(diagnosticsRoot, target),
      ...(target === "ministack"
        ? { ANBO_SDK_TARBALL: sdkTarball }
        : { ANBO_PLUGIN_SDK_TARBALL: sdkTarball }),
    };
    run("npm", ["run", "test:installed-cli", "--workspace", `@getanbo/plugin-${target}`], repositoryRoot, environment);
  }

  process.stdout.write(`Official plugin acceptance passed: ${targets.join(", ")}.\n`);
} finally {
  if (process.env.ANBO_KEEP_ACCEPTANCE === "1") {
    process.stdout.write(`Acceptance files retained at ${temporaryRoot}\n`);
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function packWorkspace(workspace) {
  const output = run(
    "npm",
    ["pack", "--json", "--workspace", workspace, "--pack-destination", artifactRoot],
    repositoryRoot,
  );
  const [{ filename }] = JSON.parse(output);
  return join(artifactRoot, filename);
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}
