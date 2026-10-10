# Handoff: GeoTandem · Etappe 2 (Modus B · LLM-Support)

## Überblick
Bildschirmreferenz für Etappe E2 (E2.3–E2.6 aus `etappen.md`): Prompt-Reiter, Antwort der Direktabfrage, Abweisung, Stufe ohne Ausführungsrecht, Freigabe und Rücknahme, Stufenanzeige, Werkzeugkette mit Plan, Lauf und Vergleich, Dialogverlauf, Mehrdeutigkeit, unpassende Arbeitsweise, Fehlerfälle, der Übergang Modus B → A → B und das Protokoll der Modellaktionen. Grundlage ist das Briefing `BRIEF.md` (F-5.1, F-5.4–F-5.18, F-6.1–F-6.9, F-9.5).

Leitfrage: Ein Anwender ohne GIS-Vorkenntnisse sieht jederzeit, *was das Modell vorschlägt, was es angenommen hat, was schon passiert ist und wie er es zurücknimmt oder von Hand weiterbearbeitet*.

Vorführung E2.6: Prompt → Antwort → Freigabe → angewendet → im Editor B2 von Hand ändern → Folgeprompt mit dem geänderten Stand als Bezug (M1.1 → M2.1 → M5.1 → M2.2 → M15.1 → M15.2 → M11.2).

## Über die Designdateien
Die Dateien sind **Designreferenzen in HTML** (Wireframes), kein Produktionscode. Nachbauen in der Zielumgebung laut `tech-stack.md` (Vite + TypeScript + React 19, React Router, Leaflet/react-leaflet, Tailwind CSS); HTML-Struktur nicht übernehmen, Muster der Codebasis verwenden. Alles baut auf E1 auf (`design_handoff_geotandem_e1/`): Arbeitsplatz B1, Editor B2, Kartenzustände B9, Admin-Rahmen D1, Protokollmuster D7/D8.

`GeoTandem E2 - Final.dc.html` im Browser öffnen (braucht `support.js` und `_ds/` daneben; die Datei ist gross und braucht einige Sekunden). Jeder Bildschirm hat einen Code (M1 … M16), jeder Zustand eine Nummer (M1.1 …), eine Zeile „Weiter“ und eine Notiz. Jeder Zustand ist als ganze Seite gezeichnet.

## Fidelity
**Low-fidelity** wie E1. Massgeblich sind Struktur, Inhalte, Zustände und Abläufe; Abstände und Grössen sind ungefähr. Tokens siehe unten.

## Navigation und Adressen
**Kopfzeile Anwendung** (wie E1, ergänzt): Marke → B1 · Sitzung ▾ (C1) · „● ungespeichert“ · **Anbindung · Stufe ▾** (M7; externe Anbindung mit Host-Kennzeichen, ohne Anbindung „Keine Modellanbindung“) · Administration (nur Admin) · Benutzermenü mit neu **Meine Modellaktionen** (M16.3).
**Seitenleiste:** Reiter Klassik | **Prompt**. Prompt öffnet ein Panel (460 px, wie B2) zwischen Seitenleiste und Karte; Seitenleiste, Karte und Tabelle bleiben sichtbar und gelten. „Im Editor öffnen“ / „Anpassen“ wechselt auf Klassik und öffnet B2 an der Stelle des Panels; der Dialogverlauf bleibt erhalten.
**Administration:** neue Gruppe **Modell** in D1 (bisher ausgegraut): Modellanbindungen, Stufen, Was das Modell sieht (Bestand, hier nicht neu entworfen) · **Modellprotokoll** (M16, neu). Bewertung ab E3, MCP ab E4 bleiben ausgegraut.

| Route | Bildschirm |
|---|---|
| `/admin/modellprotokoll` | M16.1 |
| `/admin/modellprotokoll/:id` | M16.2 |

Alle übrigen M-Zustände ohne eigene Adresse (Panel, Popover, Dialog im Arbeitsplatz `/` bzw. `/sitzung/:id`). Die vollständige Übergangstabelle und der Ablauf einer Anfrage stehen in der Referenz unter „Globale Navigation und Beziehungen“ (`screenshots/00-navigation.png`).

## Bildschirme

