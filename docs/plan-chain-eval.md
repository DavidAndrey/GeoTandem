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

**Amended 2026-10-28 (F20), after the results of `b6` (section 16).** The
silent-wrong clause as frozen asked for another seed block whenever its
interval contained 0 and was wider than the noise. The width comes from the
cases, not the seeds (a third block moved it by 0.2 points), so the rule
never ended. The clause is now split by class:
- **Peer:** the chain replaces direct, so its silent wrongs count on every
  case. Paired per case, chain minus direct, the upper bound of the 95 %
  interval must stay below **+5 points** (a non-inferiority margin).
- **Fallback:** the chain runs only after a *visible* failure of direct (a
  refusal, an error, a wrong answer that states an assumption); a silent
  wrong of direct never reaches it. Measured on those answers, A and B
  confirm: the chain passes **≥ 25 %** of them, and its silent wrongs there
  stay at **≤ 20 %** (upper bound of a 95 % bootstrap over cases). This
  replaces the recovery bar over all of direct's failures.
- **Not recommended:** neither, as before.

Results seen when this was decided: the classification of section 16 and
its silent-wrong intervals. No threshold above changes a class against the
nearest alternative tried (a ratio of three passes per silent wrong gives
the same classes).

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
| F10 | The chain's system message has no rules and no worked examples: the builder adds them for the direct query only. Nothing tells a chain about code keys, names with `eq`, lines against areas, the 300 m default (F5) or "at most one clarification" (F9) | `system_message` in `model/prompt.py`; label errors such as "Bahn" for `bahn` | The direct query's rules, written as steps, with worked plans on the same invented layers |

**Fixes made (2026-10-26):**
- **F6**, commit `8514c5c`: one schema per tool in the chain's constrained
  output.
  - A first look at gemma4:e4b, seed block 1, before a stopped re-run: first
    plans accepted went from 20–27 % to 70–79 % on the start set, and from
    0 % to 39 % on the confirm chain cases.
  - Pass went from 23–29 % to 44–46 % on the start set.
  - Silently wrong went from 1 % to 9–14 %, now that more plans run.
  - About 85 of the roughly 100 refusals left are references to no earlier
    step (F7).
- **F10**, commit `ab2df04`: the rules and worked plans for the chain prompt.
  The prompt grows by about 1 300 tokens. Not measured yet beyond a smoke
  test.

