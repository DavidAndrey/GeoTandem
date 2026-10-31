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
| `check-qwen3_14b` | 0/18 | 18 | 17.2 h | - |
| `direct-gemma4_12b` | 0/18 | 18 | 5.2 h | - |
| `direct-qwen3_14b` | 0/18 | 18 | 8.6 h | - |
| `chain-gemma4_12b` | 0/18 | 18 | 8.4 h | - |
| `chain-qwen3_14b` | 0/18 | 18 | 15.2 h | - |
| `direct-gpt_6_luna (external)` | 18/18 | 0 | 0.0 h | fb5cca0 |
| `chain-gpt_6_luna (external)` | 18/18 | 0 | 0.0 h | fb5cca0 |

Left in all: 54.5 h (estimate, 2026-10-31 11:37).
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
