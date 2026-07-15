export const CLI_VERSION = "0.2.0";
export const PROJECT_CONFIG_PATH = ".anbo/project.json";
export const PLUGIN_LOCK_PATH = ".anbo/plugins.lock.json";

export const EXIT_CODE = {
  success: 0,
  usage: 2,
  pluginUnavailable: 3,
  pluginIncompatible: 4,
  operationFailed: 5,
  cancelled: 130,
} as const;

export const LIFECYCLE = new Set([
  "configure",
  "deploy",
  "status",
  "test",
  "logs",
  "debug",
  "down",
  "doctor",
]);

export interface FirstPartyPlugin {
  id: string;
  package: string;
  description: string;
}

export const FIRST_PARTY_PLUGINS: Record<string, FirstPartyPlugin> = {
  ministack: {
    id: "ministack",
    package: "@getanbo/plugin-ministack",
    description: "Local AWS-compatible Terraform deployments powered by Anbo MiniStack.",
  },
  cloud: {
    id: "cloud",
    package: "@getanbo/plugin-cloud",
    description: "Isolated Anbo Cloud environments backed by Kubernetes.",
  },
};

export const LEGACY_CLOUD_COMMANDS = new Set([
  "setup",
  "login",
  "logout",
  "auth",
  "demo",
  "branch",
  "token",
  "create",
  "destroy",
  "sql",
  "test-run",
  "test-status",
  "report",
]);
