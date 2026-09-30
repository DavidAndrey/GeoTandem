# GeoTandem — Bewertung der Modellanbindungen

> Status: Entwurf v0.2 · Stand: 2026-09-30 · Bezug: [vision.md](vision.md),
> [anforderungen.md](anforderungen.md), [etappen.md](etappen.md),
> [tech-stack.md](tech-stack.md)
>
> Dieses Dokument beantwortet eine Frage, die die anderen vier offenlassen:
> Woran erkennt der Administrator, welche der konfigurierten LLM-Anbindungen er
> freigeben soll?
>
> Gebaut wird sie in **Etappe E3** ([etappen.md 5](etappen.md)), unmittelbar
> nach der Modellanbindung: Sobald sich Modelle benutzen lassen, muss sich auch
> sagen lassen, welches taugt. Dieses Dokument liefert die Begründung und den
> Entwurf hinter den Paketen E3.1 bis E3.5; der Zuschnitt der Pakete selbst
> steht in den Etappen. Abschnitt 10 nennt, was E2 dafür mitliefern muss — es
> ist wenig, weil fast alles ohnehin entsteht.

## 1 Die Lücke

Der Administrator kann heute mehrere Modellanbindungen parallel pflegen
(F-3.3), sie mit Endpunkt, Modellname und Parametern beschreiben (F-3.2),
festlegen, welche davon der Anwender wählen darf und welche voreingestellt ist
(F-3.8) — und er kann prüfen, ob eine Anbindung erreichbar ist (F-3.4).

Was fehlt, ist die Grundlage der eigentlichen Entscheidung. Der Verbindungstest
beantwortet *„antwortet der Endpunkt?"*, nicht *„taugt dieses Modell für diese
Aufgabe?"*. Zwischen beiden Fragen liegt der gesamte Nutzwert der Anbindung.

Diese Lücke wiegt hier schwerer als in anderen Anwendungen, aus drei Gründen:

- **Der lokale Betrieb ist der Normalfall** ([vision.md 5](vision.md),
  Leitprinzip 5). Gerade bei lokal betreibbaren Modellen ist die Streuung in der
  Fähigkeit, verlässlich strukturierte Ausgaben zu erzeugen, am grössten. Ein
  Modell, das kein schemagültiges Abfrageobjekt zustande bringt, ist für
  GeoTandem unbrauchbar, unabhängig davon, wie es in allgemeinen Ranglisten
  dasteht.
- **Falsche Antworten sind hier besonders teuer.** Ein plausibel aussehendes,
  aber falsch hergeleitetes Ergebnis wirkt durch die Kartendarstellung
  überzeugend ([vision.md 2](vision.md)). Ein Modell, das offen scheitert, ist
  dem überlegen, das still danebenliegt — und diesen Unterschied sieht man einer
  Anbindung nicht an.
- **Die Austauschbarkeit der Modellanbindung ist ein Erfolgskriterium**
  ([vision.md 9](vision.md), Kriterium 8). Austauschbarkeit lässt sich nur
  belegen, wenn man sagen kann, was ein Tausch kostet. Ohne Messung bleibt sie
  eine Behauptung über die Schnittstelle.

## 2 Warum die Bewertung hier belastbar sein kann

Modellbewertung scheitert üblicherweise am fehlenden Prüfmassstab: Die Ausgabe
ist Fliesstext, die richtige Antwort ist Auslegungssache, und am Ende bewertet
ein zweites Modell das erste. Diese Schwierigkeit hat GeoTandem nicht, weil die
Architektur den Massstab bereits mitbringt.

