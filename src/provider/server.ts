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

import { createServer } from "node:http";
import { Readable } from "node:stream";

export interface ProviderServerHandle {
  hostname?: string;
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
}

export function startProviderServer(
  providerConfig: ProviderConfig,
  appConfig: AppConfig,
  dependencies: { adapterFactory?: ProviderAdapterFactory } = {},
): ProviderServerHandle {
  const startedAt = Date.now();

  async function handleFetch(req: Request): Promise<Response> {
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
  }

  if (typeof Bun === "undefined" || !Bun.serve) {
    const server = createServer(async (nodeReq, nodeRes) => {
      try {
        const protocol = "http";
        const host = nodeReq.headers.host || `${providerConfig.host}:${providerConfig.port}`;
        const fullUrl = `${protocol}://${host}${nodeReq.url}`;
        const hasBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD";
        const webReq = new Request(fullUrl, {
          method: nodeReq.method,
          headers: nodeReq.headers as HeadersInit,
          body: hasBody ? (Readable.toWeb(nodeReq) as any) : undefined,
          duplex: hasBody ? "half" : undefined,
        } as RequestInit);

        const webRes = await handleFetch(webReq);
        nodeRes.statusCode = webRes.status;
        webRes.headers.forEach((val, key) => nodeRes.setHeader(key, val));
        if (webRes.body) {
          Readable.fromWeb(webRes.body as any).pipe(nodeRes);
        } else {
          nodeRes.end();
        }
      } catch (err) {
        if (!nodeRes.headersSent) {
          nodeRes.statusCode = 500;
          nodeRes.setHeader("content-type", "application/json");
          nodeRes.end(JSON.stringify({ error: { message: String(err) } }));
        }
      }
    });

    server.listen(providerConfig.port, providerConfig.host);
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : providerConfig.port;

    return {
      hostname: providerConfig.host,
      port: actualPort,
      stop: () => { server.close(); },
    };
  }

  const bunServer = Bun.serve({
    hostname: providerConfig.host,
    port: providerConfig.port,
    idleTimeout: 0,
    fetch: handleFetch,
  });

  return {
    hostname: bunServer.hostname,
    port: bunServer.port ?? providerConfig.port,
    stop: (closeActive) => bunServer.stop(closeActive),
  };
}

export async function stopProviderServer(server: ProviderServerHandle): Promise<void> {
  server.stop(true);
  chatGptTurnSessions.clear();
  await closeChatGptBrowserWorkers();
}
