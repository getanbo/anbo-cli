# Contributing

Use Node.js 22 or newer and run:

```bash
npm ci
npm run check
```

The package must not declare an `anbo` binary or write directly to the terminal.
Behavioral acceptance is performed by installing packed CLI and plugin
artifacts and invoking the installed `anbo` command.
