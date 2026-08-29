import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config";
import { closeChatGptBrowserWorkers } from "../adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../adapters/chatgpt-web/turn-execution";
import type { ProviderConfig } from "./config";
import { browserLoginStateExists } from "../browser-login";
import { providerModels } from "./models";
import { providerResponsesRequest, type ProviderAdapterFactory } from "./request";
import { providerChatCompletionsRequest } from "./chat-completions";

function authorized(req: Request, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(req.headers.get("authorization") ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function startProviderServer(
  providerConfig: ProviderConfig,
  appConfig: AppConfig,
  dependencies: { adapterFactory?: ProviderAdapterFactory } = {},
): ReturnType<typeof Bun.serve> {
  const startedAt = Date.now();
  return Bun.serve({
    hostname: providerConfig.host,
    port: providerConfig.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: "ok", service: "chatgpt-web-provider", uptime: (Date.now() - startedAt) / 1_000 });
      }
      if (!authorized(req, providerConfig.apiToken)) {
        return Response.json({ error: { type: "authentication_error", code: "invalid_api_key", message: "Invalid bearer token" } }, { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        const loginVerified = browserLoginStateExists(appConfig);
        return Response.json({
          status: loginVerified ? "ready" : "not_ready",
          login_verified: loginVerified,
          active_browser_turns: chatGptTurnSessions.activeCount(),
        }, { status: loginVerified ? 200 : 503 });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") return Response.json(providerModels(appConfig));
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        return providerResponsesRequest(req, appConfig, dependencies.adapterFactory);
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return providerChatCompletionsRequest(req, appConfig, dependencies.adapterFactory);
      }
      return Response.json({ error: { type: "invalid_request_error", code: "not_found", message: "Not found" } }, { status: 404 });
    },
  });
}

export async function stopProviderServer(server: ReturnType<typeof Bun.serve>): Promise<void> {
  server.stop(true);
  chatGptTurnSessions.clear();
  await closeChatGptBrowserWorkers();
}
