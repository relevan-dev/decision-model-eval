import { z } from "zod";

// Client for the System One wire protocol: `POST /v1/systemone`, a typed
// question map in and typed answers with probabilities out. TypeSafe's hosted
// Jev API defines the protocol. Laya (`laya-serve`, Apache 2.0) serves the same
// routes from open weights, so this client reaches either one by base URL.
//
// The protocol returns no text, so there is nothing to parse out of prose.
// `claude.ts` shows the other route: it asks a chat model the same questions
// and uses structured outputs to get the same answer shape back.

/** A yes/no question. The answer is the calibrated probability of `true`. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  /** Model-facing meaning of each slot, keyed `"false"` and `"true"`. */
  criteria?: Record<"false" | "true", string>;
}

/** A single-label question. The answer names one key of `criteria`. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option key to the description the model reads. */
  criteria: Record<string, string>;
}

export type SystemOneQuestion = ChoiceQuestion | NoulQuestion;

export interface SystemOneRequest {
  /** State to decide over: a string, an object, or a list of chat messages. */
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  /** Checkpoint name. Laya routes by script and language when this is unset. */
  model?: string;
}

/**
 * One answer, parsed loosely: the server sends `choice`, `noul`, `confidence`
 * and a probability map, and this keeps only the fields the eval reads. The
 * schema stays open so a newer server that adds fields still parses.
 */
const answerSchema = z.looseObject({
  choice: z.string().optional(),
  noul: z.number().optional(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

export type SystemOneAnswer = z.infer<typeof answerSchema>;

const responseSchema = z.looseObject({
  answers: z.record(z.string(), answerSchema),
  routing: z
    .looseObject({
      model: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export type SystemOneResponse = z.infer<typeof responseSchema>;

export interface SystemOneClientConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** Milliseconds before a request is aborted. Defaults to 30000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Builds the request body, so a caller can print it without a server. */
export function systemOneRequestBody(
  request: SystemOneRequest,
  config: Pick<SystemOneClientConfig, "model">,
): SystemOneRequest {
  const model = request.model ?? config.model;
  return model ? { ...request, model } : { state: request.state, questions: request.questions };
}

/**
 * Anything that answers a typed question map. The eval depends on this type
 * only, so every backend is a function of this shape.
 */
export type DecisionModel = (request: SystemOneRequest) => Promise<SystemOneResponse>;

/** A decision model backed by a System One server, such as Jev or Laya. */
export function systemOneModel(config: SystemOneClientConfig): DecisionModel {
  return (request) => evaluateSystemOne(request, config);
}

/**
 * Sends one evaluation. Every question in `request.questions` is answered in a
 * single forward pass, so the caller asks for the whole decision at once rather
 * than one question per call.
 */
export async function evaluateSystemOne(
  request: SystemOneRequest,
  config: SystemOneClientConfig,
): Promise<SystemOneResponse> {
  const url = new URL("/v1/systemone", config.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) {
    headers["authorization"] = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(systemOneRequestBody(request, config)),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `System One request failed: ${response.status} ${response.statusText}. ${detail}`.trim(),
    );
  }

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`System One server returned an unexpected payload: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Probability of `true` for a `noul` answer. The eval treats a missing or
 * out-of-range value as a server fault rather than as a `false` answer, so a
 * broken server cannot look like a confident negative.
 */
export function noulProbability(answer: SystemOneAnswer | undefined, name: string): number {
  if (answer?.noul === undefined) {
    throw new Error(`Question "${name}" returned no noul probability.`);
  }
  if (answer.noul < 0 || answer.noul > 1) {
    throw new Error(`Question "${name}" returned a noul probability outside [0, 1].`);
  }
  return answer.noul;
}

/**
 * Confidence for a `noul` answer, on [0.5, 1]: 0.5 is an even split and 1 is
 * certain. The server sends one, and this derives the same quantity when it
 * does not, so one gate threshold means one thing either way.
 *
 * A `choice` answer's confidence uses a different formula — normalized entropy,
 * on [0, 1] — so the two are not comparable. `--min-confidence` gates on this
 * one.
 */
export function noulConfidence(answer: SystemOneAnswer, probability: number): number {
  return answer.confidence ?? Math.max(probability, 1 - probability);
}
