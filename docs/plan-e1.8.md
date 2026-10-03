# Plan E1.8 — Gleiche Ergebnisse auf jedem Backend, offene Lücken

> Stand: 2026-10-03 · **umgesetzt (WP39–WP45)** · Bezug:
> [anforderungen.md](../anforderungen.md) (F-2.14, F-10.7), [tech-stack.md 9](../tech-stack.md),
> the "Reported gaps" of [plan-e1.3-e1.4.md](plan-e1.3-e1.4.md), [plan-e1.5.md](plan-e1.5.md),
> [plan-e1.6.md](plan-e1.6.md), [plan-e1.7.md](plan-e1.7.md), [plan-e1.7b.md](plan-e1.7b.md)
>
> Continues with WP39. Each WP is one commit and leaves `make gate` green.

## 1 F-2.14: same results on every backend (decided 2026-10-03)

**Policy P1, identical by adaptation.** Every operation of the query object
gives the same result on every backend. Where a backend's own function
behaves differently, its dialect adapter makes it behave the same; a
difference is a bug (F-10.7), not a backend property. Backends that lack a
function entirely are still reported at start (built in E1.2).

Rejected: P2 (offer only what every backend does alike) would have cut
case-insensitive search, text ranges and text sorting; P3 (declared
differences) contradicts F-2.14 "im selben Umfang" and F-10.7.

**Text, T1: own functions in SQLite.** Found differences and their fix:

| Difference | SpatiaLite today | Fix (WP39) | PostGIS later (P) |
|---|---|---|---|
| Case-insensitive search | `lower()` folds ASCII only: "Änggisteibach" not found by "änggi" | A function registered on every connection, Python `str.lower` (keeps "ß", like PostgreSQL) | `lower()` on a UTF-8 database |
| Text order (`order_by`) and ranges (`<`, `>`, `between` on text) | bytes: "Ägerten" after "Zollikofen" | A collation registered on every connection: base letters first (accents and case ignored), then accents, then case, then the bytes as tie-break | ICU collation, rules to match |
| Buffer shape | SpatiaLite's default, 30 segments per quarter circle (121 vertices; PostGIS defaults to 8, 33 vertices) — measured | 30 passed explicitly in every buffer, so today's results stay | `quad_segs=30` |
| Join keys of different type | SQLite compares '101' and 101 loosely | Rejected when the key types differ | Same rejection |

Not changed: search stays sensitive to accents ("Munsingen" does not find
"Münsingen"). If that is wanted later, it is option T2 (search keys stored at
import), a separate decision.

The fixed behaviour is pinned by a **backend-neutral test corpus** (names
with Ä Ö Ü, é, ß, mixed case, equal base letters): the expected results are
written down once, and the PostGIS backend must pass the same corpus (F-10.7).

### WP39 — Text and buffers alike on every backend (F-2.14, F-10.7)

- SpatiaLite adapter: register `gt_lower` and the collation `gt_text` on
  every connection; `text_match` uses `gt_lower`; the compiler sorts and
  compares text through a dialect hook that applies the collation.
- Buffer with an explicit segment count; join rejects key types that differ.
- Tests: the corpus above against the engine; existing golden results
  unchanged except where text order was wrong.
- Docs: tech-stack 9 (decided), tech-stack 3 (adapter adds functions),
  CONTEXT (Funktionsgleichheit).

## 2 The remaining gaps (decided 2026-10-03)

All of them come from the design, not from the requirements, except export
(F-8.6, planned for E5). "Kein stiller Umfangszuwachs": each was decided.

**Built in E1.8:**

| Gap | Source | Work package |
|---|---|---|
| Date type for attributes | E1.3/E1.4 D9 | WP40 |
| Default visibility of new layers, "sofort / nach Freigabe" | design D10 | WP41 |
| Duplicate a layer | design D2 | WP41 |
| Tabs for table layers in the attribute table | design B8, B11 | WP42 |
| Reorder columns by dragging | design B8 | WP42 |
| Map search | design B10 | WP43 |
| Measuring distance and area | design B10 | WP44 |

**Later, to be considered then:**

| Gap | When |
|---|---|
| Export GeoJSON/CSV (F-8.6) | E5 |
| Synonyms and display names (design D3) | E2.2 (help the model, F-2.9) |
| "Verwendung" tab on the layer page | E3 (test cases) |
| Offline background map from a local tile file | P (F-9.1) |
| Retention periods for logs and rejected rows | P |
| CSV export of the import log (design D7) | not planned |
| Own location on the map (design B10) | not planned |
| Layer versions with restore and archiving, "Layer wiederherstellen", "Unterschied in Tabelle zeigen", filtering on aggregated values, conditions on derived layers, catalog-wide default style, merging buffers, "berührt", range histogram, saved queries on derived layers | not planned; each needs its own reason |

**Kept left out:** "Auswahl als Filter" (ids do not survive a re-import,
F-8.9), affected sessions in the admin's dialogs (sessions are private).

