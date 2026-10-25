# GeoTandem

Demonstrator für GIS-Analyse mit und ohne LLM-Unterstützung. Was gebaut wird,
steht in [anforderungen.md](anforderungen.md), warum in [vision.md](vision.md),
in welcher Reihenfolge in [etappen.md](etappen.md), womit in
[tech-stack.md](tech-stack.md). Die Begriffe stehen in [CONTEXT.md](CONTEXT.md).

Stand: **Etappen E1 und E2 abgeschlossen** (Modus A ohne LLM, Modus B mit
LLM); E3, die Bewertung der Modellanbindungen, ist umgesetzt (Gate E3 bestanden, 2026-10-25).
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
- jeder Text der Oberfläche in einem Meldungskatalog, Zahlen und Daten in einer
  zentralen Schweizer Form, Ablehnungen des Backends nach Code formuliert:
  bereit für weitere Sprachen, vorerst Deutsch (E1.9)
- Stufen der Modellunterstützung je Operationsklasse festlegen (E2.0);
  Modellanbindungen lokal und extern verwalten, mit verschlüsseltem
  Zugangsschlüssel und Verbindungstest, Wahl von Anbindung und Stufe im
  Arbeitsplatz (E2.1); der Layer-Steckbrief zeigt, was ein Modell je Konto
  erfährt: nur Metadaten (E2.2)
- eine Frage per Prompt stellen, als Direktabfrage oder Werkzeugkette, unter
  der gewählten Stufe, mit Protokoll jeder Modellaktion und Übergängen
  zwischen Modus A und B (E2.3–E2.6, *Modus B im Einsatz*)
