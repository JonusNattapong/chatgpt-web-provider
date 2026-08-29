import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { formatErrorResponse } from "../bridge";
import { readJsonRequestBody } from "../http-body";
import { responseRequest } from "../server";
import type { ProviderAdapter } from "../adapters/base";

export type ProviderAdapterFactory = Parameters<typeof responseRequest>[2];

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const idempotencyFingerprints = new Map<string, string>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inputItems(input: unknown): unknown[] {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return Array.isArray(input) ? input.map(item => record(item) ? { ...record(item)! } : item) : [];
}

function requestIdentity(req: Request, body: Record<string, unknown>): { conversationId: string; turnId: string } {
  const suppliedConversation = req.headers.get("x-chatgpt-web-conversation-id")?.trim();
  if (suppliedConversation && !SAFE_ID.test(suppliedConversation)) {
    throw new Error("x-chatgpt-web-conversation-id must contain 1-128 safe characters");
  }
  const idempotencyKey = req.headers.get("x-idempotency-key")?.trim();
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 200)) {
    throw new Error("x-idempotency-key must contain 8-200 characters");
  }
  if (idempotencyKey) {
    const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const existing = idempotencyFingerprints.get(idempotencyKey);
    if (existing && existing !== fingerprint) throw new Error("x-idempotency-key was already used for a different request");
    idempotencyFingerprints.set(idempotencyKey, fingerprint);
    if (idempotencyFingerprints.size > 1_000) {
      idempotencyFingerprints.delete(idempotencyFingerprints.keys().next().value!);
    }
  }
  const turnId = idempotencyKey
    ? `provider-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`
    : `provider-${randomUUID()}`;
  const promptCacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()
    ? body.prompt_cache_key.trim()
    : undefined;
  return {
    conversationId: suppliedConversation ?? promptCacheKey ?? turnId,
    turnId,
  };
}

export function normalizeProviderResponsesRequest(
  req: Request,
  raw: unknown,
): { body: Record<string, unknown>; conversationId: string } {
  const body = record(raw);
  if (!body) throw new Error("Request body must be a JSON object");
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new Error("Generic tool execution is not enabled in provider v1");
  }
  if (typeof body.model !== "string" || !body.model.startsWith("chatgpt-web/")) {
    throw new Error("model must be one of the chatgpt-web/* models returned by /v1/models");
  }
  const input = inputItems(body.input);
  let currentUser = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (record(input[index])?.role === "user") {
      currentUser = index;
      break;
    }
  }
  if (currentUser < 0) throw new Error("input must include a current user message");

  const identity = requestIdentity(req, body);
  const user = record(input[currentUser])!;
  input[currentUser] = {
    ...user,
    id: typeof user.id === "string" && user.id ? user.id : `msg_${randomUUID().replaceAll("-", "")}`,
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
  };
  return {
    conversationId: identity.conversationId,
    body: {
      ...body,
      input,
      tools: [],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "turn",
          thread_id: identity.conversationId,
          turn_id: identity.turnId,
        }),
      },
    },
  };
}

function withConversationHeader(response: Response, conversationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-chatgpt-web-conversation-id", conversationId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function providerResponsesRequest(
  req: Request,
  config: AppConfig,
  adapterFactory?: (provider: Parameters<NonNullable<ProviderAdapterFactory>>[0]) => ProviderAdapter,
): Promise<Response> {
  try {
    const raw = await readJsonRequestBody(req);
    const normalized = normalizeProviderResponsesRequest(req, raw);
    const internal = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(normalized.body),
      signal: req.signal,
    });
    const response = await responseRequest(internal, config, adapterFactory);
    return withConversationHeader(response, normalized.conversationId);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
}
