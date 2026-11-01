# Benchmarks: examples chosen per question

> Stand: 2026-10-30 · the runs of [plan-improve-examples.md](plan-improve-examples.md)
> 6.5, decided by its rule 6.6 · runner: [backend/evals/bench.py](../backend/evals/bench.py)

The matrix takes about 74 hours, too long for one sitting. It is cut into
chunks of 15 to 60 minutes, and each session runs as many as fit in the hours
it is given. A session can be stopped at any time; what it did not finish runs
again next time.

## What runs

| | |
|---|---|
| Cases | the confirm splits of the three files: `heldout` (37), `chain-heldout` (23), `layers-heldout` (43); the three copies of 6.4 left out |
| Arms | `a` fixed set, `b` random pool cases, `c` selector (6.5) |
| Seeds | two blocks, 1–5 and 6–10; temperature 0.3, as Lauf 6–13 |
| Groups | in this order: check on gemma4:12b, qwen3:14b; direct on both; chain on both; direct and chain on gpt-6-luna and on claude-haiku-5-5 (paid APIs, only with `--external`) |
| Haiku | temperature 1 and effort `default`, as in Lauf 3 and 10: Anthropic refuses a temperature below 1. Its three arms run alike, so rule 6.6 compares within Haiku as within the others; its rates are not comparable with the other models' at 0.3 |

A **chunk** is one `run.py` call: one group, one file, one arm, one seed block,
labelled `xb-<approach>-<model>-<file>-<arm>-s<block>`, for example
`xb-check-gemma4_12b-heldout-a-s1`. A group has 18 chunks. In a block, the
three arms of a file run one after the other, so A is always measured fresh
beside B and C.

## A session

From `backend/`:

```sh
uv run python evals/bench.py status                      # what is done, what is left
uv run python evals/bench.py next --hours 3 --dry-run    # what the next 3 hours would run
uv run python evals/bench.py next --hours 3              # run it
```

- `next` runs the chunks left, in order, as long as their estimate fits the
  hours, always at least one. `--only check-gemma4_12b` keeps to one group.
- Ctrl-C or a failed chunk: its file becomes `….jsonl.partial`, which
  `compare.py` does not read, and the chunk runs again from the start next
  time. Finished chunks are kept.
- Estimates start from a guess per group (`Group.seconds` in `bench.py`).
  After the group's first chunk they come from the measured time.
- gpt-6-luna: `--external` and the key in the environment
  (`export OPENAI_API_KEY="$(cat ~/.config/geotandem/openai.key)"`); the
  key is never printed. claude-haiku-5-5 likewise with
  `export ANTHROPIC_API_KEY="$(cat ~/.config/geotandem/anthropic.key)"`.
  Both run on remote APIs, so a session may run them beside a local group,
  each `next` with its own `--only`.
- At the end of a session, `next` writes the status below into this file.
  Commit it with the session's notes.

## Rules

- **One commit per group.** `next` refuses to run with uncommitted changes
  under `backend/` or `schema/`. Each chunk's commit (the last one that
  touched `backend/src`, `backend/evals` or `schema/`, so a commit of docs
  alone changes nothing) goes to
  `results/bench-log.jsonl`, and `status` marks a group whose chunks ran on
  different commits (`⚠ mixed`). If the prompt, the pool, the cases or the
  grading change during a group, its chunks run again.
- **No tuning between sessions.** A result seen on a confirm case is never a
  reason to change a prompt, an example or the selector before the runs are
  done (plan 3, D2).
- **Results stay where they are run.** `backend/evals/results/` is
  git-ignored, in the checkout that runs. Copy the `xb-*` files and
  `bench-log.jsonl` to the main checkout before a worktree is removed.

## After a group

```sh
uv run python evals/bench.py compare check-gemma4_12b    # prints the compare.py command
uv run python evals/decide.py check-gemma4_12b           # the figures of rule 6.6
```

It compares B and C with A, case by case, over both blocks and all three
files (pass, bootstrap interval). Then the rule of 6.6 for the group: C − A
in pass and silent wrongs, asking and declining, group 4, C − B, and for the
check the marks on correct answers. Write the outcome under *Results*.

## Status

