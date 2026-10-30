# Plan: examples chosen per question, for the direct query and the chain

> Stand: 2026-10-30 · proposal, not started; section 6 (the measurement)
> worked out, the check included · Bezug:
> [plan-chain-eval.md](plan-chain-eval.md) (sections 15, 16; F16, F17),
> [plan-e3.md](plan-e3.md) (D2, D3, D9, F-9.3),
> [testplan-system-context.md](testplan-system-context.md) (8.5, Phase 4)

## 0 Why

Both approaches send a fixed set of worked examples, written on an invented
dataset (oaks, the Altstadt, Seedorf; `prompt.py`, `_EXAMPLES`). Two findings
of the chain evaluation point past that:

- **Small models copy examples, they do not follow rules.** F13 came with a
  worked plan and its case went from 0 to 10 of 10; F16's rule «a restricted
  subject needs a filter» did not take on gemma4:e4b and qwen3:14b; F17 took
  once it had a worked plan.
- **Invented conditions** (`gem_nr = 1234`, `typ ne spezial`) are the
  second cause of silent wrongs in the chain (79 of 376 in `b5`), almost all
  qwen3:14b. Phase 4 of testplan-system-context showed that confirmed code
  lists matter more than the choice of model.

Examples chosen for the question at hand, and in the end taken from the
customer's own verified cases, address both, for the direct query as well as
for the chain.

## 1 Two sources, one mechanism

| Source | What | When |
|---|---|---|
| **Library** | 25–40 worked examples on the invented dataset, tagged by the operations they show; today's examples become part of it | Always; the base of every installation |
| **Own cases** | The administrator's cases of E3 (authored, from the log, imported) with a reference query on live data | Once there are any, and only those marked for it |

A question gets one fixed base example and up to three chosen ones (the
count is a setting of the prompt profile, section 5).

### The library

- One versioned file in the package, beside `examples/12.txt`.
- Each example: question, the direct query, the chain plan, tags of the
  operations: `filter-subject`, `buffer`, `within`, `outside` / negation,
  `contains`, `near` with a distance, two conditions on one object, count.
- Every shape the tools allow has at least two examples; the shapes small
  models get wrong (a buffer around a filtered object, areas that contain
  something) have more.
- **Tested:** each example's query and plan pass the application's checks
  (`check_plan` and the query checks) against the invented dataset, so a
  broken example fails the tests rather than teaching a mistake.

### Own cases

Every E3 case's reference is a direct query (`gold`, also in the chain sets).
The chain plan is derived from it mechanically: the chain's tools mirror the
query's parts (`related` becomes a filter step and a spatial step; `contains`
is the query's `related` with contains, F13). One case serves both
approaches. Questions only the chain can answer would need a reference plan,
which the case format does not have yet (later).

## 2 Choosing examples

Deterministic, in code, no extra model call, so the choice can be tested and
read back.

1. **Layers:** the layers the question names, by name and label in the layer
   profile. Weighs most for own cases (same world).
2. **Shape:** German cue words mapped to operations:
   - «in der Nähe», «nahe», «500 m» → `near`
   - «Puffer», «um» with a distance → `buffer`
   - «ausserhalb», «ohne», «nicht», «kein» → `outside` / negation
   - «mit einer», «in denen … steht» → `contains`
   - «wie viele» → count
   - an adjective or a compound before the subject («öffentliche»,
     «Bus-») → `filter-subject`
3. Rank by overlap (layers first for own cases, shape for the library), take
   the top ones, add the fixed base example.

Not embeddings: the library lives in another world than the customer's data,
and «Bushaltestellen nahe der Aare» lies closer in meaning to a topic than to
a plan of the same shape.

## 3 Keeping the evaluation honest

Examples taken from cases that are also measured show memorisation.

- Only `tuning` cases may be examples, never `confirm` cases (D2).
- A case is never its own example (leave one out when a tuning case runs).
- Explicit: a flag **«als Beispiel verwenden»**, offered on tuning cases only.
- New library examples are written only for weaknesses found on tuning
  cases, never from confirm cases.