| Vorhandene Eigenschaft | Was sie für die Bewertung leistet |
|---|---|
| Das Modell erzeugt ein **deklaratives, schemavalidiertes Abfrageobjekt** (F-5.5, F-10.3) | Die Ausgabe ist ein vergleichbares Datenobjekt, kein Text. Formgültigkeit ist maschinell entscheidbar, Gleichheit strukturell prüfbar. |
| Jedes Ergebnis ist **ohne Modell reproduzierbar** (F-8.9) | Eine Referenzantwort lässt sich als Abfrageobjekt *und* als dessen Ergebnis hinterlegen. Beide Seiten des Vergleichs sind deterministisch herstellbar. |
| Der **Beispieldatensatz** steht ab E1.1 fest (F-10.5) | Es gibt einen unveränderlichen Datenstand, gegen den alle Läufe vergleichbar bleiben. |
| Jede Modellaktion wird **protokolliert** (F-6.8) | Prüffälle müssen nicht erfunden werden; echte Sitzungen lassen sich zu Prüffällen befördern. |
| Beide Arbeitsweisen münden in **denselben Analysezustand** (F-5.7) | Direktabfrage und Werkzeugkette sind mit demselben Massstab messbar — genau die Gegenüberstellung, die F-5.8 verlangt. |

Daraus folgt die Grundentscheidung dieses Konzepts: **Die Bewertung ist
deterministisch, nicht urteilend.** Es wird kein zweites Modell als Schiedsrichter
eingesetzt. Wo ein belastbarer Massstab vorliegt, würde ein urteilendes Modell
nur Unsicherheit dort einführen, wo keine nötig ist.

## 3 Der Prüffall

Ein Prüffall ist die kleinste Einheit der Bewertung. Er gehört zum
Prüffallbestand, der wie das Abfrageobjekt-Schema ein versioniertes Artefakt im
Repository ist und sich ausführen wie einlesen lässt (F-10.4).

Es gibt zwei Klassen, weil nicht jede sinnvolle Frage eine richtige Antwort hat.

### 3.1 Abfragefälle

Fälle mit einer hinterlegten richtigen Antwort. Sie tragen:

| Bestandteil | Inhalt |
|---|---|
| Fragestellung | der Prompt in natürlicher Sprache, so wie ein Anwender ihn stellen würde |
| Datenstand | Bezug auf den Beispieldatensatz (F-10.5) in einer festen Fassung |
| Arbeitsweise | Direktabfrage, Werkzeugkette oder beide (F-5.4) |
| Referenzabfrage | das Abfrageobjekt, das die Frage korrekt beantwortet, mit Angabe der Schemaversion (F-10.3) |
| Referenzergebnis | der Fingerabdruck des Resultats: Menge der Objektkennungen, Kennzahlen, Aggregatwerte |
| Toleranzen | wo numerische Abweichung zulässig ist (Flächen, Distanzen), und wo nicht (Trefferanzahl) |
| Anmerkung | die fachliche Absicht der Frage, für den Menschen, der eine Abweichung beurteilen muss |

### 3.2 Verhaltensfälle

Fälle ohne Referenzabfrage, weil die richtige Reaktion keine Antwort ist. Sie
hinterlegen statt der Referenz eine **erwartete Verhaltensklasse**:

- **Mehrdeutig** — die Frage lässt mehrere Lesarten zu; erwartet wird eine
  Rückfrage oder eine gekennzeichnete Annahme (F-5.13).
- **Nicht abbildbar in der gewählten Arbeitsweise** — erwartet wird die
  Rückmeldung nach F-5.14, ohne selbsttätigen Wechsel.
- **Nicht beantwortbar mit dem vorhandenen Datenbestand** — erwartet wird eine
  klare Fehlanzeige (F-5.18).

Diese Klasse ist die wichtigere Hälfte der Bewertung, auch wenn sie die kleinere
ist. Ein Modell, das auf eine unbeantwortbare Frage ein sauber geformtes,
inhaltlich erfundenes Abfrageobjekt liefert, fällt in keinem Abfragefall auf —
und ist genau das Modell, vor dem der Demonstrator warnen will.

### 3.3 Herkunft der Prüffälle

Zwei Wege, und der zweite ist der tragfähigere:

1. **Von Hand geschrieben**, zusammen mit dem Beispieldatensatz. Das ist der
   Startbestand — jene Fragestellungen, die in den Vorführungen von E1 und E2
   ohnehin gebraucht werden ([etappen.md 3, 4](etappen.md)).
