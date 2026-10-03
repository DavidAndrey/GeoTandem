# Plan E1.6 — Attributtabelle

> Stand: 2026-10-03 · **entschieden 2026-10-03** · Bezug: [etappen.md 3](../etappen.md),
> [anforderungen.md 8](../anforderungen.md) (F-8.2), [design/e1/README.md](../design/e1/README.md)
> (screens B8, B9, B3 "Tabelle öffnen"), [plan-e1.5.md](plan-e1.5.md)
>
> Continues with WP26. Each WP is one commit, regenerates derived artefacts
> with `make gen` and leaves `make gate` green.

Target (etappen E1.6): **hits can be read, not just counted.** F-8.2: an
attribute table of the current selection, sortable, with configurable
columns, and highlighting in both directions between table and map.

## 0 Starting point

- `main` at E1.5 plus S3 (schema v1 is the whole intrinsic contract) and the
  personal instance (`make instance`).
- The map fetches each displayed layer with one query (`['map-layer', q]`, all
  attributes, whole or by view per D5) and the result layer's hit ids with a
  second one (`['map-hits', q]`, `select: []`). Hits/non-hits are already
  told apart on the map (B9 colours). The table can be built from these
  cached results **without a new endpoint and without a second path past
  the engine**.
- There is no dock under the map yet; B3 has no "Tabelle öffnen" entry yet.
- Attribute labels, units and types come from the catalog metadata
  (`layerInfo.ts`, `popup.ts`), the Swiss number format is in place.

## 1 The schema question (decide first)

The design's table (B8) and the session example (`design/e1/schema/sitzung.example.json`)
show **computed columns**: "Distanz Hauptstr." (`@distanz:hauptstr`) and the
attributes of the area the hit lies in (`@liegt_in:stadtteile_kinder.ant_u18`,
"aus Raumfilter"). They answer *why* an object is a hit. Plan E1.5 deferred
them to E1.6. F-8.2 itself does not ask for them, and schema v1 cannot
express them: `select` only names existing attributes.

| # | Question | Options |
|---|---|---|
| **S4** | Computed columns from spatial conditions | **A — leave out, report as gap.** E1.6 ships source and joined attributes only. Smallest, strictly F-8.2. **B — schema v2, additive:** a new top-level `columns: [{name, fn: "distance_to", layer, where?} \| {name, fn: "value_of", layer, attr, predicate: within\|intersects}]` compiled as correlated subqueries (the EXISTS machinery of `related`, with `MIN(ST_Distance)` / a scalar lookup), returned as ordinary result attributes. v1 documents stay valid; v2.json exported next to v1.json. The table offers one column per spatial row of the tree, marked "berechnet" / "aus Raumfilter". **C — frontend computes them** from the fetched geometries. Rejected: a second way past the engine, wrong in metres without projection. |

**S4 decided 2026-10-03: B, schema v2.** Reason: "Treffer lesen" is the point of the stage and
the reference question's hits are only explainable with the distance and the
area's share of children. It touches the lock point again, as v1 did, and
adds one WP (WP26). Option A would have
left them as a reported gap.

## 2 Other decisions

**D1–D9 decided 2026-10-03 as recommended.**

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Where sort and column choice live | **In the analysis state, not in the query object**: `table: {tab, mode: hits\|all, onlyView, columns: {[layerId]: string[]}, sort: {[layerId]: [{attr, dir}]}}`. Changing them sets *ungespeichert* (design decision); E1.7 saves them with the session (C7). The table sorts the already fetched rows locally | They are a view over the result, like map position, but the design wants them saved. Writing them into `order_by`/`select` of the map query would force a second fetch per sort click and break the popup and symbology, which need all attributes. The query (and F-8.9) is unchanged by sorting |
| D2 | Data source of the table | **Reuse the map's cached queries** (`['map-layer', q]` for rows, `['map-hits', q]` for the hit set). For a tab whose layer is hidden or not displayed, the same query is fetched with `enabled` regardless of visibility | One query per layer, one truth. No new endpoint |
| D3 | Layers above `max_features` (fetched by view, plan D5) | "Alle" then shows the rows of the current view only, with a hint ("nur Kartenausschnitt geladen"), and "nur aktueller Kartenausschnitt" is forced on | Same limit as the map (F-9.6); honest instead of silently partial |
| D4 | Rendering many rows | **Own table component on Radix + Tailwind, no table library; windowed rendering** (fixed row height, only visible rows in the DOM). Sorting is a pure, tested function (multi-key, de-CH collation, numbers numerically, empty values last) | Up to 10 000 rows; the needs (sort, choose, order columns) are small. TanStack Table would be a new dependency for little gain — noted in tech-stack if chosen otherwise |
| D5 | Selection and highlighting (B9) | A small Zustand store `selection` beside `useMapView`: `{layerId, fids:Set, hover}`. Not saved (design: "Tabellenauswahl nicht gespeichert"). Row click → feature gets outline + dashed ring (never a new colour), map pans only if it is out of view; map click on a feature of the open tab → row selected and scrolled into view, popup still opens; row hover → short highlight; ⌖ zooms to the feature; checkboxes for multi-select | Exactly B8/B9; ring instead of colour keeps classified maps readable |
| D6 | "Auswahl als Filter" (B8) | **Leave out, report.** Schema v1 has no condition on feature ids, and ids are not stable across `replace_layer`, so such a filter would not reproduce (F-8.9). Not in F-8.2 | "Kein stiller Umfangszuwachs" |
| D7 | Tabs | One tab per displayed layer, result layer first, then panel order; table-only layers (no geometry) get a tab too (B11: "nur als Tabellenreiter"). Opening: B3 "Tabelle öffnen" and a toggle in the toolbar; dock with drag divider and ⌄ collapse; height in `localStorage` (per viewer, not session state) | Design B1/B3/B8 |
| D8 | "Export ab E5" button | Shown disabled with "ab E5", like the Prompt tab | Design shows it; F-8.6 belongs to E5 |
| D9 | Column defaults | All attributes in catalog order, labels and units from metadata (D3 "fachliche Namen"); joined columns after the source's | Matches popup behaviour |

