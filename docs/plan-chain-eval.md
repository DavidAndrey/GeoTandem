# Plan: testing and benchmarking the tool chain (draft)

Status: draft, 2026-10-25. Open points answered (section 10); success rule
detailed in section 8. Phase 0 and step 1a done 2026-10-25 (sections 3 and 4
say what was built and where it differs from the plan); their findings are in
section 11. Postponed item "Tool chain evaluation (E3.6)" of
[plan-e3.md](plan-e3.md) section 9; the method is [bewertung.md](bewertung.md)
section 4 *Die Werkzeugkette an demselben Massstab*.

## 1 Why, and what is known

The direct query path has four testplans, 165-run noise figures, a prompt
study and per-model prompt profiles. The chain (E2.5, `geotandem.model.chain`,
`geotandem.tools.chain`) has deterministic tests only: the enforcement matrix,
the flow, the gate and the sentinel tests (`tests/test_model_chain_*.py`) run
scripted plans against a stub. **No real model has been measured on it.** We
do not know whether the chain answers more questions than the direct path,
what it costs, or how it fails.

What the code tells us about what to measure:

- Planning is **one call** returning the steps as structured output
  (`PlanAnswer`); the model calls no tool. `check_plan` validates every step
  and composes the query objects; steps are only **counted**, never fetched.
- A **re-plan** is a further call, due after an error or an empty step before
  the last (`MAX_REPLANS = 2`); the plan is at most `MAX_STEPS = 8` steps.
- The result is the last step's **query object** (F-5.7), so the existing
  grader (`evaluation/grade.py`, result-based, `gold_any`, `require`) applies
  unchanged. That is what makes a paired direct-vs-chain comparison possible.
- A chain that ends in a buffer is refused (`not_representable`, D3), and
  `within`/`outside` of a buffer only holds for points.
- The start set (71 cases) has **no usable chain cases**: two carry
  `other_approach: chain` (h32, h33), one the tag `chain` (n07). About a dozen
  more are two-layer spatial cases that a chain could solve step by step.

## 2 Questions the benchmark must answer

| # | Question | Decides |
|---|---|---|
| Q1 | On the same cases and models, is chain better, equal or worse than direct, per case class? | Whether the chain is a peer path, a fallback for what direct cannot express, or not worth shipping on small models |
| Q2 | Where does a chain fail: bad plan, refused step, empty step, wrong composition, step limit, no convergence after re-plans? | Which part to improve: prompt, tool schema, validation messages, re-plan message, limits |
| Q3 | What does it cost: calls, tokens, latency, per answered question and per *correct* answer? | Which models are usable for the chain; cost estimate before a run (bewertung.md 12) |
| Q4 | Does the re-plan loop earn its calls? | Keep, tune or drop `MAX_REPLANS`; the "empty step" trigger |
| Q5 | Are `MAX_STEPS`, `MAX_CONDITIONS` set right? | Limits (F-3.9) |
| Q6 | Is the best chain prompt the same as the best direct prompt, per model? | Chain prompt profile per connection (see memory: per-model approach) |
| Q7 | Does the chain say when it is silently wrong (plan runs, result differs from the question)? | Safety of showing intermediate counts as reassurance |

## 3 What to build first (Phase 0, no model needed)

1. **A chain driver for the harness and the application's runs.** It must
   run plan, `check_plan`, `run_step`, re-plan exactly as `model.service`
   does, minus the store, approvals and halts. Preferably extract the loop
   from `service.py` (`_plan`, `replan`) into a function both call, so the
   harness measures production code, not a copy (the direct path got this
   treatment: `DirectQuery.ask`).
2. **Per-case trace**: plan(s) as sent back, per step: tool, count or error
   code, duration; calls, tokens per call, re-plans, final query object,
   `finish_reason`. Same JSONL shape as direct runs so `compare.py` works.
3. **Verdicts extended**, beside the existing `pass`, `wrong:*`, `kind`,
   `refused`, `error`, `forbidden`, `other_approach`:
   `plan_invalid` (schema or reference), `step_refused:<code>`
   (`not_representable`, `step_limit`, `model_query_invalid`),
   `no_convergence` (re-plans spent), `result_too_large`,
   `silently_wrong` (runs, wrong result, no assumption recorded; the E2 `n03`
   class).
