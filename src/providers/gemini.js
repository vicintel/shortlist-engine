import { toGoogle } from "./schema.js";
import { rateLimiter } from "../util.js";

/**
 * Google AI Studio — the free option. `gemini-3.5-flash-lite` is fast, supports
 * structured output, and costs nothing on the free tier. Rate limits are the
 * constraint rather than money, so 429 is retried with backoff.
 */
export function createGemini({ apiKey, model = "gemini-3.5-flash-lite", rpm = 12 }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const throttle = rateLimiter(rpm);

  return {
    name: "gemini",
    model,
    free: true,
    concurrency: 3,
    rpm,

    async complete(system, user, fields, { attempt = 0, maxTokens = 900 } = {}) {
      await throttle();

      // A timeout or socket error throws before there is a body to inspect, so it
      // never reached the retry below. That silently converted transient network
      // blips into permanent failures.
      let res;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: toGoogle(fields),
              temperature: 0.3,
              maxOutputTokens: maxTokens,
            },
          }),
          signal: AbortSignal.timeout(120000),
        });
      } catch (err) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
          return this.complete(system, user, fields, { attempt: attempt + 1, maxTokens });
        }
        throw err;
      }

      const body = await res.json().catch(() => ({}));

      if (body.error) {
        const retryable = body.error.code === 429 || body.error.code >= 500;
        if (retryable && attempt < 4) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          return this.complete(system, user, fields, { attempt: attempt + 1, maxTokens });
        }
        throw new Error(`${body.error.code} ${body.error.message}`);
      }

      const cand = body.candidates?.[0];
      if (!cand) throw new Error("no candidate returned");
      if (cand.finishReason === "MAX_TOKENS") throw new Error("hit maxOutputTokens — output truncated");
      if (cand.finishReason && cand.finishReason !== "STOP") throw new Error(`finishReason ${cand.finishReason}`);

      const text = cand.content?.parts?.map((p) => p.text).join("") ?? "";
      const u = body.usageMetadata || {};
      return { data: JSON.parse(text), usage: { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0 } };
    },
  };
}