<!-- bench:status -->
| Group | Chunks done | Left | Estimate left | Commits |
|---|---|---|---|---|
| `check-gemma4_12b` | 18/18 | 0 | 0.0 h | fb5cca0 |
| `check-qwen3_14b` | 18/18 | 0 | 0.0 h | 6a9a1d2 |
| `direct-gemma4_12b` | 18/18 | 0 | 0.0 h | 6a9a1d2 |
| `direct-qwen3_14b` | 18/18 | 0 | 0.0 h | 6a9a1d2 |
| `chain-gemma4_12b` | 18/18 | 0 | 0.0 h | 6a9a1d2 |
| `chain-qwen3_14b` | 10/18 | 8 | 3.0 h | 6a9a1d2 |
| `direct-gpt_6_luna (external)` | 18/18 | 0 | 0.0 h | fb5cca0 |
| `chain-gpt_6_luna (external)` | 18/18 | 0 | 0.0 h | fb5cca0 |
| `direct-claude_haiku_5_5 (external)` | 18/18 | 0 | 0.0 h | 6a9a1d2 |
| `chain-claude_haiku_5_5 (external)` | 18/18 | 0 | 0.0 h | 6a9a1d2 |

Left in all: 3.0 h (estimate, 2026-11-01 22:41).
<!-- /bench:status -->

## Results

Per group: the date, the commit, the figures of rule 6.6, and whether it
holds.

### direct-gpt_6_luna: does not hold (point 3)

2026-10-31, commit fb5cca0, 18/18 chunks, 103 cases × 10 seeds per arm.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 80.0 → 90.9 % | +10.9 (+5.9 … +16.3) | 103 | holds |
| 2 silent wrongs | C − A | 8.6 → 1.7 % | −7.0 (−10.9 … −3.6) | 103 | holds |
| 3 asking/declining | C − A | 60.0 → 54.5 % | −5.5 (−16.4 … +0.0) | 11 | **fails** |
| 4 group 4 pass | C − A | 86.7 → 100.0 % | +13.3 (+3.3 … +25.8) | 12 | holds |
| 5 selector | C − B | 85.0 → 90.9 % | +5.9 (+2.5 … +9.6) | 103 | holds |
| (B) | B − A | 80.0 → 85.0 % | +5.0 (+1.7 … +8.5) | 103 | |

Point 3 fails on one case: `h33-puffer` declines in 7 of 10 answers under A
and in 1 of 10 under C (8 × `kind:query`). The other ten behaviour cases are
equal under A and C. The selector's examples make luna write a query where
it should decline.

### chain-gpt_6_luna: does not hold (point 3)

2026-10-31, commit fb5cca0, 18/18 chunks, 101 cases × 10 seeds per arm.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 76.7 → 87.4 % | +10.7 (+5.5 … +16.1) | 101 | holds |
| 2 silent wrongs | C − A | 3.2 → 2.2 % | −1.0 (−3.6 … +1.6) | 101 | holds |
| 3 asking/declining | C − A | 82.2 → 75.6 % | −6.7 (−15.6 … +0.0) | 9 | **fails** |
| 4 group 4 pass | C − A | 71.7 → 96.7 % | +25.0 (+8.3 … +45.0) | 12 | holds |
| 5 selector | C − B | 83.1 → 87.4 % | +4.4 (+1.0 … +7.9) | 101 | holds |
| (B) | B − A | 76.7 → 83.1 % | +6.3 (+3.0 … +10.0) | 101 | |

Point 3 fails on two cases: `ks03-ganz-im-puffer` declines in 4 of 10
answers under A and in none under C (10 × `kind:plan`), and `ks09-spital`
passes 10 of 10 under A and 8 of 10 under C (2 × `other_approach:direct`).
The other seven behaviour cases are equal under A and C. As for direct: the
examples raise pass and group 4 well, but make luna plan where it should
decline.

### check-gemma4_12b: does not hold (point 3)

2026-10-31, commit fb5cca0, 18/18 chunks, 103 cases × 10 seeds per arm.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 69.4 → 87.3 % | +17.9 (+10.3 … +25.9) | 103 | holds |
| 2 silent wrongs, unmarked | C − A | 4.9 → 1.7 % | −3.2 (−5.7 … −1.2) | 103 | holds |
| 3 asking/declining | C − A | 53.6 → 44.5 % | −9.1 (−23.6 … +0.0) | 11 | **fails** |
| 4 group 4 pass | C − A | 41.7 → 99.2 % | +57.5 (+31.7 … +82.5) | 12 | holds |
| 5 selector | C − B | 76.5 → 87.3 % | +10.8 (+5.2 … +16.6) | 103 | holds |
| (B) | B − A | 69.4 → 76.5 % | +7.1 (+2.3 … +12.1) | 103 | |

| Arm | Answers | Correct | Marked of correct (≤ 10 %) | Wrong left unmarked |
|---|---|---|---|---|
| A | 1030 | 656 | 52 = 7.9 % | 60 of 154 |
| B | 1030 | 719 | 58 = 8.1 % | 48 of 119 |
| C | 1030 | 850 | 34 = 4.0 % | 30 of 41 |