4. **Parity check**: a chain of one step must grade the same as the direct
   path on the same answer. Catches a harness that measures the driver
   instead of the model.
5. **Prompt hash for the chain**, as for direct (`prompt_sha256` over the
   plan prompt and schema, plus the re-plan message), so two runs are known
   to have sent the same thing.
6. **Stub-model dry run** in `make gate`: a scripted model through the new
   driver, grading a handful of cases. No endpoint needed, keeps the driver
   from rotting.

**Built (2026-10-25).** Where it differs from the list above:

- Item 1, no extraction. What a run decides about the model already lives
  outside the service: `ChainState` (next step, re-plan due, re-plan
  messages, revise), `check_plan`, `run_step`, `last_complete`.
  [`evaluation/chain.py`](../backend/src/geotandem/evaluation/chain.py)
  (`drive`) uses them and repeats only the loop of `_Runner.go` and
  `_Runner.replan`, about 40 lines, at a level whose cells are all `auto`.
  Extracting the loop would have meant rewriting the service's run, where
  store writes, halts, query slots and aborts sit between the same lines, for
  no gain in what is measured. Instead a parity test runs seven scripts
  through the application at *Automatisch* and through `drive`. The scripts
  cover done, re-planned, re-plans used up, step limit at a re-plan, an
  unreadable re-plan, a refused plan and no plan. The test asserts the same
  calls with the same messages word for word, the same steps and counts, the
  same end, code and result. Breaking the driver's re-plan turns it red.
- Item 3, no new verdicts. The contract's verdicts stay (the frontend reads
  them):
  - A refused plan is `refused:<code>` (`model_query_invalid`,
    `not_representable`, `step_limit`), as a refused direct query.
  - A chain that stopped before its end is `refused:<reason>`
    (`replan_limit`, `step_limit`, `time_limit`, `result_too_large`).
  - *Silently wrong* is `wrong` with the `no_assumption` flag. The harness
    now writes the flags into every record, direct runs included.
  - The detail is in the record: `end`, `error`, `replans`, `count`, `calls`
    (re-plan number, latency, tokens, outcome) and `steps` (position, tool,
    arguments, status, count, code, duration, which plan it came with).
  - The grader takes a plan answer as a query answer: its kind counts as
    `query` where a case names kinds, its tag says `plan`. Direct verdicts
    are unchanged.
- Item 5: the header carries `approach`, `prompt_sha256` over the chain's
  prompt, and `replan_sha256` over the re-plan message for a placeholder
  step.
- Item 6: the dry run is
  [`tests/test_eval_chain.py`](../backend/tests/test_eval_chain.py), part of
  `make test` and therefore of the gate. It drives every chain case's
  reference script through `drive` and the grader, and checks every probe
  plan (section 4).
- Harness: `evals/run.py --approach chain` with `--cases chain` or
  `chain-heldout` for the new cases. A case that demands *this* approach be
  offered as the other one (`other_approach: chain`, h32 and h33) is left out
  of a chain run. A chain run takes no prompt variant yet. `regrade.py`
  refuses chain runs: re-grading a chain means running its steps again.

## 4 Case set (Phase 1)

Three groups, each with the tuning/confirm split (D2) so tuning does not
overfit the confirmation set.

| Group | Source | Size | Purpose |
|---|---|---:|---|
| A. Shared | the 71 start cases, unchanged | 71 | Q1: paired direct vs chain on identical input |
| B. Chain-native | new, authored in Modus A with the query builder (memo, point 1) | ~30 | Questions direct cannot express or expresses badly: buffer then relation, filter then spatial on the filtered result, three or more steps, a step that is a relation to a relation |
| C. Stress | new, small | ~12 | Re-plan triggers (a step that comes back empty on purpose), step-limit pressure, buffer-ending request, "within a buffer of a line" (refused for non-points), unknown layer mid-chain, ambiguous question that should ask |

