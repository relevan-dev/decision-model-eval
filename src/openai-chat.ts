import { z } from "zod";

import { answerSchema, claudePrompt } from "./claude";
import type { DecisionModel, SystemOneResponse } from "./system-one";

// A decision model backed by any chat model behind an OpenAI-compatible
// `POST /v1/chat/completions` route, such as vLLM serving NVIDIA's Nemotron 3
// Nano or Nemotron 3.5 Lightning. It is the same adapter as `claude.ts`: the
// same prompt, and the same answer schema, sent as a `json_schema` response
// format so the server constrains decoding to it. Nothing is parsed out of
// prose, and the answer comes back in the System One response shape.

export interface ChatCompletionsConfig {
  baseUrl: string;
  apiKey?: string;
  /** The server's model name, as `--served-model-name` set it. */
  model: string;
  /**
   * Whether the model may reason before it answers. Nemotron reads this from
   * the chat template kwarg `enable_thinking`. Off by default: a short
   * classification rarely needs it, and it costs most of the latency.
   */
  thinking?: boolean;
  /**
   * Cap on generated tokens. Defaults to 1024 without thinking. With thinking,
   * it is left unset, so the server allows whatever context remains: a fixed
   * cap such as 8192 cut some of Lightning's reasoning off before its answer.
   */
  maxTokens?: number;
  /** Milliseconds before a request is aborted. Defaults to 120000, or 600000 with thinking. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Only the fields this adapter reads; the rest of the body may vary by server. */
const completionSchema = z.looseObject({
  model: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullable().optional(),
        message: z.looseObject({ content: z.string().nullable().optional() }),
      }),
    )
    .min(1),
  usage: z
    .looseObject({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

/** Builds the request body, so a test or a caller can read it without a server. */
export function chatCompletionsBody(
  request: Parameters<DecisionModel>[0],
  config: Pick<ChatCompletionsConfig, "model" | "thinking" | "maxTokens">,
) {
  const maxTokens = config.maxTokens ?? (config.thinking ? undefined : 1024);
  return {
    model: config.model,
    messages: [{ role: "user", content: claudePrompt(request) }],
    // Greedy decoding. It is not fully deterministic: vLLM batches and MoE
    // kernels can change the numerics, so answers near a tie can flip between
    // runs. Run the eval more than once before reading one miss.
    temperature: 0,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answers",
        strict: true,
        schema: z.toJSONSchema(answerSchema(request.questions)),
      },
    },
    chat_template_kwargs: { enable_thinking: config.thinking ?? false },
  };
}

/** A decision model that asks a chat model over the OpenAI-compatible API. */
export function chatCompletionsModel(config: ChatCompletionsConfig): DecisionModel {
  return async (request) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) {
      headers["authorization"] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(new URL("/v1/chat/completions", config.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(chatCompletionsBody(request, config)),
      signal: AbortSignal.timeout(config.timeoutMs ?? (config.thinking ? 600_000 : DEFAULT_TIMEOUT_MS)),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Chat completion request failed: ${response.status} ${response.statusText}. ${detail}`.trim(),
      );
    }

    const completion = completionSchema.safeParse(await response.json());
    if (!completion.success) {
      throw new Error(`Chat server returned an unexpected payload: ${completion.error.message}`);
    }
    const [choice] = completion.data.choices;
    const content = choice?.message.content;
    if (!content) {
      throw new Error(
        `Chat model returned no content (finish reason: ${choice?.finish_reason ?? "unknown"}).`,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error(`Chat model returned content that is not JSON: ${content.slice(0, 200)}`);
    }
    const parsed = answerSchema(request.questions).safeParse(json);
    if (!parsed.success) {
      throw new Error(`Chat model's answer does not match the schema: ${parsed.error.message}`);
    }

    const answers: SystemOneResponse["answers"] = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const value: unknown = (parsed.data as Record<string, unknown>)[name];
      answers[name] =
        question.type === "noul"
          ? { noul: typeof value === "number" ? value : undefined }
          : { choice: typeof value === "string" ? value : undefined };
    }

    return {
      answers,
      routing: { model: completion.data.model ?? config.model },
      usage: {
        input_tokens: completion.data.usage?.prompt_tokens,
        output_tokens: completion.data.usage?.completion_tokens,
      },
    };
  };
}
