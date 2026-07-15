# Contributing

Changes are made through pull requests against `main`. Keep the CLI core provider-neutral and put target-specific behavior in the appropriate `plugins/*` workspace.

## Development

```sh
npm ci
npm run check
```

Work in `packages/cli` for command and host behavior, `packages/plugin-sdk` for public contracts, `plugins/ministack` for local Terraform orchestration, and `plugins/cloud` for the hosted backend client. Root scripts build the complete dependency graph; workspace scripts are available for focused native tests.

Add unit coverage for native logic. Any user-visible workflow must also be covered by `scripts/acceptance.mjs`, using packed packages installed into an empty prefix and invoking only `node_modules/.bin/anbo`.

Plugin API changes require schema updates, SDK type coverage, testkit coverage, and compatibility verification against both first-party plugins. Breaking changes require a new plugin API version.

The first-party plugins remain separately published packages even though they share this repository. Reusable third-party plugins and adapters may live in their own repositories and depend only on the public SDK.

Use Conventional Commit-style subjects. Do not commit credentials, generated package tarballs, or `.anbo` runtime state.
