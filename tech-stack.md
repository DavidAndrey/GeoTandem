# GeoTandem — Technologie-Stack

> Status: Entwurf v0.4 · Stand: 2026-09-30 · Bezug: [vision.md](vision.md),
> [anforderungen.md](anforderungen.md), [etappen.md](etappen.md)
>
> *Was* gebaut wird, steht in den Anforderungen; *warum*, in der Vision; *in
> welcher Reihenfolge*, in den Etappen. Dieses Dokument beantwortet die vierte
> Frage: **womit**. Es nennt die gesetzten Technologien, die Begründung dort, wo
> sie aus einer Anforderung folgt, und die noch offenen Wahlmöglichkeiten.
>
> Verbindlich festgeschrieben werden Versionen in den Sperrdateien (`uv.lock`,
> `package-lock.json`) in E1.1. Abschnitt 2.1 hält fest, welcher Stand der
> Auswahl zugrunde lag — damit später prüfbar ist, ob eine Entscheidung noch auf
> aktuellen Annahmen beruht.

## 1 Leitlinien der Auswahl

Die Stackwahl folgt den Leitprinzipien aus [vision.md 5](vision.md), vor allem
Prinzip 6 („Austauschbarkeit vor Funktionstiefe"). Daraus ergeben sich vier
Auswahlregeln:

1. **Eine Technologie muss beide Datenkern-Backends tragen** (F-2.11). Was nur
   auf PostGIS läuft, kommt nicht in Frage — auch nicht als Abkürzung.
2. **Schema an einer Stelle.** Das deklarative Abfrageobjekt (F-10.3) ist der
   Vertrag zwischen Backend, Oberfläche und Modell. Es wird einmal definiert und
   in alle anderen Darstellungen abgeleitet, nie parallel gepflegt.
3. **Lokal lauffähig ohne Dienste.** Der Standardfall ist ein Container ohne
   Datenbankdienst (F-2.12, F-9.7). Alles, was zwingend einen zusätzlichen
   Dienst voraussetzt (Broker, Cache, Kartenserver), ist zu begründen.
4. **Breit belegte Bibliotheken vor spezialisierten.** Ein Demonstrator, der
   von Agents weitergebaut wird, profitiert von Werkzeugen mit dichter
   Dokumentation stärker als von der jeweils elegantesten Lösung.

## 2 Überblick

| Schicht | Technologie | Zweck |
|---|---|---|
| Backend-Laufzeit | Python 3.14 | Fachlogik, Geodaten, Modellanbindung |
| Web-Schicht | FastAPI + Uvicorn | HTTP-Schnittstelle, OpenAPI-Beschreibung |
| Schemata | Pydantic v2 | Abfrageobjekt, Konfiguration, Ein-/Ausgaben |
| Datenzugriff | SQLAlchemy 2 (Core + ORM) | Backend-neutrale Abfragekonstruktion |
| Geometrie-Typen | GeoAlchemy2 | Geometriespalten und Raumfunktionen |
| Schema-Versionierung | Alembic | Migrationen für beide Backends (F-2.17) |
| Datenkern | SpatiaLite (Standard) / PostGIS (Produktion) | Layer, Metadaten, Sitzungen, Protokolle |
| Frontend-Gerüst | Vite + TypeScript + React 19 (Node 24 LTS) | Einseiten-Anwendung |
| Navigation | React Router | Anwenderbereich / Adminbereich / Sitzungen |
| Karte | Leaflet + react-leaflet | Kartendarstellung und -bedienung |
| Gestaltung | Tailwind CSS | Oberflächengestaltung ohne eigene CSS-Schicht |
| Tests Backend | pytest + httpx | Einheiten-, Schnittstellen- und Backend-Vergleichstests |
| Tests Frontend | Vitest + React Testing Library | Einheiten- und Komponententests |
| Tests durchgehend | Playwright | Vorführskripte der Etappen als Abnahmetests |
| Betrieb | Docker / Docker Compose | Einzelcontainer und Verbund (F-9.7) |

### 2.1 Versionsstand der Auswahl

Geprüft am **2026-09-22** gegen PyPI und die npm-Registry. Die Spalte *Ansatz*
nennt, worauf gebaut wird; die Sperrdateien aus E1.1 sind massgeblich.

| Paket | Aktuell | Ansatz | Anmerkung |
|---|---|---|---|
| Python | 3.14 | **3.14**, Untergrenze 3.13 | 3.12 wäre unterstützt, aber für einen Neubeginn zu konservativ; die gesamte Geo-Kette liefert `cp314`-Wheels |
| FastAPI | 0.141 | aktuelle 0.x | noch vor 1.0; Nebenversionen können brechen, deshalb gepinnt |
| Pydantic | 2.13 | **2.x** | |
| SQLAlchemy | 2.0.54 | **2.0** | |
| GeoAlchemy2 | 0.20 | aktuelle 0.x | noch vor 1.0 — die einzige Abhängigkeit im Kern, die beide Backends trägt, und zugleich die kleinste; gepinnt und mitbeobachtet |
| Alembic | 1.20 | **1.x** | |
| Shapely | 2.1 | **2.x** | |
| pyproj | 3.8 | 3.x | verlangt selbst bereits Python ≥ 3.12 |
| pyogrio | 0.13 | aktuelle 0.x | |
| pandas | 3.0 | **3.x** | 3.0 hat gegenüber 2.x brechende Änderungen (u. a. Copy-on-Write); nur für den Import verwendet, geringe Angriffsfläche |
| pytest | 9.1 | **9.x** | |
| MCP-SDK | 2.2 | **2.x** | Für E4/E6 relevant, wird dort erneut geprüft |
| Node | 24 LTS | **24 LTS** | 26 wird am 2026-10-28 LTS; Vite 8 und Vitest 5 verlangen ≥ 22.12 |
| React | 19.3 | **19** | |
| React Router | 8.4 | **8** | |
| Vite | 8.3 | **8** | |
| Vitest | 5.0 | **5** | |
| Tailwind CSS | 4.3 | **4** | |
| Leaflet | 1.9.4 | **1.9** | siehe 4.2 |
| react-leaflet | 5.0 | **5** | verlangt React 19 — passt zur Wahl oben |
| Testing Library (React) | 16.3 | **16** | |
| Playwright | 1.63 | **1.x** | |
| TypeScript | 7.0 | **5.9** | entschieden in E1.1, siehe 4.5 |
| ESLint | 10.11 | **10** | |

## 3 Backend

### 3.1 Laufzeit und Web-Schicht

**Python 3.14** (Untergrenze 3.13), **FastAPI**, **Uvicorn**.

FastAPI ist gewählt, weil es drei Dinge zusammenführt, die dieses Projekt
ohnehin braucht: Pydantic-Validierung an der Systemgrenze (F-5.9), eine aus dem
Code erzeugte OpenAPI-Beschreibung als Grundlage der Typgenerierung für das
Frontend (siehe 4.5) und asynchrone Verarbeitung für die Modellanbindung, deren
Antwortzeiten in Sekunden gemessen werden.

Server-Sent Events der Web-Schicht decken den Fortschritt mehrschrittiger
Modellaktionen ab (F-6.5) und den Abbruch (F-6.6). WebSockets sind dafür nicht
nötig — der Datenfluss ist einseitig.

### 3.2 Schemata und Konfiguration

**Pydantic v2** für das Abfrageobjekt, alle Ein- und Ausgaben der
HTTP-Schnittstelle und die Werkzeugbeschreibungen der Registry (F-10.2).
**pydantic-settings** für die Konfiguration aus Umgebungsvariablen und
Konfigurationsdatei (F-9.9).

Das Abfrageobjekt-Schema (F-10.3) ist ein eigenes Python-Paket ohne Abhängigkeit
zur Datenzugriffsschicht. Aus ihm werden erzeugt: das JSON-Schema zur Validierung
der Modellausgabe (F-5.5), die Werkzeugbeschreibungen für Tool Calling (F-7.4)
und die MCP-Werkzeugsignaturen (F-7.5), sowie die TypeScript-Typen des Frontends.
Eine Version des Schemas ist ein Artefakt im Repository, nicht nur ein
Klassenstand im Code.

### 3.3 Datenzugriff

**SQLAlchemy 2**, **GeoAlchemy2**, **Alembic**.

Die Aufteilung ist bewusst zweigeteilt:

- **SQLAlchemy ORM** für die verwaltenden Tabellen mit festem Schema: Benutzer,
  Layer-Register, Attribut-Metadaten, gespeicherte Sitzungen, LLM-Anbindungen,
  HITL-Stufen, Protokolle.
- **SQLAlchemy Core** (Expression Language) für alles, was aus dem Abfrageobjekt
  entsteht. Layer-Tabellen werden beim Import dynamisch angelegt (F-2.6) und
  haben kein zur Bauzeit bekanntes Schema; ein ORM-Mapping wäre hier Ballast.
  Die Ausführungsmaschine aus E1.2 übersetzt das Abfrageobjekt in einen
  Core-Ausdrucksbaum, den SQLAlchemy je Backend in den passenden SQL-Dialekt
  giesst.

Damit ist die Grenze aus F-10.1 genau dort, wo sie sein soll: Das Abfrageobjekt
ist backend-neutral, die Dialektfrage löst SQLAlchemy, und nur die Raumfunktionen
bleiben als bewusst gepflegter Unterschied übrig.

**GeoAlchemy2** liefert den Geometrietyp und die `ST_*`-Funktionen für beide
Backends. Es ist eine der wenigen Bibliotheken, die SpatiaLite und PostGIS
gleichermassen unterstützt — das ist der Grund für die Wahl. Wo die Funktionen
auseinanderlaufen (etwa Indexnutzung, `ST_DWithin`, Aggregatfunktionen), liegt
die Unterscheidung in einem schmalen Dialekt-Adapter je Backend, nicht verstreut
in der Fachlogik.

**Alembic** führt versionierte Migrationen für beide Backends (F-2.17). Die
Migrationen betreffen ausschliesslich das verwaltende Schema; importierte Layer
sind Daten, nicht Schema, und werden über das Migrationswerkzeug aus P.3
übertragen.

> **Bekannte Reibungsstelle (E1.1):** SpatiaLite verlangt für Geometriespalten
> `AddGeometryColumn`/`RecoverGeometryColumn` statt eines gewöhnlichen
> `ALTER TABLE`, und das Laden der Erweiterung `mod_spatialite` setzt ein
> `sqlite3`-Modul mit aktiviertem `enable_load_extension` voraus. Beides wird in
> E1.1 einmal zentral gelöst (Verbindungs-Hook plus Alembic-Hilfsoperation) und
> nicht an jeder Aufrufstelle.

### 3.4 Geodaten-Import und -Verarbeitung

| Aufgabe | Bibliothek | Bezug |
|---|---|---|
| Vektorformate lesen (GeoJSON, Shapefile, GeoPackage) | pyogrio (GDAL/OGR) | F-2.1 |
| Geometrieoperationen im Anwendungscode | Shapely 2 | F-2.5, F-2.14 |
| CRS-Erkennung und -Transformation | pyproj | F-2.5 |
| Tabellendaten (CSV, Excel) | pandas + openpyxl | F-2.2, F-2.3 |

Der Regelfall ist, dass räumliche Operationen **in der Datenbank** laufen und
nicht in Python — nur so gilt F-2.14 überprüfbar für beide Backends. Shapely und
pyproj sind für Import, Transformation und gezeichnete Geometrien aus der
Oberfläche zuständig, nicht für die Analyse. Wo eine Operation auf SpatiaLite
fehlt und im Anwendungscode nachgebildet werden müsste, ist das eine offene
Entscheidung der Anforderungen (F-2.14) und keine stillschweigende Ausnahme.

### 3.5 Modellanbindung und MCP

- **httpx** als HTTP-Client für lokale Modell-Endpunkte (F-7.1). Dieselbe
  Bibliothek dient in den Tests als Client gegen die eigene Anwendung (siehe 5.2)
  — eine Abhängigkeit weniger.
- **Offizielles MCP-Python-SDK** für beide Rollen: Server (E4, F-7.5) und Client
  (E6, F-7.8).
- Die Anbieterabstraktion (F-7.3) ist ein eigenes schmales Protokoll im
  Projektcode, kein Framework. Ein Framework mit eigener Agenten-Schleife würde
  genau die Kontrolle verdecken, die dieser Demonstrator sichtbar machen soll
  ([vision.md 4.3](vision.md)) — die Werkzeugschleife ist hier Gegenstand der
  Untersuchung und gehört deshalb in den eigenen Code.

### 3.6 Sicherheit

| Aufgabe | Technologie | Bezug |
|---|---|---|
| Passwort-Hashing | Argon2 (argon2-cffi) | F-3.12 |
| Verschlüsselte Ablage von Zugangsdaten und Token | cryptography (Fernet), Schlüssel aus der Umgebung | F-9.2 |
| Anmeldung | serverseitige Sitzung über HttpOnly-Cookie | F-3.12 |

Die Durchsetzung der HITL-Regeln (F-6.7) und der Grenzwerte (F-9.6) liegt in der
Web-Schicht und der Ausführungsmaschine, nicht in der Oberfläche — sie greift
damit gleichermassen für den MCP-Pfad.

## 4 Frontend

### 4.1 Gerüst

**Vite**, **TypeScript** (strikt), **React 19**, **React Router**, auf
**Node 24 LTS**.

Die Anwendung ist eine Einseiten-Anwendung ohne Server-Rendering: Sie ist
angemeldet, zustandsbehaftet und kartenzentriert; ein SSR-Rahmen brächte nichts
ausser Aufbau. React Router trennt Anwenderbereich, Adminbereich (F-3.1) und
benannte Sitzungen (F-4.10), sodass ein Analysezustand eine eigene Adresse hat.

Im Container wird das Frontend gebaut und vom Backend als statische Dateien
ausgeliefert — ein Prozess, ein Port, kein zusätzlicher Webserver (F-9.7).

### 4.2 Karte

**Leaflet** mit **react-leaflet**.

Leaflet deckt den geforderten Funktionsumfang vollständig ab: Zoom, Verschieben,
Hintergrundkarte, Legende, Massstab, Popups (F-4.9), GeoJSON-Ergebnisebenen
(F-8.1), gezeichnete Geometrien für Raumfilter (F-4.3) und
attributabhängige Symbolisierung (F-4.8). Es ist klein, stabil und in der
Beispieldichte kaum zu schlagen.

Die bewusst in Kauf genommene Grenze: Leaflet zeichnet ohne WebGL und ohne
Vektorkacheln. Ergebnisebenen kommen als GeoJSON in den Browser, ihre Grösse ist
durch die serverseitigen Grenzwerte gedeckelt (F-3.9, F-9.6). Da Rasterdaten und
OGC-Dienste ohnehin ausserhalb des Umfangs liegen
([anforderungen.md 11](anforderungen.md)), trifft diese Grenze den Demonstrator
nicht.

Zur Einordnung des Reifegrads: Leaflet steht seit 1.9.4 (Mai 2023) still, eine
2.0 mit ESM-Umbau ist im Alpha-Stadium; react-leaflet 5.0 (Dezember 2024) hat
seither keine Nachfolgeversion. Das ist für diesen Demonstrator eher Vorteil als
Risiko — die Bibliothek ist fertig, nicht verwaist, und der geforderte Umfang
bewegt sich nicht. Festzuhalten bleibt, dass ein späterer Sprung auf Leaflet 2.0
ein Umbau und kein Versionswechsel wird.

### 4.3 Gestaltung

**Tailwind CSS**. Keine eigene CSS-Architektur, keine zweite Gestaltungsebene.

Für zusammengesetzte Bedienelemente (Dialoge, Auswahllisten, Reiter, Schieber der
HITL-Stufe) wird eine zugänglichkeitsfertige, ungestaltete Komponentenbasis
verwendet statt eigener Nachbauten; die Auswahl steht noch aus (siehe 9).

### 4.4 Anwendungszustand

Zu trennen sind zwei Dinge:

- **Serverzustand** (Layer, Abfrageergebnisse, Protokolle): über einen
  Abfrage-Cache mit Invalidierung, nicht im Anwendungszustand gespiegelt.
- **Analysezustand** (die aktuelle Layer-Auswahl, Filter, Symbolisierung,
  Kartenausschnitt): Dieser ist nach [vision.md 4.1](vision.md) *dasselbe Objekt*
  für beide Modi und entspricht dem Abfrageobjekt aus E1.2. Er wird deshalb als
  ein Zustandsbaum geführt, den sowohl die Klassik-Bedienelemente als auch die
  Modellantworten schreiben — die Oberfläche ist dessen Editor, kein zweiter Weg.

Die konkrete Bibliothekswahl steht noch aus (siehe 9); die Trennung selbst ist
gesetzt.

### 4.5 Typen aus dem Backend-Schema

Die TypeScript-Typen der HTTP-Schnittstelle und des Abfrageobjekts werden aus der
OpenAPI-Beschreibung von FastAPI erzeugt (`openapi-typescript`) und im Repository
abgelegt. Von Hand gepflegte Gegenstücke sind ausgeschlossen: Sobald das
Abfrageobjekt an zwei Stellen beschrieben wird, laufen Klassik-Modus und
Ausführungsmaschine auseinander, und der Sperrpunkt E1.2 wäre wertlos.

> **Entschieden in E1.1 (2026-09-30): TypeScript 5.9.** Geprüft wurde
> `openapi-typescript` 7.13 unter TypeScript 7.0.2: Die Generierung bricht ab,
> weil TypeScript 7 (die Go-Neuimplementierung) keine JavaScript-Compiler-API
> (`ts.factory`) mehr mitliefert, auf der das Werkzeug aufbaut. Unabhängig davon
> verlangt `typescript-eslint` 8.71 `typescript < 6.1`. Der Wechsel wird fällig,
> sobald beide Werkzeuge TypeScript 7 tragen; er betrifft nur das Bauwerkzeug,
> nicht die Struktur der erzeugten Typen.

## 5 Tests

### 5.1 Ebenen

| Ebene | Werkzeug | Gegenstand |
|---|---|---|
| Backend-Einheiten | pytest | Abfrageobjekt-Validierung, Dialektübersetzung, Werkzeug-Registry, HITL-Regelwerk |
| Backend-Schnittstelle | pytest + httpx (ASGI-Transport) | HTTP-Endpunkte im Prozess, ohne laufenden Server |
| Datenzugriffsschicht | pytest, über beide Backends parametrisiert | **F-10.7:** derselbe Testfallbestand gegen SpatiaLite und PostGIS |
| Frontend-Einheiten | Vitest | Zustandslogik, Übersetzung Bedienelement → Abfrageobjekt |
| Frontend-Komponenten | Vitest + React Testing Library | Bedienelemente aus Anwendersicht, keine Innenansicht |
| Durchgehend | Playwright | Vorführskript je Etappe als Abnahmetest |

### 5.2 Festlegungen

- **httpx doppelt genutzt:** als Testclient gegen die eigene Anwendung und als
  Produktionsclient gegen Modell-Endpunkte. In den Tests der Modellanbindung
  wird derselbe Client gegen einen Aufzeichnungs-Transport geführt.
- **Kein Modell in der Testsuite.** Der LLM-Pfad wird gegen einen
  deterministischen Anbieter-Adapter mit hinterlegten Antworten geprüft. Ein
  echtes Modell ist Gegenstand der Vorführung, nicht der automatisierten Tests —
  andernfalls misst die Suite die Tagesform eines Modells statt die Anwendung.
  Die Messung der Modellgüte selbst geschieht in eigenen, vom Administrator
  ausgelösten Bewertungsläufen neben der Suite ([bewertung.md 9](bewertung.md));
  die Bewertungsmaschinerie — Normalisierung und Vergleich — ist dagegen
  gewöhnlicher Anwendungscode und wird von pytest abgedeckt.
- **Der Beispieldatensatz (F-10.5) ist das Testfundament.** Er entsteht in E1.1
  und dient Unit-, Backend-Vergleichs- und Playwright-Tests gleichermassen.
- **Playwright bildet die Vorführungen ab.** Jede Etappe endet mit einer
  Vorführung ([etappen.md 1](etappen.md)); deren Skript wird als Playwright-Lauf
  geschrieben und bleibt danach als Regressionsschutz bestehen.
- **P.2 ist eine Testkonfiguration, kein zweiter Testbestand.** Die Suite der
  Zugriffsschicht läuft über eine Fixture-Parametrisierung; ein Unterschied im
  Ergebnis ist ein Fehler, keine Backend-Eigenart.

## 6 Entwicklungswerkzeuge

| Zweck | Werkzeug |
|---|---|
| Python-Abhängigkeiten und Umgebung | uv |
| Formatierung und Linting (Python) | Ruff |
| Typprüfung (Python) | mypy (strikt für Schema- und Zugriffsschicht) |
| Frontend-Abhängigkeiten | npm |
| Formatierung und Linting (Frontend) | ESLint + Prettier |
| Vor-Commit-Prüfungen | pre-commit |

## 7 Betrieb

Zwei Ausprägungen aus demselben Programmstand (F-2.13, F-9.7):

- **Einzelcontainer:** Anwendung plus SpatiaLite-Datei in einem Datenträger. Ein
  Befehl, kein Datenbankdienst, Sicherung durch Kopieren der Datei (F-9.8).
  Das ist der Standard für Entwicklung und Vorführung.
- **Verbund (Compose):** Anwendungscontainer plus PostGIS-Dienst, Sicherung per
  Datenbank-Dump. Entsteht im Querstrang P.4.

Der Wechsel geschieht ausschliesslich über die Verbindungsangabe in der
Konfiguration. Ein Bildabzug, zwei Betriebsarten — ein abweichender Programmstand
je Backend widerspräche F-2.13.

## 8 Bewusst nicht gewählt

| Nicht gewählt | Begründung |
|---|---|
| Django / Flask | FastAPI bringt Pydantic-Validierung, OpenAPI und asynchrone Verarbeitung ohne Zusatzbau mit |
| Geodienst-Server (GeoServer, MapServer) | Ergebnisebenen entstehen aus der Ausführungsmaschine und sind durch Grenzwerte gedeckelt; ein Kartendienst wäre ein zweiter Weg an E1.2 vorbei |
| OpenLayers / MapLibre | Mehr Funktion als der Umfang verlangt; Raster und OGC-Dienste sind ausgeschlossen |
| Aufgabenwarteschlange (Celery, Redis) | Widerspräche dem dienstfreien Standardbetrieb (F-2.12); lange Läufe werden durch Grenzwerte verhindert, nicht durch Hintergrundverarbeitung |
| Agenten-Framework (LangChain o. ä.) | Die Werkzeugschleife ist Untersuchungsgegenstand, nicht Infrastruktur ([vision.md 4.3](vision.md)) |
| Generiertes SQL als Modellausgabe | Durch [anforderungen.md 11](anforderungen.md) ausgeschlossen; das Modell erzeugt ausschliesslich Abfrageobjekte und Werkzeugaufrufe |
| Server-Rendering (Next.js o. ä.) | Angemeldete, zustandsbehaftete Einseiten-Anwendung ohne Bedarf an Vorab-Rendering |
| GraphQL | Ein einziger Client, festes Abfrageobjekt-Schema |

## 9 Offene Punkte

Diese Entscheidungen sind bewusst noch nicht gefällt. Jede nennt den Zeitpunkt,
zu dem sie spätestens fällig wird.

| Offen | Zu entscheiden bis | Anmerkung |
|---|---|---|
| Bibliothek für Serverzustand und Analysezustand (4.4) | E1.5 | Kandidaten: TanStack Query für den Serverzustand, dazu ein schlanker Speicher (Zustand) für den Analysezustand |
| Komponentenbasis für Bedienelemente (4.3) | E1.5 | Kandidaten: Radix UI, Headless UI, Base UI |
| Diagrammbibliothek (F-8.3) | E5.1 | Auswahl erst, wenn die Kennzahlen feststehen; Leichtgewichtigkeit vor Funktionsumfang |
| Kartenexport als Bild (F-8.7) | E5.3 | Clientseitig aus dem Browser oder serverseitig gerendert — beides hat spürbare Folgen für den Containerumfang |
| PostGIS in der Testumgebung (F-10.7) | P.2 | Testcontainers oder Dienstcontainer der Bauumgebung |
| Transport der MCP-Server-Rolle (F-7.5) | E4.1 | stdio und/oder HTTP; hängt an der Frage aus [vision.md 8.2](vision.md) |
| Format und Ablage des Prüffallbestands (F-3.13) | E3.1 | Dateiartefakt im Repository, Läufe im Datenkern; siehe [bewertung.md 10](bewertung.md) |
| Übersetzungsbibliothek (F-10.6) | nach E6 | Nach [etappen.md 10](etappen.md) ausserhalb der sechs Etappen |
| Umgang mit SpatiaLite-Lücken (F-2.14) | E1.2 | Keine reine Technologiefrage — die Entscheidung steht in den Anforderungen offen und prägt den Dialekt-Adapter |

## 10 Bezug zu den Anforderungen

Anforderungen, deren Erfüllung unmittelbar an einer Stackentscheidung hängt:

| Anforderung | Tragende Entscheidung |
|---|---|
| F-2.11, F-2.13, F-10.1 | SQLAlchemy Core als backend-neutrale Abfragekonstruktion, Dialekt-Adapter je Backend |
| F-2.12 | SpatiaLite als Datei, keine Dienstabhängigkeit im Standardbetrieb |
| F-2.17 | Alembic für beide Backends |
| F-2.5, F-2.14 | Einheitliches metrisch-projiziertes CRS über pyproj; Raumoperationen in der Datenbank |
| F-5.5, F-5.9, F-10.3 | Pydantic-Schema als einzige Quelle, JSON-Schema-Validierung der Modellausgabe |
| F-5.16, F-5.17 | Gemeinsamer Analysezustand im Frontend, Typen aus dem Backend-Schema erzeugt |
| F-6.5, F-6.6 | Server-Sent Events und asynchrone Verarbeitung in FastAPI |
| F-6.7, F-9.6 | Durchsetzung in Web-Schicht und Ausführungsmaschine, nicht in der Oberfläche |
| F-7.1, F-7.3 | httpx plus eigenes Anbieterprotokoll statt Framework |
| F-7.5, F-7.8 | MCP-Python-SDK in beiden Rollen |
| F-9.2 | cryptography/Fernet mit Schlüssel aus der Umgebung |
| F-9.7, F-9.8 | Ein Bildabzug, zwei Betriebsarten über Konfiguration |
| F-10.7 | Parametrisierte pytest-Fixtures über beide Backends |
