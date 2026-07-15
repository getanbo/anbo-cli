# Contributing

Use Node.js 22 or newer and run:

```bash
npm ci
npm run check --workspace @getanbo/plugin-cloud
npm run test:installed:cloud
```

The package must not declare an `anbo` binary or write directly to the terminal.
Behavioral acceptance is performed by installing packed CLI and plugin
artifacts and invoking the installed `anbo` command.
