# Plan E1.3 / E1.4 — Import, Layer-Verwaltung, Anmeldung, Rollen

> Stand: 2026-10-03 · **umgesetzt (WP11–WP19)** · Bezug: [etappen.md 3](../etappen.md),
> [anforderungen.md 2, 3](../anforderungen.md), [design/e1/README.md](../design/e1/README.md)
>
> Continues the work packages WP1–WP10 (E1.1/E1.2). Each WP is one commit,
> regenerates derived artefacts with `make gen` and leaves `make gate` green
> (until WP11 introduces it: `make lint test`, image build and Playwright
> against the container, done by hand).

## 0 Starting point (checked 2026-10-03)

- `make lint test` green: ruff, mypy, 79 pytest, Vitest, API drift check.
- E1.2 "fertig wenn" is covered by `backend/tests/golden/` and the Playwright smoke.
- Building blocks E1.3 reuses: `DataBackend.create_layer` (table + R-tree +
  registry in one transaction), `geo.reprojector`, `layer` / `layer_attribute`
  (F-2.8 fields already present), `catalog.LayerInfo`.
- Open from E1.2: tech-stack 9 still lists "Umgang mit SpatiaLite-Lücken
  (F-2.14)" as due at E1.2. The code already reports missing functions at
  start and documents the ASCII-only `lower()` gap; the decision should be
  written down (tech-stack 9 → decided) before E1.3 imports data with umlauts.

## 1 Decisions to confirm before starting

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | What does "Umbenennen" (F-2.7) change? | Only `title`. `name` is the stable identifier and never changes | Query objects, sessions (E1.7) and golden files reference `name`; renaming it would break them and needs a table rename in every backend |
| D2 | What does "Aktualisieren" (F-2.7) mean? | Replace the content from a new file, keep the layer's identity, matching attribute metadata and visibility; set a new `dataset_version`; record the old and new counts in the import log | The design (D3/D4/D5) adds restorable versions, 90-day retention and archiving. That is not in F-2.7 → report it as a gap, don't build it |
| D3 | WFS / database table as import source (design D6) | Leave out | anforderungen 11 excludes OGC services |
| D4 | "Für Modell" flag, synonyms, display name (design D3) | Add `for_model` (layer + attribute). Leave out synonyms and display name | The design review decided on `for_model` for E1 (decision 6). It feeds F-2.9/F-9.3. Synonyms are not in F-2.8 |
| D5 | Ordering: import routes before auth exists | Keep etappen order. All write routes go into one `/api/admin` router from WP11 on; WP17 protects that router with one dependency | No temporary unauthenticated write path survives E1.4 |
| D6 | Visibility of sample and new layers | Sample layers: visible to both roles. New imports: visible to administrators only until released (design D10) | That gives the E1.4 acceptance case naturally: import → user doesn't see it → release → user sees it |
| D7 | First administrator | Setup page A1 while no account exists, plus `geotandem user create --role admin` for headless/container | No password in environment variables |
| D8 | Server state library, component base (tech-stack 9, due at E1.5) | Decide now: TanStack Query; Radix UI primitives | E1.3/E1.4 already need tables, dialogs, menus and a wizard |
| D9 | Date/time columns | Import as `text` (ISO 8601), with a preview warning | `AttributeType` has no date type; extending it changes the query schema (lock point E1.2) |
| D10 | Map preview in the wizard (design D6 step 4) | Defer to E1.5 (Leaflet arrives there). E1.3 shows bbox, counts and a table | F-2.4 asks for columns, types, geometry type, CRS and count, not for a map |

## 2 E1.3 — Import und Layer-Verwaltung

Target: "Alle drei Importwege enden als verwalteter Layer mit Raumindex und
gepflegten Metadaten." The three paths are **vector file**, **table + X/Y
columns** and **table + area key joined to a geometry layer**.

New dependencies: `pyogrio` (raw API, no geopandas), `openpyxl`,
`python-multipart` (pandas was dropped in WP12, see tech-stack 3.4). New settings: `GEOTANDEM_MAX_IMPORT_MB` (default 200) and
a staging dir under `data_dir`.