### M · Prompt und Antwort (E2.3)
- **M1 Prompt-Reiter**: M1.1 lokales Modell · M1.2 externe Anbindung (Hinweis „Der Prompt-Text verlässt das Haus“, Host im Kopf, im Hinweis und in der Fusszeile; bei Datenfreigabe ein: „… sieht auch Werte aus den Treffern“) · M1.3 keine Anbindung (Reiter ausgegraut, Klassik voll nutzbar, Admin-Link). Eingabe mehrzeilig, Senden ⌘/Ctrl+Enter, Arbeitsweise *Direktabfrage | Werkzeugkette* je Anfrage (bis E2.5: Werkzeugkette deaktiviert mit „ab E2.5“), 2–3 Beispielprompts aus den sichtbaren Layern (Klick setzt Text, sendet nicht), Statuszeile Anbindung · Stufe · „Ihre Eingaben werden protokolliert“.
- **M2 Antwort**: M2.1 Modell arbeitet (Eingabe gesperrt, Laufzeit bis 2:00, Abbrechen; kein Token-Streaming) · M2.2 angewendet (Seitenleiste zeigt die Abfrage mit Marke „Modell“ je Bedingung; 7 von 39; ● ungespeichert) · M2.3 zurückgenommen. Antwort = Erläuterung (1–3 Sätze) · Annahmen einzeln mit ≈ · lesbare Abfrage im Bedingungsbaum-Stil (JSON nur unter „Technisch“) · Status · Aktionen *Im Editor öffnen*, *Zurücknehmen*, *Protokoll*.
- **M3 Abweisung** (durch die Anwendung, nicht das Modell): M3.1 `layer_not_visible` (als m.keller) · M3.2 `limit_exceeded` · M3.3 `not_representable` (mit Angebot Werkzeugkette). Weitere Codes gleich dargestellt: `layer_unknown`, `schema_invalid`. Grund in Worten, Code nur unter „Details“; abgewiesene Abfrage einsehbar, nicht anwendbar. Aktionen *Prompt ändern* (Text zurück ins Feld), *Erneut versuchen*. Kein `class_not_allowed` (Q1).
- **M4 Stufe ohne Ausführungsrecht** (Assistenz): M4.1 Vorschlag mit *In Editor übernehmen*, ohne Freigabe, Vorschau oder Rücknahme · M4.2 Entwurf in B2; erst „Übernehmen“ ändert die Analyse, als Handlung des Anwenders.

### H · Freigabe und Rücknahme (E2.4)
- **M5 Freigabe** (angedockt in der Antwort, nicht modal): M5.1 Vorschlag mit Änderungsliste gegenüber jetzt (+/~/− wie D4), Vorschau „39 → 7“ gestrichelt auf der Karte, „Braucht Freigabe: …“; *Annehmen · Anpassen … · Ablehnen*; Fokus auf Annehmen, Esc = Ablehnen; kein Auto-Timeout · M5.2 Stand inzwischen von Hand geändert (Hinweis, Liste neu berechnet; Klassik bleibt bedienbar; höchstens ein offener Vorschlag) · M5.3 abgelehnt mit optionalem Stichwort (falsch verstanden · falscher Layer · falscher Wert · anderes).
- **M6 Auto-Ausführung**: M6.1 Hinweisleiste an der Karte „Modell hat angewendet: … · Rückgängig · Änderung ansehen“ (bleibt bis zur nächsten Änderung; × blendet nur aus) · M6.2 nach Rückgängig · M6.3 gemischte Stufe: strengste Festlegung gilt für die ganze Antwort, Klassenliste zeigt warum.
- **M7 Stufenanzeige**: M7.1 Popover „Was darf das Modell hier?“ (Klasse × Festlegung, lesend) · M7.2 Stufenwahl mit Kurzspalte A/F/– · M7.3 Wechsel bei offener Freigabe: Vorschlag bleibt an die Stufe gebunden, unter der er gestellt wurde.

### K · Werkzeugkette (E2.5)
- **M8 Geplante Schritte**: M8.1 Stufe Prüfen (eine Freigabe für die ganze Kette) · M8.2 Stufe Teilautonom (Klasse und Festlegung je Schritt; Halt vor Schritten mit „Freigabe“) · M8.3 Plan anpassen (Werte ändern, Schritte entfernen; neue Schritte nur per Prompt). Schrittlimit sichtbar („5 von höchstens 8“).
- **M9 Lauf**: M9.1 läuft (Schritt 3 von 5, Laufzeit, Zwischenstände gedämpft auf der Karte, je Schritt „Modell sieht: …“) · M9.2 Halt zur Freigabe · M9.3 fertig (*Ergebnis übernehmen*, *Als Abfrage ansehen*, *Mit Direktabfrage vergleichen*) · M9.4 abgebrochen · M9.5 Begrenzung erreicht (Ergebnisgrösse; gleich für Schrittzahl und Laufzeit). Nach Abbruch/Begrenzung ist der letzte vollständige Zwischenstand übernehmbar; die Analyse bleibt bis dahin unverändert.
- **M10 Vergleich**: M10.1 Einstieg über ⋯ „Mit Werkzeugkette wiederholen“ · M10.2 Dialog, gleiche Treffer · M10.3 Treffer unterscheiden sich („2 nur links, 1 nur rechts“, Grund). *Diese übernehmen* ersetzt die Analyse und gilt als Freigabe.