- **F7**: a plan the checks refuse gets one correction (`ask.plan`, used by
  the service and the evaluation driver alike).
  - The model is told what it is told of a failed step: the step, its tool,
    and `model_view` of the refusal (code, plus as `part` a name it wrote or
    a word of the tool's schema). The refusal's text never reaches it.
  - The correction counts against the request limit as a re-plan does. It
    is skipped at the limit, and the refusal then stands. It does not count
    against `MAX_REPLANS`. Its tokens are added to the record's.
  - The model stub (`e2e/model-stub`) finds a correction's case by the
    question before it.
  - The security sentinel now checks that a correction for a hidden layer
    is word for word the one for a missing layer.

Both F6 and F10 change the chain prompt, so its pinned hash in
`test_prompt_profiles.py` is taken again. Luna's baseline must therefore
come from commit `7d1bc35`.

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

## 13 After F6, F10 and F7 (2026-10-26)

The chain was re-run on the three local models with the three fixes (commit
`cc8ba0d`, labels `b3-k-*`), at the baseline's settings. The direct path is
the baseline's. Figures in [benchmarks.md](benchmarks.md), *Lauf 7*.

**What changed:**
- **First plans accepted:** 19/33/40 % → 49/61/68 % (gemma4:e4b, gemma4:12b,
  qwen3:14b).
- **Pass, all sets:** 19/29/32 % → 40/47/43 %.
- **Recovery of direct's failures (confirm cases):** 0–4 % → 12/18/24 %.

**What did not change:**
- **Gap to direct.** The chain is still behind on every set: −25 to −31
  points on A (confirm) and −30 to −48 on B. Only qwen3:14b's interval on B
  touches zero.
- **Silent wrongs.** The chain is now about as often silently wrong as direct
  (8/10/16 % against 6/8/16 %). The baseline's lead only meant that few plans
  ran.
- **Corrections and re-plans rarely rescue.** 7–18 % of corrected plans are
  accepted, and re-planned chains almost never pass.
- **gemma4:e4b still asks back** where a plan is due: 211 clarifications
  (F9 is not solved by F10's rule). On its stress cases it dropped from 6 %
  to 1 % because of one case (`ks09`, a clarification in place of
  `cannot_answer`).

**Classification (section 8), on this intermediate state:** still no model
reaches *fallback*.
- First plans accepted: gemma4:12b and qwen3:14b now clear 50 %; gemma4:e4b
  does not (49 %).
- Recovery: qwen3:14b reaches 24 %, just below the 25 % bar; the others are
  further below.

| # | Finding | Evidence | Candidate fix |
|---|---|---|---|
| F11 | F3 is the main refusal left. A spatial step can act only on an earlier step, so to use a whole layer the model names the step itself (`outside {"of": 2, "in": 1}` as step 2) | 495 of the 900 refusals after the correction are a step naming itself; 11 name a later step | Let `of`, `in`, `to` and `with` take a layer name as well as a step number (one condition-free query object on that layer). This also removes the invented always-true conditions of F3 |
| F12 | Next after F11 are `not_representable` refusals (288): a relation to a step with more than one condition or a negated one, a relation to a relation, a chain ending in a buffer | Refusals after the correction, by code | F1/F2 (the direct prompt's promises) and a clearer statement in the chain's rules; part of it is the chain's real limit (F4) |

**Next, recommended:**
1. F11. It is the largest single cause, and it makes the tools match how
   models plan.
2. A re-run.
3. Then the failure reading of Phase 2, on the wrong answers that run (the
   silent wrongs), not on the refusals.

Luna's baseline still runs from commit `7d1bc35`.

## 14 Luna's baseline, and the chain after F11 (2026-10-27)

Two runs at the baseline's settings. Figures in [benchmarks.md](benchmarks.md),
*Lauf 8*.
- **Luna's baseline:** the chain as shipped (`7d1bc35`) and the direct path.
  This completes Phase 1's baseline.
- **The chain after F11:** commit `f776048`, labels `b4-k-*`, on the three
  local models.

**Luna (baseline):**
- **Gap to direct:** the chain trails direct about as far as the local
  models did. Paired, it is −31 points on A and −37 on B and C.
- **Recovery:** 10 % of direct's confirm failures.
- **Silent wrongs:** almost none (0.5 % against direct's 7.5 %).
- **Refusals:** 150 of its 205 refused plans are F11 and F6 shapes, both
  fixed since.

So Luna's baseline says little about today's chain. *Not recommended* on the
chain as shipped (recovery below 25 %).

**After F11 (local):**
- **First plans accepted:** 49/61/68 % → 80/79/82 % (gemma4:e4b,
  gemma4:12b, qwen3:14b).
- **Schema refusals:** almost gone (`model_query_invalid`: 6 in all).
- **Pass, all sets:** 40/47/43 % → 48/64/53 %.
- **Paired on B and C:** gemma4:12b (−14, interval to +6) and qwen3:14b (−7,
  interval to +13) are no longer resolved behind direct.
- **gemma4:12b on B tuning** is ahead of direct (71 % against 64 %).
- **Recovery of direct's failures on A and B (confirm):** 31/43/26 %, past
  the 25 % bar for all three.
- **But silent wrongs rose:** on the A and B confirm cases they are now
  15/13/28 % against direct's 5/5/15 %. Most of them are on group A, on
  cases direct gets right.

**Calibration check (section 8):** settled on this state. On B confirm the
best model passes 60 % and the worst 25 %, so B separates models. The open
question of section 12 (keep group B) needs no change of cases.

**Classification, on this intermediate state:** every local model is *not
recommended*. Recovery would make each a fallback, but the silent-wrong
clause overrides it. No model is a peer: on A every interval stays below
−noise.

| # | Finding | Evidence | Candidate fix |
|---|---|---|---|
| F13 | No step expresses "polygons that contain features". Models write `within {"of": <polygons>, "in": <points>}`, which is always empty; direct writes `related … contains` | `h26-gemeinden-seilbahn` and `h27-gross-mit-sek` silently wrong in 9 and 10 of 10 answers of gemma4:12b; 16 (12b) and 49 (qwen3:14b) silent wrongs whose first empty step is a `within` | A `contains` tool, or `within` taking either direction by the geometry types; a rule and a worked example in the chain prompt |
| F14 | A chain that ends with no features is taken as the answer | Of the silent wrongs, 12/53/96 end empty (e4b, 12b, qwen3:14b) | An empty step's result shown to the model as such, with one re-plan; or the answer carries a note that the result is empty |
| F12 | `not_representable` is now the main refusal | 214 of the 319 refusals left after the correction | As in section 13 |

**Next, recommended:**
1. **Phase 2 failure reading of the silent wrongs.** They now decide the
   class. F13 and F14 explain part of them, not all.
2. **F13 and F14**, then a re-run.
3. **F12.**
4. **Luna on the current chain:** one block of the confirm sets, to know
   whether an external model clears the bar. That costs roughly USD 1–2.

## 15 Phase 2: the silent wrongs after F11, their fixes, and the re-run (2026-10-27)

**The reading.** Every silent wrong of the F11 run (`b4-k-*`, 510 answers
over gemma4:e4b, gemma4:12b and qwen3:14b) was grouped by case and plan
shape, read by case, and given one primary cause. Structural causes were
then counted by script over all answers, passes included, to see which a
check could refuse without touching a correct plan.

| Cause | e4b | 12b | qwen3:14b | All | On passes |
|---|---:|---:|---:|---:|---:|
| A condition of the question is missing, mostly a layer named whole (F11) where the question restricts it («Bushaltestellen» ⇒ `"haltestellen"`) | 53 | 33 | 35 | 121 | – |
| `within` or `outside` against points or lines: areas in points, everything «outside» a river | 1 | 19 | 66 | 86 | 0 |
| A step no later step reads, whose conditions the result lacks: the model reads the steps as combined, the result is the last one alone | 40 | 16 | 26 | 82 | 7 |
| Invented conditions: guessed codes and numbers (`gem_nr` = 1, 1234 …), catch-alls (`typ ne spezial`, `not is_null`) that drop features | 9 | 11 | 60 | 80 | – |
| The result on the wrong layer: «Gemeinden mit einer Seilbahnstation» ends on the stations, since no step keeps areas that contain features | 10 | 20 | 46 | 76 | – |
| Other (empty results of other causes, redundant steps, name resolution) | 12 | 17 | 36 | 65 | – |

Most silent wrongs are on group A, cases direct gets right: the chain loses
there what the direct query's `related` expresses in one condition.

**F12 read again.** The 240 `not_representable` refusals of `b4` overlap
these causes more than they mark the chain's own limit:
- **`related` (79):** a relation's filter with two conditions (31) or a
  negated one (20), the controls' limit (D3); invented catch-alls (9).
- **`with`, `in`, `to` on a relation (39):** two results joined by
  `intersects` where the second spatial step should build on the first;
  a relation to a relation (the chain's limit, F4).
- **`source` (35):** a table layer as a step.
- **`in` of a buffer for areas or lines (21), a chain ending in a buffer
  (20), a buffer as `of` (17, the arguments reversed).**
- **`compare` (12), `near_feature` (5):** invented conditions.

**F14 is not done as planned.** A re-plan after an empty last step would
need a re-plan that keeps a result (today a re-plan answer that is no plan
ends the chain), in the service and the interface, and would risk the 31
passes whose correct result is empty. In the reading, an empty end is rarely
a cause of its own (14 of 510): the empty endings come from the geometry
and the invented conditions, which the fixes below address.

**Fixes (commit `d61df1e`):**
- **F13:** a tool `contains` (`{"of": <areas>, "has": <features>}`, the
  query's `related` with `contains`), and a check: `within` or `outside` of
  points or lines, and `contains` on them, is refused as
  `not_representable`, `part: geometry`. Never on a pass of `b4`.
- **F15:** a step no later step reads, whose conditions or buffer distance
  the last step's query lacks, is refused as `not_representable`,
  `part: unused`, naming the step. 89 silent wrongs of `b4` against 7
  passes; a step the result repeats passes.
- **F16:** rules in the chain prompt: name a whole layer without a
  catch-all condition; a restricted subject needs a `filter`; only the last
  step is the result and a further condition builds on the step before
  (`of`), a second spatial one too; never a guessed code or number; nothing
  lies in a point or a line, with a worked plan for `contains`.
- **F12:** a relation's filter `not` of one comparison is written as its
  complement (`ne`, `ge` …; the same rows in SQL, a missing value fails
  both). This also lets the direct query through where it wrote the same.
  A relation's filter of two conditions stays the controls' limit.

The correction (F7) reaches the model with the code and the part
(`geometry`, `unused`), as for every refusal.

### The re-run (`b5-k-*`)

Commit `d61df1e`, the three local models, both seed blocks, all four sets;
direct is the baseline's (`b1-d-*`). Figures in
[benchmarks.md](benchmarks.md), *Lauf 9*.

**What the fixes did:**
- **Silent wrongs, all sets:** 125/116/269 → 142/56/178 (e4b, 12b,
  qwen3:14b). On the A and B confirm cases 15/13/28 % → 16/7/20 %, direct
  5/5/15 %.
- **F13 works.** `h26-gemeinden-seilbahn`, silent in 9 (12b) and 10
  (qwen3:14b) of 10 answers, now passes in 10 and 9. `h27-gross-mit-sek`
  passes for qwen3:14b in 9 of 10, direct in 2. No silent wrong is left
  whose cause is geometry; the check refused 45 plans after the correction.
- **F15 turns silent wrongs into refusals.** Unused steps with lost
  conditions: 82 → 22 silent wrongs. `doc2-gut-erschlossen` on qwen3:14b:
  10 silent wrongs → 10 refusals. The check refused 124 plans after the
  correction, the most of any part.
- **The price:** first plans accepted 80/79/82 → 69/73/75 %; chains ending
  refused 86/100/133 → 126/146/201. The correction rescues 28/32/4 % of the
  refused first plans (qwen3:14b rarely mends a plan).
- **Pass, all sets:** 48/64/53 → 49/69/56 % (direct 70/76/66 %). On A
  confirm 66/78/58 → 68/83/68 %.
- **Paired on the confirm cases (chain minus direct):** A −15 (−28 … −1),
  −8 (−18 … +3), −12 (−28 … +3); B and C −32 (−50 … −14), −6 (−26 … +14),
  −9 (−30 … +11). gemma4:12b and qwen3:14b are no longer resolved behind
  direct on A.
- **Recovery of direct's failures on A and B (confirm):** 23/57/38 % (was
  31/43/26 %).

**What the fixes did not do.** F16's rule «a restricted subject needs a
`filter`» did not take on gemma4:e4b and qwen3:14b. The missing condition is
now the main silent cause by far:

| Primary cause (`b5`) | e4b | 12b | qwen3:14b | All | `b4` |
|---|---:|---:|---:|---:|---:|
| A condition missing, mostly the subject's layer named whole | 95 | 19 | 63 | 177 | 121 |
| Invented conditions | 7 | 6 | 66 | 79 | 80 |
| An unused step with lost conditions | 4 | 2 | 16 | 22 | 82 |
| Ends empty, of no other cause | 1 | 15 | 7 | 23 | – |
| The result on the wrong layer | 6 | 0 | 5 | 11 | 76 |
| Geometry (`within` of points or lines) | 0 | 0 | 0 | 0 | 86 |
| Other | 29 | 14 | 21 | 64 | 65 |

The typical shape (gemma4:e4b, `kb22`, `kb10`, `kb30`): filter and buffer the
reference correctly, then `intersects {"of": "haltestellen", "with": 2}` for
«Bushaltestellen»: the subject's own condition is dropped. A check cannot
refuse it: 96/222/165 passes name a whole layer as well.

**Classification (section 8), on the confirm cases.** The silent-wrong
clause is now judged as the pass rate is, paired per case (seeds pooled),
with a 95 % bootstrap interval (A and B confirm, 54 cases):

| Model | Silent wrongs, chain minus direct | Seed blocks, chain | Recovery A+B | Class |
|---|---|---|---|---|
| gemma4:e4b | +10.9 points (+5.0 … +17.4) | 13.0 / 19.3 % | 23 % | *not recommended* |
| gemma4:12b | +2.2 points (−4.4 … +8.9) | 7.0 / 7.0 % | 57 % | *not resolved*, fallback if the clause stays clear |
| qwen3:14b | +3.7 points (−6.1 … +13.3) | 21.1 / 18.1 % | 38 % | *not resolved*, fallback if the clause stays clear |

For gemma4:12b and qwen3:14b the interval contains 0 but is far wider than
the noise, so the rule says *not resolved* and asks for another seed block.
None is a peer: B confirm passes 67 % and 51 %, below the 70 % floor.

Read the same way, section 14's verdict on gemma4:12b was not resolved
either: paired, `b4` gives +8.1 (−1.3 … +17.6). The pooled rates (13 against
5 %) looked clear, since many silent wrongs sit on a few cases. qwen3:14b's
(+11.7, +0.6 … +22.8) and gemma4:e4b's (+9.6, +3.9 … +15.9) held.

| # | Finding | Evidence | Candidate fix |
|---|---|---|---|
| F17 | The subject is named as a whole layer where the question restricts it; the rule of F16 does not reach the small models | 177 of 376 silent wrongs of `b5`, 95 of 142 on gemma4:e4b | A worked plan whose last spatial step reads a filtered subject (`of: <step>`); per-model prompts (Phase 4). No check: passes have the same shape |
| F18 | qwen3:14b writes `related_dwithin` with `distance_m` 0 | 10 schema refusals | A rule, or 0 read as `intersects` |

**Next, recommended:**
1. **A third seed block on the confirm sets** (`heldout`, `chain-heldout`,
   seeds from 11), chain and direct, for gemma4:12b and qwen3:14b. It
   resolves the silent-wrong clause and is the fresh block a
   re-classification needs. About 1–1.5 hours, local.
2. **F17**, then a re-run.
3. **Luna on the current chain** (roughly USD 1–2), for the global verdict's
   external model.

## 16 F17, and six models on the chain (2026-10-28)

**F17 (commit `a29d781`).** The chain prompt gains two rules and a worked
plan: a restricted subject («Bushaltestellen», «öffentliche Schulhäuser») is
a `filter` step, and the spatial step names it by its number, the subject as
well as the other objects; only a subject meant whole is named by its layer,
without a catch-all condition. **F18** in the same commit: `near` needs a
`distance_m` above 0, a distance of 0 is `intersects`.

A tuning check before the run (gemma4:e4b, seed block 1, `t17`): cases 93 →
90 passes, 8 → 6 silent wrongs; chain 24 → 27 passes, 13 → 12 silent wrongs.
Within the noise. The subject is now mostly filtered, some other conditions
are still dropped.

### The run (`b6-*`)

Commit `a29d781`, six models: gemma4:e4b, gemma4:12b, qwen3:14b, qwen3.5:9b
(local, as in Lauf 6), gpt-6-luna (as in Lauf 8) and claude-haiku-5-5 (as in
Lauf 3: effort default, temperature 1). Confirm sets (`heldout`,
`chain-heldout`) in three seed blocks (1, 6, 11), chain and a fresh direct
run each; tuning sets in two blocks, chain only. Figures in
[benchmarks.md](benchmarks.md), *Lauf 10*.

**Pass on the confirm cases, chain / direct:**

| Model | A | B | C |
|---|---|---|---|
| gemma4:e4b | 62 / 78 % | 30 / 59 % | 20 / 48 % |
| gemma4:12b | 75 / 85 % | 61 / 76 % | 21 / 46 % |
| qwen3:14b | 67 / 76 % | 49 / 58 % | 30 / 43 % |
| qwen3.5:9b | 57 / 71 % | 39 / 43 % | 9 / 24 % |
| gpt-6-luna | 82 / 87 % | 87 / 79 % | 47 / 50 % |
| claude-haiku-5-5 | 98 / 98 % | 94 / 87 % | 70 / 56 % |

**Section 8, per model** (paired per case, seeds pooled, 95 % bootstrap;
silent wrongs on A and B confirm, 54 cases; noise is the spread of the direct
pass rate on A over the three blocks):

| Model | Paired A | Paired B | Silent, chain / direct | Silent, paired | First plan accepted | Recovery A+B | Class |
|---|---|---|---|---|---|---|---|
| gemma4:e4b | −19.4 (−34.8 … −4.3) | −28.9 (−50.7 … −5.6) | 12.8 / 7.3 % | +5.3 (−1.7 … +12.5) | 67 % | 35 % | *not resolved*; fallback if the clause clears |
| gemma4:12b | −14.8 (−26.9 … −4.1) | −14.4 (−40.0 … +12.6) | 5.7 / 5.2 % | +0.2 (−6.5 … +6.3) | 79 % | 41 % | *not resolved*; fallback if the clause clears |
| qwen3:14b | −13.3 (−28.1 … +0.9) | −8.9 (−34.8 … +17.0) | 14.8 / 14.3 % | +0.0 (−9.5 … +9.5) | 75 % | 33 % | *not resolved*; fallback if the clause clears |
| qwen3.5:9b | −17.0 (−29.8 … −3.9) | −3.3 (−25.9 … +19.6) | 21.7 / 4.8 % | +16.8 (+9.1 … +24.7) | 64 % | 32 % | *not recommended* |
| gpt-6-luna | −9.1 (−20.9 … +2.0) | +8.5 (−9.3 … +25.9) | 2.0 / 6.9 % | −5.2 (−11.2 … −0.2) | 89 % | 75 % | **fallback** |
| claude-haiku-5-5 | 0.0 (−3.7 … +3.9) | +6.7 (+0.7 … +15.9), sign test p 0.12 | 0 / 0 % | 0 | 93 % | 67 % | **fallback**; peer *not resolved* |

- **Haiku** passes every peer condition but two: on A the interval is
  centred on 0 but ±3.8 wide against a noise of ±1 (direct passes 97–99 %
  per block), and on B the bootstrap interval excludes 0 while the sign test
  (6 better, 1 worse) does not. With direct near the ceiling on A, more seed
  blocks will hardly narrow either.
- **Luna** is the first model whose chain makes fewer silent wrongs than its
  direct query, outside the interval (2.0 against 6.9 %).
- **qwen3.5:9b** (first time on the chain) adds silent wrongs: 21.7 against
  4.8 %, every seed block near 21 %.
- No model fails the latency and cost clause: median latency at most 1.7×
  direct, seconds per correct answer at most 2.6×.

**The silent-wrong clause does not resolve by seed blocks.** For gemma4:12b
and qwen3:14b the point estimate is 0, and the third block narrowed the
interval only from ±6.6 to ±6.4 and from ±9.7 to ±9.5. The width comes from
the spread between cases (a few cases carry most silent wrongs), not between
seeds; the seed-block rates move by 1–4 points. As written, section 8 keeps
asking for another block. A reading that terminates: the clause fires when
the interval's lower bound is above 0 (as for qwen3.5:9b), and only then.
With it, gemma4:e4b, gemma4:12b and qwen3:14b are fallback. This is a change
of a frozen rule and is left to a decision.

**Global verdict.** At least one external model is fallback (Luna, Haiku).
A local one is fallback under the reading above (gemma4:12b with the
smallest interval); strictly, none is resolved yet.

### F17 against Phase 2, on the same seeds

`b5` and `b6` on seed blocks 1 and 6, chain only, paired `b6` minus `b5`:

| Model | A | B and C | Silent wrongs, both confirm sets |
|---|---|---|---|
| gemma4:e4b | −4.2 (−11.1 … +1.4) | +2.4 (−3.6 … +10.0) | 93 → 70 |
| gemma4:12b | −7.5 (−16.7 … +0.6) | −10.0 (−24.0 … +3.6) | 39 → 33 |
| qwen3:14b | −1.1 (−4.7 … +1.9) | −0.8 (−14.0 … +11.6) | 118 → 81 |

F17 cut silent wrongs by a quarter to a third, at no clear cost in passes
for gemma4:e4b and qwen3:14b. gemma4:12b lost passes: on heldout it gives a
clarification or a `cannot_answer` instead of a result 44 times instead of 8
(both blocks). It asks which «Bern» is
meant (`h22`, 5 of 5), declines `h27` because it takes `gemeinden` for a
table layer, and filters the Aare by `typ` instead of `name` (`h20`). These
are safe failures, mostly; they explain 12b's lower A and B against `b5`.

| # | Finding | Evidence | Candidate fix |
|---|---|---|---|
| F19 | After F17, gemma4:12b asks for clarification or declines where it planned before | `kind` verdicts on heldout 8 → 44 (blocks 1 and 6); `h22` 5 → 0, `h27` 5 → 0 passes | Per-model prompt (Phase 4); look at which F17 sentence it reads as doubt |
| F20 | The silent-wrong clause of section 8 cannot be resolved by more seed blocks | Interval width unchanged by a third block (12b ±6.6 → ±6.4, qwen3:14b ±9.7 → ±9.5) | Decided 2026-10-28: the clause split by class, section 8 amended (below) |

### The classification under the amended rule (F20)

On A and B confirm, three blocks, 810 answers per model. *Visible failures*
are direct's answers that neither pass nor are silently wrong; on them the
chain runs as fallback:

| Model | Direct: visible failures / silent | Chain on them: pass | Chain on them: silent | Class |
|---|---|---|---|---|
| gemma4:e4b | 149 / 61 | 33 % (11 … 55) | 9 % (3 … 19) | **fallback** |
| gemma4:12b | 77 / 44 | 35 % (12 … 70) | 5 % (0 … 11) | **fallback** |
| qwen3:14b | 101 / 120 | 25 % (4 … 54) | 31 % (10 … 55) | *not recommended* |
| qwen3.5:9b | 253 / 40 | 29 % (15 … 44) | 31 % (18 … 46) | *not recommended* |
| gpt-6-luna | 50 / 58 | 72 % (37 … 100) | 6 % (0 … 14) | **fallback** |
| claude-haiku-5-5 | 45 / 0 | 67 % (27 … 100) | 0 % | **fallback** |

- **qwen3:14b and qwen3.5:9b** turn about as many visible failures into
  silent wrongs as into passes. As a fallback they would replace an honest
  failure with a wrong number one time in three.
- **gemma4:e4b** clears the silent bar narrowly (upper bound 19 %).
- **Peer:** only Haiku meets the B floor of 70 % with its own A; its silent
  wrongs pass the new margin (0 against 0), but A (±3.8 against a noise of
  ±1) and the B sign test (p 0.12) stay unresolved.
- **Global verdict: met.** Local fallback: gemma4:e4b, gemma4:12b;
  external fallback: gpt-6-luna, claude-haiku-5-5.

**Next, recommended:**
1. **Per-model prompts (Phase 4)**, starting with the qwen models, whose
   silent wrongs keep them out, and gemma4:12b (F19).
2. **Haiku as peer:** only a larger B set can resolve it; the seeds cannot.

### F21: the plan checked against its question (2026-10-28)

The main silent cause, a condition of the question the plan drops (F17), can
be checked after all, from the question's side: commit `e278945`
(`model/chain/cover.py`). The question's text is searched for what the layer
profile names, nothing else: codes of confirmed code lists and boolean
attributes by their stem («Bus», «Hauptgewässer», «französisch»,
«Sekundarstufe»), and distances («300 m», «2 km»). The plan carries one when
it writes the code, a condition on the same attribute (a complement: «weder
Bus noch Tram» as the other codes), a single feature by its name («der
Bahnhof Bern»), or the distance within 1 %. A plan that lacks one is refused
(`not_representable`, `part: missing`) and corrected once; the model is told
the attribute, a name of the profile, never a value.

**On the recorded `b6` answers** (all six models): 232 of 737 silent wrongs
caught (gemma4:e4b 82, gemma4:12b 22, qwen3:14b 59, qwen3.5:9b 62, Luna 7,
Haiku 0); of 5577 passes 3 refused, each a plan that drops the condition and
passes by chance («near all stops» for «near bus stops»).

**Tuning check (`t21`, seed block 1, against `b6` on the same seeds):**

| Model, set | Pass | Silent wrong | Refused |
|---|---|---|---|
| gemma4:e4b, chain | 27 → 30 | 12 → 1 | 9 → 20 |
| gemma4:e4b, cases | 90 → 91 | 2 → 4 | 31 → 29 |
| qwen3:14b, chain | 36 → 38 | 16 → 7 | 18 → 24 |
| qwen3:14b, cases | 98 → 100 | 20 → 17 | 25 → 27 |

On the multi-step questions the silent wrongs fall by more than half; the
caught plans become a corrected pass or an honest refusal, and passes do not
drop. On the simple questions nothing changes beyond noise: qwen3:14b's silent
wrongs there are mostly invented conditions, which the check does not see.

| # | Finding | Evidence | Fix |
|---|---|---|---|
| F21 | A plan that drops a condition the question names (code, flag, distance) passes the checks | 232 of 737 silent wrongs of `b6`; 3 of 5577 passes, all by chance | Done in `e278945`; the classification needs a fresh confirm block |

**Next:** a confirm block with F21 (the confirm sets, seeds from 16, chain
only, against `b6-d`) re-classifies the local models. The qwen models'
remaining silent wrongs are invented conditions: option 3 of the
improvements, real values in the prompt (see
[plan-improve-examples.md](plan-improve-examples.md)).
