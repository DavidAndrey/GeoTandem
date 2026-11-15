# Plan: the quality of the model's answers («Antwortqualität»)

> Status: draft 2026-11-13, nothing built. Phase 1 runs on the host that
> keeps the harness results (`backend/evals/results/*.jsonl`); they were not
> on the Windows host where this plan was written, and its application
> database has no evaluation runs. Every later phase waits for Phase 1's
> figures (rule of plan E3: only measured presets ship).

## 1 The question

Can the answers of Modus B be made more reliable: fewer wrong answers, a
signal where an answer is doubtful, fewer misread questions, and a warning
for an unexpected result? The candidates looked at:

| # | Idea | Verdict before measuring |
|---|---|---|
| R | A second agent that reviews the answer | Not pursued (section 7) |
| 1 | Execution feedback: an empty or oversized result noticed | A note only, no retry; size it in Phase 1 |
| 2 | A repair call on the direct path after a refusal | Likely about +1 point; build only if Phase 1 says so |
| 4 | A query language harder to misuse (normaliser, then schema v3) | Normaliser small; v3 a plan of its own, driven by Phase 2 |
| 8 | The query told back to the user | Mostly in place; no work unless a user test asks for it |

## 2 What exists already

- **Checks before an answer is shown** ([validate.py](../backend/src/geotandem/model/validate.py)):
  schema, the engine's validation in the model's world, whether the controls
  can show the query (`not_representable`), the condition limit.
- **Shapes written plain** ([shapes.py](../backend/src/geotandem/model/shapes.py)):
  `and`/`or` of one, `not` of `not`, `not compare` in a relation's filter as
  its complement (F12); code labels as codes (`labels.as_codes`).
- **The chain's correction** ([chain/ask.py](../backend/src/geotandem/model/chain/ask.py)):
  one call after a refused plan (F7), and the cover check for a condition of
  the question that no step writes (F21). A re-plan after an error or an
  empty step before the last, not after an empty last step (F14, not done:
  it would risk the passes whose correct result is empty).
- **The direct path has no correction**: `DirectQuery.ask` makes one call;
  a refusal is stored as it is ([direct.py](../backend/src/geotandem/model/direct.py)).
- **Constrained output** where the prompt profile asks for it
  (`Prompt.constrained`, `response_format` with `json_schema` in
  `openai_compat`, falling back to the schema as text).
- **The check by the chain** ([plan-check-mode.md](plan-check-mode.md)):
  the same prompt asked with the chain, the results compared by feature ids,
  the answer marked «geprüft» or «unsicher: N statt M». Switched on for
  gemma4:12b and qwen3:14b. This is already the "second agent", and a stronger
  one than a reviewer: it derives the answer again instead of reading the
  first one.
- **The query told back** ([readable.ts](../frontend/src/model/readable.ts),
  [Preview.tsx](../frontend/src/model/approval/Preview.tsx)): the query as
  the editor's condition rows in the editor's words, JSON where the controls
  cannot show a part; the preview with its count, the hits dashed on the map
  and the references in grey.
- **The grader's flags** ([grade.py](../backend/src/geotandem/evaluation/grade.py)):
  a `wrong` answer carries `zero_hits` (it found nothing) and
  `no_assumption` (silently wrong); `refused:<code>`, `error:<code>` and
  `kind:<kind>` carry their codes. Phase 1 needs no new grading.

## 3 What is known

The only verdict breakdown of the direct query in the docs is
[benchmarks.md](benchmarks.md) *Lauf 1* (2026-10-12, 33 cases × 3 seeds,
before most prompt changes):

| Model | pass | wrong | kind | refused | error |
|---|---:|---:|---:|---:|---:|
| gemma4:12b | 78 | 9 | 6 | 3 | 0 |
| qwen3:14b | 75 | 11 | 9 | 4 | 0 |
| gemma4:e4b | 75 | 9 | 10 | 4 | 0 |
| qwen3.5:9b | 66 | 16 | 13 | 2 | 0 |

Later runs give only totals: on the A and B confirm cases (810 answers per
model) direct's visible failures are 149 / 77 / 101 / 253 and its silent
wrongs 61 / 44 / 120 / 40 (e4b, 12b, qwen3:14b, qwen3.5:9b;
[plan-chain-eval.md](plan-chain-eval.md), F20). The chain's correction
rescues 28 / 32 / 4 % of refused first plans (e4b, 12b, qwen3:14b).

**Reading:** the direct query fails on content (`wrong`, `kind`), rarely on
format (`refused` 2–4 %, `error` 0). A repair call reaches only the refusals:
about +1 point. Whether that still holds, and how many wrong answers are
empty, is what Phase 1 measures.

## 4 Phase 1: measure (no code)

### 4.1 The runs

Use the newest direct runs on the confirm cases if they are of the current
commit: `b1-d-*` and the direct side of `b9-c-*` (seeds 21–25). Otherwise
run fresh, and keep the results this time:

```sh
cd backend
for m in gemma4:e4b gemma4:12b qwen3:14b qwen3.5:9b; do
  n=${m//:/_}
  uv run python evals/run.py --model $m --cases heldout       --temperature 0.3 --repeat 5 --seed-start 21 --label q1-d-$n
  uv run python evals/run.py --model $m --cases chain-heldout --temperature 0.3 --repeat 5 --seed-start 21 --label q1-dk-$n
  uv run python evals/run.py --model $m --cases behaviour     --temperature 0.3 --repeat 5 --seed-start 21 --label q1-db-$n
done
```

`heldout` is group A confirm, `chain-heldout` group B and C confirm,
`behaviour` the cases that test when to ask back. Local models take
15–30 minutes per model and case file.

### 4.2 What to extract, per model

