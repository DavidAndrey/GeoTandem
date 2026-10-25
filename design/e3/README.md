# Handoff: GeoTandem · Etappe 3 (Bewertung der Modellanbindungen)

## Überblick
Bildschirmreferenz für E3 nach `BRIEF.md` (Stand 2026-10-23; Bezug `docs/plan-e3.md`, `bewertung.md`, F-3.13–F-3.18). Der Administrator **misst**, welche Modellanbindung für seine Daten und Fragen taugt, und erkennt, *woran* es liegt: am Modell, am Prompt oder an den Metadaten seiner Layer.

Nur Administratoren. Anwender sehen von E3 nichts ausser „zuletzt bewertet“ an der Anbindung.

## Über die Designdateien
**Designreferenzen in HTML** (Wireframes), kein Produktionscode. Nachbauen in der Zielumgebung laut `tech-stack.md` (Vite + TypeScript + React 19, React Router, Tailwind CSS) mit den Mustern der Codebasis. Baut auf E1 (Admin-Rahmen D1, Layerseite D3, Protokollmuster D7/D8) und E2 (lesbarer Bedingungsbaum, Statussprache, Modellprotokoll M16) auf.

`GeoTandem E3 - Drafts.dc.html` im Browser öffnen (braucht `support.js` und `_ds/` daneben). Jeder Bildschirm hat einen Code (V1 … V8), jeder Zustand eine Nummer (V1.1 …), eine Zeile „Weiter“ und eine Notiz. Alle Zustände sind ganze Seiten.

## Fidelity
**Low-fidelity** wie E1/E2. Massgeblich sind Struktur, Inhalte, Zustände und Abläufe. Tokens unverändert (Classical), siehe E1-README.

## Navigation und Adressen
Administration › Gruppe **Modell**: Modellanbindungen · Stufen · Was das Modell sieht · Modellprotokoll · **Bewertung** (bisher ausgegraut, jetzt aktiv). Bewertung mit Reitern **Läufe** (Standard) und **Prüffälle**.

| Route | Bildschirm |
|---|---|
| `/admin/bewertung` | V5 Läufe |
| `/admin/bewertung/lauf/neu` | V4 Neuer Lauf |
| `/admin/bewertung/lauf/:id` | V6 Matrix (läuft: V6.1) |
| `/admin/bewertung/lauf/:id/fall/:fall` | V7 Fall im Lauf |
| `/admin/bewertung/faelle`, `…/faelle/:id` | V1, V2 |

Einstiege von aussen: Arbeitsplatz (nur Admin) **Als Prüffall speichern** → V3 · Modellprotokoll M16.2 **Als Prüffall übernehmen** → V2 vorbefüllt · *Was das Modell sieht* → Vollständigkeit V8 · Anbindungsseite „zuletzt bewertet“ → V6.

## Bildschirme
- **V1 Prüffälle**: V1.1 Liste (Kennung, Frage, Art, Teil, Stichwörter, Herkunft, Datenstand; Filter; Import/Export; Startfälle oben, eigene darunter) · V1.2 eigener Fall *veraltet* (grau, durchgestrichenes Etikett) / *Datenstand geändert* (Meldung, schwarz) · V1.3 Import mit Fehlern (Dialog; Fall + Grund; nichts übernommen) · V1.4 keine eigenen Fälle (drei Wege).
- **V2 Prüffall**: V2.1 Abfragefall bearbeiten (Referenz als Bedingungsbaum mit Treffern je Bedingung, „Technisch“ aufklappbar; Trefferzahl auf dem Datenstand; Im Arbeitsplatz öffnen; Weitere Lesart; Teil; Stichwörter; Anmerkung; Herkunft) · V2.2 Verhaltensfall (erwartet; auch zulässig als Haken; nicht zulässig) · V2.3 Startfall nur lesbar mit zwei Lesarten (gleich gewichtet; „Als eigenen Fall kopieren“).
- **V3 Als Prüffall speichern** (Dialog im Arbeitsplatz): V3.1 Referenz = aktuelle Analyse (Baum, Treffer, Datenstand), Frage in Anwenderworten mit Hilfetext, Teil (Vorgabe Bestätigung), Stichwörter · V3.2 nicht speicherbar (> 8 Bedingungen; gleiche Grenzwerte wie M3).
- **V4 Neuer Lauf** (eine Seite, vier Schritte): V4.1 Messpunkte (Anbindung · Promptprofil mit drei Auswahlen · Stufe · System-Prompt nur für diesen Lauf · Vergleichsbasis als Radio), Prüffälle (Startbestand/eigene, Teil, Stichwort; ein Datenstand je Lauf), Umfang (Vollständig 2 × 5 · Schnelltest 1 × 5), Abschätzung (Anfragen, Tokens, Kosten in Preiswährung, Dauer; extern: „Steckbrief und Fragen gehen an *Host*; keine Geodaten-Inhalte“ + Haken, sonst Start gesperrt) · V4.2 anderer Lauf läuft (Start gesperrt, Link).
- **V5 Läufe**: V5.1 Liste (Lauf, wann/wer, Messpunkte · Fälle · Datenstand · Umfang, Status, Quote der Vergleichsbasis, Kosten; zwei markieren → Gegenüberstellen, nur bei gleichen Fällen und vollständigen Läufen) · V5.2 leer (Vorschlag kleinster erster Lauf).
- **V6 Matrix**: V6.1 läuft (Fortschritt `role="status"`, Zeit, Kosten bisher, Abbrechen; Zellen füllen sich; Spaltenköpfe erst am Ende) · V6.2 fertig (Zeilen = Prüffälle nach Stichwort mit Gruppensummen, Spalten = Messpunkte; Zelle „richtig von 10“ + Kurzform f/a/x/n; still falsch = gestrichelter Rahmen + „!“ + Text; Spaltenkopf: Quote Abstimmung, still falsch, nicht lesbar, Verhalten, Zeit Median · oberes Zehntel, Tokens/Kosten, Aussage auf Bestätigung *besser · schlechter · nicht belegt* mit Unterschied und Spanne; Vergleichsbasis mit Strich oben) · V6.3 Beschriftung des Laufs · V6.4 Promptprofil übernehmen (Dialog mit Änderungsliste und Kehrseite) · V6.5 Schnelltest (ohne Vergleich, Hinweis) · V6.6 zwei Läufe nebeneinander.
- **V7 Fall im Lauf**: V7.1 links Frage + Referenz, rechts 10 Antworten (1.1–2.5: Urteil, Erklärung, Annahmen, Zeit) · V7.2 falsche Antwort geöffnet (Unterschied in Worten +/−/~, Treffer beider Mengen, abweichende Objekte, beide im Arbeitsplatz öffnen) · V7.3 richtig, anders formuliert · V7.4 abgewiesen / nicht lesbar (wie M3/M14, Rohtext unter Technisch) · V7.5 Verhaltensfall (erwartet gegen gegeben).
- **V8 Stand des Steckbriefs** (auf *Was das Modell sieht* und in V6.3): V8.1 Zusammenfassung je Layer als Anteile (Balken + Zahl) und Lücken in Pflegereihenfolge 1. Codelisten · 2. Beschriftungen · 3. Beschreibungen mit Bedeutung, je Link auf D3 › Felder; Bezug zum Messergebnis · V8.2 vollständig.

