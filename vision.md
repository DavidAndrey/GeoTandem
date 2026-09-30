# GeoTandem — Vision

> Status: Entwurf v0.4 · Stand: 2026-09-30 · Dokumenttyp: Produktvision (Demonstrator)

## 1 Kurzfassung

GeoTandem ist ein Demonstrator für die Verbindung von Geodaten-Analyse und
Sprachmodellen. Fachanwender arbeiten entweder klassisch — Layer wählen, Filter
setzen — oder sie beschreiben ihr Analyseziel in natürlicher Sprache und lassen
ein LLM die passende Karte, Tabelle oder Grafik erzeugen. Entscheidend ist dabei
nicht, dass das Modell arbeitet, sondern *wie eng der Mensch dabei eingebunden
bleibt*: Der Grad der Kontrolle (Human-in-the-Loop, HITL) ist eine einstellbare
Grösse, kein fester Systemzustand.

Der Name ist Programm: Mensch und Modell treten gemeinsam in die Pedale. Wer
lenkt, ist regelbar.

## 2 Ausgangslage

Geoinformationssysteme sind mächtig und gleichzeitig schwer zugänglich. Wer eine
Frage wie *„Welche Schulen liegen im 500-Meter-Umkreis von Hauptverkehrsstrassen
in Gebieten mit hohem Kinderanteil?"* beantworten will, muss die Frage zuerst in
Layer, Joins, Puffer und Filterausdrücke übersetzen. Diese Übersetzungsleistung
ist die eigentliche Einstiegshürde — nicht die Daten selbst.

Sprachmodelle können diese Übersetzung übernehmen. Damit entsteht aber ein neues
Problem: Ein plausibel aussehendes Analyseergebnis, dessen Herleitung niemand
geprüft hat, ist im fachlichen Kontext wertlos oder sogar irreführend. Räumliche
Aussagen wirken durch die Kartendarstellung besonders überzeugend, auch wenn die
zugrunde liegende Abfrage falsch war.

GeoTandem geht davon aus, dass sich dieser Zielkonflikt nicht durch eine einzige
richtige Einstellung lösen lässt. Wie viel Autonomie ein Modell bekommen darf,
hängt von Datenlage, Anwendungsfall, Nutzererfahrung und Risiko ab. Also muss die
Autonomie selbst zum konfigurierbaren Parameter werden.

## 3 Vision Statement

> **Für** Fach- und Verwaltungsanwender, die räumliche Fragestellungen
> beantworten müssen, ohne GIS-Spezialisten zu sein,
> **ist** GeoTandem eine selbst betreibbare Web-Anwendung,
> **die** Geodaten sowohl klassisch als auch über natürlichsprachliche Prompts
> analysierbar macht — mit frei einstellbarer Tiefe der menschlichen Kontrolle.
> **Anders als** reine Chat-Aufsätze auf GIS-Systeme
> **macht** GeoTandem jeden Modellschritt als geprüfte, deklarative Abfrage
> sichtbar, nachvollziehbar und rücknehmbar.

## 4 Das Zielbild

### 4.1 Zwei Arbeitsmodi, ein Datenmodell

Beide Modi arbeiten auf demselben Zustand — derselben Layer-Auswahl, denselben
Filtern, derselben Kartenansicht. Das ist die zentrale Designentscheidung: Der
LLM-Modus ist keine separate Anwendung, sondern eine zweite Eingabemethode für
dieselbe Maschinerie.

**Modus A — Klassik.** Der Anwender wählt Layer, definiert Attribut- und
Raumfilter, gestaltet die Symbolisierung. Vertraute GIS-Bedienung, ohne
LLM-Beteiligung. Dieser Modus ist auch dann voll funktionsfähig, wenn kein Modell
angebunden ist.

**Modus B — LLM-Support.** Der Anwender formuliert seine Frage als Prompt. Das
Modell übersetzt sie in eine strukturierte Abfrage gegen die vorhandenen Layer
und erzeugt daraus Karte, Tabelle, Diagramm oder Bericht.

