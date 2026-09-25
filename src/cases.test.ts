import { indexMappingSchema, phoneticConfigSchema } from "./mapping";
import { describe, expect, it } from "vitest";

import { EVAL_CASES } from "./cases";
import { isPhoneticCandidate, phoneticCandidates } from "./phonetic-question";

// The labels are the measuring stick, so they are checked against the same
// schemas the config must pass. A label the schema would reject makes every
// score meaningless.

describe("labelled cases", () => {
  it("gives every case a distinct index name", () => {
    const names = EVAL_CASES.map((item) => item.indexName);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(EVAL_CASES.map((item) => [item.indexName, item] as const))(
    "%s has a valid mapping",
    (_name, evalCase) => {
      expect(indexMappingSchema.safeParse(evalCase.mapping).success).toBeTruthy();
    },
  );

  it.each(EVAL_CASES.map((item) => [item.indexName, item] as const))(
    "%s has a valid label",
    (_name, evalCase) => {
      expect(phoneticConfigSchema.safeParse(evalCase.expected).success).toBeTruthy();
    },
  );

  it.each(EVAL_CASES.map((item) => [item.indexName, item] as const))(
    "%s labels only fields the mapping declares",
    (_name, evalCase) => {
      for (const field of Object.keys(evalCase.expected.fields)) {
        expect(evalCase.mapping.fields[field]).toBeDefined();
      }
    },
  );

  it.each(EVAL_CASES.map((item) => [item.indexName, item] as const))(
    "%s labels only fields that can carry the subfield",
    (_name, evalCase) => {
      const labelled = Object.entries(evalCase.mapping.fields).filter(
        ([field]) => evalCase.expected.fields[field] !== undefined,
      );
      for (const [, mapping] of labelled) {
        expect(isPhoneticCandidate(mapping)).toBeTruthy();
      }
    },
  );

  it.each(EVAL_CASES.map((item) => [item.indexName, item] as const))(
    "%s gives samples for every candidate field",
    (_name, evalCase) => {
      for (const candidate of phoneticCandidates(evalCase.mapping, evalCase.samples, true)) {
        expect(candidate.samples.length).toBeGreaterThan(0);
      }
    },
  );

  it("keeps the labels balanced, so accuracy is not a majority-class artefact", () => {
    const candidates = EVAL_CASES.flatMap((evalCase) =>
      phoneticCandidates(evalCase.mapping, evalCase.samples, true).map(
        (candidate) => evalCase.expected.fields[candidate.name] !== undefined,
      ),
    );
    const enabled = candidates.filter(Boolean).length;

    expect(candidates.length).toBeGreaterThanOrEqual(24);
    expect(enabled / candidates.length).toBeGreaterThan(0.4);
    expect(enabled / candidates.length).toBeLessThan(0.6);
  });

  it("labels more than one encoder, so the choice question is not a single-answer test", () => {
    const encoders = new Set(
      EVAL_CASES.flatMap((evalCase) =>
        Object.values(evalCase.expected.fields).map((field) => field.encoder),
      ),
    );
    expect(encoders).toEqual(new Set(["double_metaphone", "soundex"]));
  });
});
