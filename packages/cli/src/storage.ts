import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PluginCredentialsV1,
  PluginStateV1,
} from "@getanbo/plugin-sdk";
import { readJson, writeJsonAtomic } from "./config.js";

export interface PluginPaths {
  state: string;
  cache: string;
  data: string;
}

export function pluginPaths(rootDir: string, pluginId: string): PluginPaths {
  const userData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const userCache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return {
    state: join(rootDir, ".anbo", "state", "plugins", pluginId),
    cache: join(userCache, "anbo", pluginId),
    data: join(userData, "anbo", pluginId),
  };
}

export function createStateStore(path: string): PluginStateV1 {
  return new JsonNamespaceStore(join(path, "state.json"));
}

export function createCredentialStore(path: string): PluginCredentialsV1 {
  const store = new JsonNamespaceStore(join(path, "credentials.json"));
  return {
    async get(name) {
      return await store.get<Record<string, string>>(name);
    },
    async set(name, value) {
      await store.set(name, value);
    },
    async delete(name) {
      await store.delete(name);
    },
  };
}

class JsonNamespaceStore implements PluginStateV1 {
  private writeChain = Promise.resolve();

  constructor(private readonly path: string) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const values = (await readJson<Record<string, unknown>>(this.path)) ?? {};
    return values[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.mutate((values) => {
      values[key] = value;
    });
  }

  async delete(key: string): Promise<void> {
    await this.mutate((values) => {
      delete values[key];
    });
  }

  private async mutate(change: (values: Record<string, unknown>) => void): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const values = (await readJson<Record<string, unknown>>(this.path)) ?? {};
      change(values);
      await writeJsonAtomic(this.path, values);
    });
    await this.writeChain;
  }
}