Der Übergang ist in beide Richtungen offen: Eine vom Modell erzeugte Abfrage
landet in denselben Bedienelementen und kann dort von Hand weiterbearbeitet
werden. Umgekehrt kann eine von Hand gebaute Analyse als Ausgangspunkt für einen
Prompt dienen. Das Modell ersetzt die Oberfläche nicht, es füllt sie aus.

### 4.2 Human-in-the-Loop als Regler

Die HITL-Stufe bestimmt, wie viel das Modell ohne Rückfrage tun darf. Sie wird
vom Administrator vorkonfiguriert und — je nach Freigabe — vom Anwender im Rahmen
dieser Vorgaben angepasst. Zu jeder Stufe hinterlegt der Administrator einen
eigenen System-Prompt, der das Verhalten des Modells auf dieser Stufe prägt.

Die konkrete Stufeneinteilung ist eine **bewusst offene Designfrage** dieses
Demonstrators (siehe Abschnitt 8). Die Anwendung soll sie erproben, nicht
vorwegnehmen.

### 4.3 Nachvollziehbarkeit als Grundprinzip

Das Modell erzeugt niemals direkt ein Bild oder eine Tabelle. Es erzeugt eine
**deklarative Abfragebeschreibung** — ein strukturiertes, gegen ein Schema
validiertes Objekt — oder ruft **definierte GIS-Werkzeuge** auf. Erst die
Anwendung führt diese Beschreibung aus.

Daraus folgt dreierlei: Jedes Ergebnis ist auf eine lesbare Abfrage zurückführbar.
Jede Abfrage ist prüfbar, bevor sie läuft. Und jedes Ergebnis ist reproduzierbar,
auch ohne das Modell — dieselbe Abfrage liefert dasselbe Resultat. Das Modell ist
Übersetzer, nicht Ausführungsinstanz.

### 4.4 Zwei Wege zum Ergebnis — der Anwender wählt

Innerhalb des LLM-Modus gibt es zwei Arbeitsweisen, und beide stehen jederzeit
zur Verfügung. Der Anwender entscheidet pro Anfrage, welche er nutzt:

**Direktabfrage.** Das Modell übersetzt den Prompt in ein einziges deklaratives
Abfrageobjekt, das vollständig sichtbar, prüfbar und von Hand nachbearbeitbar
ist. Ein Schritt, eine Aussage, minimale Angriffsfläche für Fehler — geeignet für
klar umrissene Fragestellungen.

**Werkzeugkette.** Das Modell zerlegt die Aufgabe in mehrere Aufrufe der
freigegebenen GIS-Werkzeuge und arbeitet über Zwischenergebnisse zum Ziel.
Ausdrucksstärker und offener für explorative Fragen, dafür mit mehr Schritten,
die gesehen und gegebenenfalls freigegeben werden wollen.

Der Demonstrator legt diese Grenze bewusst nicht fest, sondern macht sie zur
Bedienentscheidung. Dadurch lässt sich dieselbe Fragestellung über beide Wege
stellen und vergleichen: Wo genügt ein sauber formuliertes Abfrageobjekt, wo
braucht es wirklich eine Kette von Werkzeugen? Wie unterscheiden sich Aufwand,
Prüfbarkeit und Trefferquote? Genau diese Gegenüberstellung ist der eigentliche
Erkenntnisgewinn — sie wäre verschenkt, wenn das System den Weg selbst wählte.

Beide Wege münden in denselben Analysezustand, und auch das Ergebnis einer
Werkzeugkette lässt sich als Abfrageobjekt ausdrücken. Damit gilt das Prinzip aus
4.3 unverändert für beide: reproduzierbar auch ohne Modell.

### 4.5 GeoTandem im LLM-Ökosystem

GeoTandem ist über das Model Context Protocol (MCP) in beide Richtungen
anschlussfähig:

- **Als MCP-Server** stellt die Anwendung ihre GIS-Werkzeuge nach aussen bereit.
  Externe Clients — Claude Desktop, Claude Code, eigene Agenten — können damit auf
  den verwalteten Geodatenbestand zugreifen, ohne die Oberfläche zu benutzen.
  GeoTandem wird so zur Geo-Toolbox für beliebige LLM-Clients.
