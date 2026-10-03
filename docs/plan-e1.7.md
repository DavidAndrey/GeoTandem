# Plan E1.7 — Sitzung speichern und wiederherstellen

> Stand: 2026-10-03 · **entschieden 2026-10-03** · Bezug: [etappen.md 3](../etappen.md),
> [anforderungen.md 4, 8](../anforderungen.md) (F-4.10, F-8.9), [design/e1/README.md](../design/e1/README.md)
> (screens C1–C8, "Verhalten und Zustand"), [plan-e1.6.md](plan-e1.6.md)
>
> Continues with WP31. Each WP is one commit, regenerates derived artefacts
> with `make gen` and leaves `make gate` green.

Target (etappen E1.7): **a saved session gives the same result after a
restart.** F-4.10: save and restore the whole analysis state as a named
session. F-8.9: every result is tied to its query and reproducible without a
model. E1.7 is the last package of E1, so its acceptance is also the
**Vorführung E1**: a multi-layer question answered by hand, saved, and
reproduced after a restart, without any LLM connection (F-4.11).

## 0 Starting point

- `main` at E1.6. The gate passes: 290 backend tests, 86 frontend tests,
  21 Playwright tests run twice, the second time after a container restart
  on the same volume.
- The analysis state lives in the frontend store (`analysis/store.ts`):
  layers with recipes and symbology, result layer, condition tree,
  restriction, table state. `dirty` already follows the design's rule
  (layers, query, derived layers, columns and sort; not map moves).
- Every result already carries `query_hash`, `schema_version` and the
  `data_versions` of the layers it touched (F-8.9). `dataset_version`
  changes with every import that replaces a layer (`import-<run>`).
- There is no session yet: no table, no route, no header menu. The header
  has no session name and no "ungespeichert" indicator.
- `api/admin.py` says every route that changes data lives under the admin
  router. Sessions are written by every user, so that rule needs a
  narrower wording (it means geodata and the catalog).

## 1 The format question (decide first)

A session must hold the whole analysis state (F-4.10), and reopening it must
give the same result (F-8.9). Only the frontend can turn the state into query
objects (`analysis/query.ts`). So the question is what the server stores and
checks.

| # | Question | Options |
|---|---|---|
| **S5** | What is stored, and what proves "same result"? | **A — state plus query plus stamp (recommended).** The session stores (1) the analysis state as versioned JSON (`state_version: 1`), opaque to the server apart from a size limit; (2) the **result query object**, validated by the server like any query; (3) a **result stamp** the server computes by running that query: hit count, sha256 of the sorted feature ids, `data_versions`. Reopening runs the stored query again and compares stamps (C4); the frontend also rebuilds the query from the state and checks its hash against the stored one, so state and query cannot drift apart unnoticed. **B — a full session schema**, exported like the query schema, with the server validating every field of the state. A contract for E2 (the model writes the same state) and E4 (MCP), but it freezes the frontend's state shape now, before E2 has shown what it needs. |

**S5 decided 2026-10-03: A.** The query object stays the one contract (CONTEXT.md);
the state is the editor's own data, versioned so it can migrate. If E2 needs
the state as a contract, B can follow then, from a state that has proven itself.

## 2 Other decisions

**D1–D10 decided 2026-10-03 as recommended.**

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Saved queries (B1 "Gespeicherte Abfragen", C6, shared and read-only for others) | **Left out, reported.** Sessions only | F-4.10 asks for sessions. Saved queries are a second artefact with sharing rules, not in the requirements. "Kein stiller Umfangszuwachs" |
| D2 | Ownership | Sessions are **private** to their owner (design decision 2), also for administrators; deleting an account deletes its sessions | Design; nothing in F-3.x lets an admin read a user's work |
| D3 | Map view | Saved with the session (`bbox` at save time) and restored on open; moving the map still does not set *ungespeichert* | The example (C7) saves it; restoring the view is what "wiederherstellen" means to a user |
| D4 | C4 "Unterschied in Tabelle zeigen" | **Left out, reported.** The deviation notice names the cause (layers whose `dataset_version` changed or that are gone) and old → new hit count; "Mit aktuellen Daten übernehmen" sets a new stamp | Showing added and removed rows would need the old ids, and ids are not stable across `replace_layer` (plan E1.6, D6), so such a diff would mislead |
| D5 | C8 missing layer (deleted, or hidden from the role) | Result layer missing → open without a result, notice with "Anderen Ergebnis-Layer wählen". Condition on a missing layer → **removed on open and listed** in a lasting notice; the result counts as deviating. **"Layer wiederherstellen" (admin) left out**: there is no layer history to restore from (D3 "Verlauf" is not built) | An "abgeschaltet" flag on rows would add a state to every row for a rare case; listing what was removed says the same |
| D6 | C5 unsaved changes | Dialog on open, new session and sign-out: "Speichern und …", "Verwerfen", "Abbrechen"; plus the browser's own prompt on leaving the page | Design C5 |
| D7 | Addresses (design "Adressen") | `/sitzung/:id` opens a session with the C4 check; `/` opens the user's **last opened** session (or an empty one); after sign-in the same | Design A2 "Anmelden → letzte Sitzung" |
| D8 | Saving while the editor is open | Saves the applied state; the draft stays open and still counts as unsaved | "Übernehmen" is the editor's commit point (B2); a half-edited condition is not part of the analysis |
| D9 | Affected sessions in the admin's delete and update dialogs (D4, D5 "Verwendung") | **Left out, reported** | Sessions are private; listing them to an admin contradicts D2. C8 handles the consequence on open |
| D10 | Names | Unique per owner; "Speichern unter" with an existing name asks before overwriting. Limits: name ≤ 120 chars, note ≤ 2000, state ≤ 1 MB | Plain; the limit protects the data file from a drawn polygon with a million vertices |

