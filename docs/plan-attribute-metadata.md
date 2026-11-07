# Plan: attribute metadata — units, roles, references, and a model that reads them

> Status: decided 2026-11-07 (Q1–Q9, section 6). A done on branch
> `attribute-metadata`: no effect of units, roles or real references
> (testplan 8.6); E and the `identifier` role dropped (section 7). B, C, D open.
> Bezug: [memo.md](../memo.md) (Phase 4 result), [testplan-system-context.md 8.5](testplan-system-context.md),
> [plan-e3.md](plan-e3.md) D11 / WP94, `backend/src/geotandem/catalog.py`,
> `backend/src/geotandem/evaluation/profiles.py`, `schema/eval-cases/`.

## 1 Why

In the Datenkatalog the unit mostly stays empty, because most attributes have
none. Three questions followed: what an empty unit costs, whether marking an
attribute's *kind* (identifier, reference …) helps, and whether a model can
show what it understands from the metadata and propose what is missing.

## 2 What we know already

| Fact | Where | Consequence |
|---|---|---|
| An empty unit is `null` and left out of the profile (`exclude_none`); it costs nothing | `catalog.py:283` | Empty is right for text, boolean, date and coded attributes |
| The storage type is already in the profile: `integer · real · text · boolean · date` | `AttributeInfo.data_type` | No new *storage* type is needed |
| `references` exists in the profile, but is set **only at import** (key reference); `AttributeUpdate` has no `references` | `importing/run.py:381`, `catalog.py:132` | An administrator cannot mark a reference afterwards |
| The sample data sets **no** `references`. The joins live in descriptions: «Schlüssel auf gemeinden.gem_nr» (`schulen`, `gemeindedaten`) | `sample/data/metadata.json` | The `references` path is never measured |
| That description makes qwen3:14b write `gem_nr = 1` (`log2` 0/10); without it, it takes the name (7/10); `in-gemeinde-bahn` 0 ⇒ 10/10 | testplan 8.5, point 4 | The strongest case for an *identifier* role / a real reference |
| The sample's units also sit in the column names: `flaeche_km2`, `laenge_km`. Others: `einwohner` (Personen), `arbeitsplaetze` (Stellen), `steuerpflichtige` (Personen) | `metadata.json` | A unit ablation on the sample hardly measures anything |
| Every start-set case uses the column's own unit (km², km). None converts (ha, m) | `start-tuning.json`, `start-confirm.json` | Units are not measured today; `raw` strips them only together with everything else |
| Phase 4: code lists ≫ labels > descriptions; descriptions help or hurt depending on wording | memo.md | Generated descriptions must state meaning, never joins |
| The completeness summary (D11) counts labels, code lists and descriptions, not units | `evaluation/summary.py` | Units join it only if they turn out to matter, and only for `integer`/`real` |

## 3 Scope

### In

| Part | What | Kind |
|---|---|---|
| **A** | Measure units, the identifier role and real references: new cases, new ablation modes, one run | measurement (evals, cases) |
| **B** | `references` editable by the administrator | product (BE + FE) |
| **C** | Comprehension probe: a model says what it reads from a layer's metadata | product (BE + FE) |
| **D** | Proposed labels/descriptions from a model, confirmed by the administrator | product (BE + FE) + measurement |
| **E** | Completeness hint for units and roles, *only if A shows an effect* | product, conditional |

Order: A first (it decides E and whether roles are built). B is independent of
A and can run alongside. C before D: D reuses C's call and its display.

### Out