B and C need a `gold` as a query object (the chain's final state), with
`other_approach` set where direct is also fair. Authoring is the long pole:
budget it first and check `gold_any` for questions with several fair
readings. Split B roughly 40/60 tuning/confirm.

**Built (2026-10-25).** The cases are in
[`schema/eval-cases/chain-cases.json`](../schema/eval-cases/chain-cases.json):
42 cases, `origin: authored`, on the sample data. They sit beside the start
set, not in it, so the application's 71 start cases and its tests stay as
they are. The harness reads them through `evaluation.cases.chain_set`.

| Group | Tag | Cases | Tuning / confirm |
|---|---|---:|---|
| B | `chain-native` | 30 (`kb01`–`kb30`) | 12 / 18 |
| C | `chain-stress` | 12 (`ks01`–`ks12`) | 5 / 7 |

Group B, as built:
- Every reference is a query a direct answer may write too (finding F4), so
  both approaches are graded on every case.
- What makes a case chain-native is that it decomposes: buffer then
  relation, filter on a step, two relations on one source, three layers.
- References hit between 2 and 214 features.

Group C covers four kinds of stress:
- What neither approach can express (`ks01`–`ks04`, expected
  `cannot_answer` without the offer of the other approach).
- The chain's gap where direct can (`ks05`, *does not intersect*).
- Re-plan triggers (`ks06`, `ks07`: a municipality name that finds nothing
  at first).
- Step-limit pressure (`ks08`, seven steps at best), an unknown layer, the
  table join, a nearness without a distance, and a negation to be rewritten.

Each case has a reference script in
[`tests/eval_chain_plans.json`](../backend/tests/eval_chain_plans.json):
- For a query case, a plan (with re-plans where the case is about them)
  whose result equals the reference.
- For a behaviour case, its answer.
- Where a case says the chain cannot do something, a probe plan the chain
  must still refuse, or (for `ks05`) the trap it must still fall into.

The cases were written from the layer profile and the sample's actual
values, not in Modus A.

## 5 Experiments

Each run: at least two seed blocks, temperature 0.3, `--repeat 5` as in
testplan-system-context, paired sign test and bootstrap interval per
comparison (`evaluation/stats.py`). Same sample dataset and default level.

| Phase | Experiment | Answers |
|---|---|---|
| 1 | **Baseline.** Chain with the default prompt on A + B + C, on a local ladder (gemma4:e4b, gemma4:12b, qwen3:14b) and one external (Luna). Direct re-run on A as the control in the same session | Q1, Q3 |
| 2 | **Failure taxonomy.** Read every non-pass of Phase 1 by hand (about 100 to 150); label root cause (planning, composition, tool misuse, validation message misread, grading artefact). Output: a ranked table of causes with counts | Q2, Q7 |
| 3 | **Re-plan ablation.** `MAX_REPLANS` 0, 1, 2; with and without the empty-step trigger. Report accuracy gained per extra call | Q4 |
| 3 | **Limit sweep.** `MAX_STEPS` 4, 6, 8 on group B+C: how many correct answers need more than 4 steps, how many wrong ones ran long | Q5 |
| 4 | **Prompt variants for the chain**, picked from the Phase 2 causes (candidates: tool list placement, worked chain examples as in P6, a shorter tool schema, the re-plan message wording, first-question note). Tune on tuning, confirm on confirm | Q6 |
| 4 | **Direct-then-chain routing** (offline simulation, no new calls): per case, chain only where direct failed or refused. Computed from the Phase 1 data | Q1, product shape |
| 5 | **Full baseline and comparison.** Every model used for direct requests, on all groups with its best chain profile (default if Phase 4 found none): the ten Ollama models of benchmark run 1 and Luna, Haiku and Sonnet. Direct results come from the existing runs, re-run on A where the code or data changed since | Q1 to Q3, release decision |

Models in Phase 1 are a subset (gemma4:e4b, gemma4:12b, qwen3:14b, Luna) to
find the failures early; Phase 5 repeats the winner configuration on all
thirteen. deepseek-r1:8b (57 s median in direct) is run once with a per-case
time cap and reported as such; it is not repeated.

Cost: the chain is 1 to 3 calls per case, and its plan prompt is longer
(tool list), so assume about 2 to 3 times the direct cost. With direct
≈ 0.0008 (Luna), 0.0013 (Haiku), 0.024 (Sonnet) USD per question, a Phase 1
run of 113 cases × 5 repeats × 2 seed blocks is about 1130 questions: roughly
USD 3 for Luna, 5 for Haiku, 80 for Sonnet at 3×. Run Sonnet on confirm
cases and one seed block first. For Phase 5, external models run one seed block of 3 repeats (they are close
to deterministic at low temperature); Haiku about USD 3, Luna 2, Sonnet about
45 on 113 cases, before B and C grow the set to its final size. Local runs:
minutes to half an hour each, the slow models longer.

## 6 Metrics

Correctness (graded on the final query object, same grader as direct):
pass rate per group, per tag, per model, with interval; the paired difference
to direct on group A; verdict distribution with the new chain verdicts.

Behaviour: plan validity rate on the first call; re-plan rate and success
rate after a re-plan; steps per answer (median, p90) against the limit;
share of runs hitting a limit; refusals by code; calibration of the "kind"
cases (asks instead of inventing); silent-wrong rate.

Cost: calls, prompt and completion tokens per case, latency median and p90,
**cost per correct answer** (the number that makes direct and chain
comparable).

Reliability: noise between seed blocks, per model; share of cases whose
verdict flips between seeds.

## 7 Deterministic tests worth adding alongside

Cheap, no model, found by reading the code rather than by benchmarking:

- Property test over `check_plan`: random plans from the tool schemas must
  end in a `Refusal` with a step number or a checked chain, never an
  exception (`model_query_invalid`, `not_representable` precedence as the
  docstring orders them).
- Round trip: the final query object of every accepted chain in the test
  fixtures passes `check_query` and runs in the engine with the same count the
  last step reported.
- Counts only: assert no step reads rows (the module already claims it; a
  test on the engine calls makes it durable).
- Re-plan message: given a recorded failing step, the message contains the
  code and the name only, never the error text (security: "its text never
  reaches the model").

## 8 Outputs and how they feed the next steps

A report (`docs/benchmarks.md`, new run section; convention: append, never
overwrite) and a short decision memo with the numbers behind:

1. **Verdict on the chain's role** per model, by the rule below.
2. **Ranked improvement backlog** from the Phase 2 taxonomy, each item with
   the number of cases it would fix.
3. **Limits**: keep or change `MAX_STEPS`, `MAX_REPLANS`, with the curve.
4. **Chain prompt profile per connection**, as presets next to P0/P5/P9, if
   Phase 4 shows a per-model winner.
5. **Cost table** per model for direct and chain, for the run cost estimate in
   the application.
6. Chain cases and runs in *Administration › Modell › Bewertung* (E3.6
   proper), shaped by which metrics proved useful.

### Success rule (to be frozen before the first Phase 1 run)

Terms. *Pass rate* is the share of passes on the confirm cases only (tuning
cases are for tuning). *Paired difference* is chain minus direct per case on
group A, as sign test plus 95 % bootstrap interval over cases, seeds pooled
per case. *Noise* is the model's measured seed-block spread (about ±1.2 %
for gemma4:12b, ±3.6 % for qwen3:8b, from the direct runs; measured again for
the chain in Phase 1, where it replaces these figures). *Equal* means the
interval of the paired difference contains 0 and its half-width is not wider
than the noise; if it is wider, the result is "not resolved", the run is
extended by another seed block, never judged on the first read.

Per model, three classes, evaluated in this order:

| Class | Condition | Consequence |
|---|---|---|
| **Peer** | Group A: chain is equal to direct or better (lower bound of the interval ≥ −noise); group B: chain pass rate ≥ 70 % **and** ≥ the model's own direct pass rate on A minus 10 points, and ahead of direct by a significant margin on B; silent-wrong rate ≤ direct's; plan-valid on first call ≥ 85 % | Offered as a normal working mode for the connection |
| **Fallback** | Not peer, but: on cases direct fails or refuses (group A and B), the chain recovers ≥ 25 % of them; on cases direct passes, a routed "direct first, chain after failure" never loses a pass (by construction) | Offered after a failed or refused direct query, or on request |
| **Not recommended** | Neither; or silent-wrong rate above direct's by a margin outside noise; or plan-valid on first call < 50 %; or the median latency > 3× direct and cost per correct answer > 4× | Hidden behind a warning in the connection settings; the evaluation still lets an admin measure it |

Why these numbers. The B bar has two parts: an absolute floor of 70 %
(below it the chain is no normal working mode for any model) and a bar
relative to the model's own direct result on A minus 10 points (B is harder by
construction, but the gap should stay small for a peer; it keeps the bar fair
across strong and weak models). The B cases are not yet calibrated: after the
first Phase 1 run, if the best model passes more than 95 % of B or the worst
less than 10 %, the cases do not separate models and are revised before the
thresholds are frozen. This is the only exception to freezing, and it is
documented. The 25 % recovery bar is what justifies the
extra calls: one case in four rescued. The silent-wrong clause overrides
accuracy, since the chain shows intermediate counts that look reassuring.
The cost clause is a guard, not a goal; it applies to local models too
(minutes per question).