## 3 Work packages

### WP31 — Sessions in the backend (F-4.10, F-8.9)

- Migration `0004_sessions`: table `analysis_session` (id, owner → `app_user`
  with cascade, name, note, `state_version`, state JSON, result query JSON,
  `query_hash`, stamp: count, ids hash, `data_versions` JSON; created,
  updated, opened). Unique (owner, name).
- `geotandem.sessions`: create, list (own only), get, update (rename, note,
  state), duplicate, delete, `stamp(query)` and `check(session)` → identical
  / deviating with causes (changed versions, missing layers, count old →
  new). Stamps run through the user's `LayerView`, so visibility holds
  (F-2.7): a hidden layer is a missing layer.
- API `/api/sessions` (signed-in users, owner-scoped; another user's id is
  404, never 403): `GET`, `POST`, `GET/PATCH/DELETE /{id}`,
  `POST /{id}/duplicate`, `POST /{id}/check` (also records the opening).
  The user's last opened session: `GET /api/sessions/last`. Saving (`PUT`)
  always sets a new stamp, so "Mit aktuellen Daten übernehmen" is a save.
- `api/admin.py` wording: the admin router holds every route that changes
  geodata or the catalog.
- Tests: CRUD and ownership (two accounts), unique names, limits, invalid
  query rejected, stamp identical across two runs and after a reconnect of
  the data file, deviation after `replace_layer` names the layer, missing
  layer after hiding it from the role, account deletion cascades.

### WP32 — Session format and store (frontend)

- `session/format.ts`: analysis state + table state + map view ↔ JSON
  (`state_version: 1`), with a migration hook for later versions; reading
  rejects unknown versions with a clear message.
- Store `session`: current id, name, note, saved-at, stamp; actions save,
  save as, open, new, delete; `dirty` reset on save and open.
- Open: load the state, rebuild `resultQuery`, compare its hash with the
  stored one (warn if different), apply D5 for missing layers.
- Unit tests: round trip of 300 random analyses (the E1.5 generator) gives
  the same `resultQuery` and the same queries for every layer; missing
  layers removed and listed; unknown version refused.

### WP33 — Session menu and dialogs (C1, C2, C3, C5)

- Header: session name ▾ (C1: Speichern ⌘S/Ctrl+S, Speichern unter …, Neue
  Sitzung, Zuletzt (2), Alle öffnen …, Diese Sitzung löschen) and the
  indicator "● ungespeichert" / "gespeichert 14:02".
- C2 Speichern unter: name, note, summary of what is saved (layers,
  conditions, derived layers), the stamp after saving.
- C3 Sitzungen: search; name, result layer, hits, changed, ⋯ (Öffnen,
  Umbenennen, Duplizieren, Löschen); flag "Daten neu" when a layer's
  current version differs from the stamp.
- C5 guard on open, new and sign-out; `beforeunload` while unsaved.
- Routes per D7.
- Component tests for menu, dialogs and the guard.

### WP34 — Opening with check (C4, C8)

- On open: `POST /check`. Identical → notice "identisch", closes after a
  few seconds. Deviating → lasting notice with the cause and old → new
  count, "Mit aktuellen Daten übernehmen" (a save, which restamps). Missing layers per D5.
- The map restores the saved view (D3).
- Tests: identical, changed version, missing result layer, missing
  condition layer.

### WP35 — Acceptance E1.7, Vorführung E1, docs

- `e2e/tests/acceptance-e1.7.spec.ts`, built for the gate's two passes: the
  first pass builds the reference question by hand (shared helper from
  E1.6), adds the buffer, reads the hits in the table, saves the session
  "Vorführung E1" and checks the stamp against a direct query; the second
  pass, **after the container restart**, signs in fresh, lands in that
  session and sees "identisch", the same ten rows in the same order, the
  same columns and sort. Every request validates against `v2.json`; no LLM
  connection exists (F-4.11).
- A data change case: replace a layer the session uses, reopen, see the
  deviation name that layer.
- Docs: CONTEXT.md (Sitzung, Ergebnis-Stempel), README (where sessions live,
  backup covers them, F-9.8), etappen (E1 complete), anforderungen
  untouched.

## 4 Order

```
WP31 ── WP32 ─┬─ WP33 ─┐
              └─ WP34 ─┴─ WP35
```

WP31 first: the frontend saves through it. WP33 and WP34 share only the
session store from WP32.

## 5 Reported gaps (not built)

- Saved and shared queries, B1 "Gespeicherte Abfragen", C6 (D1).
- "Unterschied in Tabelle zeigen" in C4 (D4).
- "Layer wiederherstellen" in C8 (D5); needs a layer history.
- Affected sessions in the admin's delete and update dialogs (D9).
