# GeoTandem — Etappen

> Status: Entwurf v0.3 · Stand: 2026-09-30 · Bezug: [vision.md](vision.md),
> [anforderungen.md](anforderungen.md)
>
> *Was* gebaut wird, steht in den Anforderungen; *warum*, in der Vision. Dieses
> Dokument regelt nur die Reihenfolge, die Abhängigkeiten und den Zuschnitt der
> Arbeitspakete. Es ändert sich häufiger als die beiden anderen.

## 1 Vorgehen

Der Demonstrator entsteht in sechs aufeinander aufbauenden Etappen **E1 bis E6**,
begleitet von einem Querstrang **P** (Produktionspfad), der ab E2 nebenher läuft.

Jede Etappe endet mit einer Vorführung, die ohne die folgenden Etappen
auskommt. Das ist die eigentliche Schnittregel: Eine Etappe, die sich nicht für
sich allein zeigen lässt, ist falsch geschnitten.

Zur Begriffstrennung: *Etappe* (E1–E6) ist der Bauabschnitt, *Modus* (A Klassik,
B LLM-Support) die Arbeitsweise in der fertigen Anwendung. E1 liefert Modus A,
E2 Modus B.

## 2 Regeln für die Umsetzung durch Agents

- **Verträge vor Parallelisierung.** Abfrageobjekt-Schema, Werkzeug-Registry und
  die HTTP-Schnittstelle entstehen in E1.2 und liegen danach fest. Vor diesem
  Punkt wird nicht parallel gearbeitet — zwei Agents ohne gemeinsames Datenmodell
  bauen zwei Anwendungen.
- **Ein Arbeitspaket ist ein abgeschlossener Auftrag.** Es nennt seinen Bezug auf
  F-Kennungen, ein prüfbares „Fertig wenn" und die Testfälle, an denen es
  gemessen wird.
- **Der Beispieldatensatz (F-10.5) entsteht in E1.1**, nicht am Ende. Jedes
  spätere Paket braucht etwas, wogegen es prüfen kann.
- **Domänenbegriffe stehen in einer `CONTEXT.md`** im Repository — Layer,
  Abfrageobjekt, Werkzeug, HITL-Stufe, Sitzung, Analysezustand —, damit
  implementierende Agents dieselbe Sprache verwenden wie diese Dokumente.
- **Kein stiller Umfangszuwachs.** Was nicht in den Anforderungen steht, wird
  nicht gebaut. Fehlt etwas, wird die Lücke gemeldet, statt sie zu erfinden.
- **Automatisierte Tests je Paket**, Abnahme über das Vorführskript der Etappe.

## 3 E1 — Standalone-Anwendung, Modus A

Ziel: eine vollständig benutzbare GIS-Anwendung ohne jede LLM-Beteiligung.

| Paket | Inhalt | F-Bezug | Fertig wenn |
|---|---|---|---|
| **E1.1** | Gerüst: Container, Konfiguration, SpatiaLite-Datei beim ersten Start, versionierte Schema-Migrationen, Beispieldatensatz als Fixture | F-2.12, F-2.17, F-9.7, F-9.9, F-10.5 | Ein Befehl startet die Anwendung auf einem leeren System, ohne Datenbankdienst |
| **E1.2** | **Sperrpunkt:** Abfrageobjekt-Schema v0, Ausführungsmaschine gegen SpatiaLite, Werkzeug-Registry, Datenzugriffsschicht hinter Schnittstelle | F-2.11, F-2.13, F-2.14, F-10.1, F-10.2, F-10.3 | Ein von Hand geschriebenes Abfrageobjekt läuft gegen die Beispieldaten und liefert ein reproduzierbares Ergebnis |
| **E1.3** | Import (Vektor, Tabellen mit Geobezug), Vorschau, CRS-Transformation, Layer-Verwaltung, Attribut-Metadaten, Importprotokoll | F-2.1–F-2.10 | Alle drei Importwege enden als verwalteter Layer mit Raumindex und gepflegten Metadaten |
| **E1.4** | Anmeldung, Rollen Administrator/Anwender, Adminbereich-Grundgerüst, Layer-Sichtbarkeit je Rolle | F-2.7, F-3.1, F-3.12 | Zwei Konten mit unterschiedlichen Rollen sehen unterschiedliche Layer |
| **E1.5** | Karte und Klassik-Bedienung: Layer-Auswahl, Attribut- und Raumfilter, räumliche Verknüpfung, Puffer, Join, Aggregation, Symbolisierung, Kartenbedienung | F-4.1–F-4.9, F-8.1 | Jede Bedienhandlung erzeugt ein gültiges Abfrageobjekt nach E1.2 — die Oberfläche ist dessen Editor, kein zweiter Weg an der Maschinerie vorbei |
| **E1.6** | Attributtabelle mit Sortierung, Spaltenwahl und wechselseitiger Hervorhebung zur Karte | F-8.2 | Treffer lassen sich lesen und nicht nur zählen |
| **E1.7** | Analysezustand als benannte Sitzung speichern und wiederherstellen | F-4.10, F-8.9 | Eine gespeicherte Sitzung liefert nach Neustart dasselbe Ergebnis |