2. **Aus dem Protokoll befördert.** Das Protokoll hält Prompt, HITL-Stufe,
   erzeugte Abfrage, Freigabeentscheidung und Ergebnisumfang bereits vollständig
   fest (F-6.8). Hat ein Anwender eine Modellantwort geprüft und freigegeben, ist
   damit eine geprüfte Prompt-Abfrage-Paarung entstanden. Der Administrator muss
   sie nur noch als Prüffall übernehmen.

Der zweite Weg ist der Grund, warum der Prüffallbestand nicht als
Pflegeaufgabe endet: Er wächst als Nebenprodukt der Benutzung, und er wächst mit
den Fragen, die tatsächlich gestellt werden, statt mit denen, die man sich beim
Schreiben des Bestandes ausgedacht hat.

## 4 Die drei Bewertungsstufen

Jeder Abfragefall wird in drei aufeinander aufbauenden Stufen bewertet. Eine
nicht bestandene Stufe beendet die Auswertung des Falls.

### Stufe 0 — Formgültigkeit

Lässt sich die Modellausgabe überhaupt als Abfrageobjekt lesen? Ist sie
schemagültig (F-5.5)? Verweist sie ausschliesslich auf Layer, Attribute und
Werkzeuge, die es gibt und die freigegeben sind (F-5.9, F-5.10)?

Binär, ohne Ausführung, ohne Datenbankzugriff. Diese Stufe kostet nichts und
trennt bereits die Anbindungen, die für GeoTandem gar nicht in Frage kommen.

### Stufe 1 — Abfragegleichheit

Entspricht das erzeugte Abfrageobjekt der Referenzabfrage? Der Vergleich
geschieht **normalisiert**: Reihenfolge gleichrangiger Filterbedingungen,
unterschiedlich geklammerte, aber logisch gleichwertige UND/ODER-Verknüpfungen,
ausgeschriebene gegenüber weggelassenen Vorgabewerten und Benennungen von
Zwischenergebnissen dürfen abweichen, ohne dass der Fall als abweichend gilt.

Das Ergebnis dieser Stufe ist **kein Urteil**. Eine Abweichung bedeutet
zunächst nur: anders formuliert. Ob anders auch falsch heisst, entscheidet
Stufe 2.

### Stufe 2 — Ergebnisgleichheit

Die Anwendung führt beide Abfragen aus — die erzeugte und die Referenz — und
vergleicht die Resultate innerhalb der hinterlegten Toleranzen.

Das ist die entscheidende Stufe. Sie erkennt eine anders gebaute, aber richtige
Abfrage als richtig an, und sie entlarvt eine der Referenz strukturell ähnliche,
inhaltlich aber falsche Abfrage. Sie ist nur deshalb möglich, weil die
Ausführung ohne Modell reproduzierbar ist (F-8.9).

> **Das Verhältnis der Stufen:** Stufe 2 fällt das Urteil, Stufe 1 liefert die
> Erklärung dazu. Stufe 1 allein wäre in beide Richtungen unzuverlässig — sie
> würde richtige Antworten als falsch zählen und falsche als richtig
> durchwinken. Sie bleibt trotzdem im Bestand, weil ein Administrator, der eine
> Abweichung in Stufe 2 sieht, wissen will, *woran* es lag; der
> Abfragevergleich zeigt es ihm.

### Die Werkzeugkette an demselben Massstab

Für die Werkzeugkette gelten dieselben drei Stufen, verschoben um eine Ebene:
Stufe 0 prüft die einzelnen Werkzeugaufrufe gegen die Registry, Stufe 2 arbeitet
unverändert auf dem Endergebnis, und Stufe 1 vergleicht nicht die Schrittfolge,
sondern das Abfrageobjekt, als das sich das Ergebnis der Kette ausdrücken lässt
(F-5.7).

