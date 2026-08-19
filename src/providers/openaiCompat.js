import { toJSONSchema } from "./schema.js";

/**
 * One adapter for every OpenAI-compatible endpoint: Groq and OpenRouter both have
 * free tiers, Ollama runs locally for nothing, and OpenAI itself works if a key
 * is present. They differ only in base URL and model id.
 */
const PRESETS = {
  groq:       { base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", free: true,  keyEnv: "GROQ_API_KEY" },
  openrouter: { base: "https://openrouter.ai/api/v1",   model: "meta-llama/llama-3.3-70b-instruct:free", free: true, keyEnv: "OPENROUTER_API_KEY" },
  ollama:     { base: "http://localhost:11434/v1",      model: "llama3.1:8b", free: true,  keyEnv: null },
  openai:     { base: "https://api.openai.com/v1",      model: "gpt-4o-mini", free: false, keyEnv: "OPENAI_API_KEY" },
};

export function createOpenAICompat({ preset, apiKey, model, baseURL }) {
  const p = PRESETS[preset] || {};
  const base = baseURL || p.base;
  const chosen = model || p.model;

  return {
    name: preset,
    model: chosen,
    free: p.free ?? false,
    concurrency: preset === "ollama" ? 1 : 3,

    async complete(system, user, fields, { attempt = 0, maxTokens = 900 } = {}) {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: chosen,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "structured_output", strict: true, schema: toJSONSchema(fields) },
          },
        }),
        signal: AbortSignal.timeout(90000),
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          return this.complete(system, user, fields, { attempt: attempt + 1, maxTokens });
        }
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${body.error?.message || res.statusText}`);

      const text = body.choices?.[0]?.message?.content ?? "{}";
      const u = body.usage || {};
      return { data: JSON.parse(text), usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 } };
    },
  };
}

export { PRESETS };
