import type { AppConfig } from "../config";
import {
  availableChatGptWebModelRoutes,
  resolveChatGptWebContextLimits,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
} from "../chatgpt-web-models";

export function providerModels(config: AppConfig): Record<string, unknown> {
  const capabilities = {
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
    experimentalBiggerContext: config.experimentalBiggerContext,
  };

  const routes = availableChatGptWebModelRoutes(capabilities);
  const data: Array<Record<string, unknown>> = [];

  if (capabilities.solAvailable) {
    data.push({
      id: "sol",
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: "ChatGPT Sol (Adjustable Effort)",
      description: "Flagship ChatGPT Sol model. Adjust reasoning effort via reasoning_effort ('low', 'medium', 'high') or model aliases.",
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", capabilities),
    });
    data.push({
      id: "sol-high",
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: "ChatGPT Sol — High Effort",
      description: "ChatGPT Sol with high reasoning effort for complex coding and deep problem solving.",
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", capabilities),
    });
    data.push({
      id: "sol-medium",
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: "ChatGPT Sol — Medium Effort",
      description: "ChatGPT Sol with balanced speed and reasoning depth.",
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", capabilities),
    });
    data.push({
      id: "sol-low",
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: "ChatGPT Sol — Low Effort",
      description: "ChatGPT Sol instant response with minimal reasoning latency.",
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", capabilities),
    });
    data.push({
      id: "terra",
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: "ChatGPT Terra",
      description: "ChatGPT Terra fast model for everyday instructions and quick editing.",
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", capabilities),
    });
    if (capabilities.proAvailable) {
      data.push({
        id: "sol-pro",
        object: "model",
        created: 0,
        owned_by: "chatgpt-web-provider",
        name: "ChatGPT Pro",
        description: "Account-gated ChatGPT Pro with maximum reasoning effort.",
        input_modalities: ["text", "image"],
        ...resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "max", capabilities),
      });
    }
  } else {
    data.push({
      id: "luna",
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: "ChatGPT Luna",
      description: "ChatGPT Free model with rolling checkpoints.",
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", capabilities),
    });
  }

  for (const route of routes) {
    data.push({
      id: route.slug,
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: route.displayName,
      description: route.description.replace(" through the native Codex harness", ""),
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, capabilities),
    });
  }

  return { object: "list", data };
}