- **Als MCP-Client** bindet die Anwendung externe Server ein, etwa für Geocoding,
  Statistik- oder Fachdatenzugriffe, und erweitert damit den Datenraum über die
  importierten Layer hinaus.

Diese Zweiseitigkeit ist für einen Demonstrator der aufschlussreichste Teil: Sie
zeigt, ob eine HITL-Abstufung nicht nur in der eigenen Oberfläche greift, sondern
auch dann, wenn die Anfrage von aussen kommt.

### 4.6 Der Weg dorthin

Das Zielbild entsteht nicht in einem Zug. Der Demonstrator wird in sechs Etappen
gebaut, von denen jede für sich vorführbar ist: eine vollständige GIS-Anwendung
ohne jede Modellbeteiligung (Modus A), dann die Anbindung lokaler Sprachmodelle
samt HITL-Steuerung (Modus B), dann die Bewertung der Modellanbindungen, dann
die Öffnung nach aussen als MCP-Server, dann Diagramme, Kennzahlen und Export,
zuletzt die Gegenrichtung: das Einbinden fremder MCP-Server. Der Umstieg von der
dateibasierten Datenhaltung auf PostgreSQL/PostGIS läuft als Querstrang nebenher.

Die Reihenfolge folgt einer Abhängigkeit, die sich nicht umkehren lässt: Zuerst
entsteht das deklarative Abfrageobjekt mitsamt der Maschinerie, die es ausführt —
die Bedienoberfläche des Klassik-Modus ist dessen Editor, das Sprachmodell später
ein zweiter Erzeuger desselben Objekts. Wer umgekehrt beginnt, baut in der
zweiten Etappe die erste noch einmal.

Dieselbe Überlegung stellt die Bewertung unmittelbar hinter die Modellanbindung:
Sobald sich Modelle benutzen lassen, muss sich auch sagen lassen, welches taugt.
Wer die Bewertung ans Ende schiebt, führt die drei folgenden Etappen mit einer
Modellwahl vor, die auf nichts beruht ausser der Erreichbarkeit des Endpunkts
([bewertung.md](bewertung.md)).

Zuschnitt der Etappen, Arbeitspakete und Abnahmekriterien stehen in
[etappen.md](etappen.md).

## 5 Leitprinzipien

1. **Kontrolle ist einstellbar, nicht fest.** Es gibt keine allgemein richtige
   Autonomiestufe — nur eine passende für den jeweiligen Fall.
2. **Das Modell schlägt vor, das System führt aus.** Kein direkter Zugriff auf
   Daten oder Darstellung, ausschliesslich validierte Abfragen und freigegebene
   Werkzeuge.
3. **Keine stille Magie.** Jede Modellaktion ist im Nachhinein als Abfrage lesbar.
4. **Ohne LLM voll benutzbar.** Der Klassik-Modus ist kein Rückfallmodus, sondern
   gleichwertig.
5. **Daten bleiben im Haus.** Vollständiger Betrieb mit lokalem Modell ist der
   Normalfall, Cloud-Anbindung die bewusst freigeschaltete Ausnahme.
6. **Austauschbarkeit vor Funktionstiefe.** Als Demonstrator ist GeoTandem so
   gebaut, dass Datenhaltung, Modellanbindung und Werkzeugumfang ersetzt werden
   können. Das gilt nicht nur auf dem Papier: Die Anwendung startet mit einer
   dateibasierten Datenhaltung (SpatiaLite) und wird für den produktiven Betrieb
   auf PostgreSQL/PostGIS umgestellt — per Konfiguration und einmaliger
   Datenmigration, nicht per Umbau.

## 6 Rollen

