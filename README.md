# GeoTandem

Demonstrator für GIS-Analyse mit und ohne LLM-Unterstützung. Was gebaut wird,
steht in [anforderungen.md](anforderungen.md), warum in [vision.md](vision.md),
in welcher Reihenfolge in [etappen.md](etappen.md), womit in
[tech-stack.md](tech-stack.md). Die Begriffe stehen in [CONTEXT.md](CONTEXT.md).

Stand: Etappe E1.1 (Gerüst) und E1.2 (Sperrpunkt: Abfrageobjekt-Schema v0,
Ausführungsmaschine, Werkzeug-Registry, HTTP-Schnittstelle).

## Starten (ein Befehl, kein Datenbankdienst)

```sh
docker build -t geotandem .
docker run -p 8000:8000 -v geotandem-data:/data geotandem
```

Beim ersten Start entsteht `/data/geotandem.sqlite`, das Schema wird migriert
und der Beispieldatensatz „Tandemtal" geladen. Danach: <http://localhost:8000>.

Eine Abfrage von Hand:

```sh
curl -X POST localhost:8000/api/query -H 'content-type: application/json' \
  -d @backend/tests/golden/schools_per_municipality.query.json
```

## Entwicklung

Voraussetzungen: [uv](https://docs.astral.sh/uv/), Node 24, die
SpatiaLite-Erweiterung (`apt install libsqlite3-mod-spatialite`).

```sh
make install   # Python 3.14 und Node-Abhängigkeiten
make dev       # Backend auf :8000 mit ./data, lädt Beispieldaten
cd frontend && npm run dev   # Frontend auf :5173, leitet /api an :8000 weiter
make lint test # ruff, mypy, pytest, ESLint, Vitest, Drift-Prüfungen
make e2e       # Playwright gegen eine laufende Instanz (E2E_BASE_URL)
```

Abgeleitete Artefakte werden nie von Hand bearbeitet, sondern mit `make gen`
aus ihrer einzigen Quelle erzeugt; Tests schlagen fehl, wenn sie abweichen:

| Artefakt | Quelle |
|---|---|
| `schema/query-object/v0.json` | `packages/query` (Pydantic-Modelle) |
| `frontend/openapi.json`, `frontend/src/api/schema.d.ts` | FastAPI-Routen |
| `backend/src/geotandem/sample/data/` | `backend/src/geotandem/sample/generate.py` |

Ergebnisse der Referenzabfragen liegen in `backend/tests/golden/`; nach einer
bewussten Änderung mit `GEOTANDEM_UPDATE_GOLDEN=1 uv run pytest -k golden`
neu schreiben.

## Konfiguration

Umgebungsvariablen mit Präfix `GEOTANDEM_`, optional ergänzt durch eine
TOML-Datei, deren Pfad `GEOTANDEM_CONFIG_FILE` nennt (Umgebung geht vor Datei).

| Variable | Standard | Bedeutung |
|---|---|---|
| `GEOTANDEM_DATA_DIR` | `./data` (Container: `/data`) | Ablage der SpatiaLite-Datei |
| `GEOTANDEM_DATABASE_URL` | SpatiaLite-Datei in `DATA_DIR` | Backend-Wahl (F-2.13); PostGIS folgt in P.1 |
| `GEOTANDEM_INTERNAL_CRS` | `2056` | Internes metrisches CRS (EPSG), beim ersten Start festgeschrieben |
| `GEOTANDEM_MAX_FEATURES` | `10000` | Höchstzahl Objekte je Ergebnis (F-9.6) |
| `GEOTANDEM_QUERY_TIMEOUT_S` | `10` | Höchstlaufzeit je Abfrage in Sekunden (F-9.6) |
| `GEOTANDEM_LOAD_SAMPLE_DATA` | `false` (Container: `true`) | Beispieldatensatz beim Start laden |
| `GEOTANDEM_SPATIALITE_LIBRARY` | `mod_spatialite` | Name oder Pfad der SpatiaLite-Erweiterung |

## Sicherung (F-9.8)

Bei SpatiaLite genügt das Kopieren der Datei bei gestoppter Anwendung:

```sh
docker run --rm -v geotandem-data:/data -v "$PWD":/backup debian \
  cp /data/geotandem.sqlite /backup/geotandem-$(date +%F).sqlite
```

Wiederherstellen: Datei zurück nach `/data/geotandem.sqlite` kopieren.

## Aufbau

```
packages/query/   Abfrageobjekt-Schema (hängt nur von Pydantic ab)
backend/          Anwendung: config, db (Migrationen), data (Zugriffsschicht,
                  Dialekt-Adapter), engine (Ausführungsmaschine), tools
                  (Registry), api (HTTP), sample (Beispieldatensatz)
frontend/         Vite + React + TypeScript
e2e/              Playwright
schema/           Versionierte Schema-Artefakte
```
