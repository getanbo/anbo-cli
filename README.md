# Anbo CLI

Install the Anbo CLI with npm:

```sh
npm install -g github:getanbo/cli
```

Then log in:

```sh
anbo login
```

Create an isolated Postgres clone:

```sh
anbo branch create refund-migration-check
```

The CLI talks to `https://app.getanbo.com` by default.
