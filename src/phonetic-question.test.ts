import { type IndexMapping, PHONETIC_ENCODERS } from "./mapping";

import { describe, expect, it } from "vitest";

import {
  ENABLE_QUESTION,
  ENCODER_QUESTION,
  encoderQuestion,
  isPhoneticCandidate,
  phoneticCandidates,
  phoneticQuestions,
  phoneticState,
} from "./phonetic-question";

const MAPPING: IndexMapping = {
  language: "english",
  fields: {
    candidateName: { use: ["searchable", "autocompletable"], kind: "text", language: "none" },
    summary: { use: ["searchable"], kind: "text" },
    inferred: { use: ["searchable"] },
    sku: { use: ["searchable"], kind: "id" },
    yearsExperience: { use: ["filterable"], kind: "number" },
    phone: { use: ["filterable"], kind: "text" },
  },
};

describe(isPhoneticCandidate, () => {
  it("accepts a searchable text field", () => {
    expect(isPhoneticCandidate({ use: ["searchable"], kind: "text" })).toBeTruthy();
  });

  it("accepts a searchable field with no declared kind, since text is inferred", () => {
    expect(isPhoneticCandidate({ use: ["searchable"] })).toBeTruthy();
  });

  it("rejects a field that is not text, which the converter would throw on", () => {
    expect(isPhoneticCandidate({ use: ["searchable"], kind: "id" })).toBeFalsy();
    expect(isPhoneticCandidate({ use: ["searchable"], kind: "number" })).toBeFalsy();
  });

  it("rejects a text field no query can reach", () => {
    expect(isPhoneticCandidate({ use: ["filterable"], kind: "text" })).toBeFalsy();
  });
});

describe(phoneticCandidates, () => {
  it("keeps only legal fields when the guardrail is on", () => {
    const names = phoneticCandidates(MAPPING, {}, true).map((item) => item.name);
    expect(names).toEqual(["candidateName", "summary", "inferred"]);
  });

  it("keeps every field when the guardrail is off", () => {
    const names = phoneticCandidates(MAPPING, {}, false).map((item) => item.name);
    expect(names).toHaveLength(6);
  });

  it("attaches the samples for each field and defaults to none", () => {
    const candidates = phoneticCandidates(MAPPING, { candidateName: ["Siobhán"] }, true);
    expect(candidates[0]?.samples).toEqual(["Siobhán"]);
    expect(candidates[1]?.samples).toEqual([]);
  });
});

describe(phoneticState, () => {
  const context = { indexName: "recruiter-candidates", description: "Candidate records." };

  it("carries the field's declared capabilities and samples", () => {
    const candidate = {
      name: "candidateName",
      mapping: { use: ["searchable", "autocompletable"], kind: "text", language: "none" },
      samples: ["Krzysztof Nowak"],
    } as const;
    const state = phoneticState(context, candidate, MAPPING);

    expect(state).toEqual({
      index: "recruiter-candidates",
      index_contents: "Candidate records.",
      field: "candidateName",
      declared_type: "text",
      search_capabilities: ["searchable", "autocompletable"],
      analyzer_language: "none",
      sample_values: ["Krzysztof Nowak"],
    });
  });

  it("falls back to the mapping's language and to a text type", () => {
    const candidate = { name: "inferred", mapping: { use: ["searchable"] }, samples: [] } as const;
    const state = phoneticState(context, candidate, MAPPING);

    expect(state.analyzer_language).toBe("english");
    expect(state.declared_type).toBe("text");
  });
});

describe(phoneticQuestions, () => {
  it("asks both questions in one map, so one pass answers them", () => {
    expect(Object.keys(phoneticQuestions())).toEqual([ENABLE_QUESTION, ENCODER_QUESTION]);
  });

  it("offers exactly the encoders the mapping feature supports", () => {
    expect(Object.keys(encoderQuestion().criteria)).toEqual([...PHONETIC_ENCODERS]);
  });

  it("gives the enable question both slots, so neither is left to a default", () => {
    const question = phoneticQuestions()[ENABLE_QUESTION];
    expect(Object.keys(question.criteria ?? {})).toEqual(["false", "true"]);
  });
});
