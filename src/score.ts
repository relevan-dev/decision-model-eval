import type { EvalCase } from "./cases";
import type { FieldDecision, IndexDecision } from "./decide-phonetic";

// Scores the model's decisions against the labels in `cases.ts`.
//
// Three numbers matter, and they answer different questions:
//
// 1. The confusion matrix says whether the model turns the feature on for the
//    right fields. A false positive costs a wrong `.phonetic` clause in every
//    query; a false negative costs the misspelling match the customer wanted.
// 2. Encoder accuracy says whether it picks the right analyzer once it decides
//    to act. It is scored only where the enable decision was already correct.
// 3. The Brier score says whether the probabilities mean anything. A model
//    whose confidence is meaningful can be gated; one whose confidence is not
//    has to be reviewed field by field, which removes the reason to use it.
//
// Latency is reported beside them, because a model that is correct but slow
// may not fit where the decision has to run.
//
// A field held back by `--min-confidence` is not a decision, so it is left out
// of the first two: counting a held field as a wrong answer would make the
// confidence gate look worse the better it works. `coverage` reports how much
// of the set the model decided, and the Brier score still covers every field,
// because the probability exists whether or not it was acted on.

/** One scored field: what the model said, and what the label says. */
export interface ScoredField {
  indexName: string;
  field: string;
  expectedEnabled: boolean;
  expectedEncoder?: string;
  decision: FieldDecision;
  /** True when the enable decision matches the label. */
  enableCorrect: boolean;
  /** True when both sides enable the field and the encoders agree. */
  encoderCorrect: boolean | undefined;
}

export interface ConfusionMatrix {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
}

/** One calibration bucket: the model's stated probability against the outcome. */
export interface CalibrationBucket {
  /** Lower bound of the probability range, inclusive. */
  lower: number;
  /** Upper bound, exclusive except for the last bucket. */
  upper: number;
  count: number;
  /** Mean probability the model gave in this bucket. */
  meanProbability: number;
  /** Share of fields in this bucket the label actually enables. */
  observedRate: number;
}

export interface EvalSummary {
  fields: ScoredField[];
  /** Counted over decided fields only; held fields appear in `abstentions`. */
  matrix: ConfusionMatrix;
  /** Share of decided fields whose enable decision matches the label. */
  accuracy: number;
  /** Of the fields the model enabled, the share it should have enabled. */
  precision: number;
  /** Of the fields the label enables, the share the model enabled. */
  recall: number;
  /** Share of correct encoder choices among correctly enabled fields. */
  encoderAccuracy: number;
  encoderScored: number;
  /** Indexes whose whole assembled config equals the labelled config. */
  exactConfigMatches: number;
  indexCount: number;
  /** Mean squared error of the enable probability, over every field. Lower is better. */
  brierScore: number;
  calibration: CalibrationBucket[];
  /** Fields held for review instead of decided. */
  abstentions: number;
  /** Share of fields the model decided. 1 when nothing was held. */
  coverage: number;
  latency: LatencySummary;
}

/** Per-call latency over every call of the run, in milliseconds. */
export interface LatencySummary {
  calls: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Sum of every call: the run time without the harness itself. */
  totalMs: number;
  /** Calls a fallback model answered. */
  fallbacks: number;
}

