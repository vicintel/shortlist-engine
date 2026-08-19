import Anthropic from "@anthropic-ai/sdk";
import { toJSONSchema } from "./schema.js";

/** Anthropic — highest quality of the options here, and the only one that bills. */
export function createAnthropic({ apiKey, model = "claude-haiku-4-5" }) {
  const client = new Anthropic({ apiKey });

  return {
    name: "anthropic",
    model,
    free: false,
    concurrency: 4,

    async complete(system, user, fields, { maxTokens = 900 } = {}) {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema: toJSONSchema(fields) } },
      });
      const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
      return { data: JSON.parse(text), usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
    },
  };
}