Point 3 fails mainly on `h31-naehe-wovon`: it asks back in 10 of 10 answers
under A and in 2 of 10 under C (8 × `kind:query`); `h33-puffer` (1 → 0) and
`h38-je-gemeinde` (8 → 7) add the rest. The other eight behaviour cases are
equal. The marks on correct answers stay under the bar in every arm (6
holds). Group 4, the cases least like the pool, gains the most: 41.7 → 99.2 %.

### direct-claude_haiku_5_5: does not hold (points 1 and 5)

2026-10-31, commit 6a9a1d2, 18/18 chunks, 103 cases × 10 seeds per arm,
temperature 1.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 92.6 → 94.3 % | +1.7 (−0.1 … +3.6) | 103 | **fails** |
| 2 silent wrongs | C − A | 0.0 → 0.0 % | +0.0 (+0.0 … +0.0) | 103 | holds |
| 3 asking/declining | C − A | 74.5 → 80.9 % | +6.4 (+0.0 … +17.3) | 11 | holds |
| 4 group 4 pass | C − A | 98.3 → 100.0 % | +1.7 (+0.0 … +4.2) | 12 | holds |
| 5 selector | C − B | 94.4 → 94.3 % | −0.1 (−1.1 … +0.9) | 103 | **fails** |
| (B) | B − A | 92.6 → 94.4 % | +1.7 (+0.1 … +3.8) | 103 | |

Haiku is near the ceiling under A already, so there is little to gain: C
is 1.7 points better, but the interval just touches 0, and the selector is no
better than random pool cases. Nothing gets worse: no silent wrongs in any
arm, and point 3 rises, mostly on `h34-loeschen` (3 → 9 of 10). `ks01` and
`ks03` pass in no arm: under C, `ks03` declines but offers the chain in all
10 answers (the case expects no offer), and `ks01` does that in 5 and writes a
query in the other 5.

### chain-claude_haiku_5_5: does not hold (point 5)

2026-10-31, commit 6a9a1d2, 18/18 chunks, 101 cases × 10 seeds per arm,
temperature 1.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 93.4 → 95.0 % | +1.7 (+0.3 … +3.2) | 101 | holds |
| 2 silent wrongs | C − A | 0.0 → 0.0 % | +0.0 (+0.0 … +0.0) | 101 | holds |
| 3 asking/declining | C − A | 77.8 → 78.9 % | +1.1 (+0.0 … +3.3) | 9 | holds |
| 4 group 4 pass | C − A | 92.5 → 99.2 % | +6.7 (+0.8 … +15.0) | 12 | holds |
| 5 selector | C − B | 94.8 → 95.0 % | +0.3 (−0.8 … +1.3) | 101 | **fails** |
| (B) | B − A | 93.4 → 94.8 % | +1.4 (+0.0 … +2.9) | 101 | |

C beats A, with a small but clear gain, and group 4 gains the most.
Nothing gets worse: no silent wrongs in any arm, and point 3 is equal or
better on every behaviour case. Only the selector adds nothing over random
pool cases. `ks01` and `ks03` again pass in no arm: under C, `ks01` plans
in all 10 answers, and `ks03` declines but offers the direct approach in 8
(the case expects no offer).

### check-qwen3_14b: holds

2026-10-31, commit 6a9a1d2, 18/18 chunks, 103 cases × 10 seeds per arm.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 61.5 → 84.8 % | +23.3 (+14.3 … +32.4) | 103 | holds |
| 2 silent wrongs, unmarked | C − A | 6.8 → 5.3 % | −1.5 (−6.2 … +3.2) | 103 | holds |
| 3 asking/declining | C − A | 45.5 → 59.1 % | +13.6 (−18.2 … +45.5) | 11 | holds |
| 4 group 4 pass | C − A | 56.7 → 75.0 % | +18.3 (+0.0 … +41.7) | 12 | holds |
| 5 selector | C − B | 67.5 → 84.8 % | +17.3 (+11.1 … +23.7) | 103 | holds |
| (B) | B − A | 61.5 → 67.5 % | +6.0 (−0.1 … +12.2) | 103 | |

| Arm | Answers | Correct | Marked of correct (≤ 10 %) | Wrong left unmarked |
|---|---|---|---|---|
| A | 1030 | 583 | 88 = 15.1 % | 137 of 312 |
| B | 1030 | 650 | 101 = 15.5 % | 133 of 232 |
| C | 1030 | 808 | 49 = 6.1 % | 68 of 101 |