### WP11 — Admin schema migration 0002 and backend interface

- Alembic `0002`: `layer` gets `for_model`, `updated_at`. `layer_attribute`
  gets `for_model` and `references` (`layer.attribute`, set by the key join,
  F-2.9 "Beziehungen"). New table `import_run`: id, started/finished, actor
  (username as text, no FK), source file name and format, target layer, mode
  (`create`/`replace`), status (`ok`/`warning`/`failed`/`aborted`), counts
  (read/imported/rejected), decisions JSON (CRS, geometry mode, key, renamed
  fields), warnings/errors JSON, steps with duration, and a sample of rejected
  rows capped at 1000.
- `DataBackend`: add `replace_layer(name, NewLayer)` (new table, swap,
  registry update in one transaction, keeps id/visibility/metadata of
  same-named attributes) and invalidate the `layer_table` cache. Both changes
  are part of the P.1 contract, so document them in `interface.py`.
- `NewLayer` gets an optional explicit `geometry_type`, so an empty or mixed
  file doesn't silently become `Geometry`.
- Tests: migration up/down on a fresh and on an E1.2 file, replace keeps
  identity and metadata, and `data_versions` in a query result changes after
  a replace (F-8.9).
- `make gate`, the single gate every WP from here on finishes with:
  `make lint test`, then `docker build`, then a container on a fresh
  throwaway volume and a free port, then a wait for `healthy`, then the
  Playwright suite against it (`E2E_BASE_URL`), then a restart on the same
  volume (healthy again, no reload of the sample data). Container and volume
  are removed even if a step fails (`trap`). Document it in the README
  (Entwicklung).

### WP12 — Readers and preview (F-2.1–F-2.4, F-2.5 detection)

Module `geotandem/importing/`, with no HTTP and no database access:

- `read_source(path) → Source`: GeoJSON, Shapefile (zip with .shp/.shx/.dbf,
  .prj/.cpg optional), GeoPackage (one sublayer is chosen if there are several)
  through `pyogrio.raw`. CSV (encoding UTF-8 → cp1252 fallback, delimiter
  sniffing, override possible) through `csv`, XLSX (sheet choice) through
  openpyxl; column types are inferred by our own code.
- `Preview`: columns with detected type, sample values, null count, distinct
  count; geometry type; detected CRS (or `None`); record count; bbox.
- Proposals: X/Y columns by name and value range; CRS from range (WGS84
  vs. internal CRS); key columns that match an existing layer's attribute,
  with match rate (design B5/D11 "36 / 38").
- Name sanitising for layer and attributes: `[a-z0-9_]`, ≤ 63, not starting
  with a digit, deduplicated, `fid`/`geom` reserved. The original name becomes
  the default `label`. Column names reach SQL only after this step.
- Value-domain proposal (F-2.8): numeric min/max; code list for text with
  ≤ 20 distinct values.
- Fixtures: small files per format under `backend/tests/fixtures/import/`,
  generated from the Tandemtal data and including broken cases (no .prj,
  wrong delimiter, unmatched keys, values outside the WGS84 range).

### WP13 — Import execution and log (F-2.5, F-2.6, F-2.10)

- `run_import(source, decisions, backend, actor) → ImportRun`: reprojects to
  the internal CRS (pyproj, application code as in `geo.py`), builds rows
  for the three paths and calls `create_layer`/`replace_layer`.
  Key join: copies the geometry of the target layer (a materialised vector
  layer) and sets `references`. Rows without a match or a geometry are
  rejected and logged, not dropped silently.
- Blocking errors (no CRS and none chosen, file unreadable, 0 importable rows)
  vs. warnings (rejected rows, duplicate keys, invalid geometries repaired
  with `make_valid`). Warnings don't block (design D6).
- Every attempt, including failed and aborted ones, writes an `import_run`
  row in its own transaction (design D11).
- Sample load writes an `import_run` too (`source = sample:tandemtal`).
- Tests: one end-to-end test per path against the fixtures. It checks that
  the R-tree exists, that the round trip WGS84 → internal → WGS84 stays
  within 1 cm, and that a query object over the new layer runs. Plus failure
  cases with a log entry.

