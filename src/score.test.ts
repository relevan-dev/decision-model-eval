import type { PhoneticEncoder } from "./mapping";

import { describe, expect, it } from "vitest";

import type { EvalCase } from "./cases";

import { type FieldDecision, type IndexDecision, toPhoneticConfig } from "./decide-phonetic";
import {
  calibrationBuckets,
  sameConfig,
  scoreIndex,
  summarize,
  summarizeLatency,
} from "./score";

function decision(
  field: string,
  probability: number,
  encoder: PhoneticEncoder = "double_metaphone",
): FieldDecision {
  return {
    field,
    probability,
    confidence: Math.abs(probability - 0.5) * 2,
    enabled: probability >= 0.5,
    abstained: false,
    encoder,
    encoderConfidence: 0.8,
  };
}

function indexDecision(indexName: string, decisions: FieldDecision[]): IndexDecision {
  return { indexName, decisions, config: toPhoneticConfig(decisions), calls: [] };
}

const CASE: EvalCase = {
  indexName: "people",
  description: "People.",
  mapping: {
    fields: {
      name: { use: ["searchable"], kind: "text" },
      bio: { use: ["searchable"], kind: "text" },
      city: { use: ["searchable"], kind: "text" },
    },
  },
  samples: { name: ["Meyer"], bio: ["A long biography."], city: ["Bicester"] },
  expected: {
    fields: { name: { encoder: "double_metaphone" }, city: { encoder: "metaphone" } },
  },
};

describe(scoreIndex, () => {
  it("marks a correct enable decision and a correct encoder", () => {
    const [scored] = scoreIndex(CASE, indexDecision("people", [decision("name", 0.95)]));

    expect(scored).toMatchObject({
      expectedEnabled: true,
      enableCorrect: true,
      encoderCorrect: true,
    });
  });

  it("separates a right enable decision from a wrong encoder", () => {
    const [scored] = scoreIndex(CASE, indexDecision("people", [decision("city", 0.9)]));

    expect(scored?.enableCorrect).toBeTruthy();
    expect(scored?.encoderCorrect).toBeFalsy();
  });

  it("does not score the encoder where the field should be off", () => {
    const [scored] = scoreIndex(CASE, indexDecision("people", [decision("bio", 0.8)]));

    expect(scored?.enableCorrect).toBeFalsy();
    expect(scored?.encoderCorrect).toBeUndefined();
  });
});

describe(summarize, () => {
  const result = indexDecision("people", [
    decision("name", 0.95),
    decision("bio", 0.7),
    decision("city", 0.92, "metaphone"),
  ]);
  const summary = summarize([CASE], [result]);

  it("counts each cell of the confusion matrix", () => {
    expect(summary.matrix).toEqual({
      truePositive: 2,
      falsePositive: 1,
      trueNegative: 0,
      falseNegative: 0,
    });
  });

  it("derives precision and recall from the matrix", () => {
    expect(summary.precision).toBeCloseTo(2 / 3);
    expect(summary.recall).toBe(1);
    expect(summary.accuracy).toBeCloseTo(2 / 3);
  });

  it("reports full coverage when nothing was held", () => {
    expect(summary.coverage).toBe(1);
  });

  it("scores the encoder only over correctly enabled fields", () => {
    expect(summary.encoderScored).toBe(2);
    expect(summary.encoderAccuracy).toBe(1);
  });

  it("counts a whole config as wrong when one field is extra", () => {
    expect(summary.exactConfigMatches).toBe(0);
  });

  it("measures the probabilities with a Brier score", () => {
    const expected = (0.05 ** 2 + 0.7 ** 2 + 0.08 ** 2) / 3;
    expect(summary.brierScore).toBeCloseTo(expected);
  });

  it("counts held fields separately from decided ones", () => {
    const held = { ...decision("bio", 0.7), enabled: false, abstained: true };
    const withHeld = summarize([CASE], [indexDecision("people", [held])]);

    expect(withHeld.abstentions).toBe(1);
    expect(withHeld.coverage).toBe(0);
  });

  it("keeps a held field out of the matrix, so gating cannot look like a wrong answer", () => {
    const held = { ...decision("name", 0.95), enabled: false, abstained: true };
    const gated = summarize([CASE], [indexDecision("people", [held, decision("bio", 0.1)])]);

    // `name` should be on, but it was held, so it is neither a false negative
    // nor a wrong answer — only uncovered.
    expect(gated.matrix.falseNegative).toBe(0);
    expect(gated.accuracy).toBe(1);
    expect(gated.coverage).toBe(0.5);
  });

  it("still scores a held field's probability, which exists either way", () => {
    const held = { ...decision("name", 0.95), enabled: false, abstained: true };
    const gated = summarize([CASE], [indexDecision("people", [held])]);

    expect(gated.brierScore).toBeCloseTo(0.05 ** 2);
    expect(gated.calibration.at(-1)?.count).toBe(1);
  });
});

describe(calibrationBuckets, () => {
  it("puts a probability of exactly 1 in the last bucket", () => {
    const fields = scoreIndex(CASE, indexDecision("people", [decision("name", 1)]));
    const buckets = calibrationBuckets(fields);

    expect(buckets.at(-1)?.count).toBe(1);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
  });

  it("compares the stated probability with the observed rate", () => {
    const fields = scoreIndex(
      CASE,
      indexDecision("people", [decision("name", 0.9), decision("bio", 0.85)]),
    );
    const [bucket] = calibrationBuckets(fields).filter((item) => item.count > 0);

    expect(bucket?.count).toBe(2);
    expect(bucket?.meanProbability).toBeCloseTo(0.875);
    expect(bucket?.observedRate).toBe(0.5);
  });
});

describe(sameConfig, () => {
  it("accepts the labelled config", () => {
    const result = indexDecision("people", [
      decision("name", 0.95),
      decision("city", 0.92, "metaphone"),
      decision("bio", 0.1),
    ]);
    expect(sameConfig(CASE, result)).toBeTruthy();
  });

  it("rejects a config that names the right fields with the wrong encoder", () => {
    const result = indexDecision("people", [decision("name", 0.95), decision("city", 0.92)]);
    expect(sameConfig(CASE, result)).toBeFalsy();
  });

  it("rejects a config that misses a field", () => {
    expect(sameConfig(CASE, indexDecision("people", [decision("name", 0.95)]))).toBeFalsy();
  });
});

describe(summarizeLatency, () => {
  function withCalls(ms: number[], fallbacks = 0): IndexDecision {
    return {
      ...indexDecision("people", []),
      calls: ms.map((value, index) => ({ kind: "field", ms: value, fallback: index < fallbacks })),
    };
  }

  it("reports nearest-rank percentiles over every call of every index", () => {
    const latency = summarizeLatency([withCalls([100, 300]), withCalls([200, 400, 1000])]);

    expect(latency).toMatchObject({
      calls: 5,
      p50Ms: 300,
      p95Ms: 1000,
      maxMs: 1000,
      totalMs: 2000,
      meanMs: 400,
    });
  });

  it("counts the calls a fallback model answered", () => {
    expect(summarizeLatency([withCalls([10, 20, 30], 2)]).fallbacks).toBe(2);
  });

  it("reports zeros for a run with no calls", () => {
    expect(summarizeLatency([])).toMatchObject({ calls: 0, p50Ms: 0, meanMs: 0 });
  });
});
