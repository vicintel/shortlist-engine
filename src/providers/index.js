import { createGemini } from "./gemini.js";
import { createAnthropic } from "./anthropic.js";
import { createOpenAICompat, PRESETS } from "./openaiCompat.js";

/** USD per million tokens. Free tiers are 0 — that is the point of them. */
const PRICE = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5": [3, 15],
  "claude-opus-5": [5, 25],
  "gpt-4o-mini": [0.15, 0.6],
};

export function estimateCost(usage, model) {
  const rate = PRICE[model];
  if (!rate) return 0;
  return (usage.input / 1e6) * rate[0] + (usage.output / 1e6) * rate[1];
}

/**
 * Resolve a provider. Order of preference when SHORTLIST_PROVIDER is unset:
 * a free provider with a working key, then a paid one. Nothing is chosen that
 * would spend money without being asked for by name.
 */
export function createProvider(env = process.env) {
  const explicit = (env.SHORTLIST_PROVIDER || "").trim().toLowerCase();
  const model = env.SHORTLIST_MODEL?.trim() || undefined;

  const build = (name) => {
    switch (name) {
      case "gemini":
        if (!env.GEMINI_API_KEY) return null;
        return createGemini({
          apiKey: env.GEMINI_API_KEY,
          model,
          rpm: Number(env.SHORTLIST_RPM || 12),
        });
      case "anthropic":
        if (!env.ANTHROPIC_API_KEY) return null;
        return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, model });
      case "ollama":
        return createOpenAICompat({ preset: "ollama", model, baseURL: env.OLLAMA_URL });
      case "groq":
      case "openrouter":
      case "openai": {
        const key = env[PRESETS[name].keyEnv];
        if (!key) return null;
        return createOpenAICompat({ preset: name, apiKey: key, model });
      }
      default:
        return null;
    }
  };

  if (explicit) {
    const p = build(explicit);
    if (!p) throw new Error(`SHORTLIST_PROVIDER=${explicit} but its API key is not set`);
    return p;
  }

  for (const name of ["gemini", "groq", "openrouter", "anthropic", "openai"]) {
    const p = build(name);
    if (p) return p;
  }
  return null;
}

export const PROVIDER_NAMES = ["gemini", "groq", "openrouter", "ollama", "anthropic", "openai"];