## 4 Privacy (F-9.3)

The layer profile may leave the house, data contents may not. A reference
query can hold data (a name, an address, a parcel number). For an external
connection an own case goes out as an example only if every value in it is
from a confirmed code list (already in the profile) or a number such as a
distance; otherwise it is used for local connections only. The library is
invented and always allowed.

## 5 Integration

- **Prompt profile (D9):** *Beispiele* gains `eigene` (library plus own
  cases) beside `standard` and `12`, with a count. Measured like every preset
  in the run matrix, adopted with «Promptprofil übernehmen».
- **Placement:** the examples go after the fixed part of the prompt (system
  prompt, layer profile), right before the question, so the prompt cache of
  external models keeps the long prefix (the builder already places examples,
  P5/P9).
- **Upkeep:** a stale or invalid case (D3) drops out of the pool by itself;
  the pool's hash is part of the run label, so runs stay comparable. The
  prompt hash test pins the library and the selector instead of one prompt.
- **Per model:** the library is shared; the count is per profile, e.g. three
  for small models, fewer or none for Haiku (Phase 4 of the chain).
- **Recording:** each answer records which examples it was given.

## 6 First step: measure before building

A harness option, no application change. The measurement decides whether
the rest is built, so its cases, groups and decision rule (6.1–6.6) are
fixed before the first run; nothing in them is changed after looking at
results.

### 6.1 What the sets give today

Counted on the reference queries (2026-10-28):

| | Pool (tuning) | Measured (confirm) |
|---|---|---|
| Cases with a reference | 35 | 50 |
| one layer | 12 | 16 |
| two layers | 21 | 32 |
| three layers | 2 | 2 |
| a relation inside a relation's filter | 0 | 0 |

- 8 confirm cases use a combination of layers no pool case has
  (`gewaesser`, `strassen`, `gewaesser+strassen`, `gewaesser+schulen`,
  `haltestellen+strassen`); `strassen` is the subject of 6 confirm cases
  and 1 pool case.
- **Load-bearing check:** each condition of every reference dropped in turn
  (202 conditions, 90 cases) and the result compared on the sample data.
  In 5 cases a condition changes nothing, so an answer that drops it still
  passes: `kb04-koeniz-nahe-bus` (confirm; without the bus condition, the
  same 11 schools), `kb15-seilbahn-nahe-schule`, `kb24-sek-klein-nahe-bus`,
  and one branch of the «oder» in `doc6-verschachtelt` and
  `h14-sek-kg-oder-gross`. `n12-schiff-leer` is empty by design.

As they stand, the sets would measure two-layer questions on schools and
stops, and not the questions with several conditions where the chain drops
one (F17, F21).

### 6.2 Data

The sample dataset is real open data (AGI Kanton Bern, opendata.swiss,
`terms_open`). Its values may go to external connections as examples
for this measurement (decided 2026-10-28; this widens X-1 of
[testplan-external-models.md](testplan-external-models.md), which kept
*darf Inhalte erhalten* off), so Luna stays in the run. The privacy rule
of section 4 still holds for a customer's data.

### 6.3 More cases across layers, from the data

Cases are generated from templates; the reference is a query, its expected
result is what the query returns on the sample data, so no count is
written by hand.

- **Template = shape + layers.** The shapes: `near`, `within`, `outside`,
  `contains`, `intersects`, each with or without a filter on the subject
  or the related layer. For three layers: two relations on the subject, and
  a relation inside a relation's filter («Schulen in Gemeinden, die eine
  Bahnhaltestelle haben»). Every pair of layers where the shape makes sense
  (5 layers, 10 pairs).
- **Variants** of a template change the values (distance, code,
  municipality); the question is written in German by hand and read by a
  person for natural wording.
- **A case is accepted** only if its reference passes the application's
  checks, its result is neither empty nor the whole layer, and every
  condition is load-bearing (6.1).
- **Target:** about 15 three-layer confirm cases, every layer the subject
  of at least 4 confirm cases.
