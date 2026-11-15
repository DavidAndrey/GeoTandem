# Plan: what the query object can say, and what the model may say with it («Fähigkeiten der Abfrage»)

> Status: draft 2026-11-15, nothing built, no decision confirmed. Written from
> a review of the query object (`packages/query`, `engine/compile.py`, the
> model path, `frontend/src/analysis/query.ts`) and a count of the eval cases
> in `schema/eval-cases/`. Pass rates here are **estimates**: the harness
> results are on the other host. Every phase after P1 waits for P1's figures
> (rule of plan E3: only measured presets ship). It takes the place of the
> v3 seed in [plan-answer-quality.md](plan-answer-quality.md) section 8 (D5).

## 1 The question

GeoTandem shows how far a local model can be trusted with GIS questions. More
capability answers more questions, and gives the model more ways to be wrong.
Where is the sweet spot between what the query object can express and answers
the user can rely on? And what would GROUP BY change?

**The answer in one line:** let verifiability decide, not capability. A
capability goes to the model only where a wrong answer would be visible to the
user. The application cannot make a small model reliably correct, but it can
make sure the model is rarely wrong without anyone noticing.

## 2 The format: keep it

A declarative JSON object with a closed vocabulary, generated from Pydantic,
compiled by one engine, is the right core. One object has to be edited by the
controls, written by small local models, classified for the levels, hashed for
reproducibility (F-8.9) and run alike on SpatiaLite and PostGIS (F-2.14).

