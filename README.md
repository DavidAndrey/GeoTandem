# GeoTandem

Demonstrator für GIS-Analyse mit und ohne LLM-Unterstützung. Was gebaut wird,
steht in [anforderungen.md](anforderungen.md), warum in [vision.md](vision.md),
in welcher Reihenfolge in [etappen.md](etappen.md), womit in
[tech-stack.md](tech-stack.md). Die Begriffe stehen in [CONTEXT.md](CONTEXT.md).

Stand: **Etappe E1 abgeschlossen** (Modus A, ohne LLM), E2 noch nicht begonnen.
Die Anwendung kann:

- Vektordaten und Tabellen importieren, Layer verwalten, Metadaten pflegen
  (E1.3); Anmeldung, Rollen Administrator/Anwender, Sichtbarkeit je Layer (E1.4)
- Karte und Klassik-Bedienung: Attribut- und Raumfilter, räumliche
  Verknüpfung, Puffer, Join, Aggregation, Symbolisierung (E1.5); jede
  Bedienhandlung ist ein Abfrageobjekt nach Schema v2
- Attributtabelle mit Sortierung, Spaltenwahl und Hervorhebung zur Karte (E1.6)
- Sitzungen speichern und mit Ergebnis-Prüfung wieder öffnen (E1.7);
  Abfragen speichern und mit allen teilen (E1.7b)
- gleiche Ergebnisse auf jedem Backend, Datumsattribute, Layer duplizieren,
  Kartensuche, Distanz- und Flächenmessung (E1.8)

Pläne und Befunde je Etappe liegen in [docs/](docs/) (`plan-e1.*.md`); wie
Bedingungen, Einschränkung und Abfrageobjekt zusammenhängen, steht in
[docs/filters.md](docs/filters.md), der Ablauf aus Sicht der Nutzer in
[docs/user-journey.md](docs/user-journey.md).

## Starten (ein Befehl, kein Datenbankdienst)

```sh
docker build -t geotandem .
docker run -p 8000:8000 -v geotandem-data:/data geotandem
```

Beim ersten Start entsteht `/data/geotandem.sqlite`, das Schema wird migriert
und der Beispieldatensatz «Bern-Mittelland» geladen. Danach: <http://localhost:8000>.
Ein Neustart auf demselben Volume behält die Daten und lädt den Beispieldatensatz
nicht noch einmal. `make docker` und `make docker-run` tun dasselbe (der Container dort mit `--rm`).