- **Own file**, beside `chain-cases.json`, so the sets of Lauf 1–11 stay
  as they were measured. `kb04`, `kb15`, `kb24`, `doc6`, `h14` get values
  that make their conditions bite, as new cases in that file; the old ones
  stay unchanged.
- **The load-bearing check becomes a test** over every case file, so new
  and edited cases keep it.

### 6.4 Duplicates and groups

Each reference is reduced to a signature: subject, layers, operations and
predicates, attributes. With values: the full signature.

- Same full signature in tuning and confirm (a paraphrase): a duplicate,
  not allowed across the splits.
- Every confirm case is put in a **group**, by its nearest pool case,
  stored with the case before the runs:
  1. same layers, same shape (another value): what a customer has once
     their own cases cover a question;
  2. same layers, other shape;
  3. same shape, other layers;
  4. nothing alike: the transfer, and where Risk 1 shows.
- About half the templates have variants in both splits (group 1), the
  rest are whole in one split (groups 2–4); each group has at least
  8 confirm cases.

### 6.5 Arms and runs

| Arm | Examples |
|---|---|
| A | today's fixed set |
| B | three pool cases drawn at random (seeded per case, the draw recorded) |
| C | three pool cases chosen by the selector (section 2) |

B separates the selector from the plain effect of examples from the same
world: if C is not better than B, the selector is not worth building.

- Pool: the tuning cases of all files with a reference. Leave one out on
  tuning runs; measured on the confirm cases.
- Direct and chain; gemma4:12b, qwen3:14b, gpt-6-luna; seed blocks from 1
  and 6; one commit, A run fresh in the same block.
- **Check** (`--approach check`, [plan-check-mode.md](plan-check-mode.md)):
  on gemma4:12b and qwen3:14b, the two models it may be switched on for
  (2026-10-30), same seeds. An arm's examples go to both calls, the direct
  query and the check's planning call, as the application would send them.
  The check is measured on its own because shared examples make the direct
  answer and the plan more alike: a mistake both copy from one example is
  `same` and passes the check unmarked.
- Each answer records the pool ids it was given.

### 6.6 Decision rule

Per model and approach, on the confirm cases, paired per case with a
bootstrap interval over cases (as F20):

1. **Pass:** C − A has a lower bound above 0.
2. **Silent wrongs:** C − A has an upper bound of at most +5 points (the
   F20 margin).
3. **Asking and declining** (cases with `expect`): C no more than 5 points
   below A, since examples of queries can make a model answer where it
   should ask.
4. **Group 4:** C no more than 5 points below A in pass.
5. **Selector:** C − B lower bound above 0; otherwise random examples from
   the pool would be built instead of the selector.
6. **Check:** with the check, 1–4 apply to the direct answer as it is
   then shown, with silent wrongs counting only the wrong answers left
   unmarked; marks on correct answers stay at the bar of plan-check-mode
   (at most 10 %).

A model for which 1–4 (and 6 where its check is on) do not hold gets no own examples in its profile (the
count, section 5, is 0). If they hold for at least one model, the library,
the flag, the privacy rule, the profile option and the query-to-plan
conversion become an extension of E3.

About a day and a half of work (templates, cases, checks, groups, the
harness option), then the runs.

## 7 Risks

- The selector misses an operation and the model sees worse examples than the
  fixed set today; the base example limits it, the tuning sets show it.
- Sample tuning and confirm questions share one small dataset and may be
  closer than a customer's; the duplicate check and group 4 (6.4) show it.
- The pool and the confirm cases share one dataset; the library will not
  share the customer's. Groups 3 and 4 come closest to that; a second real
  dataset with other layers (more AGI products) would measure it properly,
  later.
- Generated questions sound alike and easier than real ones; each is worded
  by hand and read by a person (6.3).
- Long examples cost tokens on every question; three examples are about the
  size of today's set. With the check they are sent twice.
- Examples shared by the direct query and the check weaken the check
  (6.5); rule 6 shows it.