| Alternative | Why not as the core |
|---|---|
| Text-to-SQL | No safety, no backend neutrality, nothing the editor can read back, no canonical hash, no operation classes |
| Step pipeline (MongoDB `$match`/`$group`, PRQL, the chain's steps) | Composes better, but many pipelines mean the same, so the canonical form and representability get much harder; the chain eval shows small models plan poorly |
| OGC CQL2-JSON | A standard for the filter part only (no join, buffer or aggregation); its `{"op","args":[{"property":…}]}` shape is more verbose and harder for small models. Worth an import/export mapping for `where`, not the core |
| Logical-plan formats (Substrait and the like) | Far too general for this audience and these models |

To keep: `extra="forbid"`; variants told apart by a constant instead of rules
coupling fields; "normalise, never reject" (`between`, `bbox`); versions that
only add; the complexity bounds; `fid` as the last tie-breaker; one compiler for
every way a query is run or checked.

One level of grouping plus a filter on its result is SQL's own sweet spot
(`SELECT … WHERE … GROUP BY … HAVING … ORDER BY … LIMIT`). GROUP BY confirms
the single object; a pipeline only pays off at aggregates of aggregates, which
this audience rarely asks for and which stays with the chain or Modus A.

## 3 Findings of the review

| # | Finding | Where | Matters for |
|---|---|---|---|
| W1 | **Fixed stage order, one slot per stage.** One join, one buffer, one aggregate, nothing after `aggregate`: no filter on an aggregate result (HAVING), an aggregate is never the input of anything, a relation to a derived layer only via the buffer→`dwithin` rewrite | `models.py` docstring, `tools/chain.py` (`NotComposable`) | Coverage |
| W2 | **Several ways to say one spatial thing.** Without a `buffer`, top-level `spatial_relation` and `related` in `where` compile to the same SQL (`Compiler.spatial_relation`) but hash differently; `near_feature` is `related` + `dwithin` + `where: fid eq` (except distance 0: `ge 0` against `gt 0`). Today this does **not** hurt the model: its answer format holds only `source`, `where`, `output`. It will once buffer or aggregate are opened | `models.py`, `compile.py` | Hash, model once widened |
| W3 | **Aggregation is spatial only and narrow.** Groups are features of an area layer. Missing: grouping by an attribute or a key (a table layer cannot be summarised), `count_distinct`, geometric metrics (length or area of the part inside), an assignment rule for lines and areas across boundaries (`within` drops them, `intersects` counts them twice) | `Aggregate`, `Compiler.aggregate` | Coverage, silent wrongs |
| W4 | **The attribute join loses rows silently.** First match by `fid` guards against duplicated rows, but drops 1:n data without a word; 1:n needs aggregation | `compile.py` `attribute_join` | Correctness |
| W5 | **Values are constants only.** No attribute against attribute, no arithmetic; unit conversion (ha → km²) is the model's job, and the `unit` cases show it fails there | `Compare`, `Between` | Silent wrongs |
| W6 | **The canonical form is shallow.** No flattening of nested `and`/`or`, `and` of one and `not` of `not` left as they are (`shapes.plain` does it, on the model path only), strings not NFC-normalised (a decomposed «Köniz» fails `eq` silently), `in` values not de-duplicated | `canonical.py` | Reproducibility |
| W7 | **Query and presentation are mixed.** `symbology` and `output` are hashed: a colour change gives another `query_hash`, so `state_matches` (`sessions.py`) is false, and the stamp no longer names the data result alone. E5's chart output would add to it | `QueryObject`, `canonical.py` | Reliability |
| W8 | Small: `IsNull` does not call `use(Op.ATTRIBUTE_FILTER)` (missing from the reported operations, bypasses `unsupported`); `between` takes numbers only, so a date range is `ge`+`le` with a special case (`dates()`) in both inverses; `text_match mode: equals` overlaps `compare eq` and no control writes it; `distance_to` scans the whole other layer per result row (KNN through the dialect for PostGIS); each joined field is its own correlated subquery | `compile.py:204`, `models.py`, `represent.py`, `query.ts` | Hygiene, performance on PostGIS |
| W9 | **Every addition is paid four times.** Forward and inverse each exist in Python (`represent.py`, `canonical.py`) and TypeScript (`query.ts`), held together by `schema/model-cases/represent.json`. Not a reason to change the design; a factor in every estimate | — | Cost, drift |

## 4 What the eval set says about coverage

The case files hold 174 questions that expect a query, 10 that expect a
clarification and 44 that expect `cannot_answer`. The 44, by cause:

| Cause | Cases | v2 can say it? | Needs |
|---|---:|---|---|
| Layer or attribute missing, out of scope, safety | 24 | — | Nothing: these stay refused |
| Table layer (`n03`, `h37`, `v23`–`v26`, `ks10`) | 7 | Yes, `attribute_join` (`v23`, `v26` to check) | The join on the model path and in the editor |
| Not representable: several conditions on a related layer, relation to a relation, buffer as result (`ks01`, `ks02`, `ks04`, `h32`, `h33`, `n07`) | 6 | Yes | Editor and model path only |
| Areas fully in a buffer of another layer (`ks03`) | 1 | No | A buffer on the related layer |
| Per area (`v27`, `h38`, `n15`: «je Gemeinde», «die meisten») | 3 | **Yes**: `aggregate` + `order_by` + `limit` | Aggregation as a result, in editor and model path |
| Per attribute (`v28`) | 1 | No | `by_attrs` |
| Length per area (`v29`) | 1 | No | A geometric metric |
| Population of catchments per transport mode (`v30`) | 1 | No | Area-weighted interpolation: out of scope |

- **20 of the 44 are limits of the application, and 16 of these v2 already
  expresses.** `ALLOWED_FIELDS` (`represent.py`) and the editor block them,
  not the schema.
- **GROUP BY adds 2 of the 20** (`by_attrs`, a length metric).
- **The set is blind to GROUP BY's main use.** No case asks for a filter on
  groups («Gemeinden mit mehr als 5 Schulen»), a total or «je Typ»: the set
  was written around what exists. Guess, to be checked against the
  `cannot_answer` decisions in the model-action log: 15–30 % of real questions
  count, rank or group.

On the authored set the answerable share goes from 174 of 218 (80 %) to at
most 192 (88 %): 16 from widening the model path, 2 from GROUP BY.

## 5 The criterion and the rule

**Measure silent wrongs, not the pass rate.** A refusal, a clarification or a
wrong answer that names its assumption costs a moment. A plausible wrong
number costs trust in the whole tool. A clear «das kann ich nicht beantworten,
so geht es im Klassik-Modus» is a good answer.

**A capability belongs in Modus B when all four hold:**

1. the controls can show it (D3 of plan E2);
2. the user can check the result at a glance (highlight, count, explaining
   columns);
3. a second derivation can cross-check it (`check_mode`);
4. its measured silent-wrong rate is not above that of plain filters today.

**Modus A keeps the whole schema.** The sweet spot limits what the model may
write, never what the application can do.

**The rule: the model writes names and numbers from the question; the
application decides the meaning.** Each decision moved from the model to the
application adds capability without a new failure mode; each new decision the
model must make costs reliability.

| The model would decide … | The application decides it from |
|---|---|
| Join key and table («Einwohner» is in `gemeindedaten`) | The attribute references (`references`, plan-attribute-metadata B): the model writes `einwohner > 10000` on `gemeinden`, the engine adds the join |
| `within` or `intersects` when aggregating lines and areas | The geometry types: points by containment, lines by length share, areas by largest overlap |
| Unit arithmetic (ha → km²) | A unit on the value and the attribute's stored unit |
| `spatial_relation` or `related` | One form (P4) |

## 6 Capabilities: inside, at the edge, outside

| Capability | Verdict | Why |
|---|---|---|
| Filters, spatial relations, negation (today) | **Inside** | Condition rows, highlight, chain check |
| Table attributes through declared references | **Inside, next** | Still features on the map; the joined value shows in the attribute table |
| Count or sum per area, «which has the most» | **Inside, on conditions** | The application picks the assignment rule; the whole ranking is shown, not only the first; the chain check compares by group key |
| Per attribute («je Typ») | **Inside** | Its own check: the groups add up to the total («7 von 39») |
| Filter on groups (HAVING) | **Inside, once aggregation is** | A condition row on the aggregate layer |
| Length or area per area («km Kantonsstrasse») | **Edge** | Fine in the engine, once the assignment rule is fixed |
| Arithmetic, attribute against attribute, densities | **Outside for now** | The model invents the formula; a user does not see an invented formula is wrong |
| Aggregates of aggregates, area-weighted interpolation (`v30`), free pipelines | **Outside** | No user can check the answer; refuse clearly and point to Modus A |

## 7 GROUP BY in the schema (v3)

`aggregate` is generalised, not joined by a second field. Additive: every v2
document stays valid with the same meaning.

```json
"aggregate": {
  "by_layer": "gemeinden", "predicate": "within", "area_fields": ["name"],
  "by_attrs": ["sprache"],
  "metrics": [{"fn": "count", "as": "anzahl"}],
  "having": {"op": "compare", "attr": "anzahl", "cmp": "gt", "value": 5}
}
```

- `by_layer` becomes optional, `by_attrs` is new. **Neither means one row,
  the total**, as in SQL: no rule couples the two fields (section 2).
- `by_attrs` names source attributes, joined ones included.
- `having` is the existing condition grammar over the result's names (keys
  and metrics); relations and geometry conditions are refused there.
