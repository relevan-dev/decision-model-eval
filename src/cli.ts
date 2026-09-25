import { parseArgs } from "node:util";

import { type Backend, backendLabel, BACKENDS, isBackend, modelFromEnv } from "./backends";
import { EVAL_CASES, evalCaseByName, type EvalCase } from "./cases";
import {
  DEFAULT_THRESHOLD,
  decideIndex,
  type DecideOptions,
  type IndexDecision,
} from "./decide-phonetic";
import {
  enableQuestions,
  phoneticCandidates,
  phoneticQuestions,
  phoneticState,
} from "./phonetic-question";
import { renderComparison, renderReport } from "./render";
import { type EvalSummary, summarize } from "./score";
import type { DecisionModel } from "./system-one";

// Entry point. Run one backend, or several to compare them:
//
//   npm run eval -- --backend jev
//   npm run eval -- --backend laya --backend jev --backend claude
//
// `--print-requests` needs no server and no key: it writes the exact request
// bodies, which is how to read the task before paying for a run.

const USAGE = `Usage: npm run eval -- [options]

  --backend <name>      ${BACKENDS.join(", ")}. Repeatable. With more than one,
                        the run ends with a comparison table.
  --index <name>        Run one case by index name. Repeatable.
  --threshold <0-1>     Probability at or above which phonetic matching is on.
                        Default ${DEFAULT_THRESHOLD}.
  --min-confidence <0-1>  Hold a field for human review below this confidence.
                        The scale runs 0.5 (an even split) to 1 (certain), so
                        0.5 holds nothing. Default 0, which decides every field.
  --no-guardrail        Also ask about fields that cannot carry the subfield,
                        to measure the model without the type filter.
  --chain               Decide the encoder once per index, then ask each field
                        only whether to enable phonetic matching.
  --gate                Ask once per index whether any field needs phonetic
                        matching, and skip the field calls when it does not.
                        With --chain, one index call asks both questions.
  --print-requests      Print the request bodies and exit. No server needed.
  --json                Print the machine-readable summaries instead of the report.
  --help                Print this message.

Environment, per backend:
  laya    LAYA_BASE_URL (required), LAYA_API_KEY, LAYA_MODEL
  jev     JEV_API_KEY (required), JEV_BASE_URL, JEV_MODEL
  claude  ANTHROPIC_API_KEY (required), CLAUDE_MODEL`;

function parseUnitInterval(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--${flag} must be a number between 0 and 1, not "${value}".`);
  }
  return parsed;
}

function parseBackends(names: string[]): Backend[] {
  if (names.length === 0) {
    throw new Error(`Name at least one --backend: ${BACKENDS.join(", ")}.`);
  }
  return names.map((name) => {
    if (!isBackend(name)) {
      throw new Error(`Unknown backend "${name}". Available: ${BACKENDS.join(", ")}.`);
    }
    return name;
  });
}

function selectCases(names: string[]): readonly EvalCase[] {
  return names.length === 0 ? EVAL_CASES : names.map(evalCaseByName);
}

/** Writes every request body the run would send, without sending one. */
function printRequests(cases: readonly EvalCase[], options: DecideOptions) {
  for (const evalCase of cases) {
    const candidates = phoneticCandidates(
      evalCase.mapping,
      evalCase.samples,
      options.guardrail ?? true,
    );
    for (const candidate of candidates) {
      const body = {
        state: phoneticState(
          { indexName: evalCase.indexName, description: evalCase.description },
          candidate,
          evalCase.mapping,
        ),
        questions: phoneticQuestions(),
      };
      console.log(JSON.stringify(body, null, 2));
    }
  }
}

/**
 * One call before the clock starts, so the first measured call does not carry
 * a TLS handshake or a model load.
 */
async function warmUp(model: DecisionModel) {
  await model({
    state: { field: "surname", sample_values: ["Smythe", "Carrington"] },
    questions: enableQuestions(),
  });
}

async function runBackend(
  backend: Backend,
  cases: readonly EvalCase[],
  options: DecideOptions,
): Promise<{ summary: EvalSummary; results: IndexDecision[] }> {
  const model = modelFromEnv(backend);
  await warmUp(model);
  const results: IndexDecision[] = [];
  // One index at a time, so each latency measures one call and not a queue.
  for (const evalCase of cases) {
    results.push(await decideIndex(evalCase, model, options));
  }
  return { summary: summarize(cases, results), results };
}

async function main() {
  const { values } = parseArgs({
    options: {
      backend: { type: "string", multiple: true, default: [] },
      index: { type: "string", multiple: true, default: [] },
      threshold: { type: "string" },
      "min-confidence": { type: "string" },
      "no-guardrail": { type: "boolean", default: false },
      chain: { type: "boolean", default: false },
      gate: { type: "boolean", default: false },
      "print-requests": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const options: DecideOptions = {
    threshold: parseUnitInterval(values.threshold, "threshold", DEFAULT_THRESHOLD),
    minConfidence: parseUnitInterval(values["min-confidence"], "min-confidence", 0),
    guardrail: !values["no-guardrail"],
    chain: values.chain,
    gate: values.gate,
  };
  const cases = selectCases(values.index);

  if (values["print-requests"]) {
    printRequests(cases, options);
    return;
  }

  const backends = parseBackends(values.backend);
  const runs: { label: string; summary: EvalSummary }[] = [];
  // One backend at a time, so the latencies of two backends do not overlap.
  for (const backend of backends) {
    const label = backendLabel(backend);
    const { summary, results } = await runBackend(backend, cases, options);
    runs.push({ label, summary });
    if (!values.json) {
      console.log(renderReport(summary, results, label));
      console.log();
    }
  }

  if (values.json) {
    console.log(JSON.stringify(runs, null, 2));
  } else if (runs.length > 1) {
    console.log(renderComparison(runs));
  }
}

await main();
