# GeoTandem — Domänenbegriffe

> Verbindliches Vokabular für Code, Tests und Dokumente
> ([etappen.md 2](etappen.md)). Bezeichner im Code sind englisch; die
> Zuordnung steht jeweils in Klammern.

**Layer** (`layer`) — Ein verwalteter Datenbestand im Datenkern: eine Tabelle,
bei Vektor-Layern mit genau einer Geometriespalte (`geom`) im internen CRS und
Raumindex, bei Tabellen-Layern (`kind = table`) ohne Geometrie. Jeder Layer ist
im Layer-Register (`layer`) eingetragen, mit Attribut-Metadaten
(`layer_attribute`, F-2.8). Jedes Objekt trägt eine stabile Kennung `fid`.

**Abfrageobjekt** (`QueryObject`) — Die deklarative, backend-neutrale
Beschreibung einer Analyse: Quell-Layer, Filter, räumliche und attributbezogene
Verknüpfung, Puffer, Aggregation, Symbolisierung, Ausgabeart. Das Schema ist ein
versioniertes Artefakt (`schema/query-object/v<N>.json`, F-10.3) und der
einzige Vertrag zwischen Oberfläche, Modell und Ausführungsmaschine.

**Analysezustand** — Das Abfrageobjekt, das gerade die Karte bestimmt. Es ist
*dasselbe Objekt* für Modus A und Modus B; die Oberfläche ist sein Editor.

**Ausführungsmaschine** (`engine`) — Übersetzt ein Abfrageobjekt über die
Datenzugriffsschicht in eine Abfrage und führt sie unter serverseitigen
Grenzwerten aus (F-9.6). Das einzige, was Abfragen ausführt.

**Ergebnis** — Die Antwort der Ausführungsmaschine, stets mit dem
Abfrage-Hash (`query_hash`), der Schemaversion und der Fassung des Datenstands
verknüpft (F-8.9). Gleiches Abfrageobjekt auf gleichem Datenstand ⇒ gleiches
Ergebnis.

**Datenkern** — Die Datenbank, die Layer und Verwaltungsdaten hält: SpatiaLite
(Standard) oder PostGIS (Produktion), F-2.11.

**Datenzugriffsschicht** (`DataBackend`) — Die Schnittstelle, hinter der das
Backend austauschbar ist (F-10.1). Der **Dialekt-Adapter** (`SpatialDialect`)
ist ihr schmaler, backend-spezifischer Teil für Raumfunktionen.

**Internes CRS** — Das metrisch-projizierte Koordinatenbezugssystem aller
gespeicherten Geometrien (F-2.5). Wird beim ersten Start festgelegt und danach
nicht mehr geändert. Ein- und Ausgaben an der HTTP-Schnittstelle sind WGS84.

**Werkzeug** (`Tool`) — Eine registrierte, beschriebene GIS-Operation mit
Pydantic-Ein- und -Ausgabemodell (F-10.2). Dieselbe Registry speist
Klassik-Modus, Tool Calling und MCP-Server.

**Modus A / Modus B** — Klassik-Bedienung bzw. LLM-Support; Arbeitsweise der
fertigen Anwendung. Nicht zu verwechseln mit der **Etappe** (E1–E6), einem
Bauabschnitt.

**Arbeitsweise** — Im Modus B: **Direktabfrage** (ein Abfrageobjekt) oder
**Werkzeugkette** (mehrere Werkzeugaufrufe).

**HITL-Stufe** — Grad der menschlichen Kontrolle über Modellaktionen. Der
Schnitt der Stufen wird in E2.0 festgelegt.

**Sitzung** — Ein benannt gespeicherter Analysezustand (F-4.10), ab E1.7.

**Beispieldatensatz** — Die synthetische Region „Tandemtal", erzeugt durch
`geotandem sample generate` (fester Seed) und im Repository abgelegt (F-10.5).
Er ist das Fundament aller Tests und Bewertungsläufe; seine Fassung steht in
`manifest.json`.
