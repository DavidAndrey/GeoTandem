# Plan E1.7b — Gespeicherte und geteilte Abfragen

> Stand: 2026-10-03 · **umgesetzt (WP36–WP38)** · Bezug:
> [plan-e1.7.md](plan-e1.7.md) (D1: zunächst ausgelassen), [design/e1/README.md](../design/e1/README.md)
> (B1 "Gespeicherte Abfragen", C6, C7 `gespeicherteAbfrage`)
>
> Continues with WP36. Each WP is one commit and leaves `make gate` green.

Target: **a query — result layer, conditions, restriction — can be saved by
name, reused across sessions, and shared with every user, read-only.**
Plan E1.7 left this out (D1) because the requirements do not name it; it is
built now on explicit request (2026-10-03). The design is the reference.

## 1 Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | What a saved query holds | Like a session (plan E1.7, S5): the query part of the state as versioned JSON (result layer, condition tree, restriction), the **result query object**, validated by the server, and the catalog layers it uses (from compiling it) | One contract, the query object; the state is the editor's own data |
| Q2 | Result layer | **Catalog layers only.** A query on a derived layer (buffer, join) cannot be saved; the menu says why | A derived result would need its recipe too, i.e. a second session format |
| Q3 | Sharing (design decision 2) | Owner switches "Geteilt"; shared queries are readable by every account. Only the owner renames, saves over, shares or deletes. Anyone else's "Speichern" **saves a copy** under their own account | Design C6 "Ändern erzeugt Kopie" |
| Q4 | Visibility (F-2.7) | A shared query appears only to accounts that see **all** its layers. Otherwise it is not listed and its id is 404 | Listing it would leak names of hidden layers |
| Q5 | Opening a query (B1) | Replaces result layer, conditions and restriction of the analysis; adds the result layer to the map if missing; closes an open editor draft. **Asks** first when the current query has changes that are not in a saved query (design "bei Änderungen mit Rückfrage") | Design B1 |
| Q6 | Link from session to query (C7 `gespeicherteAbfrage`) | The analysis remembers which saved query it was opened from (`query: {id, name}` in the session state, additive; format stays 1). The panel shows its name; changes mark it "geändert" | The session keeps its own copy of the conditions, so a deleted or changed query never breaks a session |
| Q7 | Delete (C6) | Asks; says how many sessions refer to it (a count across all accounts, never their names). Sessions keep their conditions | Design C6; counting leaks nothing |
| Q8 | List (B1 menu, C6) | B1: "Gespeichert · <Ergebnis-Layer>" first, then other result layers, with hit counts; C6: search, filter by result layer, name, result layer, conditions ("1 A · 2 R"), changed, shared, ⋯ (Öffnen, Umbenennen, Duplizieren, Löschen; for others' queries only Öffnen and Duplizieren) | Design B1, C6 |
| Q9 | "Verwendung" tab of the layer page (D3) | **Left out** | The layer page has no Verwendung tab yet |

## 2 Work packages

### WP36 — Saved queries in the backend

- Migration `0005_saved_queries`: table `saved_query` (id, owner, name,
  shared, `state_version`, state JSON, query JSON, layers JSON, created,
  updated); unique (owner, name).
- `geotandem.saved_queries` and `/api/queries`: list (own and shared,
  filtered by visibility), create, get, save (owner), patch name/shared
  (owner), duplicate (anyone who sees it → own copy), delete (owner),
  usage (sessions referring to it). Summaries carry owner, `mine`, result
  layer, condition counts (attribute, spatial) from the query object.
- Tests: CRUD, uniqueness, sharing and copy semantics, others cannot
  change or delete, hidden layers hide a shared query, usage count.

### WP37 — Saved queries in the workplace (B1, C6)

- Analysis store: `queryRef` (id, name, owner is me, the saved snapshot);
  "geändert" when the current query differs from the snapshot. Saved with
  the session.
- QueryPanel "Gespeicherte Abfragen": name ▾ with Speichern, Speichern
  unter …, Neue Abfrage (leer), the lists of B1 with hit counts, Verwalten …
- C6 dialog; open with the Q5 question; Q2 hint.
- Component and unit tests.

### WP38 — End-to-end and docs

- `e2e/tests/queries.spec.ts`: one account saves the reference question and
  shares it; a second sees it, opens it in its own analysis with the same
  hit count, changes it and saves a copy; the first deletes it and is told
  one session uses it; the second's session still opens identical.
- Docs: CONTEXT (Gespeicherte Abfrage), plan-e1.7 D1 marked as done.

## 3 Reported gaps

- Queries on derived result layers (Q2).
- "Verwendung" on the layer page (Q9).

## 4 Found on the way

- **Summaries carry the query object (WP37).** The B1 menu shows each
  query's hit count; with the query object in the list it is one count
  request for all of them instead of one fetch per query.
- **Menus opened under dialogs (WP38).** The shared row menu and the
  confirmation sat below the modal's overlay, so "⋯ → Löschen" in C6 — and
  the same menu in the session list C3 — could not be clicked. Unit tests
  without layout cannot see stacking; the end-to-end test did. Menus and
  confirmations now stack above dialogs.
- **Opening a query before the catalog had loaded (WP38).** Under load the
  layer list could still be on its way when a query was chosen; an empty
  catalog made its result layer look missing and the open failed. Opening
  now waits for the catalog.
- **⌖ right after another zoom did nothing (WP38).** Leaflet drops an
  animated zoom asked for while another one runs. Feature requests now wait
  for the running zoom to end. Found by `table.spec` once it zoomed to the
  layer first.
- **Two map-click tests depended on the first view (WP38).** The first view
  covers every layer the account sees, which grows with what earlier tests
  imported, so a feature clicked by position could be outside the map: under
  load in the gate's second pass, `editor.spec` (E1.5) picked nothing and
  still passed its weak check, then failed on the count. Both tests now zoom
  to their layer before clicking, and the pick check rejects the waiting
  state too.
- **Fresh accounts per run (WP38).** The gate runs the suite twice on the
  same data; the test creates its two accounts with a run suffix, so the
  second run starts from nothing instead of from the first run's queries. The
  shared query's name carries the run too: shared queries are visible to
  every account, including other runs'.
