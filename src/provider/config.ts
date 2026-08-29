import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  atomicWriteFile,
  defaultBrokerEndpoint,
  defaultChromeExecutable,
  defaultConfig,
  type AppConfig,
} from "../config";

export interface ProviderConfig {
  version: 1;
  host: "127.0.0.1";
  port: number;
  apiToken: string;
  chromeExecutablePath: string;
  headed: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
  experimentalBiggerContext: boolean;
}

export function providerHome(): string {
  return resolve(process.env.CHATGPT_WEB_PROVIDER_HOME?.trim() || join(homedir(), ".chatgpt-web-provider"));
}

export function providerConfigPath(): string {
  return join(providerHome(), "config.json");
}

export function defaultProviderConfig(): ProviderConfig {
  return {
    version: 1,
    host: "127.0.0.1",
    port: 17842,
    apiToken: randomBytes(32).toString("base64url"),
    chromeExecutablePath: defaultChromeExecutable(),
    headed: true,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: false,
  };
}

function validate(config: ProviderConfig): ProviderConfig {
  if (config.version !== 1) throw new Error(`Unsupported provider config version in ${providerConfigPath()}`);
  if (config.host !== "127.0.0.1") throw new Error("Provider must bind to 127.0.0.1");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) throw new Error("Provider port is invalid");
  if (typeof config.apiToken !== "string" || config.apiToken.length < 32) throw new Error("Provider API token is invalid");
  if (typeof config.chromeExecutablePath !== "string" || !config.chromeExecutablePath.trim()) {
    throw new Error("Provider Chrome executable is missing");
  }
  return config;
}

export function saveProviderConfig(config: ProviderConfig): void {
  mkdirSync(providerHome(), { recursive: true, mode: 0o700 });
  atomicWriteFile(providerConfigPath(), `${JSON.stringify(validate(config), null, 2)}\n`);
}

export function loadProviderConfig({ create = false }: { create?: boolean } = {}): ProviderConfig {
  const path = providerConfigPath();
  if (!existsSync(path)) {
    if (!create) throw new Error(`Provider is not initialized; run chatgpt-web-provider init (${path})`);
    const config = defaultProviderConfig();
    saveProviderConfig(config);
    return config;
  }
  return validate(JSON.parse(readFileSync(path, "utf8")) as ProviderConfig);
}

export function providerAppConfig(config: ProviderConfig): AppConfig {
  const home = providerHome();
  // Shared browser/session helpers resolve their private state through the upstream home variable.
  // A provider process owns a separate home and must never reuse Codex integration state.
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  return {
    ...defaultConfig("browser-only"),
    host: config.host,
    port: config.port,
    appName: "ChatGPT Web Provider",
    browserHost: "managed-chrome",
    chromeExecutablePath: config.chromeExecutablePath,
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(home),
    headed: config.headed,
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
    experimentalBiggerContext: config.experimentalBiggerContext,
    autoApproveToolCalls: false,
    controlToken: randomBytes(32).toString("base64url"),
  };
}