Dass beide Arbeitsweisen damit an einem Massstab hängen, ist der Punkt: Erst
so wird die Gegenüberstellung aus F-5.8 mehr als ein Nebeneinanderstellen
zweier Bildschirmausschnitte.

## 5 Aufwand und Verhalten

Neben der Richtigkeit wird je Anbindung erhoben, was die Richtigkeit kostet und
wie das Modell sich verhält, wenn es nicht weiterkommt.

| Kennzahl | Warum sie zählt |
|---|---|
| Antwortzeit je Anfrage, Median und oberes Zehntel | Entscheidet darüber, ob ein lokales Modell überhaupt bedienbar ist. Ein Modell, das richtig antwortet und drei Minuten braucht, ist keine Anbindung, sondern ein Stapelverarbeitungsauftrag. |
| Schrittzahl der Werkzeugkette | Misst, wie zielgerichtet das Modell arbeitet, und wie nah es an die Grenzwerte aus F-3.9 kommt. |
| Anteil der Läufe, die in einen Grenzwert laufen | Ein Modell, das regelmässig abgeschnitten wird (F-9.6), ist auf dieser Konfiguration nicht brauchbar — was auch heissen kann, dass die Grenzwerte falsch stehen. |
| Anteil nicht formgültiger Antworten, Anteil nötiger Wiederholungen | Der praktische Kern von Stufe 0, über alle Fälle betrachtet. |
| Erfüllungsgrad der Verhaltensfälle (3.2) | Ob das Modell nachfragt und abweist, statt zu erfinden. |
| Kontext- und Tokenverbrauch, soweit der Endpunkt ihn meldet | Grundlage für die Wahl der Kontextlänge (F-3.2) und, bei externen Anbindungen, für die Kosten. |

Bei den Verhaltensfällen ist offen, wie weit die Einstufung automatisch gelingt
(siehe 12). Der Rückfall ist eine manuelle Einstufung durch den Administrator
im Rahmen des Laufs — was vertretbar ist, weil diese Fälle die Minderheit sind.

## 6 Der Bewertungslauf

Ein Lauf ist eine Messung, kein Vorgang im Betrieb. Der Administrator stellt ihn
im Administrationsbereich (F-3.1) zusammen:

- **Anbindungen:** eine oder mehrere, auch mehrere Modelle desselben Endpunkts.
- **Prüffallbestand:** der ganze Bestand oder eine Auswahl.
- **Arbeitsweise:** Direktabfrage, Werkzeugkette oder beide.
- **Prüfumgebung:** der verwendete System-Prompt (F-3.6) samt Modellparametern.
  Er gehört zur Messung, nicht zum Hintergrund — dasselbe Modell mit einem
  anderen System-Prompt ist ein anderer Messpunkt.
- **Wiederholungen:** wie oft jeder Fall gefahren wird.

Vier Festlegungen für die Durchführung:

1. **Wiederholung ist Pflicht, nicht Kür.** Modelle antworten nicht
   deterministisch. Ein einzelner Durchlauf ist keine Messung, sondern eine
   Stichprobe der Grösse eins. Der Lauf fährt jeden Fall mehrfach und weist
   neben der Quote die Streuung aus. Ein Modell, das dieselbe Frage einmal
   richtig und einmal falsch beantwortet, ist etwas anderes als eines, das sie
   verlässlich zur Hälfte der Fälle löst.
2. **Jeder Fall startet frei.** Kein Dialogverlauf wird zwischen Fällen
   mitgeführt (F-5.15), sonst misst der zweite Fall den ersten mit.
3. **Es gelten dieselben Regeln wie im Betrieb.** Der Lauf führt ausschliesslich
   lesende Operationen aus (F-9.5) und unterliegt denselben serverseitig
   durchgesetzten Grenzwerten (F-9.6). Die Bewertung ist kein Sonderweg an der
   Ausführungsmaschine vorbei.
