# GeoTandem — Anforderungen

> Status: Entwurf v0.3 · Stand: 2026-09-30 · Bezug: [vision.md](vision.md),
> [etappen.md](etappen.md)
>
> Kompakte Feature-Liste für den Demonstrator. Die Kennungen (F-x.y) dienen der
> Referenzierbarkeit, nicht einer Priorisierung. Abschnitt 11 hält fest, was
> bewusst nicht zum Umfang gehört; die Reihenfolge der Umsetzung regelt
> [etappen.md](etappen.md).

## 1 Rahmen und Annahmen

- **Charakter:** interner Demonstrator / Proof of Concept, ausdrücklich auf
  Anpassbarkeit und Austauschbarkeit ausgelegt.
- **Betriebsform:** browserbasierte Web-Anwendung mit Server-Backend,
  vollständig self-hosted / on-premises betreibbar.
- **Datenkern, zweistufig:** **SQLite/SpatiaLite** ist der Standard für
  Entwicklung und Vorführung — eine Datei, kein Datenbankdienst, keine
  Installation. **PostgreSQL/PostGIS** ist das Ziel für den produktiven Betrieb.
  Beide laufen über dieselbe Datenzugriffsschicht; der Wechsel ist eine
  Konfigurationsfrage plus eine einmalige Datenmigration (F-2.11 bis F-2.17).
- **LLM-Wirkungstiefe:** ausschliesslich deklarative Abfrageobjekte und Aufrufe
  vordefinierter GIS-Werkzeuge. Kein generiertes SQL, kein generierter Code.
- **Zwei Arbeitsweisen:** Direktabfrage (ein Abfrageobjekt) und Werkzeugkette
  (mehrere Werkzeugaufrufe) stehen jederzeit beide zur Verfügung; die Wahl trifft
  der Anwender.
- **Rollen:** Administrator, Anwender, externer LLM-Client (über MCP).
- **Datenzugriff:** alle Analyseoperationen sind lesend.

---

## 2 Datenhaltung und Import

- **F-2.1** Import von Vektordaten: GeoJSON, Shapefile (inkl. zugehöriger
  Begleitdateien), GeoPackage.
- **F-2.2** Import von Tabellendaten mit Geobezug: CSV, Excel.
- **F-2.3** Geobezug tabellarischer Daten über Koordinatenspalten oder über einen
  Gebietsschlüssel (z. B. AGS, PLZ, Gemeindekennziffer) mit Join auf einen
  vorhandenen Geometrie-Layer.
- **F-2.4** Import-Vorschau vor der Übernahme: erkannte Spalten, Datentypen,
  Geometrietyp, Koordinatenbezugssystem, Datensatzanzahl.
- **F-2.5** Erkennung und Transformation des Koordinatenbezugssystems in ein
  einheitliches internes CRS. Dieses ist metrisch-projiziert, damit Distanz-,
  Puffer- und Flächenoperationen auf beiden Backends (F-2.11) dieselben Werte
  liefern und nicht von backend-spezifischen Geography-Typen abhängen.
- **F-2.6** Ablage importierter Daten als verwaltete Layer im Datenkern, je
  Layer eine Tabelle mit Geometriespalte und Raumindex — als SpatiaLite-Tabelle
  mit R-Tree-Index bzw. als PostGIS-Tabelle mit GiST-Index.
- **F-2.7** Layer-Verwaltung: Auflisten, Umbenennen, Aktualisieren, Löschen,
  Sichtbarkeit je Rolle.
- **F-2.8** Attribut-Metadaten je Layer: fachliche Bezeichnung, Beschreibung,
  Einheit, Wertebereich bzw. Codeliste — als Grundlage für die semantische
  Deutung durch das Modell.
- **F-2.9** Layer-Steckbrief für den LLM-Kontext: maschinenlesbare Beschreibung
  von Layern, Attributen und Beziehungen, aus F-2.8 abgeleitet.
- **F-2.10** Protokollierung aller Importvorgänge (Zeitpunkt, Quelle, Ergebnis,
  Fehler).

### 2.1 Backends und Umstieg

- **F-2.11** Zwei unterstützte Datenkern-Backends hinter derselben
  Zugriffsschicht (F-10.1): **SpatiaLite** als Standard für Entwicklung und
  Vorführung, **PostGIS** für den produktiven Betrieb.