> **Sperrpunkt nachgeschärft in E1.5 (2026-10-03):** Das Abfrageobjekt-Schema
> v0 liess Raumbeziehungen nur einmal und ausserhalb des Bedingungsbaums zu;
> die Klassik-Bedienung braucht sie mit UND/ODER/NICHT kombinierbar. Schema v1
> ergänzt die Bedingung `related` — rein additiv, jedes v0-Dokument gilt
> unverändert ([docs/plan-e1.5.md](docs/plan-e1.5.md), S1).
>
> **Erneut ergänzt in E1.6 (2026-10-03):** Die Attributtabelle zeigt, *warum*
> ein Objekt Treffer ist — Distanz zur Strasse, Wert des Gebiets. Schema v2
> ergänzt dafür berechnete Spalten (`columns`), wieder rein additiv: jedes v0-
> und v1-Dokument gilt mit demselben Ergebnis ([docs/plan-e1.6.md](docs/plan-e1.6.md), S4).

**Vorführung E1:** Eine mehrschichtige räumliche Fragestellung wird vollständig
von Hand beantwortet, als Sitzung gespeichert und reproduziert — ohne
konfigurierte LLM-Anbindung (F-4.11).

> **E1 abgeschlossen (2026-10-03).** Die Vorführung ist als Abnahmetest
> festgehalten (`e2e/tests/acceptance-e1.7.spec.ts`): Das Prüfskript (`make
> gate`) beantwortet die Referenzfrage von Hand, speichert sie, startet den
> Container neu und findet die Sitzung danach mit identischem Ergebnis wieder
> ([docs/plan-e1.7.md](docs/plan-e1.7.md)).
>
> **E1.9 vor E2 eingeschoben (2026-10-04): Grundlage der Mehrsprachigkeit.**
> Alle Texte der Oberfläche stehen in einem Meldungskatalog (vorerst nur
> Deutsch), Zahlen und Daten folgen einer zentralen Formatierungs-Locale, und
> Ablehnungen des Backends erscheinen über ihren Code. Damit entsteht jede
> Oberfläche ab E2 gleich übersetzbar; Französisch und weitere Sprachen samt
> Sprachwahl bleiben nach E6 ([docs/plan-e1.9.md](docs/plan-e1.9.md)).

## 4 E2 — Lokale LLM-Anbindung, Modus B

Ziel: dieselbe Fragestellung per Prompt, unter sichtbarer und durchgesetzter
menschlicher Kontrolle.