### WP14 — HTTP: import and layer management

All routes go under `/api/admin` (D5):

| Route | Purpose |
|---|---|
| `POST /imports` (multipart) | Upload to staging, returns `import_id` + `Preview` |
| `POST /imports/{id}/preview` | Read again with changed options (encoding, delimiter, sheet, sublayer) |
| `POST /imports/{id}/commit` | Decisions (geometry mode, CRS, key, field metadata, target layer for replace) → `ImportRun` |
| `DELETE /imports/{id}` | Abort, log as `aborted`, delete staging |
| `GET /imports-log`, `GET /imports-log/{id}` | F-2.10 (design D7/D8) |
| `PATCH /layers/{name}` | title, description, `for_model` |
| `PATCH /layers/{name}/attributes/{attr}` | label, description, unit, value_domain, `for_model` |
| `DELETE /layers/{name}` | delete (no archive, D2) |
| `GET /layers/{name}/profile` | Layer-Steckbrief (F-2.9), a pure function of the metadata. E2.2 adds the model context |

- Staging under `data_dir/staging/<uuid>/`, cleaned at start after 24 h.
  Size limit enforced server-side → 413.
- API tests with httpx for every route, `make gen` for openapi/schema.d.ts.

### WP15 — Frontend: admin frame, catalog, import wizard, log

- Design tokens (Classical) as a Tailwind theme, Lucide icons; TanStack Query
  and Radix (D8).
- D1 admin frame with side navigation (later groups greyed out). D2 catalog
  with metadata completeness indicator. D3 detail with the tabs Beschreibung,
  Felder and Vorschau (profile + table); Darstellung/Verwendung/Verlauf are
  left out (E1.5/E1.7, D2). D5 delete with confirmation.
- D6 wizard in 4 steps, D4 replace summary (counts +/~/−, no version
  retention), D11 error states, D7/D8 log.
- Vitest/RTL for wizard step logic and field editor. Playwright: each of the
  three paths through the wizard, after which the layer appears in the catalog.

**Acceptance E1.3:** `e2e/tests/import.spec.ts` imports `netz.gpkg` (second
layer of the file), `messstellen.csv` (X/Y, EPSG:2056, semicolons, decimal
commas) and `kennzahlen.xlsx` (key `Gem-Nr` → `gemeinden.gem_nr`). Each one
ends in the catalog with metadata, an R-tree and a log entry. The files come
from `backend/tests/import_files.py`, the same generator as the pytest fixtures.

## 3 E1.4 — Anmeldung, Rollen, Sichtbarkeit

Target: "Zwei Konten mit unterschiedlichen Rollen sehen unterschiedliche
Layer". This must hold in the backend, not only in the UI. New dependency:
`argon2-cffi`.

### WP16 — Accounts and sessions (F-3.12)

- Alembic `0003`: `app_user` (username unique, display name, argon2 hash,
  role `admin`/`user`, status `active`/`locked`, `must_change_password`,
  timestamps), `auth_session` (sha256 of the token, user, created/expires/
  last seen), `layer_visibility` (layer_id, role). `import_run.actor` stays
  the username as text (set in WP11), so the log outlives a deleted account.
- Server-side session: random token in an HttpOnly, SameSite=Strict cookie
  (`Secure` configurable); sliding expiry `GEOTANDEM_SESSION_HOURS` (default 12).
- Routes `/api/auth`: `GET setup` (account exists?), `POST setup` (only while
  no account exists → first admin), `POST login`, `POST logout`, `GET me`,
  `POST password` (≥ 10 characters, differs from the old one, clears
  `must_change_password`). Locked accounts and wrong passwords give the same
  401.
- CLI `geotandem user create|reset-password` (D7).
- Tests: hash never leaves the backend, setup closes after the first account,
  session expiry, locked login.

### WP17 — Enforcement in the backend (F-2.7 visibility, F-3.1)

- Dependencies `current_user` (all `/api` except `health`, `auth/*`,
  `schema/query-object`) and `require_admin` (whole `/api/admin` router).
  `must_change_password` allows only `me`, `password` and `logout`.
