import type Anthropic from "@anthropic-ai/sdk";

import { describe, expect, it } from "vitest";

import { answerSchema, claudeModel, claudePrompt } from "./claude";
import { phoneticQuestions } from "./phonetic-question";

const REQUEST = {
  state: { field: "surname", sample_values: ["Smythe"] },
  questions: phoneticQuestions(),
};

/** A client whose `beta.messages.parse` returns one fixed message. */
function fakeClient(message: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return message;
        },
      },
    },
  };
  // The adapter reads only `beta.messages.parse`, so a partial client is enough.
  return { client: client as unknown as Anthropic, calls };
}

function message(parsed: unknown, overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-opus-5",
    stop_reason: "end_turn",
    stop_details: null,
    parsed_output: parsed,
    usage: { input_tokens: 400, output_tokens: 20, iterations: [] },
    ...overrides,
  };
}

describe(answerSchema, () => {
  it("accepts a number for a noul question and a known key for a choice question", () => {
    const schema = answerSchema(REQUEST.questions);
    expect(schema.safeParse({ phonetic: 0.9, encoder: "soundex" }).success).toBeTruthy();
    expect(schema.safeParse({ phonetic: 0.9, encoder: "koelner_phonetik" }).success).toBeFalsy();
    expect(schema.safeParse({ encoder: "soundex" }).success).toBeFalsy();
  });
});

describe(claudePrompt, () => {
  it("carries the state and every question key", () => {
    const prompt = claudePrompt(REQUEST);
    expect(prompt).toContain('"Smythe"');
    expect(prompt).toContain('"phonetic"');
    expect(prompt).toContain('"double_metaphone"');
  });
});

describe(claudeModel, () => {
  it("returns the parsed output in the System One answer shape", async () => {
    const { client, calls } = fakeClient(message({ phonetic: 0.92, encoder: "double_metaphone" }));

    const response = await claudeModel({ client })(REQUEST);

    expect(response.answers).toEqual({
      phonetic: { noul: 0.92 },
      encoder: { choice: "double_metaphone" },
    });
    expect(calls[0]).toMatchObject({ model: "claude-opus-5", fallbacks: "default" });
  });

  it("marks an answer that a fallback model gave", async () => {
    const { client } = fakeClient(
      message(
        { phonetic: 0.9, encoder: "soundex" },
        {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 400,
            output_tokens: 20,
            iterations: [{ type: "message" }, { type: "fallback_message" }],
          },
        },
      ),
    );

    const response = await claudeModel({ client })(REQUEST);

    expect(response.routing).toEqual({ model: "claude-opus-4-8", reason: "fallback" });
  });

  it("throws on a refusal rather than read it as a no", async () => {
    const { client } = fakeClient(
      message(null, { stop_reason: "refusal", stop_details: { category: "cyber" } }),
    );

    await expect(claudeModel({ client })(REQUEST)).rejects.toThrow(/declined/);
  });
});