- **F-2.12** Erstinbetriebnahme ohne Datenbankdienst: Die Anwendung erzeugt beim
  ersten Start eine SpatiaLite-Datei und ist ohne weitere Einrichtung
  arbeitsfähig.
- **F-2.13** Auswahl des Backends allein über die Konfiguration
  (Verbindungsangabe je Umgebungsvariable bzw. Konfigurationsdatei, F-9.9) —
  ohne Eingriff in den Programmcode und ohne getrennte Programmstände.
- **F-2.14** Funktionsgleichheit: Layer-Verwaltung, Filter, räumliche
  Verknüpfungen, Puffer, Joins und Aggregationen (Kapitel 4) stehen auf beiden
  Backends im selben Umfang zur Verfügung. Kann ein Backend eine registrierte
  Operation nicht leisten, meldet die Anwendung dies beim Start — nicht erst,
  wenn der Anwender sie auslöst.
- **F-2.15** Migrationswerkzeug SpatiaLite → PostGIS: überträgt verwaltete Layer
  samt Geometrien und Indizes, Attribut-Metadaten (F-2.8), gespeicherte
  Sitzungen (F-4.10), HITL- und Anbindungskonfiguration sowie die Protokolle
  (F-2.10, F-6.8).
- **F-2.16** Prüfbericht nach der Migration: Objektanzahl, Geometrietyp und CRS
  je Layer im Vorher-Nachher-Vergleich, mit ausgewiesenen Abweichungen.
- **F-2.17** Versionierte Schema-Migrationen für beide Backends, sodass ein
  bestehender Datenbestand beim Versionswechsel der Anwendung mitgeführt wird.

## 3 Administration und Konfiguration

- **F-3.1** Administrationsbereich, getrennt von der Anwenderoberfläche.
- **F-3.2** Verwaltung von LLM-Anbindungen: Endpunkt, Modellname, Zugangsdaten,
  Parameter (u. a. Temperatur, Kontextlänge, Zeitlimit).
- **F-3.3** Parallele Pflege mehrerer Anbindungen — lokal (z. B. Ollama, vLLM)
  und extern (Cloud-APIs) — mit Kennzeichnung, welche Daten die Instanz verlassen
  dürfen.
- **F-3.4** Verbindungstest je Anbindung.
- **F-3.5** Definition der HITL-Stufen samt Bezeichnung, Beschreibung und
  erlaubtem Verhalten. *Der konkrete Schnitt der Stufen ist offen — siehe
  [vision.md, Abschnitt 8.1](vision.md).*
- **F-3.6** Je HITL-Stufe ein eigener, frei editierbarer System-Prompt.
- **F-3.7** Freigabe von Werkzeugen je HITL-Stufe: welche GIS-Operationen auf
  welcher Stufe ohne Rückfrage ausgeführt werden dürfen.
- **F-3.8** Festlegung, welche HITL-Stufen der Anwender selbst wählen darf und
  welche Stufe voreingestellt ist.
- **F-3.9** Konfiguration von Grenzwerten: maximale Ergebnismenge, Laufzeit je
  Abfrage, Anzahl Modellschritte je Anfrage.
- **F-3.10** Verwaltung externer MCP-Server (Client-Rolle): Registrierung,
  Werkzeug-Freigabe, Deaktivierung.
- **F-3.11** Konfiguration des eigenen MCP-Servers (Server-Rolle): Zugangstoken,
  exponierte Werkzeuge, zugängliche Layer.
- **F-3.12** Benutzer- und Rollenverwaltung mit Anmeldung.

### 3.1 Bewertung der Modellanbindungen

*Etappe E3, unmittelbar nach der Modellanbindung ([etappen.md 5](etappen.md));
Konzept in [bewertung.md](bewertung.md). Der Verbindungstest (F-3.4) belegt die
Erreichbarkeit einer Anbindung, nicht ihre Eignung — diese Anforderungen
schliessen die Lücke.*

- **F-3.13** Prüffallbestand als versioniertes, exportier- und importierbares
  Artefakt (F-10.4): Fragestellung, Arbeitsweise, Referenzabfrage,
  Referenzergebnis und Toleranzen gegen den Beispieldatensatz (F-10.5), sowie
  Fälle ohne Referenzabfrage mit erwarteter Verhaltensklasse (F-5.13, F-5.14,
  F-5.18).