- One place computes `visible_layers(user)`: admin = all, user = layers with a
  `layer_visibility` row for `user`. It is passed into `list_layers`/
  `get_layer`, `run_query`/`validate_query` (the compiler resolves layers
  only through it) and `ToolContext`. An invisible layer behaves exactly like
  an unknown one (404/`UnknownLayer`), so its existence isn't leaked.
- Defaults (D6): sample layers released for `user`, new imports not.
- Routes `/api/admin/users` (list, create with generated start password +
  `must_change_password`, change role, reset password, lock/unlock, delete;
  the last active admin can't be demoted, locked or deleted) and
  `/api/admin/visibility` (matrix GET/PUT).
- Tests: a parametrised matrix (role × endpoint × visible/invisible layer),
  including a query object that only uses an invisible layer as a *condition*
  (spatial relation/join), not as a source.

### WP18 — Frontend: access and administration

- A1 setup (with "Beispieldatensatz laden" only if it isn't loaded yet), A2
  login, A4 password (dialog and mandatory page), route guards incl. target URL
  after login, header with user menu, "Administration" only for admins.
- D9 users, D10 visibility matrix, visibility field in D3.
- The API client handles 401 → `/anmelden` and 403 → notice.

### WP19 — Acceptance E1.4 and docs

- Playwright: admin creates account `m.keller` (role user) → that user logs
  in, changes the start password, sees the sample layers but not the layer
  imported in E1.3 → admin releases it in D10 → the user sees it. Also checked
  at API level: `POST /api/query` on the unreleased layer as user → 400
  `unknown_layer`, exactly as for a layer that does not exist.
- Adapt the existing smoke tests to log in (fixture for the storage state).
- README (first admin, CLI, new variables), CONTEXT.md (Rolle, Konto,
  Sichtbarkeit, Importvorgang), tech-stack 9 (D8 decided), etappen.md 11.1
  confirmed.

## 4 Order and parallelism

```
WP11 ─┬─ WP12 ── WP13 ── WP14 ── WP15
      └─ WP16 ── WP17 ───────────┴── WP18 ── WP19
```

After WP11 the import strand (WP12–14) and the auth strand (WP16–17) only
touch different modules. They can run in parallel because the contracts
from E1.2 are in place. WP14 and WP17 meet at the `/api/admin` router. WP15
and WP18 share the admin frame, so WP15 comes first.

## 5 Reported gaps (not built)

- Configurable default for new layers, "sofort sichtbar / erst nach Freigabe"
  (design D10): fixed to "erst nach Freigabe" (plan D6), not in F-2.7.
- A user-facing layer list beyond the placeholder on the start page: the
  layer panel arrives with the map (E1.5, design B1/B11).

- Layer versions with restore/retention and archiving (design D3/D4/D5).
- Synonyms and display names for layers and attributes (design D3).
- CSV export of the import log, duplicating layers (design D7, D2).
- Retention periods for logs and rejected rows (design open point 7).
- Date type in `AttributeType` (D9).

## 6 Found on the way

- **SQLite transactions (WP11, WP19).** pysqlite issued no BEGIN before DDL,
  so layer creation and migrations were not atomic; SQLAlchemy now begins
  transactions itself. Doing so with deferred transactions then made
  concurrent requests fail with "database is locked" (two read-then-write
  transactions deadlock on the lock upgrade). Transactions now begin
  IMMEDIATE, analysis queries DEFERRED, the file runs in WAL mode, writers
  wait up to 30 s. `backend/tests/test_concurrency.py` reproduces the failure.
- **pandas dropped (WP12).** Own type inference keeps area keys with leading
  zeros as text and reads decimal commas (tech-stack 3.4).
- **Fonts bundled (WP15).** The design system loads Google Fonts, which
  breaks F-9.1; `@fontsource` packages ship them with the build.
- **Key proposals (WP15, WP19).** Only unique attributes count, and layers
  made by a key join are no key targets, so a re-import of the same table is
  keyed to the original layer, not to its previous import.
- **Gate runs Playwright twice (WP19).** The second pass runs after the
  restart, on the data of the first: two of the problems above only showed
  against an instance that already had data.