4. **Ein Lauf gegen ein externes Modell ist ein Datenabfluss.** Es gehen
   Prompts und Layer-Steckbriefe hinaus, keine Geodaten-Inhalte (F-9.3) — aber
   das ist eine Zusicherung, die auch für die Bewertung gelten muss und nicht
   nur für den Betrieb. Der Hinweis nach F-9.4 gilt im Lauf wie in der Sitzung.

## 7 Die Vergleichsdarstellung

Das Ergebnis eines Laufs ist eine Matrix: Anbindungen in der einen Richtung,
Prüffälle in der anderen, je Feld die erreichte Stufe und die Zeit. Darüber je
Anbindung die verdichteten Werte aus Abschnitt 4 und 5.

Entscheidend ist die zweite Ebene: Jedes Feld lässt sich aufklappen und zeigt
Fragestellung, erzeugtes Abfrageobjekt, Referenzabfrage, den Unterschied
zwischen beiden und die beiden Ergebnismengen. Ohne diese Ansicht sieht der
Administrator eine Quote und weiss nicht, was er damit anfangen soll; mit ihr
sieht er, dass das Modell etwa den Puffer konsequent auf den falschen Layer
legt — und das ist eine Beobachtung, mit der sich ein System-Prompt
verbessern lässt.

Jeder Lauf wird mit dem beschriftet, wogegen gemessen wurde: Schemaversion
(F-10.3), Fassung des Beispieldatensatzes, System-Prompt, Modellname und
Parameter, Zeitpunkt. Ein Messwert ohne diese Angaben ist nach dem nächsten
Versionswechsel wertlos — die Bewertung muss denselben Anspruch an
Nachvollziehbarkeit erfüllen, den sie an das Modell stellt.

Läufe bleiben erhalten und lassen sich gegeneinander stellen.

## 8 Wozu das Ergebnis dient

Drei Verwendungen, in dieser Reihenfolge der Wichtigkeit:

**Freigabeentscheidung.** Welche Anbindung wird für Anwender freigegeben, welche
ist voreingestellt (F-3.3, F-3.8). Das ist der Anlass dieses Dokuments.

**Vergleich von System-Prompt-Varianten.** F-10.4 sieht vor, System-Prompts und
HITL-Konfiguration exportier- und importierbar zu halten, „um Varianten
vergleichen zu können". Womit verglichen wird, sagt die Anforderung nicht — ohne
Bewertungslauf bleibt F-10.4 eine Ablagefunktion. Mit ihm wird daraus ein
Versuchsaufbau: dasselbe Modell, derselbe Prüffallbestand, zwei Prompts, zwei
Messreihen. Der Administrator kann seine eigenen Prompts verbessern, statt sie
zu vermuten.

**Beleg für die Austauschbarkeit.** Kriterium 8 aus [vision.md 9](vision.md)
verlangt, dass sich die Modellanbindung mit vertretbarem Aufwand austauschen
lässt. Der Aufwand des Umbaus ist die eine Hälfte der Aussage, der Unterschied
im Ergebnis die andere. Erst zusammen wird daraus eine Erkenntnis des
Demonstrators statt einer Eigenschaft seiner Schnittstelle.

## 9 Verhältnis zur automatisierten Testsuite

[tech-stack.md 5.2](tech-stack.md) legt fest: kein Modell in der Testsuite. Der
Grund gilt unverändert — andernfalls misst die Suite die Tagesform eines Modells
statt die Anwendung. Die Bewertung ändert daran nichts, sie steht daneben:

| | Automatisierte Testsuite | Bewertungslauf |
|---|---|---|
| Prüft | die Anwendung | das Modell |
| Modell | deterministischer Anbieter-Adapter mit hinterlegten Antworten | echtes Modell über die konfigurierte Anbindung |
| Ausgelöst durch | jeden Commit | den Administrator |
| Ergebnis | bestanden / nicht bestanden | Quoten, Zeiten, Streuung |

Eine Ausnahme, die betont sei: Die Bewertungsmaschinerie selbst — Normalisierung,
Vergleich, Auswertung — ist gewöhnlicher Anwendungscode und **gehört in die
pytest-Suite**, geprüft gegen aufgezeichnete Modellantworten. Dass die Bewertung
nicht automatisiert läuft, heisst nicht, dass der Bewerter ungeprüft bleibt.

