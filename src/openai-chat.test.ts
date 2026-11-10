import { afterEach, describe, expect, it, vi } from "vitest";

import { chatCompletionsBody, chatCompletionsModel } from "./openai-chat";
import { phoneticQuestions } from "./phonetic-question";

const REQUEST = {
  state: { field: "surname", sample_values: ["Smythe"] },
  questions: phoneticQuestions(),
};

const CONFIG = { baseUrl: "http://127.0.0.1:8900", model: "nemotron-nano" };

function completion(content: string | null, overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      model: "nemotron-nano",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 400, completion_tokens: 20 },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** An answer that satisfies every question in `REQUEST`. */
function validAnswer(): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(REQUEST.questions)) {
    answer[name] = question.type === "noul" ? 0.9 : Object.keys(question.criteria)[0];
  }
  return answer;
}

describe(chatCompletionsBody, () => {
  it("constrains decoding to the answer schema and turns thinking off by default", () => {
    const body = chatCompletionsBody(REQUEST, CONFIG);
    expect(body.response_format.type).toBe("json_schema");
    expect(Object.keys(body.response_format.json_schema.schema.properties ?? {})).toEqual(
      Object.keys(REQUEST.questions),
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(1024);
    const thinking = chatCompletionsBody(REQUEST, { ...CONFIG, thinking: true });
    expect(thinking.chat_template_kwargs).toEqual({ enable_thinking: true });
    // With thinking, no fixed cap: the server allows whatever context remains.
    expect(thinking).not.toHaveProperty("max_tokens");
    expect(chatCompletionsBody(REQUEST, { ...CONFIG, thinking: true, maxTokens: 20_000 }).max_tokens).toBe(
      20_000,
    );
  });
});

describe(chatCompletionsModel, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the answers in the System One shape", async () => {
    const answer = validAnswer();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(completion(JSON.stringify(answer)));

    const response = await chatCompletionsModel({ ...CONFIG, apiKey: "k" })(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe("http://127.0.0.1:8900/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
    for (const [name, question] of Object.entries(REQUEST.questions)) {
      expect(response.answers[name]).toEqual(
        question.type === "noul" ? { noul: answer[name] } : { choice: answer[name] },
      );
    }
    expect(response.usage).toEqual({ input_tokens: 400, output_tokens: 20 });
  });

  it("fails on empty content, non-JSON content, and off-schema answers", async () => {
    const model = chatCompletionsModel(CONFIG);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(completion(null));
    await expect(model(REQUEST)).rejects.toThrow(/no content/);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(completion("yes, probably"));
    await expect(model(REQUEST)).rejects.toThrow(/not JSON/);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(completion(JSON.stringify({})));
    await expect(model(REQUEST)).rejects.toThrow(/does not match/);
  });

  it("reports a server error with its status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(chatCompletionsModel(CONFIG)(REQUEST)).rejects.toThrow(/500/);
  });
});
