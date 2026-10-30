# Plan: the chain checks the direct query («Prüfung durch die Kette»)

> Status: decided 2026-10-29 (D2, D3, D5 confirmed by the user as recommended;
> D1, D4, D6 as recommended). Measured in [plan-chain-eval.md](plan-chain-eval.md)
> section 17 (`b8-*`, [benchmarks.md](benchmarks.md) Lauf 12): with the check,
> silent wrongs on A+B fall by 44–58 % for gemma4:e4b, gemma4:12b and
> qwen3:14b, with marks on 3–8 % of correct answers; qwen3.5:9b marks 18 %.

## 1 What it does

The direct query is answered and shown as today. Where the connection has
the check switched on, the application then asks the same prompt with the
chain, as the comparison does (WP76, M10.1), and compares the two results by
feature ids (M10.2). Same features: the answer is marked «geprüft». Other
features: it is marked «unsicher» with the numbers («Die schrittweise
Prüfung findet N statt M Objekte»), and the existing comparison dialog opens
on it, where the user can take the chain's side.

Nothing else changes: the direct answer's governance, its execute, undo and
log stay as they are; the check never applies anything.

## 2 What exists already

- `compare` (service): the same prompt with the other approach, as a new
  record `compare_of`, always `proposed`, counted against the request limit,
  the account's one prompt at a time.
- `comparison`: both stored queries run as the caller, feature ids compared,
  the names of the difference, a reason where the queries show one.
- The comparison dialog (`frontend/src/model/compare/`).

The gap: a chain record has a `query` only after its steps ran, and a repeat
waits `proposed`, so its steps never run on their own.

## 3 Decisions

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Where the switch lives | Per connection, beside the prompt profile: `check: "off" \| "chain"`, default `off`. The model action records it in the connection snapshot | The gain depends on the model (qwen3.5:9b fails the rule); a connection already carries the measured presets (E3, D9) |
| D2 | What result the chain side has | The compiled query of its checked plan (the last step's query object, F-5.7): no step runs. Re-plans happen only while steps run; in `b8` they touched 1.5–5 % of chain answers, corrections at planning are included | Running steps the user has not approved would bypass the step cells (`approve`); the plan's query is known at planning, at no data cost |
| D3 | When it runs, and the next prompt | After the direct answer is stored, in a thread of `ModelCalls` like any model call. A new prompt of the user aborts a check still thinking instead of waiting (409 today); the aborted check leaves the answer unmarked («nicht geprüft») | The user should never wait for a check they did not ask for |
| D4 | Which answers are checked | A direct answer with a query whose classes are not `off` (the comparison's own rule, `COMPARABLE`); not clarifications, refusals, follow-ups with a chain parent, or answers of a level without the chain | Same rules as a manual comparison |
| D5 | Request limit and figures | The check counts against the request limit (it is a model call, review #43). In the key figures (M16) a check is not a proposal; it is counted apart (checks, marked, chain taken) | A limit that ignores calls is no limit; checks must not inflate the proposal figures |
| D6 | Measuring it | The harness gets `--approach check` (direct, then the chain on the same seed, `hits` of both, the outcome D/F/H as `b8read`), so the check is measured like every preset before an administrator turns it on | Plan E3 rule: only measured presets |

## 4 Work packages

1. **Record and store:** a `check` flag on a repeat (`compare_of` with
   `check = true`), the connection field and snapshot, migration. The chain
   side's query for comparison from its plan (D2).
2. **Service:** start the check after a stored direct answer (D3, D4); abort
   on the next prompt; the mark (`checked`: `same` / `differs` /
   `not_checked`) on the direct answer's view, computed from the comparison
   of the two stored queries.
3. **API and contract:** the connection field (admin), the mark in
   `ModelActionView`, OpenAPI and error codes.
4. **Frontend:** the switch in the connection form; the mark on the answer
   («geprüft», «unsicher: … N statt M»), opening the comparison dialog.
5. **Figures:** checks counted apart (D5).
6. **Harness:** `--approach check` (D6); a run per local model confirms the
   service against `b8`.
7. **Docs:** CONTEXT.md (*Prüfung durch die Kette*), anforderungen
   annotation, etappen.

## 5 Out of scope

- Running the chain's steps for the check (D2).
- Checking a chain answer with direct (the other direction).
- The check for unasked conditions and the examples per question
  (plan-chain-eval 17, plan-improve-examples.md): separate work.

## 6 Built (2026-10-29)

- **Connection:** `check_mode` (`off` · `chain`, migration 0018), in the
  admin form as *Prüfung durch die Werkzeugkette*.
- **Record:** a check is a repeat with `is_check`; the direct answer keeps
  `check` (`CheckMark`: `running`, `same`, `differs`, `not_checked`, the
  check's id, both counts). Restart and stale closing end a running mark
  `not_checked`.
- **Service:** the check starts once the direct call gave its slot back,
  takes a slot of its own but not the account (D3), is admitted by the
  request limit alone (D5); a new prompt aborts the account's checks still
  thinking. Its plan's query is compared as the caller in a query slot; the
  comparison (`/comparison`) takes a check waiting with its plan.
- **Figures:** checks are left out of the proposals and counted apart
  (`KeyFigures.checks`).
- **Frontend:** the mark under the answer, polled while `running`;
  *Vergleich ansehen* brings the check into the dialogue and opens the
  existing comparison, from which the chain's plan is approved, run and
  adopted as any repeated chain.
- **Harness:** `--approach check` (D6).

**Differs from what `b8` measured:** H there ran the chain as fallback on
direct's visible failures too; as built, a failed direct answer is not
checked (the user's own *Mit Werkzeugkette wiederholen* stays the way). The
plan's query leaves out re-plans (D2). A run of `--approach check` per local
model confirms the numbers before an administrator turns it on.

Not done: the annotation in anforderungen.md and etappen.md.

## 7 Confirmed (2026-10-30, `b9-c-*`, benchmarks.md Lauf 13)

`--approach check` on the four local models, confirm sets, seeds 21–25,
against the fallback F of `b8`. Silent wrongs on A+B fall more than in `b8`
(e4b −42 %, 12b −72 %, qwen3:14b −70 %, qwen3.5:9b −91 %), but marks on
correct answers rise, since the plan's query is rougher than the chain that
ran: 11.9 %, 10.1 %, 10.1 %, 19.2 %. By the rule as agreed no model passes;
gemma4:12b and qwen3:14b miss it by one case each.

Open for the user:
- whether 12b and qwen3:14b count as at the bar (the rule was set before the
  build, and one case of ~200 is within noise), or stay off;
- or a check closer to `b8`, which would run the chain's steps and so needs
  a rule for steps the user has not approved (D2 again).

The marks sit in few cases (buffers around the Aare, «ohne», schools in
Münsingen). They are confirm cases, so nothing is tuned on them; a narrower
rule for marking would need its own tuning on the tuning split first.