## 10 Umsetzung

Der Bau ist klein, weil er fast nichts Eigenes braucht.

**Vorhanden, wird nur benutzt** — und zwar vollständig aus E1 und E2, weshalb
E3 dort stehen kann, wo es steht: Ausführungsmaschine und Abfrageobjekt-Schema
aus E1.2, Anbieterabstraktion aus E2.1 (F-7.3), Layer-Steckbrief aus E2.2,
Beispieldatensatz aus E1.1 (F-10.5), Protokoll aus E2.4 (F-6.8),
Administrationsbereich aus E1.4. Aus E4 bis E6 stammt nichts.

**Neu zu bauen** (je Paket der Etappe):

| Teil | Paket | Umfang |
|---|---|---|
| Prüffallformat | E3.1 | Pydantic-Modell, Ablage als Dateien im Repository, ein- und auslesbar (F-10.4) |
| Normalisierer und Vergleicher | E3.2 | die Stufen 0 bis 2 aus Abschnitt 4 |
| Laufsteuerung | E3.3 | Fälle abarbeiten, wiederholen, Zeiten messen, Abbruch |
| Ablage der Läufe | E3.3 | eigene verwaltete Tabellen, über Alembic wie das übrige verwaltende Schema (F-2.17), damit sie auf beiden Backends tragen und der Querstrang P sie mitnimmt |
| Beförderung aus dem Protokoll | E3.4 | Prüffall aus einem Protokolleintrag erzeugen |
| Ansicht | E3.5 | Matrix und Aufklappen im Administrationsbereich |

**Keine neue Abhängigkeit, kein neuer Dienst.** Das entspricht Auswahlregel 3
aus [tech-stack.md 1](tech-stack.md); ein Lauf ist eine Folge gewöhnlicher
Anfragen und braucht keine Warteschlange.

**Was E2 mitliefern muss** — die einzige Vorwirkung der Bewertung auf eine
frühere Etappe:

- Die Anbieterabstraktion (F-7.3) muss Antwortzeit und, wo gemeldet,
  Tokenverbrauch durchreichen, statt sie wegzuwerfen.
- Das Protokoll (F-6.8) muss das erzeugte Abfrageobjekt vollständig und
  maschinenlesbar ablegen, nicht nur als Anzeigetext — sonst funktioniert die
  Beförderung aus 3.3 nicht.
- Der System-Prompt einer HITL-Stufe muss beim Aufruf überschreibbar sein, damit
  ein Lauf eine Variante messen kann, ohne die Konfiguration des laufenden
  Betriebs zu ändern.

Diese drei Punkte kosten in E2 fast nichts und wären eine Etappe später teuer
nachzurüsten. Sie stehen deshalb auch in [etappen.md 5](etappen.md) als
Voraussetzung bei E3.

## 11 Bewusst nicht enthalten

| Nicht enthalten | Begründung |
|---|---|
| Bewertung durch ein zweites Modell (LLM-as-Judge) | Der Massstab liegt deterministisch vor (Abschnitt 2); ein urteilendes Modell brächte Unsicherheit ohne Gegenwert |
| Allgemeine Modellranglisten und Fremd-Benchmarks | Gemessen wird die Eignung für diese Aufgabe auf diesen Daten, nicht die allgemeine Güte eines Modells |
| Automatische Optimierung von System-Prompts | Der Lauf liefert die Messung; die Schlussfolgerung zieht der Administrator |
| Bewertung der HITL-Regeltreue | Ob ein Modell die Werkzeug-Freigaben einer Stufe einhält, ist keine Frage des Modells: Die Durchsetzung liegt im Backend (F-6.7) und ist damit Gegenstand der Testsuite, nicht der Modellbewertung. Als *Verhaltens*kennzahl — wie oft ein Modell Nichtfreigegebenes versucht — wäre es nachrüstbar, siehe 12 |
| Bewertung externer MCP-Werkzeuge und des MCP-Server-Pfads | Betrifft die Güte fremder Dienste bzw. einen zweiten Zugangsweg, nicht die des Modells. E3 misst den Weg über die eigene Oberfläche; die Ausweitung auf E4 und E6 ist eine bewusste spätere Entscheidung ([etappen.md 11](etappen.md), Annahme 5) |
| Fortlaufende Überwachung im Betrieb | Der Lauf ist eine Entscheidungsgrundlage vor der Freigabe, keine Betriebsüberwachung |