- **F-3.14** Übernahme einer protokollierten Modellaktion (F-6.8) in den
  Prüffallbestand, mit der erzeugten Abfrage als Referenz.
- **F-3.15** Bewertungslauf über wählbare Anbindungen, Prüffälle, Arbeitsweisen
  und System-Prompts (F-3.6), mit Wiederholung je Fall; ausschliesslich lesend
  (F-9.5) und unter denselben serverseitig durchgesetzten Grenzwerten wie der
  Betrieb (F-9.6).
- **F-3.16** Dreistufige Bewertung je Abfragefall: Formgültigkeit gegen das
  Schema (F-5.5), normalisierter Vergleich mit der Referenzabfrage, Vergleich
  der ausgeführten Ergebnisse (F-8.9).
- **F-3.17** Kennzahlen zu Aufwand und Verhalten je Anbindung: Antwortzeit,
  Schrittzahl der Werkzeugkette, Anteil nicht formgültiger Antworten, Anteil
  in Grenzwerte gelaufener Läufe, Erfüllung der Verhaltensfälle.
- **F-3.18** Vergleichsdarstellung über mehrere Anbindungen mit Einzelansicht je
  Prüffall (erzeugte Abfrage, Referenz, Unterschied, beide Ergebnismengen);
  jeder Lauf ist mit Schemaversion, Datenstand, System-Prompt und
  Modellparametern beschriftet und bleibt zum Vergleich erhalten.

## 4 Klassik-Modus

- **F-4.1** Layer-Auswahl mit Reihenfolge, Sichtbarkeit und Transparenz.
- **F-4.2** Attributfilter mit verknüpfbaren Bedingungen (UND/ODER, Vergleich,
  Wertebereich, Textsuche, Wert-in-Liste).
- **F-4.3** Räumliche Filter: Kartenausschnitt, gezeichnete Geometrie, Auswahl
  eines Bezugsobjekts.
- **F-4.4** Räumliche Verknüpfung zweier Layer: enthalten in, schneidet,
  innerhalb einer Distanz.
- **F-4.5** Puffer-Operation um Objekte eines Layers.
- **F-4.6** Attributbezogene Verknüpfung (Join) zwischen Sachdaten und
  Geometrie-Layer.
- **F-4.7** Aggregation nach Bezugsgebiet: Anzahl, Summe, Mittelwert, Minimum,
  Maximum.
- **F-4.8** Symbolisierung: Einzelfarbe, Klassifizierung nach Attributwert
  (Kategorien, Quantile, gleiche Intervalle), abgestufte Grösse.
- **F-4.9** Kartenbedienung: Zoom, Verschieben, Hintergrundkarte, Legende,
  Massstab, Objekt-Popup.
- **F-4.10** Speichern und Wiederherstellen des gesamten Analysezustands als
  benannte Sitzung.
- **F-4.11** Der Klassik-Modus ist vollständig ohne konfigurierte LLM-Anbindung
  nutzbar.

## 5 LLM-Modus

- **F-5.1** Prompt-Eingabe in natürlicher Sprache innerhalb der Kartenansicht.
- **F-5.2** Auswahl der HITL-Stufe durch den Anwender im vom Administrator
  freigegebenen Rahmen.
- **F-5.3** Auswahl der zu verwendenden LLM-Anbindung, sofern mehrere freigegeben
  sind.
- **F-5.4** Wahl der Arbeitsweise durch den Anwender, je Anfrage und jederzeit
  umschaltbar: **Direktabfrage** (F-5.5) oder **Werkzeugkette** (F-5.6). Beide
  Wege sind dauerhaft verfügbar; das System wählt nicht selbst.
- **F-5.5** *Direktabfrage:* Übersetzung des Prompts in ein einzelnes
  deklaratives, schemavalidiertes Abfrageobjekt (Layer, Filter, Verknüpfungen,
  Aggregation, Symbolisierung, Ausgabeart).
- **F-5.6** *Werkzeugkette:* mehrstufige Bearbeitung durch Aufrufe vordefinierter
  GIS-Werkzeuge, mit sichtbaren Zwischenergebnissen zwischen den Schritten.
