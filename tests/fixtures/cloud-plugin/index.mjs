const commands = ["cloud.branch", "cloud.token", "cloud.sql", "cloud.report", "cloud.test-status"];
const actions = ["configure", "deploy", "status", "test", "logs", "debug", "down", "capabilities"];
const descriptor = {
  schema_version: 1,
  plugin_api: 1,
  id: "anbo.cloud",
  package: "@getanbo/plugin-cloud",
  version: "0.1.0",
  entrypoint: "./index.mjs",
  engines: { anbo: ">=0.2.0 <0.3.0", node: ">=20.0.0" },
  kinds: ["target", "commands"],
  targets: [{ id: "cloud", actions }],
  commands,
  config: { schema: "./config.schema.json", schema_version: 1 },
  capabilities: ["acceptance.cloud"],
};

async function result(context, name, request) {
  await context.events.emit({
    type: "cloud.command",
    level: "info",
    message: `${name} accepted`,
    data: { name, args: request.args },
  });
  return { ok: true, data: { name, args: request.args } };
}

export default {
  descriptor,
  async activate(context) {
    return {
      targets: {
        cloud: { execute: (request) => result(context, request.action, request) },
      },
      commands: Object.fromEntries(commands.map((name) => [name, (request) => result(context, name, request)])),
    };
  },
};