- Metrics: `count_distinct` (with `attr`); `length` and `area` without `attr`,
  of the part inside the area, in m and m², only with `by_layer`.
- `predicate` gains the assignment rules of section 5 (D3).
- Evaluation order: … → `aggregate` → `having` → `columns` → `select` /
  `order_by` / `limit`.
- `complexity.py`: `by_attrs` among `MAX_ITEMS`, `having` among the walked
  conditions. `levels.classify`: all of it `derive`.

**Result identity.** A group by attribute has no `fid` and, without
`by_layer`, no geometry. Everything that reads feature ids needs a **group
key** instead, `fid` as its special case: `_feature`, the `fid` tie-breaker,
`_output_columns`, `ResultStamp` (hash of sorted ids), `ids_query`, the
highlight, «7 von 39», the chain check, and the grader (`evaluation/grade.py`).
This, not the schema, is the large part of the work (P3).

Also in v3 (from section 3):

- Top-level `spatial_relation` read as `related` in `where` when there is no
  buffer (exact); with a buffer, `intersects` as `dwithin` (exact); only
  `within`/`contains` of a buffer needs a field of its own (W2).
- `between` takes two ISO dates (W8); `dates()` goes from both inverses.
- An optional `unit` on `compare` and `between` values, converted by the
  engine from the attribute's unit (W5).
- `near_feature` stays for the controls, with one canonical form (W2).

## 8 Expected effect

Coverage is counted (section 4); the rest is estimated, to be replaced by P1
and later runs.

