import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import type {
  DecisionModel,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResponse,
} from "./system-one";

// A decision model backed by Claude. Claude is a chat model, not a typed
// decision model, so this adapter does two things the System One servers do
// for free:
//
// 1. It writes the state and the questions into a prompt.
// 2. It asks for structured output, so the reply is JSON that matches a schema
//    built from the question map. Nothing is parsed out of prose.
//
// The answer comes back in the System One response shape, so the rest of the
// eval cannot tell which backend produced it.

export interface ClaudeModelConfig {
  /** Model ID. Defaults to `claude-opus-5`. */
  model?: string;
  /** Effort level. A short classification does well at `low`. */
  effort?: "low" | "medium" | "high";
  /** Client to use. Defaults to one that reads `ANTHROPIC_API_KEY`. */
  client?: Anthropic;
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

/** The schema one reply must match: one key per question. */
export function answerSchema(questions: Record<string, SystemOneQuestion>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      // A probability. The range is checked after parsing, by `noulProbability`,
      // so an out-of-range value is a fault rather than a silent clamp.
      shape[name] = z.number();
    } else {
      const keys = Object.keys(question.criteria);
      shape[name] = z.enum(keys as [string, ...string[]]);
    }
  }
  return z.object(shape);
}

/** The prompt: the state as JSON, then one line per question. */
export function claudePrompt(request: SystemOneRequest): string {
  const lines = Object.entries(request.questions).map(([name, question]) => {
    if (question.type === "noul") {
      const criteria = question.criteria
        ? ` Yes means: ${question.criteria.true}. No means: ${question.criteria.false}.`
        : "";
      return `- "${name}": the probability, from 0 to 1, that the answer is yes. ${question.instructions}${criteria}`;
    }
    const options = Object.entries(question.criteria)
      .map(([key, description]) => `    - "${key}": ${description}`)
      .join("\n");
    return `- "${name}": exactly one of the keys below. ${question.instructions}\n${options}`;
  });
  return [
    "You configure a search index. Read the state, then answer each question.",
    "",
    "State:",
    JSON.stringify(request.state, null, 2),
    "",
    "Questions:",
    ...lines,
  ].join("\n");
}

/** A decision model that asks Claude. */
export function claudeModel(config: ClaudeModelConfig = {}): DecisionModel {
  const client = config.client ?? new Anthropic();
  const model = config.model ?? DEFAULT_CLAUDE_MODEL;

  return async (request) => {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: claudePrompt(request) }],
      output_config: {
        effort: config.effort ?? "low",
        format: betaZodOutputFormat(answerSchema(request.questions)),
      },
      // A safety classifier can decline an ordinary request. With an earlier
      // prompt, every request about the index "migrated off a mainframe" was
      // declined as cyber content; with this prompt, none were. Whether it
      // happens depends on the wording, so the fallback stays on. With
      // `fallbacks`, the API sends a declined request to another model in the
      // same call, and `usage.iterations` records that it did.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined the request: ${JSON.stringify(response.stop_details)}`);
    }
    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new Error(`Claude returned no parsable output (stop reason: ${response.stop_reason}).`);
    }

    const answers: SystemOneResponse["answers"] = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const value: unknown = parsed[name];
      answers[name] =
        question.type === "noul"
          ? { noul: typeof value === "number" ? value : undefined }
          : { choice: typeof value === "string" ? value : undefined };
    }

    const fellBack = (response.usage.iterations ?? []).some(
      (iteration) => iteration.type === "fallback_message",
    );
    return {
      answers,
      routing: { model: response.model, reason: fellBack ? "fallback" : undefined },
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  };
}