| Rolle | Aufgabe |
|---|---|
| **Administrator** | Importiert und pflegt Geodaten, konfiguriert LLM-Anbindungen und MCP-Server, bewertet sie vor der Freigabe, definiert HITL-Stufen und deren System-Prompts, legt Werkzeug-Freigaben fest. |
| **Anwender** | Arbeitet im Klassik- oder LLM-Modus, wählt im freigegebenen Rahmen die HITL-Stufe, prüft und gibt Modellvorschläge frei, exportiert Ergebnisse. |
| **Externer LLM-Client** | Greift über den MCP-Server auf die GIS-Werkzeuge zu — unter denselben Freigaben und Kontrollregeln. |

## 7 Abgrenzung — was GeoTandem nicht ist

- **Kein vollwertiger GIS-Ersatz.** Kein Konkurrent zu QGIS oder ArcGIS; der
  Funktionsumfang bleibt auf das für die Demonstration Nötige beschränkt.
- **Kein Geodaten-Editor.** Der Anwender verändert keine Geometrien oder
  Sachdaten; alle Analyseoperationen sind lesend.
- **Kein Produktivsystem.** Der Demonstrator zielt auf Konzeptnachweis und
  Architekturerprobung, nicht auf Betriebsreife, Mandantenfähigkeit oder
  Skalierung.
- **Kein LLM-Training.** Es werden ausschliesslich vorhandene Modelle über APIs
  angebunden; keine eigenen Modelle, kein Fine-Tuning.
- **Kein allgemeiner Chatbot.** Der Prompt-Kanal dient der Geodaten-Analyse, nicht
  der freien Konversation.

## 8 Offene Designfragen

Diese Fragen sind absichtlich nicht entschieden — sie zu beantworten ist ein Ziel
des Demonstrators.

### 8.1 Wie werden die HITL-Stufen geschnitten? *(Kernfrage)*

Drei Kandidaten stehen zur Diskussion:

**Option A — vierstufig, global.**
`Assistenz` (Modell erklärt und schlägt vor, der Anwender klickt selbst) →
`Review` (Abfrage wird vor Ausführung zur Freigabe gezeigt) →
`Auto mit Undo` (sofortige Ausführung, Änderung wird als Diff sichtbar und ist
rücknehmbar) → `Autonom` (mehrstufige Analyse, nur das Endergebnis wird
bestätigt). Gut vermittelbar, aber grobkörnig: Die Stufe gilt für alle
Operationen gleich.

**Option B — dreistufig, global.** Wie A ohne die Undo-Zwischenstufe. Einfacher,
dafür ist der Sprung von Freigabe zu Autonomie gross.

**Option C — je Operationsklasse.** Der Administrator legt pro Klasse fest, etwa:
Lesen und Filtern autonom, Geoprocessing mit Review, Export mit Freigabe.
Fachlich am realistischsten, weil das Risiko tatsächlich an der Operation hängt
und nicht an der Sitzung — dafür erklärungsbedürftiger in der Konfiguration.

*Entscheidungskriterien:* Verständlichkeit für den Anwender, Aufwand der
Administration, Übertragbarkeit auf den MCP-Server-Pfad (dort gibt es keine
eigene Oberfläche für Rückfragen), Aussagekraft für die Demonstration.

### 8.2 Weitere offene Punkte

- **Freigabe-Mechanik bei externen MCP-Clients:** Wie wird eine Review-Stufe
  durchgesetzt, wenn die Anfrage nicht aus der eigenen Oberfläche kommt?
  Werkzeug-Ebene, Rückfrage über das Protokoll, oder Beschränkung des externen
  Zugangs auf autonomiefähige Operationen?
- **Verhalten bei falsch gewähltem Weg:** Wenn eine Direktabfrage die Frage nicht
  fassen kann — meldet das Modell dies zurück, oder schlägt es den Wechsel zur
  Werkzeugkette vor? (Die Wahl selbst bleibt beim Anwender, siehe 4.4.)
- **Umgang mit Mehrdeutigkeit:** Rückfrage des Modells, beste Annahme mit
  Kennzeichnung, oder mehrere Interpretationen zur Auswahl?
- **Semantische Beschreibung der Layer:** Wie viel Metadaten braucht ein Modell,
  um Attributnamen fachlich korrekt zu deuten — und wer pflegt sie?