| Paket | Inhalt | F-Bezug | Fertig wenn |
|---|---|---|---|
| **E2.0** | Entscheidung zum Schnitt der HITL-Stufen als Setzung für den Bau (Option A, B oder C aus [vision.md 8.1](vision.md)) | F-3.5 | Die Stufen sind benannt, beschrieben und in ihrem erlaubten Verhalten festgelegt |
| **E2.1** | Verwaltung der LLM-Anbindungen, Verbindungstest, interne Abstraktion der Modellanbindung, Anbindungswahl durch den Anwender, verschlüsselte Ablage der Zugangsdaten | F-3.2–F-3.4, F-5.3, F-7.1, F-7.3, F-9.2 | Ein lokales Modell ist angebunden, der Verbindungstest läuft grün und die Anwendung arbeitet ohne ausgehende Internetverbindung (F-9.1) |
| **E2.2** | Layer-Steckbrief als Modellkontext, begrenzt auf sichtbare Layer | F-2.9, F-5.10 | Das Modell kennt Layer und Attribute, ohne Geodaten-Inhalte zu sehen (F-9.3) |
| **E2.3** | Direktabfrage: Prompt → Abfrageobjekt nach E1.2, Schemavalidierung, Abweisung ungültiger Abfragen, lesbare Anzeige, Erläuterung der Interpretation | F-5.1, F-5.5, F-5.9, F-5.11, F-5.12, F-9.5 | Ein Prompt erzeugt dasselbe Abfrageobjekt, das in E1 von Hand gebaut wurde; schreibende Operationen sind auf diesem Pfad ausgeschlossen |
| **E2.4** | HITL-Stufen: System-Prompt je Stufe, Werkzeug-Freigaben, Stufenwahl im freigegebenen Rahmen, Freigabedialog, Änderungsanzeige, Rücknahme, Abbruch, Protokollierung, Durchsetzung im Backend | F-3.6–F-3.8, F-5.2, F-6.1–F-6.9 | Eine Stufe ohne Freigabepflicht und eine mit Freigabepflicht verhalten sich nachweislich unterschiedlich, und die Regel greift auch an der Oberfläche vorbei |
| **E2.5** | Werkzeugkette: mehrstufige Bearbeitung über Tool Calling, sichtbare Zwischenergebnisse, Schrittanzeige, serverseitige Grenzwerte | F-3.9, F-5.4, F-5.6–F-5.8, F-6.5, F-7.4, F-9.6 | Dieselbe Fragestellung ist über beide Arbeitsweisen lösbar, beide münden in denselben Analysezustand, und Herleitung, Schrittzahl und Ergebnis sind nebeneinander einsehbar |
| **E2.6** | Übergänge A↔B, Dialogverlauf mit Kontextbezug, Mehrdeutigkeit, Rückmeldung bei unpassender Arbeitsweise, Fehlerfälle ohne Zustandsverlust | F-5.13–F-5.18 | Eine vom Modell erzeugte Abfrage lässt sich von Hand weiterbearbeiten und umgekehrt |

**Vorführung E2:** Ein Anwender ohne GIS-Vorkenntnisse beantwortet die
Fragestellung aus E1 per Prompt; ein zweiter Durchlauf zeigt einen Fall, in dem
die Prüfung vor der Ausführung einen Modellfehler abfängt
([vision.md 9](vision.md), Kriterien 1, 2 und 4).

## 5 E3 — Bewertung der Modellanbindungen

Ziel: Der Administrator kann messen, welche Modellanbindung taugt, statt es zu
vermuten.

Die Etappe steht hier, weil sie ab hier möglich ist. Mit E2 liegen Anbindung,
Direktabfrage, Werkzeugkette und Protokoll vor — alles, was die Bewertung
braucht, und nichts davon stammt aus einer späteren Etappe. Wer sie ans Ende
schiebt, führt E4 bis E6 mit einer Modellwahl vor, die auf nichts beruht ausser
dem Verbindungstest. Begründung und Konzept stehen in
[bewertung.md](bewertung.md).

| Paket | Inhalt | F-Bezug | Fertig wenn |
|---|---|---|---|
| **E3.1** | Prüffallformat und Startbestand: Abfragefälle mit Referenzabfrage und Referenzergebnis, Verhaltensfälle mit erwarteter Klasse, beides gegen den Beispieldatensatz; aus- und einlesbar | F-3.13, F-10.4, F-10.5 | Der Prüffallbestand liegt als versioniertes Artefakt im Repository und übersteht einen Export-Import-Umlauf unverändert |
| **E3.2** | Bewertungsmaschinerie: Normalisierung und die drei Stufen Formgültigkeit, Abfragegleichheit, Ergebnisgleichheit | F-3.16 | Eine anders formulierte, aber richtige Abfrage gilt als richtig; eine der Referenz ähnliche, aber falsche fällt durch |
| **E3.3** | Laufsteuerung: Auswahl von Anbindungen, Fällen, Arbeitsweise und System-Prompt, Wiederholung je Fall, Messung von Zeit und Schrittzahl, Ablage der Läufe | F-3.15, F-3.17, F-9.5, F-9.6 | Ein Lauf über mehrere Anbindungen ist ausschliesslich lesend, hält die Grenzwerte ein und weist neben der Quote die Streuung über die Wiederholungen aus |
| **E3.4** | Übernahme protokollierter Modellaktionen in den Prüffallbestand | F-3.14, F-6.8 | Eine im Betrieb freigegebene Modellaktion wird aus dem Protokoll heraus zum Prüffall, ohne Abtippen |
| **E3.5** | Vergleichsdarstellung im Administrationsbereich: Matrix über Anbindungen, Einzelansicht je Fall mit Unterschied und beiden Ergebnismengen, Beschriftung des Laufs | F-3.1, F-3.18 | Der Administrator erkennt nicht nur, *dass* eine Anbindung schlechter abschneidet, sondern woran es liegt |

