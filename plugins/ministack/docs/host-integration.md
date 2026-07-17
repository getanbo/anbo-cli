# Host Integration

The canonical `anbo` package is the only executable. This package exports a
Plugin API v1 default object and a static `./descriptor` JSON export. A host
must discover the descriptor without evaluating plugin code, validate its API
and engine ranges, and only then call `activate(context)`.

The activated runtime registers one target, `ministack`, with these actions:

```text
configure deploy status test logs debug run reset down capabilities cache
impact verify recover
```

The host owns argument parsing, project and plugin locks, output rendering,
run envelopes, ordered event sequence numbers, cancellation, credential
storage, and final exit status. The plugin never writes to stdout or stderr.
It uses the provided event, process, HTTP, state, secret, adapter, and path
facades so callers receive consistent diagnostics and redaction.

Projects select the plugin explicitly in `.anbo/project.json`; hosts must not
scan arbitrary global packages, `$PATH`, or undeclared `node_modules` trees.
Release qualification installs packed CLI and plugin tarballs into an empty
temporary prefix and executes only the installed `anbo` binary.