Rules for the rule:
- The thresholds are written into this file and committed before the first
  Phase 1 run; a later change needs a commit that says why and names the
  results already seen.
- The classification is made on the confirm cases of the final configuration
  only. Prompt variants are chosen on tuning cases; if a variant wins on tuning
  and loses on confirm, the default stays.
- A model is classified once. A re-classification after a limit or prompt
  change needs a fresh seed block on confirm cases.
- The **global verdict** (ship the chain at all) is: at least one model
  of each kind (one local, one external) classified peer or fallback. If no
  local model reaches it, the chain is offered for external connections only
  and the report says so.

## 9 Order and rough effort

| Step | Content | Effort |
|---|---|---|
| 0 | Driver, trace, verdicts, parity test, gate dry run | done 2026-10-25 |
| 1a | Authoring groups B and C | done 2026-10-25 |
| 1b | Baseline runs and first read | local ladder done 2026-10-26 (section 12); Luna open |
| 2 | Failure taxonomy by hand | 2 days |
| 3 | Ablations | 2 days |
| 4 | Prompt variants, routing simulation | 3 days |
| 5 | Wider sweep, report, decision memo | 2 days |

## 10 Decisions

Answered 2026-10-25:

1. About 30 chain-native cases (group B), as planned.
2. External models: Luna, Haiku and Sonnet. Local: every model used for the
   direct requests. The aim is a full baseline and comparison for the chain,
   so Phase 5 covers all thirteen (section 5).