- **Umgang mit grossen Ergebnismengen:** Grenzwerte, Aggregation, Abbruch.

## 9 Erfolgskriterien des Demonstrators

Die Demonstration gilt als gelungen, wenn:

1. Ein Anwender ohne GIS-Vorkenntnisse eine mehrschichtige räumliche
   Fragestellung per Prompt beantworten kann.
2. Dieselbe Analyse im Klassik-Modus reproduzierbar ist — und beide Wege demselben
   internen Zustand entsprechen.
3. Dieselbe Fragestellung sich sowohl als Direktabfrage als auch als
   Werkzeugkette bearbeiten lässt und der Vergleich beider Wege eine belastbare
   Aussage über ihre jeweiligen Stärken erlaubt.
4. Die Wirkung unterschiedlicher HITL-Stufen an einem Beispiel sichtbar wird,
   inklusive eines Falls, in dem die Prüfung einen Modellfehler abfängt.
5. Der Betrieb vollständig lokal mit einem selbst gehosteten Modell gelingt.
6. Ein externer MCP-Client eine Analyse über die bereitgestellten Werkzeuge
   durchführen kann.
7. Derselbe Programmstand ohne Anpassung sowohl auf SpatiaLite als auch auf
   PostGIS läuft und ein vorgeführter Datenbestand sich vom einen auf das andere
   übertragen lässt — der Beleg dafür, dass die Datenhaltung austauschbar ist.
8. Auch die Modellanbindung mit vertretbarem Aufwand ausgetauscht werden kann.
9. Sich die Eignung einer Modellanbindung vor der Freigabe messen lässt statt
   vermuten: Zwei Anbindungen sind am selben Prüffallbestand vergleichbar, und
   der Vergleich zeigt nicht nur, welche besser abschneidet, sondern woran es
   liegt.

## 10 Ausblick

Über den Demonstrator hinaus denkbar, bewusst ausserhalb des aktuellen Umfangs:
Anbindung von OGC-Diensten (WMS/WFS) und Rasterdaten, zeitliche Analysen,
gemeinsames Arbeiten mehrerer Anwender an einer Analyse sowie Vorlagen für
wiederkehrende Fragestellungen.

Die Bewertungsumgebung, die die Qualität generierter Abfragen systematisch
misst, stand hier ursprünglich ebenfalls. Sie ist inzwischen Etappe E3: Weil die
Anwendung ein schemavalidiertes Abfrageobjekt erzeugt und jedes Ergebnis ohne
Modell reproduzierbar ist (Abschnitt 4.3), liegt der Prüfmassstab bereits vor —
die Bewertung wird dadurch deterministisch statt urteilend und ist billiger zu
bauen, als sie von aussen aussieht ([bewertung.md](bewertung.md)).

## 11 Der Kern, unabhängig von Geodaten

Der übertragbare Kern dieser Arbeit ist die Annahme, dass der Grad der
menschlichen Kontrolle über ein Modell ein einstellbarer Parameter des Systems
sein muss und keine feste Produktentscheidung — wie viel Autonomie angemessen
ist, hängt von Daten, Risiko und Anwender ab und gehört damit in die
Konfiguration, nicht in die Annahme des Herstellers. Tragfähig wird das erst
dadurch, dass das Modell die Daten nie selbst anfasst: Es erzeugt eine
deklarative, gegen ein Schema geprüfte Beschreibung dessen, was geschehen soll,
und die Anwendung führt sie aus — wodurch jede Modellaktion vor der Ausführung
prüfbar, dazwischen ablehnbar und danach ohne Modell wiederholbar ist. Weil
diese Prüfung im Backend sitzt und nicht in der Oberfläche, lässt sich derselbe
kontrollierte Werkzeugbestand der eigenen Anwendung und fremden Agenten zugleich
öffnen — und genau das erlaubt es, ein bestehendes Fachsystem für Sprachmodelle
zu öffnen, ohne die Nachvollziehbarkeit aufzugeben, die es überhaupt erst
belastbar gemacht hat.