## 3 Work packages

### WP26 — Computed columns, schema v2 (backend)

- `geotandem_query`: `columns` with `DistanceTo` / `ValueOf` (discriminated by
  `fn`), `SCHEMA_VERSION = "2"`, upgrade v1→v2 (version only), `v2.json`
  exported, v0/v1 untouched. Name clashes with source or joined attributes
  rejected. Contract test corpus (S3) extended.
- Engine: correlated subqueries with the index prefilter; `distance_to` in
  metres in the working CRS; `value_of` returns the first match by fid when
  several areas qualify (documented). Not allowed together with `aggregate`
  (validated, like the existing rules). Capability: `Op.SPATIAL_RELATION`.
- Tests: shapely oracle for both functions, NULL when nothing qualifies,
  hidden layer → `unknown_layer`, v1 golden files unchanged after upgrade.
- Frontend types regenerated; `query.ts` adds one column per spatial row to
  the result query's `columns`; ajv tests switch to `v2.json`.

### WP27 — Table state and sorting (foundation)

- Store: `table` slice per D1 (with `dirty`), cleanup when a layer is removed
  or the result layer changes; `selection` store per D5.
- Pure functions: `tableRows(features, hits, mode, viewBbox)`,
  `sortRows(rows, sort, types)`, `defaultColumns(info)`, `columnLabel`.
- Unit tests: multi-key sort, collation (Ä, ü), nulls last, numeric vs
  text, toggling ↓/↑/aus and Shift for the second key, column removal when
  the attribute disappears (join changed).

### WP28 — Attribute table dock (B8, F-8.2)

- Dock under the map with divider and collapse, tabs per D7, Treffer (n) /
  Alle (m), "nur aktueller Kartenausschnitt", Spalten ▾ popover (checkbox,
  drag to reorder, "berechnet" badge), sortable headers with ↓/↑ and order
  number, windowed body, tabular figures (`tnum`), "… n weitere" footer
  only for the collapsed preview, "n ausgewählt".
- B3 entry "Tabelle öffnen" for catalog and derived layers; empty states
  (no result layer, 0 hits) as in B12.
- Component tests with the fixtures: sort, columns, mode switch, hidden
  layer tab.

### WP29 — Highlighting between table and map (B9, F-8.2)

- `DataLayer` styles selected and hovered features (outline + ring, both
  themes), keeps the ring above the class colours; map click selects the
  row and scrolls to it; row click selects and pans if needed; ⌖ zooms.
- Works for derived layers (by their row id) and is cleared when the tab's
  layer leaves the analysis.
- Tests: unit tests on the style function; Playwright for both directions.

### WP30 — Acceptance E1.6 and docs

- `e2e/tests/acceptance-e1.6.spec.ts`: the reference question from E1.5,
  table opened on the result layer, 7 rows, sorted by Schüler ↓ then Name,
  column hidden and reordered, row → map ring, map click → row; the distance column shows the engine's values and every request still
  validates against the current schema and is accepted by the server.
- Docs: CONTEXT.md (Attributtabelle, berechnete Spalte, Auswahl), README
  (table, limits), etappen (schema v2 noted in E1.2), tech-stack (D4).

## 4 Order

```
WP26 ── WP27 ─┬─ WP28 ─┐
              └─ WP29 ─┴─ WP30
```

WP26 must land first: the frontend validates against `v2.json`. WP28 and WP29 share only the
stores from WP27.

## 5 Reported gaps (not built)

- "Auswahl als Filter" (D6).
- Export (F-8.6, E5).
