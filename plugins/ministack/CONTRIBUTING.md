# Contributing

Thanks for helping make the Anbo MiniStack target easier to use and debug.

## Development Setup

You need Node.js 22 or newer. Docker Engine or Docker Desktop is also required
for the acceptance suite.

```bash
git clone https://github.com/getanbo/anbo-cli.git
cd anbo-cli
npm ci
npm run verify --workspace @getanbo/plugin-ministack
```

`npm run verify` audits dependencies, type-checks, runs unit tests, validates
the packed plugin artifact, and runs Plugin API v1 conformance.

## Acceptance Tests

Run the Docker and MiniStack acceptance flow before submitting runtime or
Terraform changes:

```bash
npm run test:installed:ministack
```

End-to-end tests must go through the installed package's CLI. Do not prove an
Anbo workflow by directly invoking Terraform, Docker smoke scripts, or fixture
test files. Focused implementation tests may call internal functions.

## Pull Requests

- Keep changes scoped and explain any user-visible behavior change.
- Add focused tests for new behavior and failure diagnostics.
- Update the schemas and documentation when the manifest or event contract
  changes.
- Never commit credentials, clone URLs containing credentials, Terraform
  state, `.anbo` runtime data, or generated package archives.
- Confirm `npm run verify` and, when relevant, installed-CLI acceptance pass.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