**Vorführung E3:** Zwei Modellanbindungen werden über denselben Prüffallbestand
gefahren; die Vergleichsmatrix trägt die Freigabeentscheidung (F-3.3, F-3.8).
Ein zweiter Lauf stellt dieselbe Anbindung mit zwei System-Prompts gegenüber —
die Bewertung misst damit nicht nur Modelle, sondern auch die eigene
Konfiguration (F-10.4).

**Voraussetzung aus E2.** Drei Kleinigkeiten müssen dort mitentstehen, sonst
sind sie hier teuer nachzurüsten: Die Anbieterabstraktion reicht Antwortzeit und
gemeldeten Tokenverbrauch durch, statt sie wegzuwerfen; das Protokoll legt das
erzeugte Abfrageobjekt maschinenlesbar ab und nicht nur als Anzeigetext; und der
System-Prompt einer HITL-Stufe ist beim Aufruf überschreibbar, ohne die
Konfiguration des laufenden Betriebs zu ändern
([bewertung.md 10](bewertung.md)).

## 6 E4 — MCP-Server-Rolle

GeoTandem stellt seine GIS-Werkzeuge nach aussen bereit. Die umgekehrte
Richtung — externe Server einbinden — ist eine eigene Etappe (E6).

| Paket | Inhalt | F-Bezug | Fertig wenn |
|---|---|---|---|
| **E4.1** | Server-Rolle: GIS-Werkzeuge nach aussen bereitstellen, Zugangstoken, Begrenzung auf freigegebene Layer und Werkzeuge | F-3.11, F-7.5, F-7.6 | Ein externer Client führt eine Analyse über die bereitgestellten Werkzeuge durch |
| **E4.2** | Durchsetzung der HITL-Regeln auf dem MCP-Pfad; der Mechanismus ist offen ([vision.md 8.2](vision.md)) | F-6.7, F-7.7 | Eine auf der gewählten Stufe freigabepflichtige Operation kommt auch ohne eigene Oberfläche nicht ungeprüft durch |

## 7 E5 — Diagramme, Kennzahlen, Export

| Paket | Inhalt | F-Bezug | Fertig wenn |
|---|---|---|---|
| **E5.1** | Diagramme und Kennzahlen zur aktuellen Auswahl | F-8.3, F-8.4 | Balken, Linie, Streuung und Histogramm stehen über Attribut- und Aggregationswerten zur Verfügung |
| **E5.2** | Wahl der Ausgabeart durch das Modell, überschreibbar durch den Anwender | F-8.5 | Der Anwender kann die Entscheidung des Modells überstimmen |
| **E5.3** | Export: Ergebnisdaten als GeoJSON und CSV, Kartenansicht als Bild | F-8.6, F-8.7 | Ein Ergebnis verlässt die Anwendung in allen drei Formaten |
| **E5.4** | Ergebnisbericht aus Fragestellung, Daten, Abfrage und Resultat samt Annahmen | F-8.8 | Der Bericht nennt die verwendete Abfrage und die getroffenen Annahmen |

Die Verknüpfung jedes Ergebnisses mit seiner Abfrage (F-8.9) entsteht bereits in
E1.2 und wird hier nur auf die neuen Artefakte ausgedehnt.

## 8 E6 — MCP-Client-Rolle

Die Gegenrichtung zu E4: Nicht andere greifen auf GeoTandem zu, sondern
GeoTandem bindet fremde Werkzeuge ein — Geocoding, Statistik, Fachdatenzugriffe —
und erweitert damit den Datenraum über die importierten Layer hinaus.

| Paket | Inhalt | F-Bezug | Fertig wenn |
|---|---|---|---|
| **E6.1** | Verwaltung externer MCP-Server: Registrierung, Werkzeug-Freigabe, Deaktivierung | F-3.10 | Ein externer Server ist registriert, seine Werkzeuge sind einzeln freigegeben und er lässt sich stilllegen, ohne die Anwendung zu berühren |
| **E6.2** | Einbindung der freigegebenen Werkzeuge in den LLM-Modus, unter denselben HITL-Regeln und Werkzeug-Freigaben wie die eigenen | F-3.7, F-6.7, F-7.8 | Ein externes Werkzeug ist für das Modell nicht privilegierter als ein eigenes: dieselbe Stufe, dieselbe Freigabepflicht |
| **E6.3** | Kennzeichnung der Herkunft in Ergebnis, Protokoll und Bericht | F-7.9, F-8.8 | Jeder Beitrag eines externen Servers ist im Ergebnis als solcher erkennbar |