## 3 Decisions for the new pieces

| # | Question | Decision | Why |
|---|---|---|---|
| G1 | What map search searches | **The features of the layers this account sees**, by their name attribute (the one the popup and the table use), through the engine as a query object with a text condition and a limit — local, nothing leaves the installation | F-9.1; and it stays the one path to the data (E1.5). An external place-name service would send what users type outside |
| G2 | Measuring | **In the browser**, on the map only: distance along a drawn line, area of a drawn polygon, geodesic (on the ellipsoid), shown in m/km and m²/ha/km². Not saved, not part of the analysis | A view tool like zoom; no data involved, so no query object and no backend difference (F-2.14) |
| G3 | Dates in the query object | Stored as ISO text `YYYY-MM-DD` on every backend (a `date` column on PostGIS later); conditions use the existing comparison with an ISO value. "zwischen" becomes "≥ and ≤" in the editor, so **no schema change** | ISO order is date order; one representation for both backends (F-2.14) |
| G4 | Date and time values | Only dates now; a time of day is kept as text as today | Time zones would need their own decision |
| G5 | Table-layer tabs | The layer picker (B11) adds table layers too; they are listed in the panel, never drawn, and appear as a tab in the attribute table | Design B11: "Tabellen ohne Geometrie nur als Tabellenreiter / Join-Quelle" |

## 4 Work packages

### WP40 — Date type (G3, G4)

- Importer: columns whose values are all dates (or ISO date strings) become
  `date`; stored as ISO text. Existing imports keep their types.
- Engine: comparisons and `in` on a date column accept ISO dates only
  (`invalid_query` otherwise); sorting by date is by its ISO text.
- Frontend: date operators "am / nicht am / vor / bis / nach / ab / zwischen
  / ist leer", a date input, display as `dd.mm.yyyy`; the table sorts dates
  as dates.
- Tests: import with dates (CSV, Excel, GeoPackage), engine conditions,
  editor.

### WP41 — Catalog: default visibility, duplicate (D10, D2)

- Setting "Neue Layer: sofort sichtbar / erst nach Freigabe" on the
  visibility page (instance-wide, default unchanged: after release).
- "Duplizieren" in the catalog: copy of geometry, rows, metadata and
  visibility under a new name; logged like an import.
- Tests: API and admin UI.

### WP42 — Attribute table: table layers, drag columns (B8, B11)

- Table layers in the picker and the panel (without map controls); a tab
  in the attribute table; never drawn.
- Columns reordered by dragging in the column menu, with the arrows kept for
  keyboards.
- Tests: component tests.

### WP43 — Map search (G1)

- ⌕ in the map toolbar: a search field over the name attribute of every
  visible layer; results grouped by layer, at most 10 per layer; choosing
  one zooms to it and selects it (as in the table, B9).
- Through `/api/query` with `text_match` (case-insensitive, WP39) and
  `limit`; no new endpoint.
- Tests: component, end-to-end with an umlaut name.

### WP44 — Measuring (G2)

- ⟷ in the map toolbar: draw a line or a polygon (Leaflet-Geoman, already
  used), live distance or area, geodesic; Escape or the tool ends it;
  nothing is saved.
- Tests: the measuring formulas against known values; component.

### WP45 — Acceptance and docs

- End-to-end: search finds "Änggisteibach" by "änggi" and zooms to it; a
  measured distance between two known points; a table layer in the table;
  a date condition on an imported table.
- Docs: CONTEXT, README, design gaps marked.

## 5 Order

```
WP39 ── WP40 ── WP41 ── WP42 ── WP43 ── WP44 ── WP45
```

WP39 first (decided); WP43 builds on its case-insensitive search.

## 6 Found on the way

- **SpatiaLite's buffer default, measured (WP39).** 30 segments per quarter
  circle (121 vertices); PostGIS defaults to 8 (33). Kept at 30 and passed
  explicitly, so no result changed.
- **SQLite joined text "101" with the number 101 (WP39).** Measured; the
  engine now refuses keys of different kinds, and the Join dialog only
  offers matching ones.
- **"ß" and "ss" in the sort order (WP39).** The first draft sorted "Straße"
  before "Strasse" because the case level compared strings of different
  length; the case flags now follow the folded text, so the exact
  characters decide, as with ICU.
- **Excel dates were datetimes at midnight (WP40).** They are dates now; an
  existing test expected text and was updated. Rejected rows with dates
  could not be logged (JSON); the log stores its entries in JSON form.
- **A table among the first chosen layers became the result layer
  (WP42).** Table layers now carry a flag and are never the result.
- **Measuring needs the ellipsoid (WP44).** Leaflet's distance is spherical
  (about 0.3 % off at 47° N); GeographicLib is Karney's reference and
  matches PROJ to a fraction of a millimetre. The end-to-end test compares
  a measured line with the scale bar — once the first view has settled.
- **Enter before the search results (WP43).** Enter takes the first hit
  once there is one; pressing it earlier does nothing.