/** Nearest-rank percentile of a sorted list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

/** Summarizes the calls of every index. */
export function summarizeLatency(results: readonly IndexDecision[]): LatencySummary {
  const calls = results.flatMap((result) => result.calls);
  const sorted = calls.map((call) => call.ms).toSorted((left, right) => left - right);
  const totalMs = sorted.reduce((sum, ms) => sum + ms, 0);
  return {
    calls: sorted.length,
    meanMs: ratio(totalMs, sorted.length),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
    totalMs,
    fallbacks: calls.filter((call) => call.fallback).length,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Scores one index's decisions against its labels. */
export function scoreIndex(evalCase: EvalCase, result: IndexDecision): ScoredField[] {
  return result.decisions.map((decision) => {
    const expectedEncoder = evalCase.expected.fields[decision.field]?.encoder;
    const expectedEnabled = expectedEncoder !== undefined;
    const enableCorrect = decision.enabled === expectedEnabled;
    return {
      indexName: evalCase.indexName,
      field: decision.field,
      expectedEnabled,
      expectedEncoder,
      decision,
      enableCorrect,
      encoderCorrect:
        expectedEnabled && decision.enabled ? decision.encoder === expectedEncoder : undefined,
    };
  });
}

const BUCKET_COUNT = 5;

/** Groups the enable probabilities into fixed buckets and measures each one. */
export function calibrationBuckets(fields: readonly ScoredField[]): CalibrationBucket[] {
  const width = 1 / BUCKET_COUNT;
  return Array.from({ length: BUCKET_COUNT }, (_unused, index) => {
    const lower = index * width;
    const upper = lower + width;
    const inBucket = fields.filter(({ decision }) => {
      const last = index === BUCKET_COUNT - 1;
      return (
        decision.probability >= lower &&
        (last ? decision.probability <= upper : decision.probability < upper)
      );
    });
    const total = inBucket.length;
    return {
      lower,
      upper,
      count: total,
      meanProbability: ratio(
        inBucket.reduce((sum, item) => sum + item.decision.probability, 0),
        total,
      ),
      observedRate: ratio(inBucket.filter((item) => item.expectedEnabled).length, total),
    };
  });
}

/** Builds the whole summary from every index's scored fields. */
export function summarize(
  cases: readonly EvalCase[],
  results: readonly IndexDecision[],
): EvalSummary {
  const fields = cases.flatMap((evalCase, index) => {
    const result = results[index];
    return result ? scoreIndex(evalCase, result) : [];
  });

  const decided = fields.filter((item) => !item.decision.abstained);
  const matrix: ConfusionMatrix = {
    truePositive: decided.filter((item) => item.decision.enabled && item.expectedEnabled).length,
    falsePositive: decided.filter((item) => item.decision.enabled && !item.expectedEnabled).length,
    trueNegative: decided.filter((item) => !item.decision.enabled && !item.expectedEnabled).length,
    falseNegative: decided.filter((item) => !item.decision.enabled && item.expectedEnabled).length,
  };

  const encoderScored = decided.filter((item) => item.encoderCorrect !== undefined);
  const exactConfigMatches = cases.filter((evalCase, index) => {
    const result = results[index];
    return result !== undefined && sameConfig(evalCase, result);
  }).length;

  return {
    fields,
    matrix,
    accuracy: ratio(decided.filter((item) => item.enableCorrect).length, decided.length),
    precision: ratio(matrix.truePositive, matrix.truePositive + matrix.falsePositive),
    recall: ratio(matrix.truePositive, matrix.truePositive + matrix.falseNegative),
    encoderAccuracy: ratio(
      encoderScored.filter((item) => item.encoderCorrect === true).length,
      encoderScored.length,
    ),
    encoderScored: encoderScored.length,
    exactConfigMatches,
    indexCount: cases.length,
    brierScore: ratio(
      fields.reduce(
        (sum, item) => sum + (item.decision.probability - (item.expectedEnabled ? 1 : 0)) ** 2,
        0,
      ),
      fields.length,
    ),
    calibration: calibrationBuckets(fields),
    abstentions: fields.length - decided.length,
    coverage: ratio(decided.length, fields.length),
    latency: summarizeLatency(results),
  };
}

/** True when the assembled config equals the labelled config, field for field. */
export function sameConfig(evalCase: EvalCase, result: IndexDecision): boolean {
  const expected = evalCase.expected.fields;
  const actual = result.config.fields;
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const name of names) {
    if (expected[name]?.encoder !== actual[name]?.encoder) {
      return false;
    }
  }
  return true;
}