3. Order confirmed: harness and shared module first, then the application's
   runs (E3.6).
4. Gate: the chain dry run with a scripted stub model joins `make gate`
   (Phase 0, item 6). It needs no endpoint, runs in seconds, and is the only
   thing that keeps the driver from drifting from `model.service`. It stays
   a single small test, not a measurement, so the container issues of the
   recent commits are not widened.
5. Success rule: detailed in section 8; to be frozen before the first run.

## 11 Findings of Phase 0 (no model asked yet)

Found while building the driver and authoring the cases. Each is held by a
case or a probe in the dry run, so a fix shows up there.

| # | Finding | Held by | Consequence |
|---|---|---|---|
| F1 | The direct prompt sends a question with several conditions on the related layer to the chain ("auch mit mehreren Bedingungen auf einem Layer"). The chain refuses it too (`not_representable`: a step that a spatial step relates to has one attribute condition, not negated; its own tool list says so). Start case h32 expects that offer, for a question whose answer is empty anyway (no tram stop has category I) | `ks01` and its probe | The direct path offers an approach that cannot help. Fix the direct prompt's sentence and h32's expectation, or widen the chain |
| F2 | The direct prompt sends buffer questions to the chain ("kein Puffer … Sonst … other_approach chain"); a chain never ends in a buffer (D3). Start case h33 expects that offer | `ks02` and its probe | As F1: one sentence of the direct prompt and h33 |
| F3 | A whole layer as the target of a relation needs a step, and a `filter` needs a `where`. The step must be one attribute condition, not negated, that every feature meets: `not is_null` is refused, `standorte ge 0` passes | `kb15` and its probe; the scripts of `kb02`, `kb04` … | Hypothesis for Phase 2: models stumble here. Candidates: `where` optional for `filter`, or a relation's `in`/`to` taking a layer |
| F4 | Every result the chain accepts is also a valid direct query (`check_query` on every step). The chain adds decomposition and feedback (counts, re-plans), not reach. Where direct reaches further (*does not intersect*: `outside` means "lies in none", which is never true of a surface against a line) the chain cannot follow | All of group B (references pass `check_reading`); `ks05` | Group B measures whether decomposing helps a model, not whether the chain reaches more. The routing simulation (Phase 4) carries more weight than planned |
| F5 | The chain prompt has no default distance for "nahe" (the direct prompt says 300 m, as an assumption) | `ks11` (`require` 200–500 m) | Measured in Phase 1; a one-line candidate for Phase 4 |