**Vorführung E6:** Eine Fragestellung, die mit den importierten Layern allein
nicht beantwortbar ist, wird über ein externes Werkzeug gelöst; das Ergebnis
weist aus, welcher Teil von aussen stammt.

**Offener Punkt:** F-9.3 verbietet die Übermittlung von Geodaten-Inhalten an
externe *Modelle* ohne ausdrückliche Freigabe. Ein externer MCP-Server ist
derselbe Weg nach draussen, von der Anforderung aber nicht erfasst. Vor E6.2 ist
zu klären, ob F-9.3 entsprechend erweitert wird — andernfalls hebelt die
Client-Rolle Leitprinzip 5 („Daten bleiben im Haus") aus.

## 9 Querstrang P — Produktionspfad, parallel ab E2

Läuft ab E2 neben den übrigen Etappen, ohne deren Reihenfolge zu berühren. Voraussetzung ist der
Sperrpunkt E1.2: Erst wenn die Zugriffsschicht steht, lohnt ein zweiter Adapter.

| Paket | Inhalt | F-Bezug |
|---|---|---|
| **P.1** | PostGIS-Adapter hinter derselben Zugriffsschicht | F-2.11, F-2.13, F-10.1 |
| **P.2** | Gemeinsame Testsuite gegen beide Backends; abweichende Ergebnisse gelten als Fehler | F-2.14, F-10.7 |
| **P.3** | Migrationswerkzeug SpatiaLite → PostGIS mit Prüfbericht | F-2.15, F-2.16 |
| **P.4** | Betrieb: Container-Verbund mit PostGIS-Dienst, Sicherung und Wiederherstellung je Backend | F-9.7, F-9.8 |

**Arbeitsregel:** Jede ab E2 neu hinzukommende Datenoperation wird in beiden
Adaptern umgesetzt und in P.2 abgedeckt. Sonst wächst der Rückstand des
Querstrangs schneller, als P ihn abarbeiten kann — und aus „Konfiguration plus
Migration" wird doch ein Umbau.

## 10 Nach E6

Nicht Teil der sechs Etappen, sinnvoll erst danach:

- Externe Modell-APIs samt Kennzeichnung und Freigabe der Datenweitergabe
  (F-7.2, F-9.3, F-9.4) — der lokale Betrieb ist der Normalfall und muss zuerst
  tragen.
- Mehrsprachige Oberfläche (F-10.6): Französisch, dann Italienisch und
  Englisch, samt Sprachwahl. Die Grundlage dafür entsteht in E1.9.
- Export und Import der HITL- und Prompt-Konfiguration zum Vergleich von
  Varianten (F-10.4), sobald die Stufen aus E2.0 sich in der Praxis bewährt
  haben oder eben nicht.

## 11 Noch zu bestätigende Annahmen

Diese Punkte stehen in den Etappen bereits eingeplant, sind aber nicht
entschieden:

1. ~~**Benutzerverwaltung in E1.4** beschränkt sich auf lokale Konten mit den zwei
   Rollen — keine Gruppen, kein SSO.~~ So gebaut (2026-10-03).
2. **E2.0 setzt den HITL-Schnitt fest**, statt ihn offenzuhalten; der
   Demonstrator prüft die Setzung anschliessend, statt sie zu umgehen.
3. **E6 setzt E2 voraus, nicht E4.** Die Client-Rolle wirkt im LLM-Modus; sie
   liesse sich auch vor der Server-Rolle bauen. Die Reihenfolge E4 vor E6 ist
   gewählt, weil die Server-Rolle das aufschlussreichere Stück ist
   ([vision.md 4.5](vision.md)).
4. **Der Ergebnisbericht (E5.4)** bleibt in E5, obwohl er auch als Abschluss von
   E2 denkbar wäre.
5. **E3 wird einmal gebaut, nicht als Querstrang mitgeführt.** Die Bewertung
   misst den Weg über die eigene Oberfläche; Werkzeuge externer MCP-Server (E6)
   und der Zugang über die Server-Rolle (E4) bleiben aussen vor. Wächst der
   Bedarf, wird daraus ein Strang neben P — dann aber bewusst und nicht
   nebenbei.
