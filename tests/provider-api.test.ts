import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import type { CodexParsedRequest } from "../src/types";
import { chatCompletionsToResponses, providerChatCompletionsRequest } from "../src/provider/chat-completions";
import { providerModels } from "../src/provider/models";
import { normalizeProviderResponsesRequest, providerResponsesRequest } from "../src/provider/request";
import { startProviderServer, stopProviderServer, type ProviderServerHandle } from "../src/provider/server";
import type { ProviderConfig } from "../src/provider/config";

const servers: Array<ProviderServerHandle> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => stopProviderServer(server)));
});

function appConfig() {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  config.proAvailable = false;
  return config;
}

const fakeAdapter = () => ({
  name: "provider-test",
  async runTurn(parsed: CodexParsedRequest, _incoming: unknown, emit: (event: any) => void) {
    expect(parsed.context.messages.some(message => message.role === "user")).toBe(true);
    emit({ type: "text_delta", text: "provider ready", phase: "final_answer" });
    emit({ type: "done", endTurn: true });
  },
});

describe("generic provider request contract", () => {
  test("adds private turn identity without accepting client authority", () => {
    const req = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "x-chatgpt-web-conversation-id": "conversation-one", "x-idempotency-key": "request-0001" },
    });
    const normalized = normalizeProviderResponsesRequest(req, {
      model: "chatgpt-web/luna",
      input: "hello",
      client_metadata: { forged: true },
    });
    expect(normalized.conversationId).toBe("conversation-one");
    expect(JSON.stringify(normalized.body)).not.toContain("forged");
    expect(JSON.stringify(normalized.body)).toContain("provider-");
  });

  test("serves a non-streaming Responses result through the browser adapter boundary", async () => {
    const response = await providerResponsesRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-idempotency-key": "request-0002" },
      body: JSON.stringify({ model: "chatgpt-web/luna", input: "hello", stream: false }),
    }), appConfig(), fakeAdapter as any);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-chatgpt-web-conversation-id")).toBeTruthy();
    expect(JSON.stringify(await response.json())).toContain("provider ready");
  });

  test("fails closed when a generic client supplies tools", async () => {
    const response = await providerResponsesRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        input: "hello",
        tools: [{ type: "function", name: "danger", parameters: { type: "object" } }],
      }),
    }), appConfig(), fakeAdapter as any);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Generic tool execution is not enabled");
  });

  test("rejects conflicting reuse of an idempotency key", () => {
    const req = () => new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "x-idempotency-key": "request-conflict" },
    });
    normalizeProviderResponsesRequest(req(), { model: "chatgpt-web/luna", input: "first" });
    expect(() => normalizeProviderResponsesRequest(req(), { model: "chatgpt-web/luna", input: "second" }))
      .toThrow("already used for a different request");
  });
});

describe("OpenAI compatibility surfaces", () => {
  test("publishes an account-bounded model catalog without native Codex passthrough", () => {
    const catalog = providerModels(appConfig()) as { data: Array<{ id: string }> };
    expect(catalog.data.map(model => model.id)).toEqual(["chatgpt-web/luna"]);
  });

  test("maps Chat Completions messages into Responses input", () => {
    const mapped = chatCompletionsToResponses({
      model: "chatgpt-web/luna",
      messages: [{ role: "system", content: "be concise" }, { role: "user", content: "hello" }],
    });
    expect(mapped.input).toHaveLength(2);
  });

  test("returns a Chat Completions-compatible response", async () => {
    const response = await providerChatCompletionsRequest(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", messages: [{ role: "user", content: "hello" }] }),
    }), appConfig(), fakeAdapter as any);
    expect(response.status).toBe(200);
    const body = await response.json() as { object: string; choices: Array<{ message: { content: string } }> };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("provider ready");
  });

  test("accepts Chat Completions with client tools and returns text response", async () => {
    const response = await providerChatCompletionsRequest(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/luna",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "Bash", description: "Execute bash" } }],
      }),
    }), appConfig(), fakeAdapter as any);
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("provider ready");
  });

  test("translates Responses SSE into Chat Completions chunks", async () => {
    const response = await providerChatCompletionsRequest(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", stream: true, messages: [{ role: "user", content: "hello" }] }),
    }), appConfig(), fakeAdapter as any);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain("provider ready");
    expect(body).toContain("data: [DONE]");
  });

  test("enforces bearer authentication at the HTTP boundary", async () => {
    const providerConfig: ProviderConfig = {
      version: 1,
      host: "127.0.0.1",
      port: 0,
      apiToken: "a".repeat(32),
      chromeExecutablePath: "unused-in-test",
      headed: true,
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: false,
    };
    const server = startProviderServer(providerConfig, appConfig(), { adapterFactory: fakeAdapter as any });
    servers.push(server);
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
      headers: { authorization: `Bearer ${providerConfig.apiToken}` },
    });
    expect(authorized.status).toBe(200);
  });
});
