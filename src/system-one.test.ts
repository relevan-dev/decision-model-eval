import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateSystemOne,
  noulConfidence,
  noulProbability,
  systemOneRequestBody,
} from "./system-one";

const REQUEST = {
  state: { field: "candidateName" },
  questions: { phonetic: { type: "noul", instructions: "Names?" } },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe(systemOneRequestBody, () => {
  it("omits the model when neither the request nor the config names one", () => {
    expect(systemOneRequestBody(REQUEST, {})).toEqual({
      state: REQUEST.state,
      questions: REQUEST.questions,
    });
  });

  it("takes the model from the config", () => {
    expect(systemOneRequestBody(REQUEST, { model: "multilingual" })).toMatchObject({
      model: "multilingual",
    });
  });

  it("lets the request override the config's model", () => {
    expect(
      systemOneRequestBody({ ...REQUEST, model: "typed-decisions" }, { model: "english" }),
    ).toMatchObject({ model: "typed-decisions" });
  });
});

describe(evaluateSystemOne, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to /v1/systemone and returns the parsed answers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ answers: { phonetic: { noul: 0.91, confidence: 0.82 } } }));

    const result = await evaluateSystemOne(REQUEST, { baseUrl: "http://127.0.0.1:8000" });

    expect(result.answers["phonetic"]).toEqual({ noul: 0.91, confidence: 0.82 });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(init?.method).toBe("POST");
  });

  it("sends a bearer token only when a key is configured", async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ answers: {} }));

    await evaluateSystemOne(REQUEST, { baseUrl: "http://127.0.0.1:8000" });
    await evaluateSystemOne(REQUEST, { baseUrl: "http://127.0.0.1:8000", apiKey: "secret" });

    const headersWithout = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const headersWith = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headersWithout.get("authorization")).toBeNull();
    expect(headersWith.get("authorization")).toBe("Bearer secret");
  });

  it("keeps fields the schema does not name", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        answers: { phonetic: { noul: 0.5, latency_ms: 33 } },
        routing: { model: "english", reason: "latin script" },
        usage: { input_tokens: 84, output_tokens: 2 },
      }),
    );

    const result = await evaluateSystemOne(REQUEST, { baseUrl: "http://127.0.0.1:8000" });

    expect(result.routing?.model).toBe("english");
    expect(result.usage?.input_tokens).toBe(84);
    expect(result.answers["phonetic"]?.["latency_ms"]).toBe(33);
  });

  // Pinned from a live `laya-serve` response: `answers[q].type` alongside the
  // typed value, an entropy confidence on the choice, and a `model` key beside
  // `answers`. A schema change that stopped parsing this would break the real
  // server without breaking a hand-written fixture.
  it("parses the answer shape laya-serve actually sends", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        model: "english",
        answers: {
          phonetic: { type: "noul", noul: 0.93, confidence: 0.93 },
          encoder: {
            type: "choice",
            choice: "double_metaphone",
            probabilities: { double_metaphone: 0.71, metaphone: 0.145, soundex: 0.145 },
            confidence: 0.2689,
          },
        },
        usage: { input_tokens: 84, output_tokens: 0 },
        routing: { model: "english", repo: "stub", reason: "latin script" },
      }),
    );

    const result = await evaluateSystemOne(REQUEST, { baseUrl: "http://127.0.0.1:8000" });

    expect(noulProbability(result.answers["phonetic"], "phonetic")).toBe(0.93);
    expect(result.answers["encoder"]?.choice).toBe("double_metaphone");
    expect(result.answers["encoder"]?.probabilities?.["soundex"]).toBe(0.145);
    expect(result.routing?.model).toBe("english");
  });

  it("reports the status when the server rejects the request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("question 'phonetic' is malformed", { status: 422 }),
    );

    await expect(evaluateSystemOne(REQUEST, { baseUrl: "http://127.0.0.1:8000" })).rejects.toThrow(
      /422/,
    );
  });

  it("rejects a payload without an answers map", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ detail: "no model loaded" }));

    await expect(evaluateSystemOne(REQUEST, { baseUrl: "http://127.0.0.1:8000" })).rejects.toThrow(
      /unexpected payload/,
    );
  });
});

describe(noulProbability, () => {
  it("returns the probability of true", () => {
    expect(noulProbability({ noul: 0.73 }, "phonetic")).toBe(0.73);
  });

  it("throws rather than read a missing answer as false", () => {
    expect(() => noulProbability(undefined, "phonetic")).toThrow(/no noul probability/);
    expect(() => noulProbability({ confidence: 0.9 }, "phonetic")).toThrow(/no noul probability/);
  });

  it("throws on a probability outside [0, 1]", () => {
    expect(() => noulProbability({ noul: 1.4 }, "phonetic")).toThrow(/outside/);
  });
});

describe(noulConfidence, () => {
  it("prefers the server's own confidence", () => {
    expect(noulConfidence({ confidence: 0.42 }, 0.99)).toBe(0.42);
  });

  it("derives the same [0.5, 1] quantity when the server sends none", () => {
    expect(noulConfidence({}, 0.9)).toBeCloseTo(0.9);
    expect(noulConfidence({}, 0.1)).toBeCloseTo(0.9);
    expect(noulConfidence({}, 0.5)).toBe(0.5);
  });
});
