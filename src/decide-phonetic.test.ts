import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionModel, SystemOneRequest, SystemOneResponse } from "./system-one";

import { evalCaseByName } from "./cases";
import { decideIndex, readDecision, toPhoneticConfig } from "./decide-phonetic";

const stateSchema = z.object({ state: z.object({ field: z.string() }) });

function response(noul: number, choice: string, confidence?: number): SystemOneResponse {
  return {
    answers: {
      phonetic: confidence === undefined ? { noul } : { noul, confidence },
      encoder: { choice, confidence: 0.77 },
    },
  };
}

describe(readDecision, () => {
  it("enables a field whose probability clears the threshold", () => {
    const decision = readDecision("candidateName", response(0.93, "double_metaphone"));

    expect(decision).toMatchObject({
      field: "candidateName",
      probability: 0.93,
      enabled: true,
      abstained: false,
      encoder: "double_metaphone",
    });
  });

  it("leaves a field off below the threshold", () => {
    expect(readDecision("summary", response(0.12, "metaphone")).enabled).toBeFalsy();
  });

  it("treats the threshold as inclusive", () => {
    expect(readDecision("city", response(0.5, "soundex")).enabled).toBeTruthy();
    expect(readDecision("city", response(0.5, "soundex"), { threshold: 0.6 }).enabled).toBeFalsy();
  });

  it("holds a field whose confidence falls below the gate", () => {
    const decision = readDecision("brand", response(0.88, "metaphone", 0.4), {
      minConfidence: 0.85,
    });

    expect(decision.abstained).toBeTruthy();
    expect(decision.enabled).toBeFalsy();
  });

  it("rejects an encoder the config schema would not accept", () => {
    expect(() => readDecision("surname", response(0.9, "koelner_phonetik"))).toThrow(
      /koelner_phonetik/,
    );
  });

  it("throws when the encoder question went unanswered", () => {
    expect(() => readDecision("surname", { answers: { phonetic: { noul: 0.9 } } })).toThrow(
      /no choice/,
    );
  });
});

describe(toPhoneticConfig, () => {
  it("builds the config from the enabled fields only", () => {
    const config = toPhoneticConfig([
      readDecision("candidateName", response(0.93, "double_metaphone")),
      readDecision("summary", response(0.04, "metaphone")),
      readDecision("surname", response(0.81, "soundex")),
    ]);

    expect(config).toEqual({
      fields: {
        candidateName: { encoder: "double_metaphone" },
        surname: { encoder: "soundex" },
      },
    });
  });

  it("returns an empty field map when nothing is enabled", () => {
    expect(toPhoneticConfig([readDecision("body", response(0.02, "metaphone"))])).toEqual({
      fields: {},
    });
  });

  it("leaves a held field out", () => {
    const held = readDecision("brand", response(0.95, "metaphone", 0.2), { minConfidence: 0.9 });
    expect(toPhoneticConfig([held]).fields).toEqual({});
  });
});

describe(decideIndex, () => {
  const evalCase = evalCaseByName("recruiter-candidates");

  /** A fake model that answers yes for the two name fields and records every request. */
  function fakeModel(fallback = false) {
    const requests: SystemOneRequest[] = [];
    const model: DecisionModel = async (request) => {
      requests.push(request);
      const { field } = stateSchema.parse(request).state;
      const isName = field === "candidateName" || field === "currentEmployer";
      return {
        ...response(isName ? 0.9 : 0.05, "double_metaphone"),
        routing: fallback ? { reason: "fallback" } : undefined,
      };
    };
    return { model, requests };
  }

  it("asks once per candidate field and assembles the config", async () => {
    const { model, requests } = fakeModel();

    const result = await decideIndex(evalCase, model);

    // Four candidates: the number field is filtered before any request.
    expect(requests).toHaveLength(4);
    expect(result.config).toEqual({
      fields: {
        candidateName: { encoder: "double_metaphone" },
        currentEmployer: { encoder: "double_metaphone" },
      },
    });
  });

  it("records one timed call per request", async () => {
    const { model } = fakeModel(true);

    const result = await decideIndex(evalCase, model);

    expect(result.calls).toHaveLength(4);
    expect(result.calls.every((call) => call.kind === "field" && call.ms >= 0)).toBeTruthy();
    expect(result.calls.every((call) => call.fallback)).toBeTruthy();
  });

  it("asks about every field when the guardrail is off", async () => {
    const { model, requests } = fakeModel();

    await decideIndex(evalCase, model, { guardrail: false });

    expect(requests).toHaveLength(5);
  });
});

describe("decideIndex with the gate", () => {
  const logs = evalCaseByName("application-logs");
  const recruiter = evalCaseByName("recruiter-candidates");

  /** Answers the gate with `gate`, the encoder with soundex, and every field with yes. */
  function gateModel(gate: number) {
    const requests: SystemOneRequest[] = [];
    const model: DecisionModel = async (request) => {
      requests.push(request);
      return {
        answers: {
          index_needs_phonetic: { noul: gate },
          encoder: { choice: "soundex" },
          phonetic: { noul: 0.9 },
        },
      };
    };
    return { model, requests };
  }

  it("makes no field call when the gate says no", async () => {
    const { model, requests } = gateModel(0.1);

    const result = await decideIndex(logs, model, { gate: true });

    expect(requests).toHaveLength(1);
    expect(result.config).toEqual({ fields: {} });
    expect(result.decisions.every((decision) => decision.gated && decision.probability === 0.1)).toBeTruthy();
    expect(result.calls.map((call) => call.kind)).toEqual(["index"]);
  });

  it("asks the fields when the gate says yes", async () => {
    const { model, requests } = gateModel(0.9);

    await decideIndex(recruiter, model, { gate: true });

    // One gate call, then one call per candidate field with both field questions.
    expect(requests).toHaveLength(5);
    expect(Object.keys(requests[1]?.questions ?? {})).toEqual(["phonetic", "encoder"]);
  });

  it("asks the gate and the encoder in one index call when chained", async () => {
    const { model, requests } = gateModel(0.9);

    const result = await decideIndex(recruiter, model, { gate: true, chain: true });

    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["index_needs_phonetic", "encoder"]);
    expect(Object.keys(requests[1]?.questions ?? {})).toEqual(["phonetic"]);
    expect(result.decisions[0]?.encoder).toBe("soundex");
  });
});
