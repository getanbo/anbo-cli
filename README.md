# Anbo CLI

Anbo is an agent-first CLI for creating reproducible local and remote deployment environments. This repository is the only canonical source of the `anbo` executable. Deployment implementations live in versioned plugins.

## Install

The first public release is prepared as `anbo@0.2.0`. Until it is published to npm, build and install the package from this repository:

```sh
git clone https://github.com/getanbo/cli.git
cd cli
npm ci
npm run build
npm pack --workspace packages/cli
npm install --global ./anbo-0.2.0.tgz
anbo version
```

After publication:

```sh
npm install --global anbo
```

## MiniStack Project

Run these commands from a project containing Terraform:

```sh
anbo configure --target ministack
anbo doctor --output jsonl
anbo deploy --output jsonl
anbo status --output jsonl
anbo test --output jsonl -- npm test
anbo logs --follow --output jsonl
anbo debug --output jsonl
anbo down --purge --output jsonl
```

`anbo sandbox up` remains an alias for `anbo deploy --target ministack`.

## Cloud Project

The Cloud plugin owns the remote target and namespaced commands:

```sh
anbo configure --target cloud
anbo deploy
anbo cloud branch list
anbo cloud sql --env-id example --command "select 1"
```

The previous `anbo branch`, `anbo token`, `anbo sql`, `anbo report`, and `anbo test-status` forms route to their corresponding `cloud.*` commands.

## Configuration

`anbo configure` creates two committed project files:

- `.anbo/project.json` selects targets and contains only namespaced plugin configuration.
- `.anbo/plugins.lock.json` records exact package versions and npm integrity when available.

Plugin discovery is explicit. Anbo never scans arbitrary global packages, `$PATH`, or every dependency in `node_modules`. First-party target names map to exact packages, and custom plugins must be declared in `.anbo/project.json`.

## Machine Output

Use `--output jsonl` for agents and CI. Each line is one `anbo.dev/event/v1` object with a stable run ID, contiguous sequence, timestamp, source, command, target, severity, and structured data. Core owns stdout, cancellation, redaction, diagnostic codes, and the single terminal `run.finished` event.

Use `--output json` for one buffered run document or the default human output for a terminal. Machine modes never mix explanatory text into stdout or stderr.

## Plugin API v1

A plugin exports a static `./descriptor` JSON entry and default-exports:

```ts
import type { AnboPluginV1 } from "@getanbo/plugin-sdk";

const plugin: AnboPluginV1 = {
  descriptor,
  async activate(context) {
    return { targets: [targetProvider] };
  },
};

export default plugin;
```

The host supplies namespaced state, credentials, secrets, adapter access, filesystem paths, process and HTTP primitives, structured events, and an `AbortSignal`. Plugins do not parse global options or write directly to stdout/stderr.

The contract and schemas live in [`packages/plugin-sdk`](packages/plugin-sdk) and [`schemas`](schemas). `@getanbo/plugin-testkit` runs an installed `node_modules/.bin/anbo` and validates event streams.

## Testing Rule

Unit tests may call native modules. Every behavioral, integration, smoke, recovery, and release-qualification test must pack the real packages, install them into an empty prefix, and invoke only `node_modules/.bin/anbo`. The harness must not call Terraform, Docker, plugin entrypoints, or application smoke scripts directly.

```sh
npm ci
npm run check
```

`npm run check` performs type checking, unit tests, and the installed-tarball acceptance sequence, including cold/warm deploys, passthrough commands, structured logs, secret redaction, cancellation, teardown, and both MiniStack and Cloud routing.

## Repository Boundaries

- [`getanbo/cli`](https://github.com/getanbo/cli): executable, SDK, event protocol, config, locks, acceptance kit.
- [`getanbo/anbo-plugin-ministack`](https://github.com/getanbo/anbo-plugin-ministack): local Terraform and MiniStack target.
- [`getanbo/anbo-plugin-cloud`](https://github.com/getanbo/anbo-plugin-cloud): remote Anbo Cloud target.
- [`getanbo/anbo-ministack`](https://github.com/getanbo/anbo-ministack): downstream runtime image, not a CLI.

## License

MIT
