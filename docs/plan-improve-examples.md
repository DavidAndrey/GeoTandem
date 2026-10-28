# Plan: examples chosen per question, for the direct query and the chain

> Stand: 2026-10-28 · proposal, not started · Bezug:
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

The sample data already has the split this needs. A harness option, no
application change:

1. Check for near-duplicates between tuning and confirm questions; a pair
   would overstate the gain.
2. Pool: the tuning cases (`start-tuning`, the tuning half of the chain
   cases), leave one out. Measured on the confirm cases (`start-confirm`,
   `chain-heldout`).
3. Direct and chain, three examples chosen against the fixed set, on
   gemma4:12b, qwen3:14b and gpt-6-luna, two seed blocks, paired per case.

About half a day of work, then the runs. If the gain is clear, the library,
the flag, the privacy rule, the profile option and the query-to-plan
conversion become an extension of E3.

## 7 Risks

- The selector misses an operation and the model sees worse examples than the
  fixed set today; the base example limits it, the tuning sets show it.
- Sample tuning and confirm questions share one small dataset and may be
  closer than a customer's; step 6.1 checks it.
- Long examples cost tokens on every question; three examples are about the
  size of today's set.