- **F-5.7** Beide Arbeitsweisen münden in denselben Analysezustand; das Ergebnis
  einer Werkzeugkette ist als Abfrageobjekt darstellbar und damit ohne Modell
  reproduzierbar.
- **F-5.8** Vergleichbarkeit: Dieselbe Fragestellung lässt sich über beide Wege
  ausführen; Herleitung, Schrittzahl und Ergebnis sind nebeneinander einsehbar.
- **F-5.9** Ausführung ausschliesslich durch die Anwendung, nachdem das
  Abfrageobjekt bzw. der Werkzeugaufruf gegen Schema und Werkzeug-Freigaben
  validiert wurde; Abweisung ungültiger oder nicht freigegebener Abfragen mit
  verständlicher Meldung.
- **F-5.10** Bereitstellung des Layer- und Attributkontexts (F-2.9) an das
  Modell, begrenzt auf die für den Anwender sichtbaren Layer.
- **F-5.11** Anzeige des erzeugten Abfrageobjekts bzw. der geplanten Schrittfolge
  in lesbarer Form vor oder nach der Ausführung — abhängig von der HITL-Stufe.
- **F-5.12** Natürlichsprachliche Erläuterung, wie das Modell den Prompt
  interpretiert hat, inklusive getroffener Annahmen.
- **F-5.13** Rückfrage des Modells bei Mehrdeutigkeit, mit Auswahlmöglichkeit für
  den Anwender.
- **F-5.14** Rückmeldung, wenn die gewählte Arbeitsweise die Fragestellung nicht
  abbilden kann — mit Hinweis auf den jeweils anderen Weg, ohne selbsttätigen
  Wechsel.
- **F-5.15** Dialogverlauf mit Kontextbezug: Folgeprompts verfeinern die
  bestehende Analyse, statt neu zu beginnen.
- **F-5.16** Übernahme jeder vom Modell erzeugten Abfrage in die Bedienelemente
  des Klassik-Modus zur manuellen Weiterbearbeitung.
- **F-5.17** Umgekehrte Richtung: Der aktuelle Klassik-Zustand dient als
  Ausgangspunkt des nächsten Prompts.
- **F-5.18** Verständliche Fehlermeldung bei nicht erreichbarem Modell, Zeitüber-
  schreitung oder nicht beantwortbarer Fragestellung — ohne Verlust des
  Analysezustands.

## 6 HITL-Steuerung

- **F-6.1** Die aktive HITL-Stufe ist in der Oberfläche jederzeit sichtbar.
- **F-6.2** Freigabedialog vor der Ausführung: Anzeige der geplanten Abfrage mit
  Annahme, Ablehnung oder manueller Anpassung.
- **F-6.3** Darstellung der Änderung gegenüber dem bisherigen Analysezustand
  (welche Layer, Filter, Darstellungen sich ändern).
- **F-6.4** Rücknahme der zuletzt durch das Modell ausgelösten Änderung.
- **F-6.5** Bei mehrschrittigem Vorgehen: Anzeige der geplanten Schritte vor
  Beginn und des Fortschritts während der Ausführung.
- **F-6.6** Abbruchmöglichkeit während einer laufenden Modellaktion.
- **F-6.7** Durchsetzung der HITL-Regeln im Backend, unabhängig von der
  Oberfläche — auch für Anfragen über den MCP-Server.
- **F-6.8** Protokollierung jeder Modellaktion: Prompt, HITL-Stufe, erzeugte
  Abfrage, Freigabeentscheidung, Ergebnisumfang, Zeitstempel, Benutzer.
- **F-6.9** Einsehbares Protokoll für Administrator und Anwender.

## 7 LLM-Anbindung und MCP

- **F-7.1** Anbindung lokal gehosteter Modelle über deren HTTP-API.
- **F-7.2** Anbindung externer Modell-APIs, sofern vom Administrator freigegeben.
- **F-7.3** Einheitliche interne Abstraktion der Modellanbindung, sodass Anbieter
  ohne Eingriff in die Fachlogik ergänzt werden können.
- **F-7.4** Werkzeugaufrufe (Tool Calling) als Mechanismus zwischen Anwendung und
  Modell.
- **F-7.5** **MCP-Server-Rolle:** Bereitstellung der GIS-Werkzeuge — Layer
  auflisten, Layer beschreiben, Abfrage ausführen, Aggregation, Export — für
  externe LLM-Clients.