| Change | Coverage | Quality | Reliability |
|---|---|---|---|
| P0 small fixes | — | ≈ 0 | Stabler hashes, fewer false «weicht ab»; existing hashes change once |
| P2 table attributes by reference | +7 cases (`v23`, `v26` to check) | Small risk: the model names an attribute, never a key | Unchanged: still features |
| P3 aggregation as result | +3 cases now, the class grows in real use | **Pass rate on the reopened cases first falls**: declining was easy, aggregating is not. Estimate 50–70 % correct on per-group questions for the 12–14b models, against 66–78 % overall direct today. The risk is silent wrongs (a count per area looks plausible either way) | Needs group-key identity, or stamp, check and grading break |
| P4 v3 | +2 cases, plus filters on groups, totals, per type (no cases yet) | Units: most conversion errors of the 4 `unit` cases gone; date `between`: small | Fewer equal-meaning forms |
| P5 gates per connection | Depends on the model | Each model offered only what it does reliably | The matrix is the demonstrator's finding |

Where a level sets `derive` to `off`, a per-group answer stays a proposal:
the gain also depends on the level configuration.

## 9 Phases

| Phase | Content | Done when |
|---|---|---|
| **P0** | `IsNull` → `use(ATTRIBUTE_FILTER)`; NFC for string values in the models; `shapes.plain` moved into the validators (every path normalised, as `Between`). Before: how a changed `query_hash` shows in saved sessions and stamps | Tests on both backends; no saved session reads «weicht ab» from the change alone |
| **P1** | Rewrite the `per-group` and `table` cases from `cannot_answer` to reference queries (where v2 can say them) or keep them refused (`v30`); add cases for filter on groups, total, per type, length per area, each in tuning and confirm. Baseline run per model | Baseline per capability class (pass, silent wrong) in benchmarks.md |
| **P2** | Table attributes by reference: the model writes the attribute on the vector layer, the engine adds the join from `references`; the model profile lists such attributes on the vector layer; the controls show and write them like the layer's own | `n03`, `h37`, `v24`, `v25`, `ks10` pass for gemma4:12b and qwen3:14b at the P5 gate |
| **P3** | Aggregation as a result: group-key identity through engine, stamp, highlight, count, chain check and grader; the analysis state takes an aggregate as the result layer; `represent.py` and `query.ts` invert it; `aggregate` in `ALLOWED_FIELDS` and the answer format; the assignment rule set by the application; the whole ranking shown | `v27`, `h38`, `n15` at the P5 gate; `represent.json` covers every new form |
| **P4** | Schema v3 (section 7), engine on both backends, upgrade of v2 documents, prompt rules and examples | v2 golden queries and saved queries unchanged in meaning; `v28`, `v29` and the new cases at the gate |
| **P5** | A capability gate per connection, set from measurement (D5); the matrix capability × model in the evaluation view | An administrator sees per connection which classes are offered and why |

P2 does not need P3 or P4 and brings the most per effort. P3 is the large
one, mainly through W9.

## 10 Decisions

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | The bar for offering a capability to a model | Silent wrongs on its confirm cases not above plain filters' for that model; pass within 10 points of plain filters | Section 5; the bars of plan-chain-eval and plan-check-mode |
| D2 | Who writes the join | The engine, from `references`; `attribute_join` stays in the schema for Modus A | Section 5 rule; the model names no key |
| D3 | Assignment of lines and areas to areas | By the application from the geometry types: points by containment, lines by length share, areas by largest overlap; shown in the answer («Strassen, nach Länge aufgeteilt») | `within` drops, `intersects` double-counts (W3); visible rule |
| D4 | Groups without members | With `by_layer` alone: every area, count 0 (as today). With `by_attrs`: only combinations that occur | A cross product of areas and values is large and rarely meant |
| D5 | Where the gate lives | Per connection, beside the prompt profile, as measured presets; default: today's capabilities | The gain depends on the model (plan-check-mode D1) |
| D6 | Hash without presentation | The stamp's `query_hash` over the query without `symbology` and `output`; the session's state check keeps the whole object | Same data result, same hash (W7) |
| D7 | Geometry of attribute groups | None: table only. No union of members («dissolve») | Costly, hard to keep equal on both backends |
| D8 | Words | CONTEXT.md gains **Gruppe**, **Gruppenschlüssel**, **Zuordnungsregel** | Binding vocabulary (etappen 2) |

## 11 Out of scope

- Expressions and arithmetic in the query object, attribute against attribute.
- Aggregates of aggregates, pipelines of stages, area-weighted interpolation.
- A union of group members («dissolve»).
- CQL2 import or export (worth a note when E4's MCP path needs a standard
  filter).
- Performance work on PostGIS (KNN for `distance_to`, one subquery per join),
  until a production-sized dataset asks for it.