From each run's records (`verdict`, `flags`, `refusal.code`, `hits`):

| Figure | From | Decides |
|---|---|---|
| Verdict shares: pass, wrong, kind, refused, error | `verdict` prefix | all |
| `refused:*` by code | `verdict`, `refusal.code` | D2, D3 |
| `error:*` by code | `verdict` | D2 (an unreadable answer is not a refusal) |
| `kind:*` by kind, and on which cases (behaviour or not) | `verdict` | D4 |
| `wrong` with `zero_hits` | `flags` | D1 |
| `wrong` with `no_assumption` (silent) | `flags` | D1, D5 |
| Passes whose gold result is empty | case gold, `hits` | D1 (false alarms of a note) |
| `wrong` whose hits reach the result limit | `hits`, `LIMITS` | D1 |

A short script beside `chain_report.py` (`evals/direct_report.py`) prints the
table; it reads the newest run per label, as `compare.py` does.

## 5 Phase 2: read the failures (no code)

Read every `wrong` and `kind` answer of gemma4:12b and qwen3:14b on the
confirm cases (one seed block is enough for the reading), and sort each into
one cause:

| Cause | Example | Points to |
|---|---|---|
| Question misread | «Schulen» read as all buildings | prompt, examples (plan-improve-examples) |
| Language misused | `within` written the wrong way round, a predicate that cannot hold | normaliser (D3), v3 (D5) |
| Value not grounded | a place name, a code or a number not in the data | layer profile, value domains |
| Condition dropped or added | «ohne» lost, a filter nobody asked for | a cover check for direct (as F21 for the chain) |
| Not expressible | a relation's filter of two conditions, a relation to a relation | v3 (D5) |
| Asked back where a query was due | `kind:clarification` | D4 |
| Grader too strict | a fair second reading | `gold_any`, `regrade.py` |

The reading goes into this plan as section 9, with counts per cause and
model; its cases are confirm cases, so no fix is tuned on them (the tuning
split is for that).

## 6 Decisions after Phase 1 and 2

| # | Question | Build if | Recommendation |
|---|---|---|---|
| D1 | A note on an empty or oversized result | `zero_hits` is a sizeable part of the silent wrongs and the passes with an empty gold are few | A note under the answer («0 Treffer: prüfen Sie die Bedingungen»), worded so it does not claim the answer is wrong; no retry (F14) |
| D2 | A repair call on the direct path | `refused` ≥ 5 % for a model the application offers, and on the tuning split the call rescues ≥ 25 % without new silent wrongs | A per-connection switch beside `check_mode`, default off, like the chain's correction (refusal code and part fed back, one call, counted against the request limit); harness `--repair` to measure it |
| D3 | A normaliser for a refusal code | one code dominates direct's refusals and has a rewrite that keeps the meaning (as `shapes.plain`) | E.g. an attribute name one edit away from a released one; a rewrite that could change the meaning is refused as today |
| D4 | Asking back too often | `kind:clarification` outside the behaviour cases is a sizeable share | Examples and rules (plan-improve-examples), never a forced re-ask |
| D5 | A query language v3 | Phase 2 finds "language misused" and "not expressible" a sizeable part of the wrong answers | A plan of its own: [plan-query-capabilities.md](plan-query-capabilities.md) (section 8) |

"Sizeable" is set when the figures are in; the bar of plan-check-mode
(no more than about 10 % of correct answers marked) holds for any new mark.

## 7 Not pursued

- **A reviewer agent** reading the prompt and the answer. The check by the
  chain already derives the answer anew. A reviewer running on the same small
  local models shares their blind spots, and the documented silent wrongs
  (F13: a query that runs and finds nothing) are the kind a reader misses.
  Every reviewer call takes a model-call slot and counts against the request
  limit, and its false marks wear down trust in the marks. If tried at all:
  a narrow one, measured as `--approach review` against the check's numbers.
- **Confidence from the model.** Small models report it poorly calibrated;
  disagreement of two derivations (the check) is the better signal.
- **Self-consistency** (several samples, majority of results): multiplies the
  calls; reconsider only for answers that a cheap signal (D1) marks.
- **Fine-tuning a local model** on accepted queries: too little clean data,
  and a retraining routine to keep.
- **More back-translation** (idea 8): the condition rows already tell the
  query back. A plain sentence, or a flag on a part the question did not
  name, needs a user test to show a gain; the harness cannot measure it.

## 8 Seed for v3 of the query object

Taken up and widened in [plan-query-capabilities.md](plan-query-capabilities.md)
(2026-11-15): the review of the query object, the coverage of the eval set,
the sweet spot between capability and reliable answers, and v3 with GROUP BY.
Only if D5 says so. What is known to be hard for the models, from
[plan-chain-eval.md](plan-chain-eval.md):

- A relation's filter of more than one condition: the controls' limit (D3 of
  plan E2), the main cause of `not_representable`.
- A relation to a relation (F4), and two results joined where the second
  should build on the first.
- Direction of `within` / `contains` (F13): fixed for the chain by a tool and
  a check; whether direct needs an explicit direction is Phase 2's question.
- A result that ends in a buffer.

What a v3 touches, since the query object is the one contract between the
interface, the model and the engine:

- `schema/query-object/v3.json` and `packages/geotandem_query`; an older
  document stays valid unchanged, as v0–v2 did.
- The engine on both backends (SpatiaLite, PostGIS) and functional equality
  (F-2.14).
- `represent.to_analysis` and the editor (`frontend/src/analysis/query.ts`,
  `readable.ts`): what the controls can show.
- Saved queries and sessions, the prompt's rules and examples, the eval
  cases' gold queries.

## 9 Phase 2 reading

To be filled in.