## 12 Offene Punkte

Jeder Punkt nennt das Paket, bis zu dem er spätestens entschieden sein muss
([etappen.md 5](etappen.md)).

| Offen | Fällig | Anmerkung |
|---|---|---|
| Umfang des Startbestands | E3.1 | Wie viele Prüffälle ein belastbares Urteil tragen. Der Bestand aus den Vorführungen von E1 und E2 ist der Anfang, vermutlich nicht genug |
| Alterung der Prüffälle | E3.1 | Referenzabfragen hängen an der Schemaversion (F-10.3). Beim Versionswechsel: mitmigrieren oder neu aufnehmen? |
| Tiefe der Normalisierung in Stufe 1 | E3.2 | Je mehr normalisiert wird, desto aussagekräftiger die Stufe — und desto mehr Arbeit. Die Untergrenze ist die Reihenfolge gleichrangiger Bedingungen; alles darüber ist abzuwägen |
| Toleranzen in Stufe 2 | E3.2 | Gleitkommawerte bei Flächen und Distanzen weichen zwischen den Backends ab, obwohl F-10.7 Gleichheit verlangt. Wo die Toleranz liegt, ist zusammen mit F-2.14 zu klären |
| Maschinelle Auswertbarkeit der Verhaltensfälle | E3.2 | Ob sich „hat sinnvoll nachgefragt" automatisch einstufen lässt, oder ob diese Klasse manuell bleibt |
| Zahl der Wiederholungen je Fall | E3.3 | Und ab welcher Streuung ein Ergebnis als unbrauchbar gilt statt als Quote |
| Versuchte Verstösse gegen Werkzeug-Freigaben | E3.3 | Ob der Anteil abgewiesener Werkzeugaufrufe als Verhaltenskennzahl aufgenommen wird — er ist aus dem Protokoll ohnehin ablesbar (siehe 11) |
| Kosten bei externen Anbindungen | E3.3 | Ein Lauf über den vollen Bestand mit Wiederholungen ist eine nennenswerte Zahl von Anfragen. Ob der Lauf eine Kostenschätzung vorab anzeigt, ist offen |

## 13 Bezug zu den Anforderungen

Die Bewertung ist in [anforderungen.md 3.1](anforderungen.md) als F-3.13 bis
F-3.18 aufgenommen und wird in Etappe E3 gebaut ([etappen.md 5](etappen.md)).

| Anforderung | Abschnitt hier | Paket |
|---|---|---|
| F-3.13 Prüffallbestand | 3 | E3.1 |
| F-3.14 Übernahme aus dem Protokoll | 3.3 | E3.4 |
| F-3.15 Bewertungslauf | 6 | E3.3 |
| F-3.16 Dreistufige Bewertung | 4 | E3.2 |
| F-3.17 Aufwands- und Verhaltenskennzahlen | 5 | E3.3 |
| F-3.18 Vergleichsdarstellung | 7 | E3.5 |

Bestehende Anforderungen, auf denen die Bewertung aufsetzt: F-3.2, F-3.3, F-3.6,
F-3.8 (Gegenstand der Entscheidung), F-5.5, F-5.7, F-5.8, F-5.13, F-5.14, F-5.18
(Prüfgegenstand), F-6.8, F-8.9, F-10.3, F-10.4, F-10.5 (Grundlage), F-9.3,
F-9.5, F-9.6 (Grenzen des Laufs).
