#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { browserLoginStateExists, importChromeProfileToChatGpt, loginToChatGpt } from "./browser-login";
import {
  loadProviderConfig,
  providerAppConfig,
  providerConfigPath,
  providerHome,
  saveProviderConfig,
} from "./provider/config";
import { startProviderServer } from "./provider/server";

const command = process.argv[2] ?? "help";

function help(): void {
  process.stdout.write(`chatgpt-web-provider

Commands:
  init       Create a private provider config and API token
  login      Open Chrome and store a verified ChatGPT session
  import-chrome [--profile NAME]
             Import the ChatGPT session from a closed local Chrome profile
  serve      Start the OpenAI-compatible provider
  doctor     Check configuration, browser path, and login state
`);
}

async function main(): Promise<void> {
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "init") {
    const config = loadProviderConfig({ create: true });
    saveProviderConfig(config);
    process.stdout.write(`Provider initialized at ${providerConfigPath()}\nAPI token is stored only in that private config file.\n`);
    return;
  }
  const config = loadProviderConfig();
  const appConfig = providerAppConfig(config);
  if (command === "login") {
    const result = await loginToChatGpt(appConfig);
    process.stdout.write(`Verified ChatGPT login stored at ${result.storageStatePath}\n`);
    return;
  }
  if (command === "import-chrome") {
    const profileIndex = process.argv.indexOf("--profile");
    const profileDirectory = profileIndex >= 0 ? process.argv[profileIndex + 1] : "Default";
    if (!profileDirectory || (profileIndex >= 0 && profileDirectory.startsWith("--"))) {
      throw new Error("--profile requires a Chrome profile directory such as Default or Profile 1");
    }
    const result = await importChromeProfileToChatGpt(appConfig, { profileDirectory });
    process.stdout.write(`Verified ChatGPT login imported from Chrome profile ${profileDirectory} to ${result.storageStatePath}\n`);
    return;
  }
  if (command === "doctor") {
    const checks = {
      config: providerConfigPath(),
      home: providerHome(),
      chrome_exists: existsSync(config.chromeExecutablePath),
      login_verified: browserLoginStateExists(appConfig),
      host: config.host,
      port: config.port,
    };
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
    if (!checks.chrome_exists || !checks.login_verified) process.exitCode = 1;
    return;
  }
  if (command === "serve") {
    if (!browserLoginStateExists(appConfig)) throw new Error("ChatGPT login is missing; run chatgpt-web-provider login");
    const server = startProviderServer(config, appConfig);
    process.stdout.write(`chatgpt-web-provider listening on http://${config.host}:${server.port}/v1\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
