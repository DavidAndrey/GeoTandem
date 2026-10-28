# Model evals

Asks a real model the questions of the start set
([schema/eval-cases/](../../schema/eval-cases/), plan E3 D2) through the
direct query path as production sends it (`direct_prompt`, `DirectQuery.ask`:
real client, parser and checks), over a fresh sample dataset and the default
level, and grades each answer with the application's grader
(`geotandem.evaluation.grade`, the same rules an evaluation run uses). Not
part of `make gate`: it needs a running OpenAI-compatible endpoint and takes
minutes.

For administrators the application's evaluation runs succeed this harness
(*Administration › Modell › Bewertung*, README *Bewertung im Einsatz*, plan E3).
The harness stays the developer's tool and shares with the application the
grader (`evaluation/grade.py`), the paired statistics (`evaluation/stats.py`),
the sample build (`evaluation/sample.py`), the start set (read by
`evaluation/cases.py`) and the metadata ablation modes
(`evaluation/profiles.py`); its prompt variants P5, P9 and `--examples 12` are
the application's prompt profiles, built by the same builder.

```sh
cd backend
uv run python evals/run.py --model qwen3:8b --label baseline
uv run python evals/run.py --model qwen3:8b --effort default --only log1-haltestellen-nahe-schulen
```

Each case runs `--repeat` times (seeds 1..N). At temperature 0 the seeds
answer almost alike, so each case is one sample and a prompt change can flip
it whole; to compare prompt variants, run both with `--temperature 0.3
--repeat 5`:

```sh
uv run python evals/run.py --model gemma4:12b --temperature 0.3 --repeat 5 --label t3-mine
uv run python evals/run.py --model gemma4:12b --temperature 0.3 --repeat 5 --seed-start 6 --label t3-mine-s6
uv run python evals/compare.py --changed t3-mine t3-mine-s6
```

A second seed block (`--seed-start 6`) measures the noise of a model: about
±2 of 165 for gemma4:12b, ±6 for qwen3:8b (docs/testplan-system-context.md).
`compare.py` puts runs side by side by label; `--changed` keeps the cases
that differ.

## Prompt variants

The placement runs of [docs/testplan-system-context.md](../../docs/testplan-system-context.md)
(section 5). The presets the application offers as a connection's prompt
profile (plan E3, D9: `--variant p0|p5|p9`, `--examples 12`, `--no-format`)
are written by its builder (`direct_prompt` with a `PromptProfile`), so a run
here and a run in the application send the same prompt, hash for hash. The
measurement-only variants rebuild the messages the builder wrote under P0
before they are sent ([variants.py](variants.py)):

| Option | Effect |
|---|---|
| `--variant p0` | as the application sends it (default) |
| `--variant p1` | no worked examples, the rules stay |
| `--variant p2` | the worked examples as user/assistant turns (measurement only, E-8) |
| `--variant p3` | examples, rules and the first-question note in the user message (measurement only, E-8) |
| `--variant p4` | worked examples without the rules |
| `--variant p5` | examples before the layer profile (builder) |
| `--variant p8` | the JSON schema only as constrained output, not as text |
| `--variant p9` | the first-question note as a system message of its own (builder) |
| `--examples NAME` | an example set in place of the examples section (P6): `12` is the application's ([model/examples/12.txt](../src/geotandem/model/examples/12.txt), builder), any other [examples/NAME.txt](examples/) (`3`), applied before the variant |
| `--show` | print the messages of the first case as they would be sent, and stop |

An example set is a whole `# Beispiele` section: intro with the invented layer
profile, the rule lines (`- …`), then `Frage: …` and the answer JSON on the
next line, blocks separated by a blank line. Every answer is checked against
the answer schema and the query schema when the set loads.

Each answer records `prompt_tokens`, `completion_tokens` and `finish_reason`;
an `error:*` answer also its verbatim text (`raw`) when the model sent one, or
the transport's `cause`. The run's first line names `variant`, `examples` and
`prompt_sha256`, a hash over the messages and schema of a placeholder
question: two runs with the same hash sent the same prompt. The summary ends
with the median latency, mean tokens and the number of errors.

## Metadata ablation (testplan-system-context, Phase 4)