- E-7 (synonyms, values of named objects in the profile). D and C touch it, but it is its own step.
- **Sample values** sent to the generator (that's content: Datenfreigabe). D works on metadata only (Q8).
- Applying generated text without confirmation.
- Renaming columns in production data.
- The tool chain: A measures in direct mode, as Phase 4 did.

## 4 The parts

### A — Measurement

**A1 New cases** — built: `schema/eval-cases/metadata-cases.json`, its own
set beside the start set (`--cases metadata`, `metadata-heldout`), so the
start set, its 71-case count, the example pool and earlier hashes stay as they
were. Eight cases, four per split, each split with all three kinds:

- `unit` (4): «mehr als 2000 Hektaren», «länger als 10 000 m», «kleiner als 3 000 000 m²», «zwischen 500 und 1000 ha». A test shows the number taken in the attribute's own unit selects something else;
- `key` (2): «Schulen der Gemeinde Köniz / Worb». Through `gemeinden` by name and a right `gem_nr` select the same schools (checked), so one gold; a guessed number fails;
- `key-value` (2): «Gemeindenummer 616», «BFS-Nummer 351»: the role must not stop a model from using a number it is given.

Dropped: the table case (`gemeindedaten`): the direct query declines tables
(`n03`, `h37` expect `cannot_answer`), and a steueranlage negative is `h37` already.

**A2 New ablation modes** in `evaluation/profiles.py`:

| Mode | Change | Question |
|---|---|---|
| `no-units` | `unit = None` everywhere | Does the unit add anything beyond label and name? |
| `refs` | join text removed from the `gem_nr` descriptions, `references` set to `gemeinden.gem_nr` | Does a real reference beat the prose one? |
| `refs-role` | `refs` plus `role: identifier` on every `gem_nr` | Does the role stop guessed ids? |

Built. `bare-names` was dropped: the sample's labels already name no unit
(«Fläche», «Länge im Gebiet»), so it would equal `no-units`; only the column
name (`flaeche_km2`) still carries one, as accepted in Q1.

`role` is a new optional profile field (`AttributeProfile.role`), `None`
everywhere in production, so the production profile and its hash don't change
(`exclude_none`; tested). It has no catalog column: `refs-role` sets it on the
built profile and seals it again (`profiles.model_profile_for`,
`catalog.seal`). It is only built for real if `refs-role` wins (E).

**A3 Run**: `full` plus the three modes, on `cases`, `heldout`, `metadata`
and `metadata-heldout`, two seed blocks (1–5, 6–10) at temperature 0.3, on
the models at the bar (gemma4:12b, qwen3:14b), labels `m-<mode>-<cases>-<model>`;
Haiku 5.5 as the external reference (Q4) at its default temperature, as in Phase 4.
`full` runs again rather than reusing Phase 4's P0: the prompt has changed since.
Result in `testplan-system-context.md` as 8.6, decision in this plan.

### B — `references` editable

- `AttributeUpdate.references: str | None`, checked: target `layer.attribute` exists on another layer (any kind, Q7), same data type, not the attribute itself.
- `LayerPage`: a «Verweist auf» select per attribute (layer, then attribute), empty = none.
- The model profile already drops a reference whose target is hidden (`catalog.py`, `model_profile`); tests for the edit path.
- Found in A: today `references` also means «this layer took its geometry by a key join». The import skips a layer with any reference when it looks for join keys (`importing/run.py`, `key_candidates`). A reference set by hand on a vector layer would hide that layer's keys from the next key import. B has to split the two meanings (or keep the skip to imported key joins) before Q7's «any» is safe.
- Whether the sample data gets real references is decided by A (Q3).

### C — Comprehension probe («Was versteht das Modell?»)

- On `LayerPage` (Q6): «Verständnis prüfen» with a connection to choose.
- The model gets **only the layer's profile** (as it gets it for a query) and returns, per attribute: meaning in one sentence, unit, plausible values / range, and a guess whether it's an identifier.
- Shown side by side with the curated metadata; the administrator reads where they differ. No grade, no stored verdict.
- Optional second probe: a few user words («Einwohner», «Bahnhof», «gross») → which attribute the model would use. It reuses the same view.
- Metadata only, so allowed on external connections without Datenfreigabe. Any approved connection (Q9). Counts toward the connection's daily limit; logged as its own audit-log entry, not a Modellaktion (Q5).

### D — Proposed metadata

- «Vorschläge erzeugen» on a layer: the model proposes labels and descriptions where they're empty (and units for `integer`/`real`, if A shows they matter).
- Prompt rules from Phase 4: say what the value *means*; never describe joins or keys; no invented units; leave it empty if unsure.
- Proposals are shown as drafts in the attribute form; nothing reaches the profile until the administrator saves it (the S2 pattern of proposed code lists).
- **Measurement**: generate once for the sample data from `raw-codes` (bare import), confirm by hand without edits, run it as mode `generated` against `raw-codes` and `full`. Tells whether D is worth offering and with which generator.

### E — Completeness, conditional

If A shows an effect: the D11 summary counts units only for `integer`/`real`
attributes the administrator hasn't marked «ohne Einheit», and identifiers
only if the role is built. Otherwise E is dropped and the plan says why.

## 5 Order and size

| Step | Depends on | Size |
|---|---|---|
| A1 cases, A2 modes | – | small |
| A3 run + write-up | A1, A2 | half a day of runs (local), small cost (Haiku) |
| B references editable | – | medium (BE validation, FE select, tests, e2e) |
| C probe | – | medium (new model call, view) |
| D proposals + measurement | C | medium |
| E completeness | A3 | small, or dropped |

## 6 Decisions (2026-11-07)

| # | Question | Decision |
|---|---|---|
| Q1 | The sample's units sit in the column names (`flaeche_km2`), and the model sees the name. How do we measure units on bare names? | `bare-names` is enough; the name still leaks, and that is accepted. No renamed sample copy |
| Q2 | Which roles? | Only `identifier` for A. *measure / code / name* only if `identifier` pays off |
| Q3 | Should the sample data get real `references` (and lose the join prose)? It changes the sample profile hash | Only if `refs` wins in A3; then as its own commit, noted in the run labels |
| Q4 | Models for A3 | gemma4:12b, qwen3:14b, Haiku 5.5. Luna only if Haiku shows an effect |
| Q5 | Are probe (C) and proposals (D) logged as a *Modellaktion* (F-6.8)? They are not queries | No: their own log entry type in the audit log (who, connection, layer, tokens); counts toward the daily limit |
| Q6 | Where does the probe live? | `LayerPage`, per layer, next to the fields it's about |
| Q7 | Which direction may `references` point? | Any: from any layer (table or vector) to any other layer, with the same key type. Before B is built, `represent.py`'s relations are checked for what a vector → vector reference needs |
| Q8 | Sample values for the generator (D) | Out of scope |
| Q9 | Which connection generates (D)? | Any approved connection, the preset one by default |

## 7 Result of A (2026-11-07)

A3 ran on gemma4:12b, qwen3:14b and Haiku 5.5 (96 runs, testplan
[8.6](testplan-system-context.md)). No mode differs from `full` on any model or
split once paired over the cases.

| Question | Answer | Consequence |
|---|---|---|
| Does the unit add anything? | No: the column name carries it, and the failed conversions are arithmetic (m² → km² off by 1000, ha → km² off by 1000) | **E dropped** for units; D proposes no units |
| Does a real reference beat the prose? | No: gemma4:12b +2.4 pp on tuning, not confirmed; one case falls 10 ⇒ 0/10 (`h16`, `gem_nr = 100` guessed) | **Q3: the sample keeps its prose**; no new hash |
| Does `role: identifier` stop guessed ids? | No: the guesses stay (`h16`, qwen3:14b `md07` `gem_nr = 363`), given numbers are still used | **Role not built** (Q2); `AttributeProfile.role` and `refs-role` stay as an eval-only mode |
| Is the Phase 4 `gem_nr` failure still there? | No: `log2` and `in-gemeinde-bahn` now fail for other reasons on qwen3:14b | The case for an identifier role is gone |

B stays useful on its own (an administrator can mark a key join), but not as a
quality lever; its priority drops behind C and D. Guessed ids are a candidate
for the «still falsch» signal of 8.5 (5) instead: an equality on a key
attribute with a number the question doesn't contain.