- **F-7.6** Authentifizierung und Freigabesteuerung für externe MCP-Clients, mit
  Begrenzung auf freigegebene Layer und Werkzeuge.
- **F-7.7** Anwendung der HITL-Regeln auch auf dem MCP-Server-Pfad. *Der
  Mechanismus für Freigaben ohne eigene Oberfläche ist offen — siehe
  [vision.md, Abschnitt 8.2](vision.md).*
- **F-7.8** **MCP-Client-Rolle:** Einbinden externer MCP-Server; deren Werkzeuge
  stehen dem Modell im LLM-Modus nach Freigabe zur Verfügung.
- **F-7.9** Kennzeichnung der Herkunft: Ergebnisse, die auf externen MCP-Servern
  beruhen, sind als solche erkennbar.

## 8 Ergebnisartefakte

- **F-8.1** Interaktive Karte mit gefilterten Layern, Symbolisierung, Legende und
  Objekt-Popups.
- **F-8.2** Attributtabelle der aktuellen Auswahl: sortierbar, spaltenweise
  konfigurierbar, mit wechselseitiger Hervorhebung zwischen Tabelle und Karte.
- **F-8.3** Diagramme über Attribut- und Aggregationswerte: Balken, Linie,
  Streuung, Histogramm.
- **F-8.4** Kennzahlen zur aktuellen Auswahl: Objektanzahl, Summen, Mittelwerte.
- **F-8.5** Wahl der Ausgabeart im LLM-Modus durch das Modell, überschreibbar
  durch den Anwender.
- **F-8.6** Export der Ergebnisdaten als GeoJSON und CSV.
- **F-8.7** Export der Kartenansicht als Bilddatei.
- **F-8.8** Ergebnisbericht: vom Modell erzeugte Zusammenfassung aus
  Fragestellung, verwendeten Daten, angewandter Abfrage und Resultat — inklusive
  Annahmen und Einschränkungen.
- **F-8.9** Jedes Ergebnis ist mit der zugrunde liegenden Abfrage verknüpft und
  ohne Modell reproduzierbar.

## 9 Sicherheit und Betrieb

- **F-9.1** Vollständiger Betrieb ohne ausgehende Internetverbindung, wenn
  ausschliesslich lokale Modelle konfiguriert sind.
- **F-9.2** Verschlüsselte Ablage von Zugangsdaten und Token.
- **F-9.3** Keine Übermittlung von Geodaten-Inhalten an externe Modelle ohne
  ausdrückliche Freigabe; standardmässig gehen nur Struktur- und Metadaten in den
  Kontext.
- **F-9.4** Sichtbarer Hinweis in der Oberfläche, wenn ein externes Modell aktiv
  ist.
- **F-9.5** Keine schreibenden Datenoperationen über den LLM-Pfad.
- **F-9.6** Grenzwerte für Laufzeit, Ergebnisgrösse und Modellschritte werden
  serverseitig durchgesetzt.
- **F-9.7** Containerbasierte Bereitstellung mit dokumentiertem Aufsetzen, in
  zwei Ausprägungen: ein einzelner Container mit SpatiaLite-Datei für Vorführung
  und Entwicklung, und ein Verbund mit PostGIS-Dienst für den produktiven
  Betrieb. Beide nutzen denselben Programmstand (F-2.13).
- **F-9.8** Sicherung und Wiederherstellung des Datenbestands je Backend:
  Kopieren der SpatiaLite-Datei bzw. Datenbank-Dump bei PostGIS.
- **F-9.9** Konfiguration über Umgebungsvariablen bzw. Konfigurationsdateien,
  getrennt vom Programmcode.

## 10 Erweiterbarkeit

- **F-10.1** Datenzugriffsschicht hinter einer Schnittstelle, die den Austausch
  des Datenbank-Backends erlaubt. Die deklarativen Abfrageobjekte (F-10.3) sind
  backend-neutral; die Übersetzung in SQL-Dialekt und Raumfunktionen geschieht je
  Backend. Dass mit SpatiaLite und PostGIS von Beginn an zwei Umsetzungen
  bestehen, hält diese Grenze überprüfbar.