`--profile MODE` strips part of the sample data's metadata before the layer
profile is built ([evaluation/profiles.py](../src/geotandem/evaluation/profiles.py),
shared with the application's tests); the run header names the mode and the
profile's hash. `full` is the profile as loaded and sends the P0 prompt
unchanged.

| Mode | The model no longer sees |
|---|---|
| `no-desc` | layer and attribute descriptions |
| `no-labels` | attribute labels (the column name stands in) |
| `no-domains` | code lists and ranges, as an unconfirmed proposal leaves them (S2); the code reading of E-2 goes with them |
| `raw` | all three, the units, and layer titles (the layer name stands in): a plain import |
| `raw-codes` | as `raw`, but the domains confirmed as the import proposes them: each code is its own label, ranges stay |

## Fair comparisons (testplan-external-models, 9)

| Option | Effect |
|---|---|
| `--cases heldout` | the confirmation split (`start-confirm.json`) in place of the tuning split (`start-tuning.json`, `--cases cases`): questions no prompt change is tuned on |
| `--no-format` | no constrained output; the schema only as text in the prompt, as every endpoint can take it (H-8; the profile's output `text`) |
| `--api-key-env NAME` | the endpoint's key from the environment variable `NAME`; the run header names the variable, never the key |

`compare.py` joins seed blocks with `+`, sums per case tag with `--by-tag`,
and with `--stats` compares each column with the first case by case (wins,
losses, mean difference with a bootstrap interval, sign test): the answers of
one case are not independent, so the sample is the cases. The figures come
from `geotandem.evaluation.stats`, as the application's comparison takes them.

```sh
uv run python evals/compare.py --stats --by-tag ho-luna+ho-luna-s6 ho-gemma4_12b+ho-gemma4_12b-s6
```

`regrade.py <label> …` grades the stored answers of runs again against the
current cases, without asking a model; it changes nothing on unchanged cases.

A case may list `gold_any`, several fair readings that select different
features; any one passes. `tags` group the cases; `needs-values` marks one
that only a model knowing attribute values can pass. A held-out case is never
a reason to change the prompt: a change is judged on the tuning split and
confirmed on the confirmation split. Until E3 these were `evals/cases.json`
and `evals/heldout.json`; the testplans still call them so.

## The tool chain (docs/plan-chain-eval.md)

`--approach chain` asks the tool chain instead. The application's driver,
`geotandem.evaluation.chain.drive`, runs it as the application runs it at
*Automatisch*: one planning call, the steps counted in the model's world, a
re-plan after an error or an empty step before the last, to the end.
`tests/test_eval_chain.py` holds that driver to the application's run.
The chain's prompt is the application's default; it takes no prompt variant
yet.

```sh
uv run python evals/run.py --model gemma4:12b --approach chain --cases chain --label k-gemma4_12b
uv run python evals/run.py --model gemma4:12b --approach chain --cases heldout --label kh-gemma4_12b
```

| Option | Effect |
|---|---|
| `--cases chain` | the tuning split of the chain's cases (`schema/eval-cases/chain-cases.json`: `kb*` chain-native, `ks*` stress) |
| `--cases chain-heldout` | their confirmation split |

The start set's splits (`cases`, `heldout`) take the chain too, for the paired
comparison with the direct path. A case that wants the chain offered as the
other approach (h32, h33) says nothing of the chain and is left out of a chain
run, as a case wanting `direct` offered is left out of a direct run.

A chain is graded on the result the application would offer to adopt (the
grader takes the plan as a query answer). Its verdicts are those below, with
two meanings added:
- `refused:<code>` is also a plan the application refused, for example
  `refused:not_representable`.
- `refused:<reason>` is a chain that stopped before its end: `replan_limit`,
  `step_limit`, `time_limit` or `result_too_large`.

A chain record has these fields besides the direct ones:

| Field | Content |
|---|---|
| `end` | `done`, `answered`, `refused` or the stop reason |
| `error` | why a re-plan failed |
| `replans` | how many re-plans were asked |
| `count` | the result's hits |
| `calls` | per model call: re-plan number, latency, tokens, outcome |
| `steps` | per step that ran: position, tool, arguments, status, count, error code, duration, which plan it came with |

`prompt_tokens` and `completion_tokens` are the calls' sums. The header adds
`approach` and `replan_sha256`, a hash over the re-plan message. `flags`
(`no_assumption`, `zero_hits`) is written for every `wrong` answer of either
approach: `wrong` with `no_assumption` is *silently wrong*. `hits`, the
answer's feature ids, is written where grading read them (a query case
answered with a result, either approach), so two runs can be compared on
their features, not their counts (plan-chain-eval 17). `regrade.py`
refuses chain runs, since grading a chain again means running its steps
again.

## Verdicts


| Verdict | Meaning |
|---|---|
| `pass` | the query was accepted and returns the gold query's feature ids, or contains what `require` names, or the answer kind is the expected one (or one of `also`), with `other_approach` as the case names it |
| `wrong:<got>≠<want>` | accepted, but a different set of features (counts shown) |
| `wrong:missing <op>` / `wrong:source=…` | a `require` case without the required condition or layer |
| `refused:<code>` | the application refused the query (`not_representable`, `unknown_attribute`, …) |
| `kind:<kind>` | a clarification or cannot-answer where a query was due, or the reverse |
| `other_approach:<x>` | the offer of the other approach is not the one the case names: `none` demands no offer, `chain` or `direct` that one; a case without `other_approach` checks nothing |
| `forbidden:<word>` | the answer holds a word the case forbids (an invented layer of the prompt's examples) |
| `error:<code>` | no usable answer (`llm_timeout`, `model_unreadable`, …) |

Every answer is written to `results/<time>-<label>.jsonl` (git-ignored) for
reading the failures. Compare variants by label: change the prompt, rerun with
a new label, compare the summaries.

Cases are worded as users ask, not as the docs title them. The prompt's own
examples (`_EXAMPLES` in `model/prompt.py`) use invented layers, so a case is
never answered by the prompt itself; keep it that way when adding either.