### D · Dialog und Übergänge (E2.6)
- **M11 Dialogverlauf**: M11.1 Bezug letzte Antwort (Bezugsmarke über dem Feld, × = ohne Bezug; ältere Antworten eingeklappt mit Status) · M11.2 Bezug von Hand geänderter Stand · M11.3 Antwort veraltet (Layer entfernt).
- **M12 Mehrdeutigkeit**: M12.1 Annahme mit ≈ und „ändern“ (Regelfall) · M12.2 Rückfrage mit 2–4 Optionen plus freie Antwort (Sonderfall; Analyse unberührt).
- **M13 Unpassende Arbeitsweise**: M13.1 *Mit Werkzeugkette versuchen* (stellt Schalter um, befüllt Feld, sendet nicht) · M13.2 nicht beantwortbar (was fehlt, kein Knopf).
- **M14 Fehlerfälle**: M14.1 nicht erreichbar · M14.2 Zeitüberschreitung, extern (Host bleibt) · M14.3 Antwort nicht lesbar · M14.4 Kontingent. Immer: was passiert ist · „Ihr Stand ist unverändert“ · Aktion (*Erneut versuchen*, *Anbindung wechseln* ▾, Admin-Link *Modellanbindungen*). Prompt bleibt im Feld.
- **M15 Übergang B → A → B**: M15.1 B2 mit Marke „Modell“ je Bedingung · M15.2 Wert von Hand geändert (500 → 300 m; Marke dieser Zeile fällt weg; 5 von 39) → M11.2.

### P · Protokoll (E2.4)
- **M16**: M16.1 Admin-Liste mit Kennzahlenzeile (Vorschläge · angenommen unverändert · angepasst · abgelehnt · übergangen · auto angewendet · davon zurückgenommen; Zahlen mit Anteil, kein Diagramm), Filter Zeitraum/Stufe/Anbindung/Arbeitsweise, CSV · M16.2 Eintrag (Prompt, Stufe *wie damals* mit Matrix und Hash, Anbindung, Arbeitsweise, Annahmen, Abfrage lesbar + JSON, Schritte bei Kette, Entscheidung mit Zeit, Layer-Steckbrief-Hash, Prompt-Hash) · M16.3 Dialog „Meine Modellaktionen“ für Anwender (nur eigene Einträge).

## Verhalten und Zustand
- **Ein Zustand**: Modus B schreibt in dasselbe Abfrageobjekt wie Klassik (E1). Ein Vorschlag ist nie die Analyse, bis er angenommen, automatisch angewendet oder von Hand übernommen wird.
- **Status** einer Antwort: `wartet auf Freigabe` / `Vorschlag` · `angewendet` (auch `automatisch angewendet`, `von Hand übernommen`) · `abgelehnt` · `zurückgenommen` · `abgewiesen` · `veraltet` · bei Ketten `läuft`, `wartet auf Freigabe`, `fertig`, `abgebrochen`, `angehalten · Begrenzung`.
- **Statussprache**: nur Linienart + Textetikett, keine neue Farbe. Gestrichelt = Vorschlag/Plan/Lauf · durchgezogen Akzent = angewendet · grau, Etikett durchgestrichen = zurückgenommen, abgelehnt, abgewiesen, veraltet, abgebrochen · schwarz = Rückfrage, Meldung, Fehler (nichts vorgeschlagen).
- **Herkunftsmarke „Modell“** je Bedingung: fällt weg, sobald Feld, Operator oder Wert von Hand geändert wird; gilt nur in der laufenden Sitzung, wird nicht gespeichert; keine Verbindung zu geteilten Abfragen.
- **Zurücknehmen / Rückgängig** stellt den vorigen Analysezustand vollständig wieder her. Bei auto nur die letzte Modelländerung und nur, solange danach nichts von Hand geändert wurde. Kein „Wiederholen“.
- **Stufen**: Festlegung je Operationsklasse (`catalog`, `query`, `spatial`, `derive`, `display`) aus / Freigabe / auto. Die strengste Festlegung einer Antwort gilt. Die Oberfläche hängt nicht an Stufennamen (1–4, frei benannt, aus Admin › Stufen). Eine offene Freigabe bleibt an ihre Stufe gebunden.
- **Kette übernehmen**: Ergebnis wird Abfrageobjekt; Puffer wird abgeleiteter Layer (Gruppe „Abgeleitet · Sitzung“), übrige Schritte werden Bedingungen mit Marke „Modell“, reine Zwischenlayer entfallen.
- **Was das Modell sieht** (Q5): ohne Datenfreigabe je Schritt nur ok / Fehler / leer / nicht leer; der Anwender sieht immer die Zahl. Vorschau-Trefferzahlen sieht das Modell nicht.
- **Dialogverlauf** ist flüchtig (Q3), nicht Teil der Sitzung; die dauerhafte Spur ist das Protokoll.
- **Protokoll-Sichtbarkeit** (Q4): Anwender eigene Einträge, Administratoren alle samt Prompt.
- **Barrierefreiheit**: Freigabe mit Fokus auf „Annehmen“ und Esc = Ablehnen (bei Dialogen M7.3, M10, M16.3 Fokusfalle); Statuswechsel `role="status"`, Fehler und Abweisung `role="alert"`; kein Status allein über Farbe.

