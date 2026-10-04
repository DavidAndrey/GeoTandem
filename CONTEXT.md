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
einzige Vertrag zwischen Oberfläche, Modell und Ausführungsmaschine. v1 (E1.5)
ergänzt v0 um die Bedingung `related`, v2 (E1.6) um **berechnete Spalten**
(`columns`); ein älteres Dokument gilt unverändert als v2.

**Analysezustand** (`Analysis`, Frontend) — Was im Arbeitsplatz gebaut ist:
angezeigte Layer, **Ergebnis-Layer**, **Bedingungen**, **Einschränkung**. Er
wird ausschliesslich über Abfrageobjekte ausgeführt (`analysis/query.ts`); er
ist *derselbe Zustand* für Modus A und Modus B, die Oberfläche ist sein Editor.

**Ergebnis-Layer** — Der eine Layer je Sitzung, nach dem gefragt wird; andere
Layer wirken nur als Bedingung (Entwurf B1). Treffer werden auf der Karte
hervorgehoben, übrige Objekte gedämpft.

**Bedingung** — Ein Knoten im UND/ODER-Baum der Abfrage: Attribut (Vergleich,
Bereich, Text, Liste, leer), Raum (Beziehung zu einem anderen Layer, im
Abfrageobjekt `related`, ab Schema v1) oder Bezugsobjekt (`near_feature`).

**Einschränkung** — „Nur in": Kartenausschnitt (`bbox`) oder gezeichnete
Fläche (`geometry`), mit den Bedingungen UND-verknüpft.

**Abgeleiteter Layer** — Ergebnis einer Operation (Puffer, Join, Aggregation)
als Rezept, also als Abfrageobjekt; beim Anzeigen neu berechnet, nie als
Geometrie gespeichert. Bedingungen beziehen sich nur auf Katalog-Layer.

**Attributtabelle** — Die Treffer als Zeilen, angedockt unter der Karte
(F-8.2, Entwurf B8): ein Reiter je angezeigtem Layer, Ergebnis-Layer zuerst;
Treffer oder alle Objekte, sortierbar, Spalten wähl- und ordnenbar. Sie liest
dieselben Abfragen wie die Karte und ist reine Anzeige: Sortierung und
Spaltenwahl gehören zum Analysezustand (mit der Sitzung gespeichert), ändern
aber das Abfrageobjekt der Analyse nicht.

