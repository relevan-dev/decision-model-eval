import { PHONETIC_ENCODERS, type PhoneticEncoder } from "./mapping";
import {
  fieldLanguage,
  type FieldMapping,
  type IndexMapping,
} from "./mapping";

import type { ChoiceQuestion, NoulQuestion } from "./system-one";

// Turns one mapping field into the state and the two typed questions the
// decision model answers: enable phonetic matching, and which encoder. Both
// questions go in one request, because the protocol answers a whole question
// map in a single forward pass.

/** Question name for the enable decision. Also the answer key in the response. */
export const ENABLE_QUESTION = "phonetic";
/** Question name for the index-level gate of a gated run. */
export const GATE_QUESTION = "index_needs_phonetic";
/** Question name for the encoder decision. */
export const ENCODER_QUESTION = "encoder";

/** One field of one index, with the sample values the model reads. */
export interface FieldCandidate {
  name: string;
  mapping: FieldMapping;
  /** Real values from the customer's documents. */
  samples: readonly string[];
}

/** The index the candidate belongs to, for the state's surrounding context. */
export interface IndexContext {
  indexName: string;
  /** What the index holds, in the customer's words. */
  description: string;
}

/**
 * Whether a field can carry a `.phonetic` subfield at all.
 *
 * A phonetic subfield matches names typed into a search box, so it belongs on
 * searchable text. The Relevan converter this eval came from rejects a
 * phonetic config on any other field, which makes a wrong answer a failed
 * index build rather than a weak match. The eval therefore filters on the declared
 * mapping first and asks the model only about fields that could legally get
 * the subfield. Run the eval with `--no-guardrail` to remove this filter and
 * measure the model without it.
 */
export function isPhoneticCandidate(field: FieldMapping): boolean {
  const isText = field.kind === undefined || field.kind === "text";
  return isText && field.use.includes("searchable");
}

/** Candidate fields of a mapping, in declaration order. */
export function phoneticCandidates(
  mapping: IndexMapping,
  samples: Record<string, readonly string[]>,
  guardrail: boolean,
): FieldCandidate[] {
  return Object.entries(mapping.fields)
    .filter(([, field]) => !guardrail || isPhoneticCandidate(field))
    .map(([name, field]) => ({ name, mapping: field, samples: samples[name] ?? [] }));
}

/**
 * The state the model decides over. It is a plain object, not prose: the
 * protocol serializes structured state intact, and the field's declared
 * capabilities carry as much signal as its name does.
 */
export function phoneticState(
  context: IndexContext,
  candidate: FieldCandidate,
  mapping: IndexMapping,
) {
  return {
    index: context.indexName,
    index_contents: context.description,
    field: candidate.name,
    declared_type: candidate.mapping.kind ?? "text",
    search_capabilities: [...candidate.mapping.use],
    analyzer_language: fieldLanguage(mapping, candidate.mapping),
    sample_values: [...candidate.samples],
  };
}

const ENABLE_INSTRUCTIONS =
  "Would phonetic matching on this field help users find named entities " +
  "when a query and stored value sound alike but are spelled differently? " +
  "Judge from the field's purpose and sample values; ordinary typing errors " +
  "alone are not a reason to enable it.";

const ENCODER_DESCRIPTIONS: Record<PhoneticEncoder, string> = {
  double_metaphone:
    "Default for phonetic matching of names. Use when there is no verified " +
    "requirement for a specific older encoder, including for English names.",
  metaphone:
    "Use only when an existing system requires this specific Metaphone " +
    "implementation, or tests on this index's names show it works better.",
  soundex:
    "Use only when an existing system requires compatible Soundex codes, " +
    "or tests on this index's names show it works better.",
};

/** The enable question. Its answer is the probability that phonetic matching helps. */
export function enableQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions: ENABLE_INSTRUCTIONS,
    criteria: {
      false:
        "the field holds prose, descriptions, product codes, identifiers, URLs, " +
        "e-mail addresses, or numbers, where sound-alike matching only adds wrong results",
      true:
        "the field holds people's names, company names, place names, or brand names, " +
        "which users often spell wrong but say the same way",
    },
  };
}

/** The encoder question, over the encoders the mapping feature supports. */
export function encoderQuestion(): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const encoder of PHONETIC_ENCODERS) {
    criteria[encoder] = ENCODER_DESCRIPTIONS[encoder];
  }
  return {
    type: "choice",
    instructions: "Read what the index holds. Which statement about this index is true?",
    criteria,
  };
}

/**
 * The gate question: does any field of this index need phonetic matching? A
 * gated run asks it once per index, over the index state, and skips the field
 * calls when the answer is no.
 */
export function gateQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "Does any field in this index hold named entities that users search for " +
      "by how they sound, and so would benefit from phonetic matching?",
    criteria: {
      false:
        "every field holds prose, log text, identifiers, codes, or a controlled " +
        "vocabulary, where sound-alike matching only adds wrong results",
      true:
        "at least one field holds people's names, company names, place names, or " +
        "brand names, which users often hear and then spell wrong",
    },
  };
}

/** Both questions, as one map, so the server answers them in one pass. */
export function phoneticQuestions() {
  return { [ENABLE_QUESTION]: enableQuestion(), [ENCODER_QUESTION]: encoderQuestion() };
}

/** The enable question alone, for a chained run that decides the encoder first. */
export function enableQuestions() {
  return { [ENABLE_QUESTION]: enableQuestion() };
}

/** The encoder question alone, for the index-level call of a chained run. */
export function encoderQuestions() {
  return { [ENCODER_QUESTION]: encoderQuestion() };
}

/**
 * The state for the index-level encoder call. The encoder suits a whole index,
 * not one field: every case in `cases.ts` gives all its phonetic fields the
 * same encoder, and the reason to depart from the default sits in the index
 * description rather than in any field. So this state names the index and what
 * it holds, and lists the fields only as context.
 */
export function indexState(
  context: IndexContext,
  mapping: IndexMapping,
  samples: Record<string, readonly string[]>,
) {
  const fields: Record<string, string> = {};
  for (const name of Object.keys(mapping.fields)) {
    fields[name] = (samples[name] ?? []).join(", ");
  }
  return {
    index: context.indexName,
    index_contents: context.description,
    fields,
  };
}