## Entscheidungen aus dem Review (Runden 1–3)
1. Prompt-Panel 460 px neben der Karte (statt Dock). 2. Freigabe angedockt, nicht modal. 3. Vorschau-Trefferzahl vor der Freigabe. 4. Herkunftsmarke wie oben. 5. Statussprache nur über Linienart. 6. Kein „Wiederholen“ (Abweichung vom Briefing M6). 7. Rückgängig nur ohne zwischenzeitliche Handänderung. 8. Gemischte Stufe: strengste Festlegung. 9. Abweisung: Linienart wie abgelehnt, eigenes Etikett. 10. Rückfrage/Meldungen schwarz ohne Status-Linienart. 11. Stufennamen frei, Beispiele Assistenz · Prüfen · Teilautonom · Automatisch. 12. Modellprotokoll für Anwender als Dialog. 13. Kette: Freigabe je Stufe wie oben. 14. Kettenergebnis als Abfrageobjekt. 15. „Modell sieht“ im Panel und im Protokoll. 16. Zwischenstand nach Abbruch übernehmbar. 17. Plan anpassen ohne neue Schritte von Hand. 18. Vergleich als Dialog, Übernehmen = Freigabe.

Hinweis: „Teilautonom“ ist eine vom Admin eingerichtete Beispielstufe (catalog/query/spatial/display auto, derive Freigabe) für M6.3, M8.2, M9.2.

## Design-Tokens (Classical, unverändert zu E1)
- Farben: Grund `#f3f2f2`, Fläche `#eae9e9`, Text `#201f1d`, Akzent `#b68235` (Text im Akzent: accent-700); Zwischenstände der Kette in accent-300 bzw. Neutral 400. Keine neuen Farbwerte.
- Schrift: „Cormorant Garamond“ (max. 600) / „Lora“; Zahlen tabellarisch. Technische Angaben (Codes, Hashes, „Modell sieht“) in Monospace.
- Abstand 4.6 · 9.2 · 13.8 · 18.4 · 27.6 · 36.8 px; Radius 2 · 4 · 7 px; Schatten sm/md/lg aus `_ds/…/styles.css`.
- Muster: Buttons umrandet, nie gefüllt; aktive Segmente 2 px Akzent-Unterstrich; Fokus 2 px Akzent; deaktiviert 45 %. Icons Lucide (Unicode-Zeichen sind Platzhalter).

## Daten
`fixture/modus-b.json`: Stufen, Anbindungen, Grenzwerte, Referenzfrage mit Abfrageobjekt, Kettenschritten und erwarteten Zahlen, alle Beispieldialoge der Referenz mit Zuordnung zum Bildschirm, Vergleichsfall und Kennzahlen. Abgestimmt auf `fixture/beispieldaten.json` aus E1.

## Dateien
- `screenshots/`: ein PNG je Bildschirm mit allen Zuständen (`M1.png` … `M16.png`, Dateiname = Code), dazu `00-navigation.png` (Kopf, Seitenleiste, Administration, Ablauf einer Anfrage, Übergänge, Adressen, Statussprache) und `00-entscheidungen.png`. Jedes Bild enthält je Zustand die Zeile „Weiter“ und die Notiz.
- `GeoTandem E2 - Final.dc.html`: Referenz aller E2-Bildschirme.
- `support.js`, `_ds/…/styles.css`, `_ds/…/_ds_bundle.js`: zum Öffnen der Referenz nötig.
- `fixture/modus-b.json`.
- Projektdokumente (im Repository): `BRIEF.md`, `anforderungen.md`, `etappen.md`, `tech-stack.md`; E1-Paket `design_handoff_geotandem_e1/`.