- Modellanbindungen auf eigenen Daten und Fragen messen und vergleichen, mit
  Prüffällen, Bewertungsläufen, Vergleichsmatrix und Promptprofilen je
  Anbindung (E3, *Bewertung im Einsatz*)

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
`healthy`). Die Antwort sagt nur `ok` oder `degraded`; Version, Datenkern und
Fähigkeiten sehen Administratoren unter *Administration › System*
(`/api/admin/system`). Die Hintergrundkarte ist standardmässig aus; mit
`-e GEOTANDEM_BASEMAP=swisstopo-grau` lädt der Browser Kacheln von swisstopo
(siehe [Konfiguration](#konfiguration)).

### Mit Docker Compose

[compose.yaml](compose.yaml) beschreibt denselben einzelnen Container, mit
Neustart nach einem Absturz oder Reboot (`restart: unless-stopped`) und den
Einstellungen an einem Ort:

```sh
docker compose up -d --build   # bauen und im Hintergrund starten
docker compose logs -f         # Protokoll
docker compose down            # stoppen; die Daten bleiben in ./data
```

Port und Einstellungen kommen aus der Umgebung oder aus einer Datei `.env`
neben `compose.yaml`. Vorlage mit allen Variablen und ihren Standardwerten,
auch denen für Traefik: `cp .env.example .env`. Zum Beispiel:

```sh
GEOTANDEM_PORT=8080
GEOTANDEM_BASEMAP=swisstopo-grau
```

`GEOTANDEM_PORT` (Standard `8000`) ist der Port auf dem Host; die übrigen
Variablen stehen unter [Konfiguration](#konfiguration).

Die Daten liegen im Verzeichnis `./data` neben `compose.yaml`, nicht im Volume
`geotandem-data` von `docker run`: Compose und `docker run` arbeiten also auf
verschiedenen Daten. Der Container heisst `geo` und läuft als UID:GID
`1000:1000`, dem Besitzer von `./data`. Das Verzeichnis deshalb vor dem
ersten Start selbst anlegen (`mkdir -p data`); legt Docker es an, gehört es
`root`, und die Anwendung kann nicht hineinschreiben. Hat das eigene Konto eine
andere UID (`id -u`), `user:` in `compose.yaml` anpassen. Befehle im Container:
`docker compose exec geotandem geotandem user create …`.

**Erstes Konto.** Solange kein Konto existiert, führt die Anwendung auf die
Ersteinrichtung: Das erste Konto wird Administrator und legt weitere an
(Rollen Administrator und Anwender, F-3.12). Die Einrichtung verlangt einen
**Einrichtungscode** aus der Installation, damit nicht Administrator wird, wer
die Adresse zuerst erreicht. Ist `GEOTANDEM_SETUP_TOKEN` gesetzt, gilt dieser;
sonst erzeugt jeder Start, solange kein Konto existiert, einen neuen und
schreibt ihn ins Protokoll, samt Link, der ihn ins Formular einträgt:

```sh
docker logs <container> 2>&1 | grep "Setup token"
# … Setup token: Xy3… — open /einrichtung#token=Xy3… on this instance, …
```

Der Code gilt nur bis zur Einrichtung und steht nach `#` im Link, den der
Browser keinem Server schickt. Ohne Browser geht es auch so:

```sh
docker exec -it <container> geotandem user create admin --role admin   # fragt nach dem Passwort
docker exec <container> geotandem user create m.keller --start-password  # Anwender, Startpasswort
docker exec <container> geotandem user reset-password m.keller          # neues Startpasswort
```

**Passwortregeln** (gelten beim Setzen eines Passworts: Ersteinrichtung,
Passwortwechsel, `geotandem user create`): mindestens 12 Zeichen, sonst keine
Vorgaben zu Ziffern oder Sonderzeichen, kein Ablaufdatum. Abgelehnt werden
verbreitete Passwörter, auch abgewandelt (`P@ssw0rd2024!`), Tastaturreihen,
Folgen und Wiederholungen sowie Passwörter mit dem eigenen Benutzer- oder
Anzeigenamen oder «geotandem». Die Listen liegen in
`backend/src/geotandem/auth/data/` (siehe deren README); kein externer Dienst
wird gefragt. Bestehende Passwörter gelten bis zum nächsten Wechsel weiter.

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
make audit     # bekannte Schwachstellen in den ausgelieferten Abhängigkeiten (Netz)
make e2e       # Playwright gegen eine laufende Instanz (E2E_BASE_URL;
               # auf einer schon eingerichteten Instanz E2E_ADMIN_USER/_PASSWORD)
make gate      # alles zusammen, so wie es ausgeliefert wird (siehe unten)
make instance  # eigene Testinstanz aus HEAD auf 127.0.0.1:8060, Daten bleiben
               # (INSTANCE_REF, INSTANCE_PORT; instance-logs, -stop, -reset)
make doc-screenshots  # Bilder für docs/filters.md neu, prüft die Trefferzahlen
```

`make instance` baut aus einem Commit (`git archive`), nicht aus dem
Arbeitsverzeichnis, unter eigenem Image-Tag, Container und Volume.

### Sprachen

Die Oberfläche spricht Deutsch; jeder Text steht im Meldungskatalog
`frontend/src/locales/de.po` (Lingui, siehe
[docs/plan-e1.9.md](docs/plan-e1.9.md)). Im Code bleibt der deutsche Text
stehen (`` t`Sitzung speichern` ``, `<Trans>…</Trans>`); `npm run i18n:extract`
übernimmt neue Meldungen in den Katalog, `make test` prüft, dass er aktuell ist.
Mit `?lang=pseudo` zeigt die Oberfläche jede Meldung als ⟦Ƥśēũďō⟧-Text, so dass
fest eingebaute Texte und zu knappe Layouts auffallen; `?lang=de` schaltet zurück.

Eine weitere Sprache, etwa Französisch: `fr` in `frontend/lingui.config.ts`
ergänzen, `npm run i18n:extract`, `src/locales/fr.po` übersetzen, die Sprache in
`src/i18n/i18n.ts` wählbar machen. Ablehnungen des Backends kommen als Code
(`frontend/error-codes.json`) und werden in `src/i18n/errors.ts` formuliert.

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

`make gate` ist die Abnahme jedes Arbeitspakets: `lint`, `test` und `audit`, dann das
Container-Image (mit den aktuellen Basis-Images), dessen erster Start auf einem leeren Datenträger, Playwright
gegen diesen Container, ein Neustart auf demselben Datenträger (Daten bleiben,
kein zweites Laden des Beispieldatensatzes) und Playwright ein zweites Mal auf
den Daten des ersten Durchlaufs. Der Container läuft dabei in einem internen
Docker-Netz ohne Weg nach aussen: jeder Durchlauf belegt, dass GeoTandem ohne
Internetverbindung arbeitet (F-9.1). Container, Netz und Datenträger
sind Wegwerfobjekte und werden auch bei einem Fehler entfernt. Braucht Docker.

Mit einem lokalen Modell prüft das Gate auch die Modellanbindung (E2.1): ein
Ollama-Container kommt ins selbe Netz, liest die Modelle des Hosts nur lesend
und muss den Verbindungstest bestehen.

```bash
GATE_LLM_MODEL=qwen3:8b make gate
# Modelle anderswo (Verzeichnis oder Volume mit manifests/ und blobs/):
GATE_OLLAMA_MODELS=/pfad/zu/models GATE_LLM_MODEL=qwen3:8b make gate
```

Ohne `GATE_LLM_MODEL` überspringt das Gate diesen Test und sagt es am Ende;
`GATE_REQUIRE_LLM=1` macht daraus einen Fehler.

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
| `GEOTANDEM_MAX_RUNNING_QUERIES` | `8` | Gleichzeitig laufende Abfragen insgesamt; weitere warten bis zur Höchstlaufzeit, dann `503 busy` |
| `GEOTANDEM_MAX_RUNNING_QUERIES_PER_ACCOUNT` | `3` | Dasselbe je Konto, damit ein Konto nicht alle belegt |
| `GEOTANDEM_MAX_MODEL_CALLS` | `4` | Gleichzeitig laufende Modellaufrufe insgesamt (je Konto einer); ein weiterer Prompt erhält sofort `503 busy` |
| `GEOTANDEM_MAX_SESSIONS_PER_ACCOUNT` | `100` | Gespeicherte Sitzungen je Konto |
| `GEOTANDEM_MAX_SAVED_QUERIES_PER_ACCOUNT` | `100` | Gespeicherte Abfragen je Konto |
| `GEOTANDEM_MAX_IMPORT_MB` | `200` | Grösste angenommene Importdatei; Uploads warten in `DATA_DIR/staging` höchstens 24 h auf ihre Übernahme, höchstens 20 zugleich |
| `GEOTANDEM_MAX_IMPORT_UNPACKED_MB` | `1000` | Worauf ein gezipptes Shapefile oder eine Excel-Datei entpackt höchstens wachsen darf; geprüft, bevor sie gelesen wird |
| `GEOTANDEM_IMPORT_MEMORY_MB` | `4096` | Adressraum des eigenen Prozesses, der eine Importdatei liest (die Bibliotheken allein belegen etwa 1,4 GB davon) |
| `GEOTANDEM_IMPORT_TIMEOUT_S` | `300` | Rechenzeit zum Lesen einer Importdatei |
| `GEOTANDEM_BASEMAP` | `none` (`make dev`: `swisstopo-grau`) | Hintergrundkarte: `none`, `swisstopo-grau`, `osm` oder eigene Kachel-URL mit `{z}/{x}/{y}`. Alles ausser `none` lässt den Browser Kacheln von aussen laden — der Anbieter sieht dann, welcher Kartenausschnitt betrachtet wird (F-9.1) |
| `GEOTANDEM_BASEMAP_ATTRIBUTION` | leer | Quellenangabe zu einer eigenen Kachel-URL |
| `GEOTANDEM_SESSION_HOURS` | `12` | Gültigkeit einer Anmeldung; verlängert sich bei Nutzung |
| `GEOTANDEM_SESSION_MAX_DAYS` | `7` | Längste Dauer einer Anmeldung ab dem Anmelden, auch bei laufender Nutzung |
| `GEOTANDEM_COOKIE_SECURE` | `false` | Sitzungscookie nur über HTTPS senden. Kommt eine Anfrage über HTTPS an, gilt das ohnehin, und die Antwort trägt HSTS. Ein solches Cookie heisst `__Host-geotandem_session` und wird nur von diesem Host angenommen |
| `GEOTANDEM_MAX_REQUEST_MB` | `2` | Grösster Anfragekörper; nur der Upload eines angemeldeten Administrators darf bis `MAX_IMPORT_MB` gehen. Die Grenze greift, bevor die Anwendung den Körper liest |
| `GEOTANDEM_API_DOCS` | `false` (`make dev`: `true`) | `/docs`, `/redoc` und `/openapi.json` ausliefern; auf einer öffentlichen Instanz aus lassen |
| `GEOTANDEM_SETUP_TOKEN` | leer | Einrichtungscode für das erste Konto, mindestens 16 Zeichen. Leer: jeder Start ohne Konto erzeugt einen und schreibt ihn ins Protokoll |
| `GEOTANDEM_LOGIN_FAILURES` | `10` | Fehlgeschlagene Anmeldungen je Benutzername und Absenderadresse in 15 Minuten; danach antwortet die Anmeldung `429` mit `Retry-After`, auch auf das richtige Passwort |
| `GEOTANDEM_LOGIN_FAILURES_PER_ADDRESS` | `50` | Dasselbe je Absenderadresse, gleich welcher Benutzername |
| `GEOTANDEM_LOGIN_FAILURES_PER_USERNAME` | `20` | Fehlgeschlagene Anmeldungen je Benutzername von allen Adressen zusammen; danach höchstens eine Passwortprüfung alle 30 Sekunden für diesen Namen, ausser aus einem Browser, der sich schon einmal so angemeldet hat |
| `GEOTANDEM_LOAD_SAMPLE_DATA` | `false` (Container: `true`) | Beispieldatensatz beim Start laden |
| `GEOTANDEM_SPATIALITE_LIBRARY` | `mod_spatialite` | Name oder Pfad der SpatiaLite-Erweiterung |
| `GEOTANDEM_FRONTEND_DIR` | leer (Container: `/app/frontend/dist`) | Gebautes Frontend, unter `/` ausgeliefert; in der Entwicklung liefert Vite es aus |
| `GEOTANDEM_LLM_LOCAL_HOSTS` | leer | Weitere Hostnamen, deren Modellanbindungen als lokal gelten, kommagetrennt, z. B. `gpu-01.intern`. Immer lokal: `127.0.0.1`, `::1`, `localhost`, `host.docker.internal`. Wörtlich verglichen, nie aufgelöst |

## Modellanbindungen (ab E2)

Unter *Administration › Modell › Modellanbindungen* trägt der Administrator
Modelle hinter einer OpenAI-kompatiblen Schnittstelle ein (Ollama, vLLM,
llama.cpp, OpenAI, Anthropics Kompatibilitätsschnittstelle): Adresse mit `/v1`,
Modellname, optional ein API-Schlüssel, Parameter. Ohne Anbindung bleibt die
klassische Bedienung (Modus A) vollständig nutzbar.

- **Lokal oder extern** ergibt sich aus dem Host, nicht aus einem Häkchen:
  `127.0.0.1`, `::1`, `localhost`, `host.docker.internal` und die Namen in
  `GEOTANDEM_LLM_LOCAL_HOSTS` sind lokal, alles andere extern. Eine lokale
  Anbindung lässt sich als extern behandeln, nie umgekehrt. Externe tragen
  überall, wo sie gewählt oder aktiv sind, ein Kennzeichen mit ihrem Host.
- **Datenfreigabe.** Lokale Anbindungen dürfen Dateninhalte erhalten, externe
  standardmässig nur Metadaten; die Freigabe für eine externe verlangt eine
  ausdrückliche Bestätigung. Der Text einer Anfrage geht in jedem Fall an das
  Modell.
- **Freigabe für Anwender.** Eine neue Anbindung ist nicht freigegeben; eine
  nicht freigegebene nutzt niemand, auch kein Administrator. Die erste
  freigegebene wird voreingestellt.
- **Verbindungstest.** Prüft Schritt für Schritt Adresse, Erreichbarkeit,
  Zugang, Modell, Ollama-Version, eine Antwort nach JSON-Schema und einen
  Werkzeugaufruf, mit erfundenen Fragen, ohne Daten. Grün heisst: das Modell
  kann, was Direktabfrage und Werkzeugkette brauchen. Ein Modell ohne
  Werkzeugunterstützung (in Ollama etwa `gemma3:4b`) scheitert am letzten
  Schritt.
- **Stufen.** Unter *Administration › Modell › Stufen* legt der Administrator
  1 bis 4 Stufen fest und je Operationsklasse `aus`, `mit Freigabe` oder
  `automatisch`. Ausgeliefert: *Assistenz* (alles aus), *Prüfen* (alles mit
  Freigabe, voreingestellt), *Automatisch* (nur für Administratoren).
- **Was das Modell sieht** (*Administration › Modell*): der Layer-Steckbrief
  für ein Konto, nur Metadaten. Wertebereiche und Codelisten, die ein Import
  aus den Daten vorschlägt, kommen erst hinein, wenn der Administrator sie im
  Layer bestätigt.

### Externe Modelle

Die beiden externen Referenzmodelle der Auswertung, je als eigene Anbindung
([docs/testplan-external-models.md](docs/testplan-external-models.md)):

| Feld | Luna | Haiku |
|---|---|---|
| Adresse | `https://api.openai.com/v1` | `https://api.anthropic.com/v1` |
| Modell | `gpt-6-luna` | `claude-haiku-5-5` |
| API-Schlüssel | OpenAI-Schlüssel | Anthropic-Schlüssel |
| Temperatur | `0.3` oder `1` | `1` (darunter lehnt Anthropic ab) |
| Effort | `none` | `default` |

Das Formular schlägt eine lokale Ollama-Adresse und Temperatur `0` vor; beides
ist zu ändern. Den Header `anthropic-version` setzt die Anwendung selbst. Im
Verbindungstest sind Erreichbarkeit, Zugang, Modell, JSON-Schema und
Werkzeugaufruf grün.

### Modus B im Einsatz

Der Reiter *Prompt* neben *Klassik* öffnet das Eingabefeld; er ist nur
wählbar, wenn eine Anbindung freigegeben ist. Die Frage geht mit dem
Layer-Steckbrief des Kontos an das Modell (nur Metadaten, nie Zeileninhalte).

- **Zwei Arbeitsweisen.** Die *Direktabfrage* lässt das Modell ein
  Abfrageobjekt schreiben, das die Anwendung prüft, bevor irgendetwas läuft:
  Schema, Layer und Attribute des Kontos, die Grenzen unten, und ob die
  Bedienelemente es ohne Verlust zeigen können (sonst `not_representable`).
  Die *Werkzeugkette* plant mehrere Schritte (Puffer, Zählen je Gruppe …),
  zeigt den Plan vor dem Lauf und führt ihn Schritt für Schritt aus; das
  Modell sieht je Schritt nur ok/Fehler, leer/nicht leer und die Trefferzahl.
- **Stufen in der Praxis.** *Assistenz*: Das Modell schlägt vor, der Anwender
  übernimmt von Hand in den Editor. *Prüfen*: Jede Antwort wartet auf
  *Annehmen* oder *Ablehnen*, mit Änderungsliste und Vorschau der
  Trefferzahl. *Automatisch*: Die Antwort wird sofort angewendet, ein Hinweis
  auf der Karte bietet *Rückgängig*. Gilt eine Klasse als `aus`, bleibt die
  Antwort ein Vorschlag zum Übernehmen von Hand. Die Regel greift auch an der
  Oberfläche vorbei: Ausgeführt wird immer nur die gespeicherte Abfrage.
- **Hin und her.** Eine angewendete Antwort öffnet sich im Editor
  (*Im Editor öffnen*), ihre Bedingungen tragen die Marke «Modell», bis man sie
  von Hand ändert. Die nächste Frage bezieht sich auf die letzte Antwort und
  den aktuellen Stand der Analyse (Marke über dem Feld; × fragt ohne Bezug);
  wurde der Stand von Hand geändert, erfährt das Modell das. «Nur in» und die
  Darstellung bleiben Sache des Anwenders. Der Verlauf lebt nur im offenen
  Arbeitsplatz, nicht in einer gespeicherten Sitzung.
- **Grenzen.** Höchstens 8 Bedingungen je Abfrage, 8 Schritte je Kette
  (Neuplanungen eingerechnet, höchstens 2), 120 s je Modellaufruf, 300 s je
  Kette, die letzten 6 Antworten als Verlauf; dazu die Grenzen von Modus A
  (10 000 Objekte, 10 s je Abfrage). Je Anbindung kann der Administrator eine
  Tagesgrenze für Anfragen setzen.
- **Protokoll.** Jede Anfrage wird mit Prompt, Antwort, Abfrage, Stufe und
  Entscheid protokolliert. Anwender sehen ihre eigenen Einträge (*Meine
  Modellaktionen*), Administratoren alle, mit Kennzahlen zur Annahmequote
  und CSV-Export (*Administration › Modell › Modellprotokoll*). Das Eingabefeld sagt,
  dass Eingaben protokolliert werden.
- **Fehler** (Modell nicht erreichbar, Zeitüberschreitung, unlesbare Antwort,
  Grenzwert) lassen Analyse, Editor und Verlauf unverändert; der Prompt bleibt
  im Feld. Wer das Fenster schliesst, während eine Werkzeugkette läuft, hält
  sie an (das letzte vollständige Zwischenergebnis bleibt im Protokoll
  übernehmbar); eine Direktabfrage, an der das Modell noch denkt, läuft zu
  Ende, und nach einem Neuladen zeigt sie der Arbeitsplatz, sobald die nächste
  Frage gesendet wird.

**Ollama aufsetzen** (als Container mit `docker run` oder Compose, mit
NVIDIA-GPU, oder nativ auf dem Host): [docs/ollama.md](docs/ollama.md).

Die Kontextlänge der Anbindung ist ein Budget für den Steckbrief und wird
nicht gesendet: die `/v1`-Schnittstelle kennt kein Feld dafür. Bei Ollama muss
sie zu `OLLAMA_CONTEXT_LENGTH` passen (in den Beispielen in
[docs/ollama.md](docs/ollama.md) gesetzt),
sonst schneidet Ollama den Kontext still ab.

**API-Schlüssel** liegen verschlüsselt in der Datenbank. Den Schlüssel dazu
erzeugt der erste Start in `DATA_DIR/secret.key` (nur für den Benutzer der
Anwendung lesbar). Fehlt die Datei oder wurde sie ersetzt, startet die
Anwendung trotzdem; gespeicherte API-Schlüssel sind dann unlesbar und müssen
neu eingetragen werden. Über die Schnittstelle verlässt ein API-Schlüssel die
Anwendung nie: sie meldet nur, ob einer gesetzt ist.

**Öffentlich, hinter Traefik:** `compose.traefik.yaml` (Anleitung in der Datei)
setzt TLS, Grössen- und Ratenbegrenzung und sperrt die Ersteinrichtung von
aussen — als zweite Schicht: Die Anwendung begrenzt Anfragegrössen,
Anmeldeversuche und Herkunft schreibender Anfragen (gleicher Ursprung) selbst
und setzt ihre Sicherheits-Header (CSP, HSTS über HTTPS, `nosniff`,
`X-Frame-Options`) auch ohne Proxy.

**Sicherheitsprotokoll.** Anmeldungen (auch fehlgeschlagene, mit Grund:
`unknown_user`, `wrong_password`, `account_locked`), gebremste Anmeldungen,
Passwortwechsel, Konto-, Katalog-, Sichtbarkeits-, Stufen- und Importänderungen,
Änderungen und Tests von Modellanbindungen (nur Feldnamen, nie Schlüssel) samt
handelndem Konto, Start und Abbruch eines Bewertungslaufs (Anbindungen,
bestätigte externe Hosts, Anfragen, Datenstand, Umfang; nie Fragetext), Import
und Löschen von Prüffällen sowie die Abweisungen der Schutzschicht stehen als je eine
JSON-Zeile mit `"event"` auf stderr, also in `docker logs`. Passwörter und
Sitzungstoken stehen nie darin. Auswerten etwa mit
`docker logs <container> 2>&1 | grep '^{' | jq 'select(.event == "sign_in_failed")'`.

**Hinter einem Reverse-Proxy** muss uvicorn dessen Adresse vertrauen
(`FORWARDED_ALLOW_IPS`, ohne Präfix, z. B. `-e FORWARDED_ALLOW_IPS=172.18.0.2`),
sonst scheinen alle Anfragen vom Proxy zu kommen und teilen sich die Grenze
`GEOTANDEM_LOGIN_FAILURES_PER_ADDRESS`. IPv6-Adressen zählen je /64. Einen
Browser, der sich erfolgreich angemeldet hat, erkennt die Anwendung an einem
eigenen Cookie (`geotandem_device`, über HTTPS `__Host-geotandem_device`, 180
Tage, bleibt beim Abmelden) wieder: Wird sein Benutzername von anderswo mit
Versuchen überflutet, meldet er sich trotzdem ohne Wartezeit an. Die Zähler und
der Schlüssel dieses Cookies liegen im Speicher und beginnen nach einem
Neustart von vorn.

Der Proxy darf **keine `Authorization`-Kopfzeile mit Bearer-Token** (oder
einem anderen Schema als Basic) an die Anwendung weiterreichen, etwa aus einer
eigenen Token-Anmeldung davor: Die
Anwendung hält jedes solche Token für einen Programmzugang (E4) und verweigert
damit die Entscheidungen einer Person, nämlich Freigeben, Ablehnen, Übernehmen
(`approve`, `reject`, `decide`), die Vorschau und die Wahl von Anbindung und
Stufe (`403 session_required`). Basic-Authentifizierung des Proxys stört nicht.
Weitere Befunde und Massnahmen: [security-review.md](security-review.md).

### Bewertung im Einsatz

Unter *Administration › Modell › Bewertung* misst der Administrator, welche
Anbindung auf seinen Daten und mit seinen Fragen taugt, statt es zu vermuten
(Konzept in [bewertung.md](bewertung.md), Entscheidungen in
[docs/plan-e3.md](docs/plan-e3.md)). Die Bewertung sehen nur Administratoren.
Sie hat zwei Reiter: *Läufe* und *Prüffälle*.

- **Prüffälle.** Ein Prüffall ist eine Frage, wie ein Anwender sie stellt, mit
  ihrer richtigen Antwort: einer Referenzabfrage, mehreren fairen Lesarten
  oder der erwarteten Antwortart (Rückfrage, nicht beantwortbar). Jeder Fall
  gehört zu einem Teil: *Abstimmung* (daran darf man Prompts verbessern) oder
  *Bestätigung* (nur zum Nachprüfen; Vorgabe für neue Fälle). Der
  *Startbestand* (71 Fälle auf den Beispieldaten, 33 Abstimmung, 38
  Bestätigung, `schema/eval-cases/`) ist nur lesbar; *Als eigenen Fall
  kopieren* legt eine bearbeitbare Kopie an. Eigene Fälle entstehen auf drei
  Wegen:
  - im Arbeitsplatz mit *Als Prüffall speichern* (nur für Administratoren):
    Die angewendete Analyse wird zur Referenz, dazu kommen die Frage in den
    Worten eines Anwenders, Stichwörter und Teil. Die Abfrage muss die
    Prüfungen einer Modellabfrage bestehen, etwa höchstens 8 Bedingungen;
  - im Modellprotokoll mit *Als Prüffall übernehmen*: nur bei einer
    Direktabfrage, die angenommen oder automatisch angewendet und nicht
    zurückgenommen wurde. Von Hand korrigierte Antworten und Folgefragen
    bieten den Knopf nicht an. Der Fall öffnet sich vorbefüllt und entsteht
    erst mit *Speichern*;
  - mit *Importieren* einer Datei im Format des Exports, ganz oder gar nicht:
    Ist ein Fall fehlerhaft, wird keiner übernommen, und der Dialog nennt Fall
    und Grund. Importierte Fälle tragen die Herkunft *Import*; der Verweis auf
    einen Protokolleintrag einer anderen Instanz fällt weg. *Exportieren*
    schreibt die eigenen Fälle in dieselbe Form.

  Ein Fall auf Betriebsdaten nennt seine Layer. Fehlt einer, ist er nicht
  sichtbar oder nicht für das Modell freigegeben, ist der Fall *veraltet*.
  Besteht die Referenz die Prüfungen nicht mehr oder lässt sie sich nicht mehr
  ausführen, ist er *ungültig*. Beide laufen nicht mit, bis sie bearbeitet
  sind. Wurde ein Layer seit der letzten Prüfung der Referenz neu importiert,
  läuft der Fall und trägt *Datenstand geändert*. Das Referenzergebnis wird
  nicht gespeichert; es entsteht in jedem Lauf aus der Referenzabfrage.
- **Ein Lauf** (*Läufe › Neuer Lauf*, eine Seite in vier Schritten):
  1. *Messpunkte*: je eine Anbindung mit Promptprofil (Beispiele, Platzierung,
     Ausgabe; vorbelegt mit dem der Anbindung), Stufe und wahlweise einem
     System-Prompt, der nur für diesen Lauf geändert ist (*System-Prompt
     ändern*; der Betrieb bleibt unberührt, die Beschriftung hält ihn mit
     Hash fest). Ein Messpunkt ist die *Vergleichsbasis*.
  2. *Prüffälle*: Startbestand oder eigene, Teil, Stichwort. Ein Lauf hat
     einen Datenstand. Startbestand und eigene Fälle auf Beispieldaten laufen
     auf einer eigens aufgebauten Kopie der Beispieldaten, gleich, was der
     Katalog gerade enthält. Eigene Fälle auf Betriebsdaten laufen auf den
     Layern, wie der startende Administrator sie sieht. Beides mischt ein Lauf
     nicht.
  3. *Umfang*: *Vollständig* fährt jeden Fall in zwei Blöcken zu fünf
     Wiederholungen (Seeds 1–10). Der *Schnelltest* fährt einen Block (Seeds
     1–5) für einen ersten Blick: Quoten und Urteile, aber keine
     Vergleichsaussage und kein Promptprofil zum Übernehmen. *Als
     vollständigen Lauf wiederholen* öffnet ihn danach vorbefüllt.
  4. *Abschätzung vor dem Start*: Anfragen, Tokens, Dauer und Kosten. Kosten
     erscheinen, wenn an der Anbindung Preise stehen (*Preise*: je Mio. Tokens
     für Ein- und Ausgabe, mit Währung); ohne Preise bleibt es bei Tokens. Die
     Dauer schätzt die Anwendung aus der mittleren Antwortzeit des letzten
     Laufs der Anbindung, sonst aus ihrem Verbindungstest, sonst mit 3 s je
     Anfrage (gemessen: ein lokales gemma4:12b antwortet in 1,1–1,4 s, ein
     externes Modell in 2–3 s); dann steht *geschätzt, noch ohne Messung*
     daneben. Die Anbindungen eines Modell-Hosts zählen nacheinander, die
     Hosts gleichzeitig (*parallel je Modell-Host*), wie der Lauf sie fragt.
     Bei einer externen Anbindung steht da, an welchen Host Steckbrief und
     Fragen gehen, und dass keine Geodaten-Inhalte mitgehen. Ohne den Haken
     *Verstanden, extern senden* bleibt *Lauf starten* gesperrt, und auch der
     Server lehnt den Lauf ab (`external_not_confirmed`). Die Bestätigung gilt
     dem genannten Host: Sendet die Anbindung beim Start an einen anderen
     (inzwischen geändert), lehnt der Server ab, bis die neue Abschätzung
     bestätigt ist.

  Der Lauf läuft im Hintergrund, auch wenn die Seite geschlossen wird; die
  Matrix füllt sich, während er läuft. *Lauf abbrechen* hält vor der nächsten
  Frage an. Auf der ganzen Instanz läuft höchstens ein Lauf zugleich
  (`run_busy`). Messpunkte auf verschiedenen Modell-Hosts laufen
  gleichzeitig, solche auf demselben Host nacheinander. Ein Neustart beendet
  einen laufenden Lauf als *unterbrochen*. Bei einem abgebrochenen oder
  unterbrochenen Lauf bleiben die bisherigen Antworten; Quoten und Vergleich
  gibt es nur für fertige Läufe.
- **Die Matrix lesen.** Die Zeilen sind die Prüffälle, nach erstem Stichwort
  gruppiert und mit Summen je Gruppe; die Spalten sind die Messpunkte. Eine
  Zelle zeigt, wie viele der 10 Antworten (Schnelltest: 5) richtig waren, und
  die übrigen Urteile in Kurzform (f falsch, a abgewiesen, x andere
  Antwortart, w andere Arbeitsweise, u unzulässig, n nicht lesbar).
  *Still falsch* heisst falsch ohne genannte Annahme: Das Modell wirkt sicher
  und liegt daneben. Solche Zellen haben einen gestrichelten Rahmen, ein «!»
  und das Wort. Die Spaltenköpfe erscheinen erst, wenn der Lauf fertig ist:
  die *Quote Abstimmung* (auf den Fällen der Abstimmung; ein Lauf ohne solche
  zeigt die *Quote Bestätigung*), still falsch, nicht
  lesbar, Verhaltensfälle, Zeit (Median und oberes Zehntel), Tokens und
  Kosten. Dazu kommt die Aussage gegenüber der Vergleichsbasis auf den Fällen
  der *Bestätigung*: *besser*, *schlechter* oder *nicht belegt*, mit dem
  Unterschied in Punkten und der 95-%-Spanne, gepaart je Fall gerechnet.
  *Nicht belegt* heisst, die Spanne schliesst 0 ein. Das ist kein Fehler,
  sondern ein fehlender Beleg. Ohne Bestätigungsfälle gibt es keine Aussage.
  Die *Beschriftung des Laufs* hält fest, wogegen gemessen wurde:
  - Version von Abfrageschema und Bewertungsregeln;
  - der Datenstand: Fassung der Beispieldaten oder die Datensatzversion jedes
    Layers;
  - der Stand des Steckbriefs: Hash und die Anteile Beschriftungen ·
    Codelisten · Beschreibungen, aufklappbar als *Vollständigkeit im
    Einzelnen*;
  - je Messpunkt Modell, Host, Temperatur, Denkaufwand, Promptprofil, Stufe
    und System-Prompt;
  - Seeds, Fälle, wessen Sicht, wann und durch wen.

  Zwei fertige Läufe über dieselben Fälle lassen sich nebeneinander stellen:
  in der Liste zwei markieren und *Gegenüberstellen*, oder aus der Matrix
  *Lauf gegen anderen stellen*. Eine Vergleichsaussage gibt es dabei nur,
  wenn beide Läufe vollständig sind (kein Schnelltest). Die Messpunkte werden
  dabei nach der ganzen Momentaufnahme zugeordnet: Anbindung mit Modell,
  Host, Temperatur und Denkaufwand, Promptprofil, Stufe und System-Prompt;
  eine dazwischen geänderte Anbindung ist ein anderer Messpunkt. Haben die
  beiden Läufe einen anderen Steckbrief oder Datenstand, sagt es der Kopf der
  Gegenüberstellung (*Steckbrief anders*, *Datenstand anders*). *Exportieren*
  liefert den Lauf mit allen Antworten als JSON.
- **Der Fall im Lauf** (Klick oder Enter auf eine Zelle). Links stehen Frage
  und Referenz, rechts jede Antwort mit Urteil, Erklärung, Annahmen und Zeit.
  Eine falsche Antwort zeigt:
  - den Unterschied zur Referenz in Worten: fehlende, zusätzliche und
    geänderte Bedingungen. Dieser Abfragevergleich (Stufe 1) erklärt, er
    urteilt nicht; das Urteil fällt der Vergleich der Ergebnisse;
  - beide Ergebnismengen als Trefferzahl und die abweichenden Objekte (*Nur
    in Antwort*, *Nur in Referenz*).

  Referenz und Antwort öffnen sich je im Arbeitsplatz. Bei einer unlesbaren
  Antwort steht der Rohtext unter *Technisch*.
- **Freigeben und Promptprofil übernehmen.** Die Matrix trägt die
  Entscheidung, freigegeben und voreingestellt wird aber auf der Seite
  *Modellanbindungen* (*Zur Anbindung*). Dort steht je Anbindung *zuletzt
  bewertet* mit einem Verweis auf den Lauf. *Promptprofil übernehmen*
  erscheint nur bei einem fertigen, vollständigen Lauf. Es setzt das Profil
  eines Messpunkts auf seiner Anbindung in Betrieb, nach einem Dialog mit der
  Liste der Änderungen und, wenn die Spalte mehr still falsche Antworten hat
  als die Vergleichsbasis, mit diesem Hinweis. Das Profil gilt für die
  Direktabfrage aller Anwender dieser Anbindung; die Werkzeugkette behält die
  Vorgabe. Die Änderung steht nicht im Modellprotokoll, sondern im
  Sicherheitsprotokoll, als `llm_connection_changed` mit den Werten des
  Profils (siehe *Sicherheitsprotokoll* oben). Von Hand lässt sich das
  Promptprofil im Formular der Anbindung wählen, ebenfalls mit Protokoll.
- **Zuerst der Steckbrief.** Auf eigenen Daten entscheiden die Metadaten so
  viel wie das Modell: Ein schlichter Import kostet mehr als die Wahl des
  Modells ([docs/testplan-system-context.md](docs/testplan-system-context.md)
  8.5). *Was das Modell sieht* zeigt deshalb die Vollständigkeit des
  Steckbriefs und je Layer die Lücken in der Reihenfolge der Pflege:
  1. Codelisten bestätigen (stärkste Wirkung). Gezählt werden die
     Textattribute mit einer Codeliste, bestätigt oder vom Import
     vorgeschlagen;
  2. Beschriftungen: ein Attribut gilt als beschriftet, wenn die Beschriftung
     vom Spaltennamen abweicht, ohne Rücksicht auf Gross- und
     Kleinschreibung;
  3. zuletzt Beschreibungen, die die Bedeutung nennen und nicht den Verbund
     (im Mittel ohne messbare Wirkung).

  Der letzte Schritt des Imports verweist dorthin. Nach einem vollständigen
  Lauf steht je Layer, wie die Vergleichsbasis auf den Fällen dieses Layers
  abschnitt. Weil die Beschriftung des Laufs dieselbe Zusammenfassung
  festhält, liest man eine Lücke in den Metadaten nicht als schwaches Modell.
  Die Beispieldaten sind in den Codelisten vollständig, in Beschriftungen und
  Beschreibungen nicht.
- **Grenzen.** Höchstens 500 Prüffälle je Instanz, den Startbestand
  eingerechnet, also 429 eigene; eine Importdatei hält höchstens 500 Fälle
  und `GEOTANDEM_MAX_REQUEST_MB` (eine grössere teilt man). Weitere Grenzen:
  - höchstens 8 Messpunkte je Lauf;
  - Wiederholungen mit den Seeds 1–10 bei der Temperatur der Anbindung; einer
    Anbindung ohne Seed wird keiner gesendet;
  - je Modellaufruf die Zeitgrenze der Anbindung, höchstens 120 s;
  - jede Abfrage unter den Grenzen des Betriebs (10 000 Objekte, 10 s).

  Scheitern an einem Host 5 Antworten in Folge an Schlüssel, Anbieterlimit
  oder Erreichbarkeit, hält die Anwendung den ganzen Lauf sofort an (keine
  weitere Frage, an keinen Host), und er endet als *fehlgeschlagen*; die
  Seite nennt Host und Anbindungen.
- **Was ein Lauf nicht tut.** Ein Lauf ist eine Messung, kein Betrieb:
  - Er schreibt keine Modellaktion; Modellprotokoll und Annahmequote bleiben
    die Spur der echten Benutzung.
  - Er zählt nicht gegen die Tagesgrenze einer Anbindung; die Grenze ist die
    Bestätigung der Abschätzung vor dem Start.
  - Er ändert weder Analyse noch Konfiguration, ausser man übernimmt danach
    ein Promptprofil.
  - Er sendet keine Geodaten-Inhalte, auch nicht an eine externe Anbindung:
    nur Steckbrief und Fragen.

## Sicherung (F-9.8)

Zu sichern sind zwei Dateien des Datenverzeichnisses: `geotandem.sqlite` und
`secret.key`. Bei SpatiaLite genügt das Kopieren bei gestoppter Anwendung. Im
laufenden Betrieb liegen neben der Datenbank `geotandem.sqlite-wal` und `-shm`
(WAL-Modus); beim Beenden werden sie zurückgeschrieben und entfernt, die Datei
allein ist dann vollständig.

Mit Compose liegen beide in `./data`:

```sh
docker compose stop
mkdir -p backup
cp data/geotandem.sqlite backup/geotandem-$(date +%F).sqlite
cp data/secret.key backup/geotandem-$(date +%F).secret.key
docker compose start
```

Mit `docker run` liegen sie im Volume `geotandem-data` (Container vorher stoppen):

```sh
docker run --rm -v geotandem-data:/data -v "$PWD":/backup debian sh -c \
  'cp /data/geotandem.sqlite /backup/geotandem-$(date +%F).sqlite &&
   cp /data/secret.key /backup/geotandem-$(date +%F).secret.key'
```

Wiederherstellen: beide Dateien zurück ins Datenverzeichnis kopieren
(`./data` bzw. `/data` im Volume), `secret.key` mit Rechten `0600` und dem
Besitzer, als der die Anwendung läuft.

Die Datenbank enthält Layer, Metadaten, Konten, Stufen, Modellanbindungen,
Protokolle und die gespeicherten Sitzungen (F-4.10) samt ihrem
Ergebnis-Stempel. Nach einer Wiederherstellung zeigt das Öffnen einer Sitzung
an, ob ihr Ergebnis noch dasselbe ist. Ohne `secret.key` sind die API-Schlüssel
der Modellanbindungen verloren, alles andere nicht. **Bewusst in Kauf
genommen:** Wer die Sicherung beider Dateien hat, kann die API-Schlüssel
entschlüsseln. Sicherungen deshalb wie Zugangsdaten behandeln oder
`secret.key` getrennt aufbewahren.

## Aufbau

```
packages/query/   Abfrageobjekt-Schema (hängt nur von Pydantic ab)
backend/          Anwendung: config, db (Migrationen), data (Zugriffsschicht,
                  Dialekt-Adapter, Layer-Ansicht), engine (Ausführungsmaschine),
                  tools (Registry), catalog (Layer-Katalog), importing (Import
                  und Protokoll), gdal (erlaubte Importformate), auth (Konten,
                  Anmeldungen, Sichtbarkeit), sessions und saved_queries
                  (Sitzungen, gespeicherte Abfragen), levels (Stufen),
                  llm (Modell-Schnittstelle, einziger openai-Adapter),
                  connections, connection_check, vault (Anbindungen,
                  Verbindungstest, verschlüsselte Schlüssel), basemap,
                  api (HTTP), sample (Beispieldatensatz)
frontend/         Vite + React + TypeScript, Leaflet
e2e/              Playwright, auch die Abnahmetests je Etappe
schema/           Versionierte Schema-Artefakte
design/e1/        Gestaltungsreferenz der Oberfläche (B-, C-, D-Kennungen)
docs/             Pläne je Etappe, Filter-Dokumentation, User Journey
scripts/          gate.sh, doc-screenshots.sh
```
