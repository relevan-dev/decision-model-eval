# decision-model-eval

An eval that compares decision models on a real configuration task. It
measures how often each model is correct, whether its probabilities mean
anything, and how long each answer takes.

The task: read a search index mapping and decide which fields get **phonetic
matching**, and which encoder each one uses. Phonetic matching lets a search for
"Kowalchik" find "Kowalczyk". It helps on fields that hold names. On other
fields, it adds wrong results. So someone must decide field by field, and this
eval asks a model to do it.

The eval ships with three backends:

| Backend  | What it is                                                                     | How it answers                          |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| `laya`   | [Laya](https://github.com/NandhaKishorM/laya), open weights (Apache 2.0), runs on your machine | Typed answers over the System One protocol |
| `jev`    | Jev, TypeSafe's hosted model                                                   | Typed answers over the System One protocol |
| `claude` | Claude, through the Claude API                                                 | A prompt, with structured outputs        |

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

- **Claude** needs `ANTHROPIC_API_KEY`. The default model is `claude-opus-5` at
  `low` effort. Set `CLAUDE_MODEL` to use another model.

### Options

| Flag                     | Meaning                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--backend <name>`       | `laya`, `jev`, or `claude`. Repeatable.                                                                   |
| `--index <name>`         | Run one case. Repeatable.                                                                                 |
| `--threshold <0-1>`      | Probability at or above which the feature goes on. Default 0.5.                                           |
| `--min-confidence <0-1>` | Hold a field for human review below this confidence. The scale runs 0.5 (even split) to 1 (certain).      |
| `--no-guardrail`         | Also ask about fields that cannot carry the subfield.                                                     |
| `--chain`                | Decide the encoder once per index, then ask each field only whether to enable phonetic matching.          |
| `--gate`                 | Ask once per index whether any field needs phonetic matching. Skip the field calls when it does not.      |
| `--print-requests`       | Print the request bodies and exit. Needs no server.                                                       |
| `--json`                 | Print the summaries as JSON.                                                                              |

## Sample results

One run of all three backends on 2026-09-24, from one machine. Laya ran on its
CPU. Jev and Claude ran over the internet. Your latency will differ.

|                            | Laya     | Jev (`jev-1.13.0`) | Claude Opus 5 |
| -------------------------- | -------- | ------------------ | ------------- |
| Enable decision correct    | 29 of 35 | 35 of 35           | 35 of 35      |
| Precision                  | 71%      | 100%               | 100%          |
| Recall                     | 100%     | 100%               | 100%          |
| Encoder correct            | 9 of 15  | 15 of 15           | 15 of 15      |
| Whole index config correct | 4 of 10  | 10 of 10           | 10 of 10      |
| Brier score                | 0.173    | 0.020              | 0.010         |
| Median time per call       | 1.10 s   | 0.16 s             | 2.27 s        |
| 95th percentile            | 1.14 s   | 0.24 s             | 3.42 s        |
| Total                      | 38 s     | 6 s                | 84 s          |

The run sends one call at a time, after one warm-up call that is not counted.

The same day, each architecture on all three backends:

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
