#!/usr/bin/env node
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
  serve      Start the OpenAI-compatible provider server
  doctor     Check configuration, browser path, and login state
  token      Print current API token and Base URL
  ask <text> Ask a question and stream the response to terminal
  chat       Start an interactive chat session in terminal
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
  if (command === "token") {
    process.stdout.write(`Base URL:  http://${config.host}:${config.port}/v1\nAPI Token: ${config.apiToken}\nModel:     chatgpt-web/medium\n`);
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
  if (command === "ask") {
    const prompt = process.argv.slice(3).join(" ").trim();
    if (!prompt) {
      process.stderr.write("Usage: chatgpt-web-provider ask <your question>\n");
      process.exitCode = 1;
      return;
    }
    const url = `http://${config.host}:${config.port}/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify({
        model: "chatgpt-web/medium",
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Request failed (${res.status}): ${err}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") continue;
        try {
          const json = JSON.parse(dataStr);
          const content = json.choices?.[0]?.delta?.content;
          if (content) process.stdout.write(content);
        } catch {}
      }
    }
    process.stdout.write("\n");
    return;
  }
  if (command === "chat") {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write("ChatGPT Web CLI (type 'exit' or Ctrl+C to quit)\n\n");
    const conversationMessages: Array<{ role: string; content: string }> = [];
    try {
      while (true) {
        const input = await rl.question("> ");
        if (!input.trim()) continue;
        if (input.trim() === "exit" || input.trim() === "quit") break;
        conversationMessages.push({ role: "user", content: input });
        process.stdout.write("\nAssistant: ");
        const url = `http://${config.host}:${config.port}/v1/chat/completions`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${config.apiToken}`,
          },
          body: JSON.stringify({
            model: "chatgpt-web/medium",
            stream: true,
            messages: conversationMessages,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          process.stdout.write(`Error (${res.status}): ${err}\n\n`);
          conversationMessages.pop();
          continue;
        }
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullReply = "";
        while (true) {
          const { done, value } = await reader!.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") continue;
            try {
              const json = JSON.parse(dataStr);
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                process.stdout.write(content);
                fullReply += content;
              }
            } catch {}
          }
        }
        process.stdout.write("\n\n");
        conversationMessages.push({ role: "assistant", content: fullReply });
      }
    } finally {
      rl.close();
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