- **F-10.2** GIS-Werkzeuge als Registry: neue Werkzeuge lassen sich ergänzen und
  stehen anschliessend in Klassik-Modus, LLM-Modus und MCP-Server gleichermassen
  zur Verfügung.
- **F-10.3** Schema der deklarativen Abfrageobjekte als eigenständiges,
  versioniertes Artefakt.
- **F-10.4** System-Prompts und HITL-Konfiguration als exportier- und
  importierbare Konfiguration, um Varianten vergleichen zu können.
- **F-10.5** Beispieldatensatz und Beispiel-Prompts, mit denen sich der
  Demonstrator ohne eigene Daten vorführen lässt.
- **F-10.6** Mehrsprachige Oberfläche, Ausgangssprache Deutsch.
- **F-10.7** Automatisierte Tests der Datenzugriffsschicht laufen gegen beide
  Backends mit demselben Testfallbestand; abweichende Ergebnisse gelten als
  Fehler, nicht als Backend-Eigenart.

## 11 Nicht im Umfang

Bewusst ausgeschlossen, um den Demonstrator schlank zu halten:

- Rasterdaten (GeoTIFF, COG) und rasterbasierte Analysen
- OGC-Dienste als Datenquelle (WMS, WFS, WMTS)
- Bearbeiten von Geometrien und Sachdaten durch Anwender
- Generiertes SQL oder generierter Programmcode als LLM-Ausgabe
- Zeitreihen- und Bewegungsdatenanalyse
- Gleichzeitiges Arbeiten mehrerer Anwender an derselben Analyse
- Mandantenfähigkeit, Hochverfügbarkeit, Skalierung über den Demonstrator hinaus
- Training oder Fine-Tuning eigener Modelle
- Bewertung generierter Abfragen durch ein zweites Modell (LLM-as-Judge) sowie
  allgemeine Modellranglisten; der Prüfmassstab liegt deterministisch vor
  ([bewertung.md 2](bewertung.md))
- Rückmigration PostGIS → SpatiaLite sowie der gleichzeitige Betrieb beider
  Backends auf einem Datenbestand; der Weg ist einseitig gedacht (F-2.15)
- Weitere Datenbank-Backends über SpatiaLite und PostGIS hinaus; die
  Zugriffsschicht lässt sie zu (F-10.1), der Demonstrator liefert sie nicht mit

## 12 Bezug zu den offenen Designfragen

Folgende Anforderungen sind bewusst unvollständig, weil die zugehörige
Entscheidung noch aussteht ([vision.md, Abschnitt 8](vision.md)):

*Bereits entschieden:* Die Grenze zwischen deklarativem Abfrageobjekt und
Werkzeugaufruf wird nicht vom System gezogen — beide Arbeitsweisen sind dauerhaft
verfügbar und der Anwender wählt (F-5.4 bis F-5.8,
[vision.md, Abschnitt 4.4](vision.md)).

| Anforderung | Offene Entscheidung |
|---|---|
| F-3.5, F-3.7, F-3.8 | Schnitt der HITL-Stufen: global vierstufig, global dreistufig oder je Operationsklasse |
| F-7.7 | Durchsetzung der Freigabestufen ohne eigene Oberfläche beim MCP-Server-Zugang |
| F-5.13 | Verhalten bei Mehrdeutigkeit: Rückfrage, Annahme mit Kennzeichnung oder Varianten zur Auswahl |
| F-5.14 | Form der Rückmeldung, wenn die gewählte Arbeitsweise nicht ausreicht |
| F-2.8, F-2.9 | Erforderliche Tiefe der semantischen Metadaten und deren Pflegeprozess |
| F-3.9, F-9.6 | Konkrete Grenzwerte für Ergebnismenge, Laufzeit und Modellschritte |
| F-2.14 | Wie weit die Funktionsgleichheit beider Backends trägt — und was geschieht, wo SpatiaLite hinter PostGIS zurückbleibt: Operation streichen, im Anwendungscode nachbilden oder als backend-abhängig kennzeichnen |
| F-3.13, F-3.16 | Tiefe der Normalisierung beim Abfragevergleich und Toleranzen beim Ergebnisvergleich ([bewertung.md 12](bewertung.md)) |
| F-2.11, F-3.9 | Ab welcher Datenmenge und Ergebnisgrösse SpatiaLite für die Vorführung nicht mehr trägt und der Umstieg fällig wird |
