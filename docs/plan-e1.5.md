# Plan E1.5 — Karte und Klassik-Bedienung

> Stand: 2026-10-03 · **S1 and D2 decided** · Bezug: [etappen.md 3](../etappen.md),
> [anforderungen.md 4, 8](../anforderungen.md), [design/e1/README.md](../design/e1/README.md)
> (screens B1–B13), [plan-e1.3-e1.4.md](plan-e1.3-e1.4.md)
>
> Continues with WP20. Each WP is one commit, regenerates derived artefacts
> with `make gen` and leaves `make gate` green.

Target (etappen E1.5): **every UI action produces a valid query object as
defined in E1.2. The interface edits that object; it is not a second way
around the machinery.** F-4.1 to F-4.9, F-8.1.

## 0 Starting point

- `main` at E1.4. The gate passes: 214 backend tests, 37 frontend tests,
  14 Playwright tests run twice.
- The frontend has the admin area, sign-in, TanStack Query and Radix. It has
  no map yet; the start page is a placeholder (system status plus visible layers).
- Query-object schema v0 (`packages/query`) is the contract. The engine
  compiles it through the `LayerView`, so visibility already holds for
  every query the map sends.

## 1 The schema question (decide first)

The design's condition tree (B2) does not fit schema v0. In v0, `where` holds
attribute, bbox, drawn-geometry and single-feature conditions, but the
relation to *another layer* is the single top-level `spatial_relation`. The
reference question needs two such relations combined with AND:

> Grundschulen ≤ 500 m von einer Hauptstrasse, **und** in einem Gebiet mit
> Kinderanteil > 20 %