Das Image enthält Backend und gebautes Frontend in einem Prozess auf Port 8000.
Es läuft als Benutzer `geotandem` (UID 10001), der nur `/data` beschreiben
darf, und meldet seinen Zustand über `/api/health` (`docker ps` zeigt
`healthy`). Die Hintergrundkarte ist standardmässig aus; mit
`-e GEOTANDEM_BASEMAP=swisstopo-grau` lädt der Browser Kacheln von swisstopo
(siehe [Konfiguration](#konfiguration)).

### Mit Docker Compose

[compose.yaml](compose.yaml) beschreibt denselben einzelnen Container, mit
Neustart nach einem Absturz oder Reboot (`restart: unless-stopped`) und den
Einstellungen an einem Ort:

```sh
docker compose up -d --build   # bauen und im Hintergrund starten
docker compose logs -f         # Protokoll
docker compose down            # stoppen; die Daten bleiben im Volume
```

Port und Einstellungen kommen aus der Umgebung oder aus einer Datei `.env`
neben `compose.yaml`, zum Beispiel:

```sh
GEOTANDEM_PORT=8080
GEOTANDEM_BASEMAP=swisstopo-grau
```

`GEOTANDEM_PORT` (Standard `8000`) ist der Port auf dem Host; die übrigen
Variablen stehen unter [Konfiguration](#konfiguration). Das Volume heisst wie
oben `geotandem-data`: `docker run` und Compose arbeiten also auf denselben
Daten, und die [Sicherung](#sicherung-f-98) gilt unverändert. Nicht beide
gleichzeitig starten. Befehle im Container: `docker compose exec geotandem
geotandem user create …`.

**Erstes Konto.** Solange kein Konto existiert, führt die Anwendung auf die
Ersteinrichtung: Das erste Konto wird Administrator und legt weitere an
(Rollen Administrator und Anwender, F-3.12). Bis dahin ist die Einrichtung für
jeden offen, der die Adresse erreicht — die Instanz also erst nach aussen
öffnen, wenn das erste Konto steht. Ohne Browser geht es auch so:

```sh
docker exec -it <container> geotandem user create admin --role admin   # fragt nach dem Passwort
docker exec <container> geotandem user create m.keller --start-password  # Anwender, Startpasswort
docker exec <container> geotandem user reset-password m.keller          # neues Startpasswort
```

Konten mit Startpasswort müssen es bei der ersten Anmeldung ändern. Anwender
sehen nur freigegebene Layer: der Beispieldatensatz ist freigegeben, neu
importierte Layer erst nach Freigabe unter *Administration › Sichtbarkeit*.

Eine Abfrage von Hand (die Schnittstelle verlangt eine Anmeldung, ein Konto
mit Startpasswort muss es zuerst über `POST /api/auth/password` ändern):

```sh
curl -c jar -X POST localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"username": "admin", "password": "…"}'
curl -b jar -X POST localhost:8000/api/query -H 'content-type: application/json' \
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
make e2e       # Playwright gegen eine laufende Instanz (E2E_BASE_URL;
               # auf einer schon eingerichteten Instanz E2E_ADMIN_USER/_PASSWORD)
make gate      # alles zusammen, so wie es ausgeliefert wird (siehe unten)
make instance  # eigene Testinstanz aus HEAD auf 127.0.0.1:8060, Daten bleiben
               # (INSTANCE_REF, INSTANCE_PORT; instance-logs, -stop, -reset)
make doc-screenshots  # Bilder für docs/filters.md neu, prüft die Trefferzahlen
```

`make instance` baut aus einem Commit (`git archive`), nicht aus dem
Arbeitsverzeichnis, unter eigenem Image-Tag, Container und Volume.

### Beispieldatensatz

Echte offene Daten des Kantons Bern für den Verwaltungskreis Bern-Mittelland
(74 Gemeinden): Gemeinden, Gewässer, Strassen, Volksschulen, ÖV-Haltestellen
und eine Tabelle Gemeindedaten (Einwohner, Steueranlage). Quelle: Amt für
Geoinformation des Kantons Bern (AGI), über opendata.swiss, Nutzungsbedingung
«terms_open». Die aufbereiteten Dateien liegen im Repository
(`backend/src/geotandem/sample/data`) und im Image; eine Instanz braucht dafür
kein Netz.

Aktualisiert wird nur auf Anfrage:

```sh
make sample-update   # lädt die Quellen (~100 MB) und baut die Dateien neu
uv run geotandem sample update --offline   # baut neu aus dem Download-Cache
```

Die Quellen landen in `~/.cache/geotandem/sample-sources`, nicht im
Repository. Die Fassung ist das Downloaddatum (`bern-mittelland-JJJJ-MM-TT`),
`metadata.json` hält jede Quelle mit SHA-256 fest. Eine neue Fassung ändert
Testergebnisse: danach `GEOTANDEM_UPDATE_GOLDEN=1 uv run pytest -k golden` und
die festen Zahlen in Tests und Playwright prüfen.

`make gate` ist die Abnahme jedes Arbeitspakets: `lint` und `test`, dann das
Container-Image, dessen erster Start auf einem leeren Datenträger, Playwright
gegen diesen Container, ein Neustart auf demselben Datenträger (Daten bleiben,
kein zweites Laden des Beispieldatensatzes) und Playwright ein zweites Mal auf
den Daten des ersten Durchlaufs. Container und Datenträger
sind Wegwerfobjekte und werden auch bei einem Fehler entfernt. Braucht Docker.

Abgeleitete Artefakte werden nie von Hand bearbeitet, sondern mit `make gen`
aus ihrer einzigen Quelle erzeugt; Tests schlagen fehl, wenn sie abweichen:

| Artefakt | Quelle |
|---|---|
| `schema/query-object/v0.json` bis `v2.json` | `packages/query` (Pydantic-Modelle) |
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
| `GEOTANDEM_MAX_FEATURES` | `10000` | Höchstzahl Objekte je Ergebnis (F-9.6). Grössere Layer lädt die Karte nur im aktuellen Ausschnitt; die Attributtabelle zeigt dann ebenfalls nur diesen und sagt es |
| `GEOTANDEM_QUERY_TIMEOUT_S` | `10` | Höchstlaufzeit je Abfrage in Sekunden (F-9.6) |
| `GEOTANDEM_MAX_IMPORT_MB` | `200` | Grösste angenommene Importdatei; Uploads warten in `DATA_DIR/staging` höchstens 24 h auf ihre Übernahme |
| `GEOTANDEM_BASEMAP` | `none` (`make dev`: `swisstopo-grau`) | Hintergrundkarte: `none`, `swisstopo-grau`, `osm` oder eigene Kachel-URL mit `{z}/{x}/{y}`. Alles ausser `none` lässt den Browser Kacheln von aussen laden — der Anbieter sieht dann, welcher Kartenausschnitt betrachtet wird (F-9.1) |
| `GEOTANDEM_BASEMAP_ATTRIBUTION` | leer | Quellenangabe zu einer eigenen Kachel-URL |
| `GEOTANDEM_SESSION_HOURS` | `12` | Gültigkeit einer Anmeldung; verlängert sich bei Nutzung |
| `GEOTANDEM_COOKIE_SECURE` | `false` | Sitzungscookie nur über HTTPS senden; hinter TLS auf `true` setzen |
| `GEOTANDEM_LOAD_SAMPLE_DATA` | `false` (Container: `true`) | Beispieldatensatz beim Start laden |
| `GEOTANDEM_SPATIALITE_LIBRARY` | `mod_spatialite` | Name oder Pfad der SpatiaLite-Erweiterung |
| `GEOTANDEM_FRONTEND_DIR` | leer (Container: `/app/frontend/dist`) | Gebautes Frontend, unter `/` ausgeliefert; in der Entwicklung liefert Vite es aus |

## Sicherung (F-9.8)

Bei SpatiaLite genügt das Kopieren der Datei bei gestoppter Anwendung. Im
laufenden Betrieb liegen neben ihr `geotandem.sqlite-wal` und `-shm`
(WAL-Modus); beim Beenden werden sie zurückgeschrieben und entfernt, die Datei
allein ist dann vollständig:

```sh
docker run --rm -v geotandem-data:/data -v "$PWD":/backup debian \
  cp /data/geotandem.sqlite /backup/geotandem-$(date +%F).sqlite
```

Wiederherstellen: Datei zurück nach `/data/geotandem.sqlite` kopieren.

Die Datei enthält alles: Layer, Metadaten, Konten, Protokolle und die
gespeicherten Sitzungen (F-4.10) samt ihrem Ergebnis-Stempel. Nach einer
Wiederherstellung zeigt das Öffnen einer Sitzung an, ob ihr Ergebnis noch
dasselbe ist.

## Aufbau

```
packages/query/   Abfrageobjekt-Schema (hängt nur von Pydantic ab)
backend/          Anwendung: config, db (Migrationen), data (Zugriffsschicht,
                  Dialekt-Adapter, Layer-Ansicht), engine (Ausführungsmaschine),
                  tools (Registry), catalog (Layer-Katalog), importing (Import
                  und Protokoll), gdal (erlaubte Importformate), auth (Konten,
                  Anmeldungen, Sichtbarkeit), sessions und saved_queries
                  (Sitzungen, gespeicherte Abfragen), basemap, api (HTTP),
                  sample (Beispieldatensatz)
frontend/         Vite + React + TypeScript, Leaflet
e2e/              Playwright, auch die Abnahmetests je Etappe
schema/           Versionierte Schema-Artefakte
design/e1/        Gestaltungsreferenz der Oberfläche (B-, C-, D-Kennungen)
docs/             Pläne je Etappe, Filter-Dokumentation, User Journey
scripts/          gate.sh, doc-screenshots.sh
```