**Berechnete Spalte** (`columns`, ab Schema v2) — Ein Attribut, das die
Ausführungsmaschine je Ergebnisobjekt aus einem anderen Layer berechnet: die
Distanz zum nächsten Objekt (`distance_to`, „berechnet") oder ein Attribut des
Objekts, in dem es liegt (`value_of`, „aus Raumfilter"). Die Oberfläche leitet
sie aus den Raumbedingungen ab; sie zeigen, *warum* ein Objekt Treffer ist.

**Auswahl** — Die in Tabelle oder Karte angeklickten Objekte eines Layers;
auf der Karte Umriss und Ring, nie eine eigene Farbe (Entwurf B9). Nicht Teil
des Analysezustands und nicht gespeichert.

**Funktionsgleichheit** (F-2.14) — Jede Operation liefert auf jedem Backend
dasselbe Ergebnis. Wo eine Datenbankfunktion abweicht, gleicht der
Dialekt-Adapter sie an: Suche ohne Rücksicht auf Groß-/Kleinschreibung faltet
auch Umlaute („änggi" findet „Änggisteibach"), Text sortiert nach
Grundbuchstaben („Ägerten" bei A), Puffer haben überall 30 Segmente je
Viertelkreis, Join-Schlüssel müssen gleichartig sein. Akzente zählen weiterhin
(„Munsingen" findet „Münsingen" nicht).

**Kartensuche** — Sucht in den Namen der Objekte aller Layer, die das Konto
sieht, über die Ausführungsmaschine wie jede Abfrage (ohne Rücksicht auf
Groß-/Kleinschreibung, nur lokal). Ein Treffer wird angezoomt; auf einem
angezeigten Layer ist er ausgewählt, sonst markiert. Nicht gespeichert.

**Messen** — Strecke oder Fläche, auf der Karte geklickt, geodätisch auf dem
Ellipsoid (WGS84) gerechnet. Ein Werkzeug der Ansicht wie Zoomen: keine Abfrage,
nichts gespeichert.

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

**Sitzung** (`analysis_session`) — Ein benannt gespeicherter Analysezustand
(F-4.10), ab E1.7: der Zustand als versioniertes JSON (Layer, Bedingungen,
Rezepte, Tabelle, Kartenausschnitt), dazu das Abfrageobjekt des Ergebnisses und
sein **Ergebnis-Stempel**. Privat für ihr Konto, auch gegenüber
Administratoren. Nicht zu verwechseln mit der **Anmeldung** (`auth_session`),
der serverseitigen Login-Sitzung eines Kontos.

**Gespeicherte Abfrage** (`saved_query`) — Ergebnis-Layer, Bedingungen und
Einschränkung unter einem Namen, über Sitzungen wiederverwendbar (Entwurf C6).
Nur auf Katalog-Layern. **Geteilt** ist sie für jedes Konto lesbar, das alle
ihre Layer sieht; ändern kann sie nur, wer sie gespeichert hat — alle anderen
speichern eine Kopie. Eine Sitzung merkt sich, aus welcher Abfrage sie kommt,
behält aber ihre eigenen Bedingungen.

**Ergebnis-Stempel** (`ResultStamp`) — Ein Ergebnis ohne seine Objekte:
Trefferzahl, Prüfsumme der sortierten Objekt-IDs, Abfrage-Hash und Fassung je
beteiligtem Layer. Der Server berechnet ihn beim Speichern; beim Öffnen läuft
die gespeicherte Abfrage erneut und wird mit ihm verglichen — „identisch" oder
„weicht ab" mit Ursache (F-8.9).

**Konto** (`app_user`) — Ein lokales Benutzerkonto mit genau einer **Rolle**
(`role`): Administrator (`admin`) oder Anwender (`user`), F-3.12. Ein neues
oder zurückgesetztes Konto trägt ein **Startpasswort**, das bei der ersten
Anmeldung zu ändern ist.

**Sichtbarkeit** (`layer_visibility`) — Welche Layer eine Rolle sieht (F-2.7).
Administratoren sehen alle; für Anwender ist ein Layer erst nach **Freigabe**
sichtbar. Durchgesetzt über die **Layer-Ansicht** (`LayerView`): die
Datenzugriffsschicht, beschränkt auf die sichtbaren Layer — ein verborgener
Layer verhält sich wie ein nicht vorhandener.

**Importvorgang** (`import_run`) — Ein Importversuch mit Quelle, Entscheidungen,
Ergebnis und Fehlern (F-2.10), ob erfolgreich, fehlgeschlagen oder abgebrochen.
Ein **Geobezug** ist die Herkunft der Geometrie: aus der Datei, aus
Koordinatenspalten (X/Y) oder über einen **Gebietsschlüssel** auf einen
vorhandenen Layer (F-2.3).

**Beispieldatensatz** — Der Verwaltungskreis Bern-Mittelland aus offenen
Daten des Kantons Bern (AGI, opendata.swiss), aufbereitet durch
`geotandem sample update` und im Repository abgelegt (F-10.5); aktualisiert
wird nur auf Anfrage. Er löst die synthetische Region „Tandemtal" ab.
Er ist das Fundament aller Tests und Bewertungsläufe; seine Fassung steht in
`manifest.json`.

**Meldungskatalog** (`frontend/src/locales/<sprache>.po`) — Alle Texte der
Oberfläche als Meldungen; der deutsche Text ist zugleich ihr Schlüssel
(F-10.6, E1.9). Eine Meldung ist ein ganzer Satz mit Platzhaltern
(`„{name}" löschen?`) und, wo gezählt wird, Pluralformen; Satzteile werden nie
im Code zusammengesetzt. Ausgangssprache und vorerst einzige Sprache ist
Deutsch.

**Formatierungs-Locale** — Wie Zahlen, Daten und Textreihenfolge geschrieben
werden: die Sprache in ihrer Schweizer Form (`de` → `de-CH`, später `fr-CH`,
`it-CH`), an einer Stelle (`i18n/locale.ts`), nie als Literal im Code.

**Pseudo-Locale** (`?lang=pseudo`) — Eine Prüfsprache: jede Meldung erscheint
akzentuiert, um ein Drittel verlängert und in ⟦…⟧. Was ohne Klammern bleibt
und keine Daten sind, ist am Katalog vorbei in die Oberfläche gelangt; die
Bildschirmtests und ein Abnahmetest prüfen das.

**Code** (`code`) — Der stabile Schlüssel jeder Ablehnung und jedes
Importbefunds, mit seinen Werten in `details`. Die Oberfläche formuliert ihn
in der Sprache der Anwender; der englische `message` dient Protokoll und
API-Clients. Alle Codes stehen in `geotandem/codes.py` (E1.9) und gelangen als
`frontend/error-codes.json` in die Oberfläche.