The first group where rule 6.6 holds on every point. C gains the most of
all groups so far (+23.3), and the selector clearly beats random pool cases
(+17.3). The check marks fewer correct answers under C (6.1 %), the only arm
under the bar of 10 %. qwen answers each behaviour case almost alike on all
ten seeds, so point 3 moves in steps of whole cases: C gains `h33-puffer`
(0 → 10), `ks09-spital` (0 → 10) and `h37-steueranlage` (0 → 5), and loses
`h38-je-gemeinde` (10 → 0, all 10 answers offer the chain where the case
expects no offer). Hence the wide interval of point 3.

### direct-gemma4_12b: does not hold (point 3)

2026-11-01, commit 6a9a1d2, 18/18 chunks, 103 cases × 10 seeds per arm.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 69.7 → 87.1 % | +17.4 (+9.1 … +25.8) | 103 | holds |
| 2 silent wrongs | C − A | 12.6 → 1.6 % | −11.1 (−17.1 … −5.7) | 103 | holds |
| 3 asking/declining | C − A | 52.7 → 42.7 % | −10.0 (−28.2 … +0.0) | 11 | **fails** |
| 4 group 4 pass | C − A | 41.7 → 100.0 % | +58.3 (+33.3 … +83.3) | 12 | holds |
| 5 selector | C − B | 75.8 → 87.1 % | +11.3 (+5.3 … +17.4) | 103 | holds |
| (B) | B − A | 69.7 → 75.8 % | +6.1 (+1.2 … +11.3) | 103 | |

As for `check-gemma4_12b`: large gains on pass, silent wrongs and group 4,
and point 3 fails on one case. `h31-naehe-wovon` asks back in 10 of 10
answers under A and B and in none under C (10 × `kind:query`). `h37-steueranlage`
passes 6 of 10 under B but none under A or C. `h38-je-gemeinde` (7 → 6) adds
the rest; the other eight behaviour cases are equal.

### chain-gemma4_12b: does not hold (point 4)

2026-11-01, commit 6a9a1d2, 18/18 chunks, 101 cases × 10 seeds per arm.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 67.1 → 79.6 % | +12.5 (+6.0 … +18.8) | 101 | holds |
| 2 silent wrongs | C − A | 4.3 → 3.1 % | −1.2 (−4.4 … +2.3) | 101 | holds |
| 3 asking/declining | C − A | 57.8 → 71.1 % | +13.3 (−2.2 … +36.7) | 9 | holds |
| 4 group 4 pass | C − A | 59.2 → 53.3 % | −5.8 (−35.8 … +21.7) | 12 | **fails** |
| 5 selector | C − B | 73.4 → 79.6 % | +6.2 (+1.5 … +10.7) | 101 | holds |
| (B) | B − A | 67.1 → 73.4 % | +6.2 (+1.5 … +11.3) | 101 | |

The only group so far where group 4 falls, and by just over the bar. Two
cases make it: `ml17-schule-klein-fluss` (9 → 0 of 10) and
`ml18-schule-gross-fluss` (10 → 0), where under C the plans are refused,
mostly as `not_representable`; `ml71` (7 → 2) adds to it. Others gain:
`kb25` (3 → 10), `ml05` (0 → 4), `ml06` (2 → 6). The losses are refusals,
not wrong counts, so silent wrongs stay flat. Point 3 rises, mainly on
`ks09-spital` (0 → 10).

### direct-qwen3_14b: holds

2026-11-01, commit 6a9a1d2, 18/18 chunks, 103 cases × 10 seeds per arm.

| Figure | Arms | Rate | Δ points (95 %) | Cases | Rule |
|---|---|---|---|---|---|
| 1 pass | C − A | 60.2 → 84.7 % | +24.5 (+15.8 … +33.3) | 103 | holds |
| 2 silent wrongs | C − A | 18.3 → 7.7 % | −10.7 (−18.3 … −3.7) | 103 | holds |
| 3 asking/declining | C − A | 44.5 → 56.4 % | +11.8 (−16.4 … +40.0) | 11 | holds |
| 4 group 4 pass | C − A | 49.2 → 74.2 % | +25.0 (+1.7 … +49.2) | 12 | holds |
| 5 selector | C − B | 68.4 → 84.7 % | +16.2 (+10.2 … +22.3) | 103 | holds |
| (B) | B − A | 60.2 → 68.4 % | +8.3 (+1.8 … +14.8) | 103 | |

As for `check-qwen3_14b`: every point holds, with the largest pass gain of
all groups (+24.5). Point 3 holds on its mean only; whole cases move. C
gains `h33-puffer` (0 → 9), `ks09-spital` (0 → 9) and `h37-steueranlage`
(0 → 4), and loses `h38-je-gemeinde` (9 → 0, all 10 answers offer the
chain where the case expects no offer).