The design also allows OR and NOT across both kinds of condition ("liegt
ausserhalb" = NOT within, "> Distanz" = NOT dwithin). None of this is
expressible in v0, so E1.5 cannot meet its "fertig wenn" without a schema
change.

| # | Question | Recommendation |
|---|---|---|
| **S1** | How to get spatial relations into the condition tree? | **Schema v1, additive:** a new condition `{"op": "related", layer, predicate, distance_m?, where?}` usable anywhere in `where`. The top-level `spatial_relation` stays, with unchanged semantics (applied after `buffer`). Every v0 document is valid in v1 and gives the same result; the API accepts v0 and upgrades it. `schema/query-object/v1.json` is exported next to `v0.json` (policy in `version.py`). |
| S2 | Filtering on aggregated metrics ("Gemeinden mit > 5 Schulen", i.e. HAVING) | **Not in E1.5.** v0/v1 filter before aggregating. An aggregation can be shown as a derived layer (B6) but not be the result layer of a metric condition. Reported as a gap. |

The engine change for S1 is small: `spatial_relation` already compiles to an
EXISTS subquery, and the new condition reuses it inside `condition()`.

**S1 decided 2026-10-03: schema v1 as recommended.** It changes the lock point
of E1.2 deliberately and additively; etappen.md notes it in WP25.

## 2 Other decisions

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Analysis state in the frontend (tech-stack 9, due now) | **Zustand**: one store holding the analysis state; translation to query objects in pure functions | Candidate named in tech-stack 4.4; small and plain to test |
| D2 | Background map (F-4.9) vs. working offline (F-9.1) | **Decided 2026-10-03:** presets in `GEOTANDEM_BASEMAP`: `none`, `swisstopo-grau`, `osm` or an own URL template, with attribution. `make dev` uses `swisstopo-grau`; the container defaults to `none`. An active online background is marked on the map (analogous to F-9.4). A local tile file (PMTiles, protomaps-leaflet) can follow later as a further preset, e.g. on the production path (P.4) | Development needs a real map for context; a plain installation must not call outside on its own. Tandemtal lies on real coordinates (Emmental), so a muted grey map is the default for development |
| D3 | Drawing for F-4.3 | **Leaflet-Geoman (free, MIT)** for rectangle and polygon; nothing else drawn | Maintained, covers exactly the need; leaflet-draw is unmaintained |
| D4 | Hit counts per condition (B2 "Trefferzahl je Bedingung allein", B1 "7 von 39") | New endpoint `POST /api/query/count` taking a list of query objects and returning counts. Same compiler, same `LayerView`, no geometries | N full queries would ship all geometries just to count them |
| D5 | Fetching layers for display | Layers with `feature_count ≤ GEOTANDEM_MAX_FEATURES` are fetched once, whole; larger ones by the current view (`bbox` condition), debounced on move, with a hint when even that is too large | Keeps the server-side limit (F-9.6) without a tile server |
| D6 | Symbology (F-4.8) | Per displayed layer in the analysis state, written as the query object's `symbology` hint. Classes (quantile, equal interval) are computed in the frontend from the result values. Default: one colour per layer from a fixed palette. The **catalog-wide default style (D3 tab "Darstellung") is deferred** | F-4.8 asks for symbolisation, not a global per-layer style; the D3 tab needs a schema column and admin UI and is a separate piece |
| D7 | Derived layers (B4–B6) | A derived layer **is a query object** (recipe), recomputed when shown, never stored as geometry (design decision). Conditions reference **catalog layers only**; a buffer as a condition is the `dwithin` relation | Referencing a derived layer from a condition would need nested queries; not in the schema |
| D8 | Map tools of B10 beyond the requirements: search, measure, own location | **Left out** and reported; kept: zoom, pan, home, background, legend, scale, info popup, selection of a reference feature, drawing | F-4.9 lists exactly those; "kein stiller Umfangszuwachs" |
| D9 | Design details without schema support: "Überlappende verschmelzen" (B4), "berührt" (B2), range histogram (B2) | Left out and reported | The first two need schema changes; the histogram is not in F-4.2 |
| D10 | Demo data for the reference question | Tandemtal has no district layer with a share of children. The demonstration first imports `bevoelkerung` keyed onto `gemeinden` (E1.3), then asks: *Primarschulen ≤ 500 m von einer Hauptstrasse, in Gemeinden mit Anteil unter 20 > X %* | It uses E1.3 instead of inventing sample data; X is fixed once the result is known |

## 3 Work packages

### WP20 — Schema v1 and counting (backend)

- `geotandem_query`: condition `Related` (`op: "related"`), `SCHEMA_VERSION =
  "1"`, upgrade v0→v1 (only `schema_version` changes), export `v1.json`;
  `v0.json` stays untouched. The query hash covers the upgraded document.
- Engine: `related` inside `condition()`, reusing the EXISTS compilation and
  the index prefilter, so it nests under AND/OR/NOT. Capability check
  (F-2.14): the same `Op.SPATIAL_RELATION`.
- `POST /api/query/count`: `{queries: [QueryObject, ...]}` → `{counts: [int]}`,
  at most 50 queries, under the same limits and view.
- Tests: oracle tests (shapely) for `related` alone, under NOT, under OR, and
  with `where` on the related layer. The v0 golden files still pass after the
  upgrade (same result, new version). Hidden layer inside `related` →
  `unknown_layer`. Counting under limits and visibility.
- Frontend types regenerated.

### WP21 — Map foundation and analysis state (frontend)

- Leaflet 1.9 + react-leaflet 5, Zustand, Leaflet-Geoman. Background map per
  D2: setting `GEOTANDEM_BASEMAP`, `GET /api/config/map` (tile URL,
  attribution, whether it is external, initial extent from the visible
  layers), hint on the map while an external background is active.
- Store `analysis`: displayed layers (catalog or derived, order, visibility,
  opacity, symbology), result layer, condition tree (editor model with ids
  for groups and rows), restriction (view / drawn shape), derived recipes,
  pending edits of the editor ("Übernehmen" / "Verwerfen"). Map position is
  not part of the "unsaved" state (design decision 3).
- `toQuery(...)` functions: store → query object for the result, for each
  displayed and each derived layer, and per condition alone. **Every one is
  validated in the unit tests against `schema/query-object/v1.json` (ajv)**,
  including generated random edit sequences. This is E1.5's "fertig wenn"
  as a test.
- Map shell: Leaflet map, scale bar, zoom, home (extent of the visible
  layers), background on/off, layer rendering via `/api/query` per D5.

### WP22 — Workplace and layer panel (B1, B3, B11, B12, F-4.1, F-4.9, F-8.1)

- Layout B1: sidebar 250 px (tabs Klassik | Prompt disabled "ab E2"), map,
  toolbar B10 (reduced per D8).
- Layer panel: add layers (B11 popover: search over title and name, only
  visible layers, table layers only as join source), order by drag handle,
  eye, opacity slider, zoom to layer, menu B3 (without the admin entries
  that need later stages).
- Popup with attribute labels and units from the metadata (F-2.8); legend;
  empty states B12.
- Result layer: hits as accent, non-hits at 35 % opacity (B9), "7 von 39".

### WP23 — Query editor (B2, B13, F-4.2, F-4.3, F-4.4)

- Compact tree in the sidebar plus the editor panel B2: AND/OR groups,
  nesting, NOT, row type attribute or space.
- Attribute operators by type: compare, between, text (contains / starts /
  ends / equals / is empty), list (chips, suggestions from the code list).
- Spatial operators → `related`: in, outside, intersects, ≤ distance,
  > distance, contains; optional filter on the related layer's attributes.
- Restriction "Nur in": map view (`bbox`), drawn rectangle or polygon
  (`geometry`); reference feature via map click (`near_feature`) (F-4.3).
- Hit count per condition alone (WP20 counting), active row highlighted on
  the map, "Übernehmen" writes into the state, "Verwerfen" restores it.
- Changing the result layer (B13): lists the attribute conditions that
  drop out and the spatial ones that stay.

### WP24 — Operations and symbology (B4–B7, F-4.5–F-4.8)

- Buffer (B4): distance m/km, "nur gefilterte Objekte" (copies the result's
  `where` if the source is the result layer), name, preview. Without
  dissolve (D9).
- Join (B5): key pair, match rate via counting ("36 / 38"), keep or drop
  rows without match, field selection; the result is a derived layer, and
  can become the result layer.
- Aggregation (B6): area layer, metrics count/sum/avg/min/max with a field
  name, assignment within / intersects.
- Symbology (F-4.8, B7): single colour, categories, classes (quantile, equal
  interval, 2–9 classes), graduated size; quick field choice for derived
  layers; legend follows.

### WP25 — Acceptance E1.5 and docs

- Playwright: the reference question (D10) built by hand. **Every request
  the UI sends to `/api/query` and `/api/query/count` is intercepted and
  validated against `v1.json`**, and the final query object is compared
  with a hand-written reference (`backend/tests/golden/`). Buffer, join and
  aggregation each once. A user sees only released layers in B11.
- Docs: CONTEXT.md (Ergebnis-Layer, abgeleiteter Layer, Bedingung,
  Einschränkung), README (`GEOTANDEM_BASEMAP`, presets, attribution, what an
  online background sends to whom), tech-stack 9
  (Zustand and Geoman decided), etappen (schema v1 noted in E1.2).

## 4 Order

```
WP20 ── WP21 ─┬─ WP22 ─┐
              └─ WP23 ─┴─ WP24 ── WP25
```

WP20 must land first: the frontend validates against `v1.json`. WP22 and
WP23 share only the store from WP21 and can run in parallel.

## 5 Reported gaps (not built)

- Filtering on aggregated values (S2).
- Conditions that reference a derived layer (D7).
- Dissolving overlapping buffers, the predicate "berührt", the range
  histogram (D9).
- Map search, measuring, own location (D8).
- Catalog-wide default style, tab "Darstellung" in D3 (D6).
- Offline background map from a local tile file (D2, possible later preset).
- Distance and "liegt in" columns in the attribute table (`@distanz:…` in
  the session example) belong to E1.6.
