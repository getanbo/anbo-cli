# Contributing

Changes are made through pull requests against `main`. Keep the CLI core provider-neutral and put target-specific behavior in a plugin repository.

## Development

```sh
npm ci
npm run check
```

Add unit coverage for native logic. Any user-visible workflow must also be covered by `scripts/acceptance.mjs`, using packed packages installed into an empty prefix and invoking only `node_modules/.bin/anbo`.

Plugin API changes require schema updates, SDK type coverage, testkit coverage, and compatibility verification against both first-party plugins. Breaking changes require a new plugin API version.

Use Conventional Commit-style subjects. Do not commit credentials, generated package tarballs, or `.anbo` runtime state.
