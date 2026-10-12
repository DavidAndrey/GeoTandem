# Model evals

Asks a real model the questions in [cases.json](cases.json) through the
direct query path as production sends it (`direct_prompt`, `DirectQuery.ask`:
real client, parser and checks), over a fresh sample dataset and the default
level, and grades each answer. Not part of `make gate`: it needs a running
OpenAI-compatible endpoint and takes minutes.

```sh
cd backend
uv run python evals/run.py --model qwen3:8b --label baseline
uv run python evals/run.py --model qwen3:8b --effort default --only log1-haltestellen-nahe-schulen
```

Each case runs `--repeat` times (seeds 1..N). Verdicts:

| Verdict | Meaning |
|---|---|
| `pass` | the query was accepted and returns the gold query's feature ids, or contains what `require` names, or the answer kind is the expected one |
| `wrong:<got>≠<want>` | accepted, but a different set of features (counts shown) |
| `wrong:missing <op>` / `wrong:source=…` | a `require` case without the required condition or layer |
| `refused:<code>` | the application refused the query (`not_representable`, `unknown_attribute`, …) |
| `kind:<kind>` | a clarification or cannot-answer where a query was due, or the reverse |
| `error:<code>` | no usable answer (`llm_timeout`, `model_unreadable`, …) |

Every answer is written to `results/<time>-<label>.jsonl` (git-ignored) for
reading the failures. Compare variants by label: change the prompt, rerun with
a new label, compare the summaries.

Cases are worded as users ask, not as the docs title them. The prompt's own
examples (`_EXAMPLES` in `model/prompt.py`) use invented layers, so a case is
never answered by the prompt itself; keep it that way when adding either.
