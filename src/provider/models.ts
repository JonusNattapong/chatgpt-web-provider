import type { AppConfig } from "../config";
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from "../chatgpt-web-models";

export function providerModels(config: AppConfig): Record<string, unknown> {
  const capabilities = {
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
    experimentalBiggerContext: config.experimentalBiggerContext,
  };
  return {
    object: "list",
    data: availableChatGptWebModelRoutes(capabilities).map(route => ({
      id: route.slug,
      object: "model",
      created: 0,
      owned_by: "chatgpt-web-provider",
      name: route.displayName,
      description: route.description.replace(" through the native Codex harness", ""),
      input_modalities: ["text", "image"],
      ...resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, capabilities),
    })),
  };
}
