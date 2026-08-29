import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { formatErrorResponse } from "../bridge";
import { readJsonRequestBody } from "../http-body";
import { canonicalizeModelSlug } from "../chatgpt-web-models";
import { providerResponsesRequest, type ProviderAdapterFactory } from "./request";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mapContent(content: unknown, assistant: boolean): unknown {
  if (typeof content === "string") return [{ type: assistant ? "output_text" : "input_text", text: content }];
  if (!Array.isArray(content)) return [];
  const mapped: unknown[] = [];
  for (const part of content) {
    const item = record(part);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      mapped.push({ type: assistant ? "output_text" : "input_text", text: item.text });
      continue;
    }
    const image = record(item.image_url);
    if (!assistant && item.type === "image_url" && typeof image?.url === "string") {
      mapped.push({ type: "input_image", image_url: image.url, ...(typeof image.detail === "string" ? { detail: image.detail } : {}) });
    }
  }
  return mapped;
}

export function chatCompletionsToResponses(raw: unknown): Record<string, unknown> {
  const body = record(raw);
  if (!body) throw new Error("Request body must be a JSON object");
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages must be a non-empty array");
  if (body.tool_choice && body.tool_choice !== "none" && body.tool_choice !== "auto") {
    throw new Error("tool_choice other than 'none' or 'auto' is not supported in provider v1");
  }
  if (body.n !== undefined && body.n !== 1) throw new Error("Provider v1 supports only n=1");
  for (const field of ["functions", "function_call", "logprobs", "response_format"]) {
    if (body[field] !== undefined) throw new Error(`Provider v1 does not support ${field}`);
  }
  const input = body.messages.map((message, index) => {
    const item = record(message);
    if (!item || !["system", "developer", "user", "assistant"].includes(String(item.role))) {
      throw new Error(`messages[${index}].role is unsupported`);
    }
    const role = String(item.role);
    return {
      type: "message",
      role,
      content: mapContent(item.content, role === "assistant"),
    };
  });
  return {
    model: canonicalizeModelSlug(body.model, body.reasoning_effort),
    input,
    stream: body.stream === true,
    ...(typeof body.max_tokens === "number" ? { max_output_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(body.stop !== undefined ? { stop: body.stop } : {}),
    ...(typeof body.user === "string" ? { user: body.user } : {}),
  };
}

function outputText(response: Record<string, unknown>): string {
  if (!Array.isArray(response.output)) return "";
  const finalAnswer = response.output.flatMap(item => {
    const message = record(item);
    if (!message || message.type !== "message" || !Array.isArray(message.content)) return [];
    if (message.phase === "commentary") return [];
    return message.content.flatMap(part => {
      const content = record(part);
      return content?.type === "output_text" && typeof content.text === "string" ? [content.text] : [];
    });
  }).join("");

  if (finalAnswer.trim().length > 0) return finalAnswer;

  return response.output.flatMap(item => {
    const message = record(item);
    if (!message || message.type !== "message" || !Array.isArray(message.content)) return [];
    return message.content.flatMap(part => {
      const content = record(part);
      return content?.type === "output_text" && typeof content.text === "string" ? [content.text] : [];
    });
  }).join("");
}

function completionJson(response: Record<string, unknown>, model: string): Record<string, unknown> {
  return {
    id: typeof response.id === "string" ? `chatcmpl_${response.id}` : `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: outputText(response) }, finish_reason: "stop" }],
    ...(record(response.usage) ? { usage: response.usage } : {}),
  };
}

function completionStream(response: Response, model: string): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  let buffer = "";
  let sentRole = false;
  let inCommentary = false;
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(next.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        const output: string[] = [];
        for (const frame of frames) {
          const event = frame.split("\n").find(line => line.startsWith("event: "))?.slice(7);
          const dataLine = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (!dataLine) continue;
          let data: Record<string, unknown> | undefined;
          try { data = record(JSON.parse(dataLine)); } catch { continue; }
          if (event === "response.output_item.added") {
            const item = record(data?.item);
            if (item?.phase === "commentary") inCommentary = true;
          } else if (event === "response.output_item.done") {
            inCommentary = false;
          } else if (event === "response.output_text.delta" && typeof data?.delta === "string") {
            if (!inCommentary) {
              if (!sentRole) {
                sentRole = true;
                output.push(chunk({ role: "assistant" }));
              }
              output.push(chunk({ content: data.delta }));
            }
          } else if (event === "response.completed") {
            output.push(chunk({}, "stop"), "data: [DONE]\n\n");
            controller.enqueue(encoder.encode(output.join("")));
            await reader.cancel().catch(() => {});
            controller.close();
            return;
          }
        }
        if (output.length > 0) {
          controller.enqueue(encoder.encode(output.join("")));
          return;
        }
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(stream, {
    status: response.status,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

export async function providerChatCompletionsRequest(
  req: Request,
  config: AppConfig,
  adapterFactory?: ProviderAdapterFactory,
): Promise<Response> {
  try {
    const raw = await readJsonRequestBody(req);
    const mapped = chatCompletionsToResponses(raw);
    const internal = new Request(req.url.replace(/\/chat\/completions$/, "/responses"), {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(mapped),
      signal: req.signal,
    });
    const response = await providerResponsesRequest(internal, config, adapterFactory);
    if (!response.ok) return response;
    if (mapped.stream === true) return completionStream(response, String(mapped.model));
    const body = await response.json() as Record<string, unknown>;
    return Response.json(completionJson(body, String(mapped.model)), {
      headers: { "x-chatgpt-web-conversation-id": response.headers.get("x-chatgpt-web-conversation-id") ?? "" },
    });
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
}