## Verhalten
- Ein Lauf ist eine **Messung, kein Betrieb**: nicht im Modellprotokoll, ändert keine Analyse und keine Konfiguration. Einzige Ausnahme: „Promptprofil übernehmen“ mit Bestätigung (im Modellprotokoll vermerkt).
- **Höchstens ein Lauf** zugleich; läuft weiter, wenn die Seite geschlossen wird; abbrechbar. Nach Neustart „unterbrochen“, bisherige Antworten bleiben.
- Ein Lauf hat **einen Datenstand**; Startbestand und eigene Fälle auf Betriebsdaten werden nicht gemischt.
- Vergleichsaussagen nur bei vollständigen Läufen; „nicht belegt“ ist gleichwertig, kein Fehler.
- Veraltete eigene Fälle werden in Läufen nicht verwendet, bis sie bearbeitet sind.
- **Kein Urteil allein über Farbe**; Statussprache wie E2. Zahlen tabellarisch, Hashes und Codes in Monospace.
- Barrierefreiheit: Matrix als Tabelle mit Zeilen- (`th scope="row"`, Gruppen `scope="rowgroup"`) und Spaltenköpfen, Zellen per Tastatur erreichbar (Enter öffnet V7), Fortschritt `role="status"`, Fehler `role="alert"`, Dialoge mit Fokusfalle.

## Entscheidungen aus dem Review
1. Quote im Spaltenkopf auf **Abstimmung**, Vergleichsaussage auf **Bestätigung**.
2. Still falsch: gestrichelter Rahmen + „!“ + Text „still falsch“; das Etikett unterscheidet es vom E2-Vorschlag.
3. Neue eigene Prüffälle: Vorgabe Teil = **Bestätigung**.
4. Neuer Lauf als **eine Seite** in vier Schritten; Abschätzung reagiert sofort.
5. Spaltenköpfe (Quote, Vergleich) **erst am Ende** des Laufs, keine Zwischenquote.
6. „Zur Anbindung“ führt auf die bestehende Seite Modellanbindungen; freigeben und als Standard setzen dort.

## Offener Punkt (geklärt 2026-10-24)
- `attr-franzoesisch` hat in Wirklichkeit 10 von 10 bei allen vier Messpunkten (Läufe `p0-*`, `x-p0-*`, `p9-luna`). „0 von 10“ in BRIEF §6 galt nur *ohne* bestätigte Codelisten (Phase 4, Modus `no-domains`). Der Steckbrief der Beispieldaten ist vollständig in den Codelisten (6 von 6 bestätigt), nicht in den Beschriftungen und Beschreibungen: 6 von 27 Beschriftungen wiederholen den Spaltennamen (Gross-/Kleinschreibung zählt nicht, z. B. «Einwohner» über `einwohner`), 22 von 27 Attributen haben keine Beschreibung. V8.2 erscheint für sie also nicht (berichtigt in WP94, 2026-10-25; die Zahlen von `steckbrief.beispieldaten` in der Fixture sind nicht gezählt). Fixture berichtigt (Zellen, Teil = Abstimmung, da der Fall aus `cases.json` stammt).

## Daten
`fixture/bewertung.json`: Prüffälle (inkl. Lesarten, Verhaltensfall, eigene mit Status), Messpunkte, Läufe #8–#14 mit Beschriftung, Ergebnissen, Vergleich, Zellen der Referenzfälle, Fall-im-Lauf n03 × luna P9, Abschätzung und Steckbrief. Werte aus BRIEF §6; ergänzte Werte sind mit `"_ergaenzt": true` markiert (u. a. luna P9 Abstimmung 291, Haiku-Vergleich, Kosten, Läufe #8–#12, eigene Fälle).

## Dateien
- `screenshots/`: ein PNG je Bildschirm mit allen Zuständen (`V1.png` … `V8.png`), dazu `00-navigation.png` und `00-entscheidungen.png`.
- `GeoTandem E3 - Drafts.dc.html` mit `support.js` und `_ds/`.
- `fixture/bewertung.json`.