Decided 2026-10-25: F1 and F2 are fixed after the Phase 1 baseline, which
measures what ships; `ks01`, `ks02`, h32 and h33 then show the fix as a
difference.

## 12 First read of Phase 1 (2026-10-26)

Local ladder only (gemma4:e4b, gemma4:12b, qwen3:14b). Chain and direct on
all four sets, two seed blocks each, 48 runs, about 6 700 answers. Luna is
still to run: `OPENAI_API_KEY` was not set in the session. The figures are in
[benchmarks.md](benchmarks.md), *Lauf 6*.

**In one sentence:** the chain loses to the direct path everywhere, by 32 to
69 points on the confirm cases, and the cause is the format of its plans, not
the reasoning in them.

- Only 19 % (e4b), 33 % (12b) and 40 % (qwen3:14b) of first plans pass
  `check_plan`.
- A chain that is accepted and runs to its end passes 76–83 % of the time.
  That is as good as the direct path's overall rate, and such chains are
  less often silently wrong (1–6 % against direct's 6–16 %).
- The chain recovers 0–4 % of the answers the direct path misses.

New findings:

| # | Finding | Evidence | Candidate fix |
|---|---|---|---|
| F6 | The chain's constrained output leaves each step's `arguments` free (`"type": "object", "additionalProperties": true`). The tools' schemas reach the model only as text, so models copy JSON-Schema syntax into their plans. The direct path's schema constrains the whole query | 1 843 refused plans. By first error: step number as text 448; `where` with `$ref`, `$op` or a nested `where` 353; both `layer` and `of`, or neither, 260; reference to no earlier step 122; invented `text_match` mode 99. Only 116 are `not_representable` | The chain's answer format with one schema per tool: the tool name as a constant, the arguments as the tool's own model, references as integers, `layer` and `of` as alternatives. Highest value: the errors of this kind are 77–84 % of all refusals |
| F7 | A plan refused by `check_plan` ends the chain. Only an error or an empty step that ran triggers a re-plan, so the model never learns what was wrong with its plan | Re-plans in 1 % of chains | A re-plan after a refused plan, carrying the refusal's code and location as a step error is carried (a P4 change: the record and the approval flow are involved) |
| F8 | Re-plans, where they happen, rescue nothing: 23 re-planned chains, 0 passes | Mostly an empty filter, re-planned to the same empty result | Measure again after F6; Q4 cannot be answered while plans die at the check |
| F9 | On the chain path, small models ask back instead of planning: gemma4:e4b answers with a clarification 212 times where a query was due | `kind:clarification` 212 (e4b), 83 (12b), 75 (qwen3:14b) | Phase 4: compare the chain prompt's rules on clarifications with the direct prompt's |

What this changes in the plan:

1. **Classification.** By the rule of section 8, all three models are *not
   recommended* on this baseline: fewer than 50 % of first plans are accepted.
   That is a statement about the chain as shipped.
2. **Calibration check of group B.** It is formally triggered: the worst
   chain rate on B is below 10 %. The direct path passes the same cases at
   54–77 %, so the cases do separate models; the floor comes from F6.
   Recommended: keep the cases and the thresholds, and record that the check
   fired for that reason.
3. **Order.** Phase 3's ablations (re-plans, step limit) say nothing while
   most plans die before the first step. Recommended next steps:
   - Pull the F6 fix forward as the first improvement.
   - Re-run the chain for the three local models (tuning and confirm, two
     blocks, about 3 hours).
   - Then the failure reading of Phase 2 on what remains.
   - Then Phase 3.

   F7 is the second candidate. F1 and F2 stay as decided, after the baseline.
4. **Luna.** It still belongs to the baseline. It runs as soon as the key is
   available, on the chain as shipped, before any fix.
