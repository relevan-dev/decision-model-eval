import {
  type PhoneticConfig,
  PHONETIC_ENCODERS,
  type PhoneticEncoder,
} from "./mapping";

import type { EvalCase } from "./cases";

import {
  ENABLE_QUESTION,
  ENCODER_QUESTION,
  GATE_QUESTION,
  type FieldCandidate,
  type IndexContext,
  enableQuestions,
  encoderQuestion,
  encoderQuestions,
  gateQuestion,
  indexState,
  phoneticCandidates,
  phoneticQuestions,
  phoneticState,
} from "./phonetic-question";
import {
  type DecisionModel,
  noulConfidence,
  noulProbability,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./system-one";

// Runs the decision for one field and then for one whole index, and turns the
// answers into the phonetic config for that index. Assembling the real config
// is the point: the run ends at a config a person can review and apply, not
// only at a score.

/** What the model decided about one field. */
export interface FieldDecision {
  field: string;
  /** Probability that phonetic matching helps this field. */
  probability: number;
  /** The server's confidence in the enable answer, on [0.5, 1]. */
  confidence: number;
  /** True when `probability` clears the threshold and confidence is sufficient. */
  enabled: boolean;
  /** True when confidence fell below the gate, so no decision was taken. */
  abstained: boolean;
  /** The encoder the model chose. Read only when `enabled` is true. */
  encoder: PhoneticEncoder;
  encoderConfidence: number;
  /** True when the index-level gate turned the field off, with no field call. */
  gated?: boolean;
}

export interface DecideOptions {
  /** Probability at or above which phonetic matching is enabled. Defaults to 0.5. */
  threshold?: number;
  /**
   * Confidence below which the field is left to a human instead of decided.
   * The scale is the `noul` answer's, on [0.5, 1], so 0.5 holds nothing.
   * Defaults to 0, which decides every field.
   */
  minConfidence?: number;
  /** Keep only fields that could legally carry the subfield. Defaults to true. */
  guardrail?: boolean;
  /**
   * Decide the encoder once per index, then ask each field only whether to
   * enable phonetic matching. Defaults to false, which asks both questions
   * about every field.
   */
  chain?: boolean;
  /**
   * Ask once per index whether any field needs phonetic matching, and skip the
   * field calls when the answer is no. With `chain`, the same index call also
   * asks the encoder question. Defaults to false.
   */
  gate?: boolean;
}

export const DEFAULT_THRESHOLD = 0.5;

function isEncoder(value: string): value is PhoneticEncoder {
  return (PHONETIC_ENCODERS as readonly string[]).includes(value);
}

/**
 * Reads one field's decision out of a response. An unknown encoder name is a
 * fault, not a silent fallback: the config schema rejects it, so the eval must
 * count it rather than repair it.
 */
export function readDecision(
  field: string,
  response: SystemOneResponse,
  options: DecideOptions = {},
  decided?: { encoder: PhoneticEncoder; confidence: number },
): FieldDecision {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minConfidence = options.minConfidence ?? 0;

  const enableAnswer = response.answers[ENABLE_QUESTION];
  const probability = noulProbability(enableAnswer, ENABLE_QUESTION);
  const confidence = noulConfidence(enableAnswer ?? {}, probability);

  const abstained = confidence < minConfidence;
  if (decided !== undefined) {
    return {
      field,
      probability,
      confidence,
      enabled: !abstained && probability >= threshold,
      abstained,
      encoder: decided.encoder,
      encoderConfidence: decided.confidence,
    };
  }

  const encoderAnswer = response.answers[ENCODER_QUESTION];
  const choice = encoderAnswer?.choice;
  if (choice === undefined) {
    throw new Error(`Question "${ENCODER_QUESTION}" returned no choice for field "${field}".`);
  }
  if (!isEncoder(choice)) {
    throw new Error(
      `Question "${ENCODER_QUESTION}" chose "${choice}" for field "${field}", ` +
        `which is not one of: ${PHONETIC_ENCODERS.join(", ")}.`,
    );
  }

  return {
    field,
    probability,
    confidence,
    enabled: !abstained && probability >= threshold,
    abstained,
    encoder: choice,
    encoderConfidence: encoderAnswer?.confidence ?? 0,
  };
}

/** The index-level context an eval case carries, for the state builders. */
function indexContextOf(evalCase: EvalCase): IndexContext {
  return { indexName: evalCase.indexName, description: evalCase.description };
}

/** One call to the model, for the latency report. */
export interface CallRecord {
  /** `field` for a field call, `index` for the index-level call of a chained or gated run. */
  kind: "field" | "index";
  /** Wall-clock milliseconds from request to parsed answer. */
  ms: number;
  /** True when the backend reports that a fallback model answered. */
  fallback: boolean;
}

/** Sends one request and records how long it took. */
async function timedCall(
  model: DecisionModel,
  request: SystemOneRequest,
  kind: CallRecord["kind"],
  calls: CallRecord[],
): Promise<SystemOneResponse> {
  const start = performance.now();
  const response = await model(request);
  calls.push({
    kind,
    ms: performance.now() - start,
    fallback: response.routing?.reason === "fallback",
  });
  return response;
}

/** Decides one field. */
export async function decideField(
  candidate: FieldCandidate,
  evalCase: EvalCase,
  model: DecisionModel,
  options: DecideOptions = {},
  decided?: { encoder: PhoneticEncoder; confidence: number },
  calls: CallRecord[] = [],
): Promise<FieldDecision> {
  const response = await timedCall(
    model,
    {
      state: phoneticState(indexContextOf(evalCase), candidate, evalCase.mapping),
      questions: decided === undefined ? phoneticQuestions() : enableQuestions(),
    },
    "field",
    calls,
  );
  return readDecision(candidate.name, response, options, decided);
}

/**
 * The index-level call of a chained run. It asks the encoder question once,
 * over the index rather than over a field.
 */
export async function decideEncoder(
  context: IndexContext,
  mapping: EvalCase["mapping"],
  samples: EvalCase["samples"],
  model: DecisionModel,
  calls: CallRecord[] = [],
): Promise<{ encoder: PhoneticEncoder; confidence: number }> {
  const response = await timedCall(
    model,
    { state: indexState(context, mapping, samples), questions: encoderQuestions() },
    "index",
    calls,
  );
  return readEncoder(context, response);
}

/** Reads the index-level encoder answer, rejecting a missing or unknown one. */
function readEncoder(
  context: IndexContext,
  response: SystemOneResponse,
): { encoder: PhoneticEncoder; confidence: number } {
  const answer = response.answers[ENCODER_QUESTION];
  const choice = answer?.choice;
  if (choice === undefined) {
    throw new Error(
      `Question "${ENCODER_QUESTION}" returned no choice for index "${context.indexName}".`,
    );
  }
  if (!isEncoder(choice)) {
    throw new Error(
      `Question "${ENCODER_QUESTION}" chose "${choice}" for index "${context.indexName}", ` +
        `which is not one of: ${PHONETIC_ENCODERS.join(", ")}.`,
    );
  }
  return { encoder: choice, confidence: answer?.confidence ?? 0 };
}

/** Every decision taken for one index, plus the config they add up to. */
export interface IndexDecision {
  indexName: string;
  decisions: FieldDecision[];
  /** The phonetic config the decisions add up to. */
  config: PhoneticConfig;
  /** Every call made for this index, in order. */
  calls: CallRecord[];
}

/**
 * Builds the phonetic config from a set of field decisions. An abstained or
 * rejected field is absent, so it gets no subfield.
 */
export function toPhoneticConfig(decisions: readonly FieldDecision[]): PhoneticConfig {
  const fields: PhoneticConfig["fields"] = {};
  for (const decision of decisions) {
    if (decision.enabled) {
      fields[decision.field] = { encoder: decision.encoder };
    }
  }
  return { fields };
}

/**
 * The index-level call of a gated run. It asks the gate question, and with
 * `chain` the encoder question too, in one request over the index state.
 */
export async function decideGate(
  context: IndexContext,
  mapping: EvalCase["mapping"],
  samples: EvalCase["samples"],
  model: DecisionModel,
  chain: boolean,
  calls: CallRecord[] = [],
): Promise<{
  probability: number;
  confidence: number;
  decided?: { encoder: PhoneticEncoder; confidence: number };
}> {
  const questions: SystemOneRequest["questions"] = { [GATE_QUESTION]: gateQuestion() };
  if (chain) {
    questions[ENCODER_QUESTION] = encoderQuestion();
  }
  const response = await timedCall(
    model,
    { state: indexState(context, mapping, samples), questions },
    "index",
    calls,
  );
  const answer = response.answers[GATE_QUESTION];
  const probability = noulProbability(answer, GATE_QUESTION);
  return {
    probability,
    confidence: noulConfidence(answer ?? {}, probability),
    decided: chain ? readEncoder(context, response) : undefined,
  };
}

/** Decides every candidate field of one index, one request per field. */
export async function decideIndex(
  evalCase: EvalCase,
  model: DecisionModel,
  options: DecideOptions = {},
): Promise<IndexDecision> {
  const candidates = phoneticCandidates(
    evalCase.mapping,
    evalCase.samples,
    options.guardrail ?? true,
  );
  const calls: CallRecord[] = [];
  const context = indexContextOf(evalCase);
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  let decided: { encoder: PhoneticEncoder; confidence: number } | undefined;
  if (options.gate) {
    const gate = await decideGate(
      context,
      evalCase.mapping,
      evalCase.samples,
      model,
      options.chain ?? false,
      calls,
    );
    if (gate.probability < threshold) {
      // The gate said no: every field is off, and no field call is made. Each
      // field carries the gate's probability, so the Brier score still covers it.
      const decisions = candidates.map((candidate) => ({
        field: candidate.name,
        probability: gate.probability,
        confidence: gate.confidence,
        enabled: false,
        abstained: false,
        encoder: "double_metaphone" as const,
        encoderConfidence: 0,
        gated: true,
      }));
      return { indexName: evalCase.indexName, decisions, config: toPhoneticConfig(decisions), calls };
    }
    decided = gate.decided;
  } else if (options.chain) {
    // The chained run decides the encoder once, before any field call.
    decided = await decideEncoder(context, evalCase.mapping, evalCase.samples, model, calls);
  }

  // One call at a time, so each latency measures one call and not a queue. A
  // CPU `laya-serve` answers from a single process anyway.
  const decisions: FieldDecision[] = [];
  for (const candidate of candidates) {
    decisions.push(await decideField(candidate, evalCase, model, options, decided, calls));
  }

  return {
    indexName: evalCase.indexName,
    decisions,
    config: toPhoneticConfig(decisions),
    calls,
  };
}
