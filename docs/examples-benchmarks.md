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
| Groups | in this order: check on gemma4:12b, qwen3:14b; direct on both; chain on both; direct and chain on gpt-6-luna (paid API, only with `--external`) |

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
  key is never printed.
- At the end of a session, `next` writes the status below into this file.
  Commit it with the session's notes.

## Rules

- **One commit per group.** `next` refuses to run with uncommitted changes
  under `backend/` or `schema/`. Each chunk's commit goes to
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
```

It compares B and C with A, case by case, over both blocks and all three
files (pass, bootstrap interval). Then the rule of 6.6 for the group: C − A
in pass and silent wrongs, asking and declining, group 4, C − B, and for the
check the marks on correct answers. Write the outcome under *Results*.

## Status

<!-- bench:status -->
| Group | Chunks done | Left | Estimate left | Commits |
|---|---|---|---|---|
| `check-gemma4_12b` | 0/18 | 18 | 10.3 h | - |
| `check-qwen3_14b` | 0/18 | 18 | 17.2 h | - |
| `direct-gemma4_12b` | 0/18 | 18 | 5.2 h | - |
| `direct-qwen3_14b` | 0/18 | 18 | 8.6 h | - |
| `chain-gemma4_12b` | 0/18 | 18 | 8.4 h | - |
| `chain-qwen3_14b` | 0/18 | 18 | 15.2 h | - |
| `direct-gpt_6_luna (external)` | 0/18 | 18 | 3.4 h | - |
| `chain-gpt_6_luna (external)` | 0/18 | 18 | 5.9 h | - |

Left in all: 74.1 h (estimate, 2026-10-30 20:49).
<!-- /bench:status -->

## Results

None yet. Per group: the date, the commit, the table of `compare.py`, and
whether rule 6.6 holds.
