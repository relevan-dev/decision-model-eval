# Decision Model Eval

> [!NOTE]
> This repository is archived and will not be updated. It is published for
> reference only.

At Relevan, we provide custom tuned indexes for each of our customers. Doing this involves a lot of engineering to determine which features benefit the index the most. So when Jev rolled out we wondered, could it step in and make decisions where human judgment might've been previously needed. 

So we created an eval that compares decision models on a real configuration task. It
measures how often each model is correct, whether its probabilities mean
anything, and how long each answer takes.

The task: read a search index mapping and decide which fields get **phonetic
matching**, and which encoder each one uses. Phonetic matching lets a search for
"Kowalchik" find "Kowalczyk". It helps on fields that hold names. On other
fields, it adds wrong results. So someone must decide field by field, and this
eval asks a model to do it.

The eval ships with seven backends:

| Backend  | What it is                                                                     | How it answers                          |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| `laya`   | [Laya](https://github.com/NandhaKishorM/laya), open weights (Apache 2.0), runs on your machine | Typed answers over the System One protocol |
| `jev`    | Jev, TypeSafe's hosted model                                                   | Typed answers over the System One protocol |
| `claude` | Claude, through the Claude API                                                 | A prompt, with structured outputs        |
| `clm`    | [CLM-v0.1-8B](https://huggingface.co/Contrastive-LM/CLM-v0.1-8B), open weights (Apache 2.0), runs on your machine | Typed answers over the System One protocol |
| `clef`   | [Clef](https://huggingface.co/Cloudflare/clef), open weights (Apache 2.0), runs on your GPU or on Cloudflare Workers AI | Typed answers over the System One protocol |
| `nemotron-nano` | [Nemotron 3 Nano 30B-A3B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16), NVIDIA open weights, runs on your GPU through vLLM | The Claude prompt, with `json_schema` structured outputs |
| `nemotron-lightning` | [Nemotron 3.5 Lightning 30B-A3B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4), NVIDIA open weights, runs on your GPU through vLLM | The Claude prompt, with `json_schema` structured outputs |

Every backend implements one function type, `DecisionModel` in
[`src/system-one.ts`](src/system-one.ts). To test another model, write one
function of that type and add it to [`src/backends.ts`](src/backends.ts).

## Quick start

Requires Node.js 22 or later.

```bash
npm install
npm test

# Read the task first. This prints every request and needs no key or server.
npm run eval -- --print-requests --index recruiter-candidates
```

Then copy `.env.example` to `.env`, set the keys for the backends you want, and
run them:

```bash
npm run eval -- --backend jev
npm run eval -- --backend laya --backend jev --backend claude
```

With more than one backend, the run ends with a comparison table.

### Backend setup

- **Laya** runs on a CPU. Start a server, and set `LAYA_BASE_URL`:

  ```bash
  pip install "laya[serve]"
  LAYA_DEVICE=cpu laya-serve        # binds 0.0.0.0:8000; set LAYA_PORT to change it
  ```

  `laya-serve` downloads its checkpoint from the Hugging Face hub on first use.

- **Jev** needs `JEV_API_KEY`. The eval sends `model: "jev-latest"`, because the
  hosted API rejects a request with no model name. Set `JEV_MODEL` to pin a
  version.

- **CLM** needs two local servers: a vLLM embedding server for Qwen3-8B, and
  `clm-serve`, which scores those embeddings. The eval reaches `clm-serve` at
  `http://127.0.0.1:8700` unless `CLM_BASE_URL` says otherwise.

  ```bash
  pip install contrastive-lm
  vllm serve Qwen/Qwen3-8B --served-model-name qwen3-8b --runner pooling \
    --max-model-len 2048 --host 127.0.0.1 --port 8090
  clm-serve --host 127.0.0.1        # downloads CLM_v0.1-8B.pt on first use
  ```

- **Clef** runs on your own GPU through [`clef-server/`](clef-server/), a small
  System One server around the `systemone()` function that ships with the
  weights. It needs about 56 GB of GPU memory in BF16 and listens on
  `127.0.0.1:8800`. Set `CLEF_BASE_URL` to use it:

  ```bash
  cd clef-server
  uv run clef-serve                 # downloads Cloudflare/clef (52 GB) on first use
  CLEF_BASE_URL=http://127.0.0.1:8800 npm run eval -- --backend clef
  ```

  `CLEF_MODEL_PATH` loads another checkpoint, such as `Cloudflare/clef-flash`,
  and `CLEF_API_KEY` makes the server require a bearer token. The server
  accepts text and JSON state only.

  Without `CLEF_BASE_URL`, the eval calls Clef on Workers AI instead, with
  `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` that has Workers AI
  access. `CLEF_MODEL` picks `clef` or `clef-flash` there.

- **Nemotron** runs as a chat model behind vLLM's OpenAI-compatible API.
  [`src/openai-chat.ts`](src/openai-chat.ts) sends it the same prompt and answer
  schema as Claude, and vLLM constrains decoding to that schema. Use vLLM
  0.27.1 or later. On a 128 GB DGX Spark the two servers do not fit side by
  side (vLLM reserves about 19 GiB for CUDA graphs), so run one at a time.
  Each has its own default port:

  ```bash
  # Nemotron 3 Nano, on :8900
  VLLM_USE_FLASHINFER_MOE_FP4=1 vllm serve nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-NVFP4 \
    --served-model-name nemotron-nano --host 127.0.0.1 --port 8900 \
    --max-model-len 32768 --gpu-memory-utilization 0.35 --kv-cache-dtype fp8 \
    --trust-remote-code --reasoning-parser nemotron_v3
  npm run eval -- --backend nemotron-nano

  # Nemotron 3.5 Lightning, on :8901
  vllm serve nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 \
    --served-model-name nemotron-lightning --host 127.0.0.1 --port 8901 \
    --max-model-len 32768 --gpu-memory-utilization 0.6 --kv-cache-dtype fp8 \
    --moe-backend marlin --trust-remote-code --reasoning-parser nemotron_v3
  npm run eval -- --backend nemotron-lightning
  ```

  Reasoning is off by default (`enable_thinking: false`), and decoding is
  greedy. Set `NEMOTRON_THINKING=1` to let either model reason first, which is
  slower; generation is then uncapped unless `NEMOTRON_MAX_TOKENS` sets a cap.
  `NEMOTRON_NANO_BASE_URL`, `NEMOTRON_LIGHTNING_BASE_URL`, and the matching
  `_MODEL` and `_API_KEY` variables point the eval elsewhere. Any other
  OpenAI-compatible chat server works the same way through
  `chatCompletionsModel`.

- **Claude** needs `ANTHROPIC_API_KEY`. The default model is `claude-opus-5` at
  `low` effort. Set `CLAUDE_MODEL` to use another model.

### Options

| Flag                     | Meaning                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--backend <name>`       | `laya`, `jev`, `claude`, `clm`, `clef`, `nemotron-nano`, or `nemotron-lightning`. Repeatable.            |
| `--index <name>`         | Run one case. Repeatable.                                                                                 |
| `--threshold <0-1>`      | Probability at or above which the feature goes on. Default 0.5.                                           |
| `--min-confidence <0-1>` | Hold a field for human review below this confidence. The scale runs 0.5 (even split) to 1 (certain).      |
| `--no-guardrail`         | Also ask about fields that cannot carry the subfield.                                                     |
| `--chain`                | Decide the encoder once per index, then ask each field only whether to enable phonetic matching.          |
| `--gate`                 | Ask once per index whether any field needs phonetic matching. Skip the field calls when it does not.      |
| `--print-requests`       | Print the request bodies and exit. Needs no server.                                                       |
| `--json`                 | Print the summaries as JSON.                                                                              |

## Sample results

One run of Laya, Jev, and Claude on 2026-09-24, from one machine. Laya ran on
its CPU. Jev and Claude ran over the internet. Clef ran on 2026-10-02 through
[`clef-server/`](clef-server/) on an NVIDIA GB10 (DGX Spark). Your latency will
differ.

|                            | Laya     | Jev (`jev-1.13.0`) | Claude Opus 5 | Clef (local) |
| -------------------------- | -------- | ------------------ | ------------- | ------------ |
| Enable decision correct    | 29 of 35 | 35 of 35           | 35 of 35      | 34 of 35     |
| Precision                  | 71%      | 100%               | 100%          | 94%          |
| Recall                     | 100%     | 100%               | 100%          | 100%         |
| Encoder correct            | 9 of 15  | 15 of 15           | 15 of 15      | 15 of 15     |
| Whole index config correct | 4 of 10  | 10 of 10           | 10 of 10      | 9 of 10      |
| Brier score                | 0.173    | 0.020              | 0.010         | 0.015        |
| Median time per call       | 1.10 s   | 0.16 s             | 2.27 s        | 0.72 s       |
| 95th percentile            | 1.14 s   | 0.24 s             | 3.42 s        | 0.73 s       |
| Total                      | 38 s     | 6 s                | 84 s          | 25 s         |

Clef's one miss turned on phonetic matching for `restaurant-listings.cuisine`
at p = 0.548, its least confident answer. `--min-confidence 0.6` holds that
field for review instead.

The run sends one call at a time, after one warm-up call that is not counted.

### Nemotron

Nemotron 3 Nano and Nemotron 3.5 Lightning ran on 2026-11-10 on the same GB10,
with `vllm/vllm-openai:v0.27.1`, NVFP4 weights, and reasoning off. Even at
temperature 0, their answers changed between runs, so each model ran five
times. Each cell gives the range over the five runs.

|                            | Nemotron 3 Nano | Nemotron 3.5 Lightning |
| -------------------------- | --------------- | ---------------------- |
| Enable decision correct    | 30–33 of 35     | 31–32 of 35            |
| Precision                  | 75–88%          | 82–83%                 |
| Recall                     | 100%            | 93–100%                |
| Encoder correct            | 15 of 15        | 14 of 14 to 15 of 15   |
| Whole index config correct | 7–8 of 10       | 7–8 of 10              |
| Brier score                | 0.052–0.133     | 0.074–0.107            |
| Median time per call       | 0.49–0.50 s     | 0.34 s                 |
| 95th percentile            | 0.51 s          | 0.37 s                 |
| Total                      | 17 s            | 12 s                   |

Both models turn phonetic matching on for free-text fields that mention names.
`recruiter-candidates.summary` was wrong in all ten runs, and
`legacy-membership-roll.notes` in nine. Nano also missed
`academic-papers.title` and `academic-papers.abstract` in three of five runs.
Lightning turned it on for `recruiter-candidates.email` in every run, and in
two runs turned it off for `medical-providers.clinicName` at p = 0.0, its only
false negatives.

Every wrong yes came at p = 0.8 or higher, so `--min-confidence` cannot hold
them for review. The probabilities these chat models write out are not
calibrated the way the System One models' are.

On 2026-09-24, each architecture on Laya, Jev, and Claude:

| Architecture                  | Calls | Laya: enable, encoder, configs | Jev and Claude | Jev total | Claude total |
| ----------------------------- | ----- | ------------------------------ | -------------- | --------- | ------------ |
| Per field (default)           | 35    | 29 of 35, 9 of 15, 4 of 10     | all correct    | 5.9 s     | 84 s         |
| Encoder first (`--chain`)     | 45    | 29 of 35, 8 of 15, 3 of 10     | all correct    | 7.4 s     | 111 s        |
| Index gate (`--gate`)         | 38    | 27 of 35, 7 of 12, 3 of 10     | all correct    | 6.4 s     | 102 s        |
| Gate and encoder first (both) | 38    | 27 of 35, 7 of 12, 3 of 10     | all correct    | 6.7 s     | 121 s        |

## What the numbers mean

- **Precision** counts the cost of a wrong yes: a `.phonetic` clause in every
  query for a field that does not need one.
- **Recall** counts the cost of a wrong no: the sound-alike match that users
  needed, missing.
- **Encoder correct** is scored only where the enable decision was already
  correct.
- **Whole index config correct** counts indexes where every field agrees with
  the label.
- **Coverage** is the share of fields the model decided rather than held. A field
  that `--min-confidence` holds is left out of the rates above.
- **Brier score** is the mean squared error of the probabilities. 0 is perfect,
  and 0.25 is a coin flip. It tells you if `--min-confidence` is usable: when a
  model's confidence means nothing, a person must review every field.
- **Latency** is the wall-clock time of each call, from request to parsed
  answer.

## The labels

[`src/cases.ts`](src/cases.ts) holds ten indexes and the config a search
engineer would set for each. Two of them need no phonetic matching on any
field, so a model that answers yes everywhere cannot score well. Two rules
decide every label:

1. Enable phonetic matching on fields that hold names people say the same way
   but spell differently. Leave it off for prose, controlled vocabularies,
   codes, and addresses.
2. Choose `double_metaphone`, which also handles English names. Choose
   `metaphone` or `soundex` only for a stated compatibility requirement, or for
   a measured improvement on representative queries.

**The labels are hypotheses, not established ground truth.** They record what
an engineer would choose. Retrieval tests with real spoken-name queries, and a
count of the false matches, are the only way to confirm them. An earlier
version of rule 2 said "use `metaphone` for English-only names". Two models
disagreed with that label, and we found no evidence for it, so we changed the
rule.

[`src/cases.test.ts`](src/cases.test.ts) checks every label against the
mapping and config schemas, and checks that the label set stays balanced.

## Design notes

### The guardrail

The eval asks only about searchable text fields. The mapping converter that this
eval came from rejects a phonetic config on any other field, so a wrong answer
there is a failed index build, not a weak match. `--no-guardrail` removes the
filter. The difference between the two runs shows how much of the accuracy
comes from the filter and how much from the model.

### The chained run

The encoder suits a whole index, not one field. `--chain` asks the encoder
question once per index, over a state that names the index, what it holds, and
the sample values of every field. Each field call then asks only the enable
question. This removes one kind of wrong answer: two fields of the same index
with different encoders.

### The gated run

Some indexes hold no names at all, such as application logs. `--gate` asks one
index-level question first: does any field hold names that people search for
by sound? When the answer is no, every field is off, and the run makes no field
calls for that index. Each field then carries the gate's probability, so the
Brier score still covers it. With `--chain`, the same index call also asks the
encoder question.

### Claude and structured outputs

The System One protocol returns typed answers, so there is no text to parse.
Claude is a chat model, so [`src/claude.ts`](src/claude.ts) builds a schema
from the question map and asks for structured output. The reply is JSON that
matches the schema, and the adapter converts it to the System One answer shape.

The adapter also turns on the server-side refusal fallback. A safety classifier
can decline an ordinary request. With an earlier prompt, every request about
the index "migrated off a mainframe" was declined as cyber content. With the
current prompt, none were. The report counts each answer that a fallback model
gave.

### The mapping format

[`src/mapping.ts`](src/mapping.ts) is a small copy of the mapping format from
Relevan's search service, taken on 2026-09-24. It does not follow later changes
to that service. It uses only `zod`.

## License

MIT. Copyright 2026 YASS Inc. Relevan is a product and trade name of YASS Inc.
See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Laya and its checkpoints have their own license (Apache 2.0).
