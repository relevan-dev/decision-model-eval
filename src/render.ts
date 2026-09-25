import type { IndexDecision } from "./decide-phonetic";
import type { EvalSummary, ScoredField } from "./score";

// Plain-text report. It prints every field the model judged, then the totals,
// then the config each index would get, so a reader can check a number against
// the row that produced it.

const PASS = "ok  ";
const FAIL = "MISS";
const HELD = "held";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fixed(value: number): string {
  return value.toFixed(3);
}

function verdict(field: ScoredField): string {
  if (field.decision.abstained) {
    return HELD;
  }
  if (!field.enableCorrect) {
    return FAIL;
  }
  return field.encoderCorrect === false ? FAIL : PASS;
}

function expectation(field: ScoredField): string {
  return field.expectedEncoder ?? "off";
}

function outcome(field: ScoredField): string {
  return field.decision.enabled ? field.decision.encoder : "off";
}

/** One line per field: what the model said, what the label says, and whether they agree. */
export function renderFields(fields: readonly ScoredField[]): string {
  const rows = fields.map((field) => {
    const name = `${field.indexName}.${field.field}`.padEnd(42);
    const probability = fixed(field.decision.probability).padStart(6);
    const confidence = fixed(field.decision.confidence).padStart(6);
    return `  ${verdict(field)}  ${name} p=${probability} conf=${confidence}  ${outcome(field).padEnd(17)} want ${expectation(field)}`;
  });
  return ["Per-field decisions", ...rows].join("\n");
}

/** The confusion matrix and the rates derived from it. */
export function renderTotals(summary: EvalSummary): string {
  const { matrix } = summary;
  return [
    "Totals",
    `  fields scored          ${summary.fields.length}`,
    `  coverage               ${percent(summary.coverage)} (decided rather than held)`,
    `  enable accuracy        ${percent(summary.accuracy)} (over the decided fields)`,
    `  precision              ${percent(summary.precision)} (of the fields it turned on)`,
    `  recall                 ${percent(summary.recall)} (of the fields that should be on)`,
    `  true positive          ${matrix.truePositive}`,
    `  false positive         ${matrix.falsePositive} (adds a wrong phonetic clause)`,
    `  true negative          ${matrix.trueNegative}`,
    `  false negative         ${matrix.falseNegative} (misses the misspelling match)`,
    `  encoder accuracy       ${percent(summary.encoderAccuracy)} (over ${summary.encoderScored} correctly enabled fields)`,
    `  whole configs correct  ${summary.exactConfigMatches} of ${summary.indexCount}`,
    `  Brier score            ${fixed(summary.brierScore)} (0 is perfect, 0.25 is a coin flip)`,
    `  held for review        ${summary.abstentions} (left out of the rates above)`,
  ].join("\n");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Per-call latency. */
export function renderLatency(summary: EvalSummary): string {
  const { latency } = summary;
  return [
    "Latency",
    `  calls                  ${latency.calls}`,
    `  median per call        ${seconds(latency.p50Ms)}`,
    `  95th percentile        ${seconds(latency.p95Ms)}`,
    `  slowest call           ${seconds(latency.maxMs)}`,
    `  mean per call          ${seconds(latency.meanMs)}`,
    `  total                  ${seconds(latency.totalMs)}`,
    `  fallback answers       ${latency.fallbacks} (a second model answered after a refusal)`,
  ].join("\n");
}

/** Stated probability against observed rate, one row per bucket. */
export function renderCalibration(summary: EvalSummary): string {
  const rows = summary.calibration
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => {
      const range = `${bucket.lower.toFixed(1)}-${bucket.upper.toFixed(1)}`.padEnd(8);
      return `  ${range} n=${String(bucket.count).padStart(3)}  said ${fixed(bucket.meanProbability)}  actual ${fixed(bucket.observedRate)}`;
    });
  return ["Calibration", ...rows].join("\n");
}

/**
 * The config each index would get. This is the deliverable of the run: a
 * person can read a block here, review it, and apply it.
 */
export function renderConfigs(results: readonly IndexDecision[]): string {
  const blocks = results.map(
    (result) =>
      `  ${result.indexName}\n${JSON.stringify(result.config, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`,
  );
  return ["Generated phonetic configs", ...blocks].join("\n");
}

/** The whole report. */
export function renderReport(
  summary: EvalSummary,
  results: readonly IndexDecision[],
  backend: string,
): string {
  return [
    `Backend: ${backend}`,
    renderFields(summary.fields),
    renderTotals(summary),
    renderLatency(summary),
    renderCalibration(summary),
    renderConfigs(results),
  ].join("\n\n");
}

/** One row per metric, one column per backend, for a run with several backends. */
export function renderComparison(runs: readonly { label: string; summary: EvalSummary }[]): string {
  const rows: [string, (summary: EvalSummary) => string][] = [
    [
      "enable correct",
      (s) =>
        `${s.matrix.truePositive + s.matrix.trueNegative} of ${s.fields.length - s.abstentions}`,
    ],
    ["precision", (s) => percent(s.precision)],
    ["recall", (s) => percent(s.recall)],
    [
      "encoder correct",
      (s) => `${Math.round(s.encoderAccuracy * s.encoderScored)} of ${s.encoderScored}`,
    ],
    ["whole configs", (s) => `${s.exactConfigMatches} of ${s.indexCount}`],
    ["Brier score", (s) => fixed(s.brierScore)],
    ["median per call", (s) => seconds(s.latency.p50Ms)],
    ["95th percentile", (s) => seconds(s.latency.p95Ms)],
    ["total", (s) => seconds(s.latency.totalMs)],
    ["fallback answers", (s) => String(s.latency.fallbacks)],
  ];
  const width = Math.max(14, ...runs.map((run) => run.label.length)) + 2;
  const header = `  ${"".padEnd(18)}${runs.map((run) => run.label.padEnd(width)).join("")}`;
  const lines = rows.map(
    ([name, cell]) =>
      `  ${name.padEnd(18)}${runs.map((run) => cell(run.summary).padEnd(width)).join("")}`,
  );
  return ["Comparison", header, ...lines].join("\n");
}
