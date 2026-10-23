# Briefing: GeoTandem · Etappe 3 (Bewertung der Modellanbindungen)

> Stand: 2026-10-23 · Bezug: [docs/plan-e3.md](../../docs/plan-e3.md) (Entscheidungen D1–D12, O1–O4), [bewertung.md](../../bewertung.md), [anforderungen.md](../../anforderungen.md) F-3.13–F-3.18 · Baut auf E1 (`design/e1/`: Admin-Rahmen D1, Layerseite D3, Protokollmuster D7/D8) und E2 (`design/e2/`: Modellprotokoll M16, lesbarer Bedingungsbaum, Statussprache) auf.
>
> Lieferung wie bei E2: Referenz in HTML (low-fidelity), ein PNG je Bildschirm mit allen Zuständen, Zeile „Weiter“ und Notiz je Zustand, eine Fixture `fixture/bewertung.json`, README mit Navigation, Verhalten und den Entscheidungen aus dem Review.

## 1 Worum es geht

Der Administrator soll **messen** können, welche Modellanbindung für seine Daten und Fragen taugt, statt es zu vermuten. Heute sagt ihm der Verbindungstest nur, ob ein Endpunkt antwortet.

Leitfrage: *Der Administrator erkennt nicht nur, dass eine Anbindung schlechter abschneidet, sondern woran es liegt — am Modell, am Prompt oder an den Metadaten seiner Layer.*

Nutzer ist allein der **Administrator**. Anwender sehen von E3 nichts, ausser dass sich die Anbindung, die ihnen angeboten wird, auf eine Messung stützt.

## 2 Begriffe (für die Beschriftung)

| Begriff | Bedeutung |
|---|---|
| **Prüffall** | Eine Frage, wie ein Anwender sie stellt, mit der richtigen Antwort: eine Referenzabfrage (*Abfragefall*) oder eine erwartete Reaktion wie Rückfrage oder „nicht beantwortbar“ (*Verhaltensfall*). Trägt Stichwörter (z. B. räumlich, Zählung, mehrdeutig) |
| **Startbestand** | 71 mitgelieferte Prüffälle auf den Beispieldaten; nur lesbar, kopierbar |
| **Eigene Prüffälle** | vom Administrator angelegt: im Arbeitsplatz gebaut, aus dem Modellprotokoll übernommen oder importiert |
| **Teil** | *Abstimmung* (daran darf man Prompts verbessern) oder *Bestätigung* (nur zum Nachprüfen) |
| **Datenstand** | *Beispieldaten* (fest, immer gleich) oder *Betriebsdaten* (die eigenen Layer, so wie der Administrator sie sieht) |
| **Messpunkt** | eine Anbindung mit Promptprofil und Stufe (optional mit geändertem System-Prompt) |
| **Promptprofil** | drei Auswahlen je Anbindung: Beispiele (Standard · 12), Platzierung (P0 · P5 · P9), Ausgabe (erzwungen · nur Text) |
| **Bewertungslauf** | alle gewählten Prüffälle über alle Messpunkte, je Fall 10-mal (zwei Blöcke à 5); **Schnelltest** = ein Block |
| **Urteil** | richtig · falsch · abgewiesen · andere Antwortart · nicht lesbar/Fehler; dazu bei falsch die Merkmale *ohne Annahme* und *0 Treffer* |
| **still falsch** | falsch und ohne genannte Annahme: das Modell wirkt sicher und liegt daneben |

## 3 Navigation

Administration › Gruppe **Modell** (aus E2): Modellanbindungen · Stufen · Was das Modell sieht · Modellprotokoll · **Bewertung** (bisher ausgegraut, jetzt aktiv). Bewertung hat zwei Reiter: **Läufe** (Standard) und **Prüffälle**.

| Route (Vorschlag) | Bildschirm |
|---|---|
| `/admin/bewertung` | V5 Läufe |
| `/admin/bewertung/lauf/neu` | V4 Neuer Lauf |
| `/admin/bewertung/lauf/:id` | V6 Matrix (während des Laufs mit Fortschritt) |
| `/admin/bewertung/lauf/:id/fall/:fall` | V7 Fall im Lauf |
| `/admin/bewertung/faelle`, `…/faelle/:id` | V1, V2 |

Einstiege von aussen: im Arbeitsplatz (nur Admin) **Als Prüffall speichern** (V3); im Modellprotokoll-Eintrag M16.2 **Als Prüffall übernehmen**; auf *Was das Modell sieht* die Vollständigkeit (V8); auf der Anbindungsseite „zuletzt bewertet“ mit Link zum Lauf.

## 4 Bildschirme und Zustände

### V1 · Prüffälle (Liste)
- V1.1 Liste: Frage (Wortlaut), Art (Abfrage/Verhalten), Teil, Stichwörter, Herkunft (Start · Arbeitsplatz · Protokoll · Import), Datenstand; Filter nach diesen Spalten; Import, Export.
- V1.2 Ein eigener Fall ist **veraltet** (Layer gelöscht oder nicht mehr sichtbar) bzw. **Datenstand geändert** (Layer neu importiert): Kennzeichen in der Zeile, Statussprache aus E2 (veraltet grau, durchgestrichenes Etikett).
- V1.3 Import mit Fehlern: welcher Fall, warum (z. B. Referenzabfrage ungültig), nichts wird halb übernommen.
- V1.4 Leer: noch keine eigenen Fälle, Hinweis auf die drei Wege, einen anzulegen.

### V2 · Prüffall (Einzelansicht, Bearbeiten)
- V2.1 Abfragefall: Frage, Referenz als **lesbarer Bedingungsbaum** (wie M2, kein JSON im Vordergrund, „Technisch“ aufklappbar), Trefferzahl auf dem Datenstand, „Im Arbeitsplatz öffnen“, Stichwörter, Teil, Anmerkung (fachliche Absicht).
- V2.2 Verhaltensfall: erwartete Reaktion (Rückfrage · nicht beantwortbar · andere Arbeitsweise), zulässige weitere Reaktionen.
- V2.3 Startfall: nur lesbar, „Als eigenen Fall kopieren“.
- V2.4 Mehrere faire Lesarten: zwei oder mehr Referenzen, jede gilt.

### V3 · Als Prüffall speichern (Dialog im Arbeitsplatz)
- V3.1 Die aktuelle Analyse wird zur Referenz (Vorschau als Baum und Trefferzahl); der Administrator schreibt die Frage so, wie ein Anwender sie stellen würde (Hilfetext dazu), wählt Stichwörter und Teil.
- V3.2 Nicht speicherbar: die Analyse überschreitet einen Grenzwert (z. B. mehr als 8 Bedingungen).

### V4 · Neuer Lauf
- V4.1 Messpunkte zusammenstellen: Zeilen aus Anbindung · Promptprofil (drei Auswahlen, Vorgabe = Profil der Anbindung) · Stufe · optional „System-Prompt für diesen Lauf ändern“ (Textfeld, ändert den Betrieb nicht). Mehrere Zeilen, eine davon ist die **Vergleichsbasis**.
- V4.2 Prüffälle wählen: Startbestand und/oder eigene, Teil, Stichwörter; Datenstand ergibt sich aus der Wahl (ein Lauf hat einen Datenstand).
- V4.3 Umfang: **Vollständig** (2 × 5) oder **Schnelltest** (1 × 5, ohne Vergleichsaussage).
- V4.4 **Abschätzung vor dem Start**: Anfragen je Anbindung, geschätzte Tokens, bei hinterlegtem Preis geschätzte Kosten in der Währung des Preises; bei einer externen Anbindung der Hinweis „Steckbrief und Fragen gehen an *Host*; keine Geodaten-Inhalte“ mit ausdrücklicher Bestätigung.
- V4.5 Ein anderer Lauf läuft schon: Start gesperrt, Link zu ihm.

### V5 · Läufe (Liste)
- V5.1 Liste: Beschriftung (wer, wann, Messpunkte, Fälle, Datenstand), Status (läuft · fertig · abgebrochen · unterbrochen), Ergebnis der Vergleichsbasis in einer Zahl, Kosten; zwei Läufe zum Gegenüberstellen markieren.
- V5.2 Leer.

### V6 · Matrix (das Herzstück)
- V6.1 Während des Laufs: Fortschritt (Fälle × Messpunkte, Zeit, bisherige Kosten), Abbrechen; Zellen füllen sich.
- V6.2 Fertig: **Zeilen = Prüffälle** (gruppiert nach Stichwort, Gruppen mit Summen), **Spalten = Messpunkte**. Zelle: richtig von 10, dazu die Mischung der übrigen Urteile in Kurzform; still falsche Antworten hervorgehoben (ohne neue Farbe: Linienart/Zeichen + Text).
- V6.3 **Spaltenkopf** je Messpunkt: Quote, still falsch, nicht lesbar, Verhaltensfälle erfüllt, Antwortzeit (Median, oberes Zehntel), Tokens/Kosten, und gegenüber der Vergleichsbasis in Worten **besser · schlechter · nicht belegt** mit dem Unterschied und seiner Spanne (z. B. „+6,6 Punkte, 1,3 … 13,2“).
- V6.4 **Beschriftung des Laufs** (aufklappbar): Schemaversion, Datenstand, Stand des Steckbriefs (V8-Zusammenfassung), Stufe und Prompt-Hash, je Messpunkt Modell, Host, Temperatur, Promptprofil, Seeds, Zeitpunkt.
- V6.5 Schnelltest: dieselbe Matrix ohne Vergleichsaussage, Hinweis „Ein Block: für einen ersten Eindruck, nicht für eine Entscheidung“.
- V6.6 Aktionen: **Promptprofil übernehmen** (für die Anbindung dieser Spalte; Bestätigung, was sich im Betrieb ändert), **Zur Anbindung** (freigeben, als Standard setzen), Lauf gegen einen anderen stellen.
- V6.7 Zwei Läufe nebeneinander (gleiche Fälle): je Messpunkt die Werte beider Läufe und der Unterschied.

### V7 · Fall im Lauf (Einzelansicht einer Zelle)
- V7.1 Frage und Referenz (Baum) links; rechts die Antworten der 10 Wiederholungen als Liste: Urteil, Erklärung, Annahmen, Zeit.
- V7.2 Eine falsche Antwort geöffnet: **Unterschied zur Referenz** in Worten (fehlende, zusätzliche, geänderte Bedingung; anderer Layer; andere Distanz), beide Ergebnismengen als Zahlen und die abweichenden Objekte, „Im Arbeitsplatz öffnen“ für Antwort und Referenz.
- V7.3 Richtig, aber anders formuliert: Urteil richtig, Unterschied trotzdem sichtbar (Stufe 1 erklärt, sie urteilt nicht).
- V7.4 Abgewiesen / nicht lesbar: Code und Grund wie M3, Rohtext unter „Technisch“.
- V7.5 Verhaltensfall: erwartete Reaktion gegen die gegebene.

### V8 · Stand des Steckbriefs (auf *Was das Modell sieht* und in V6.4)
- V8.1 Zusammenfassung: Attribute mit eigener Beschriftung, Textattribute mit bestätigter Codeliste, Layer und Attribute mit Beschreibung, je als Anteil.
- V8.2 Lücken je Layer in der Reihenfolge der Pflege: **1. Codelisten bestätigen** (stärkste Wirkung) · **2. Beschriftungen** · **3. Beschreibungen, die die Bedeutung nennen, nicht den Verbund** — mit Link auf die Layerseite D3 (Reiter Felder).
- V8.3 Vollständig: kurze Bestätigung.

## 5 Verhalten

- Ein Lauf ist eine **Messung, kein Betrieb**: Er erscheint nicht im Modellprotokoll, ändert keine Analyse und keine Konfiguration. Nur „Promptprofil übernehmen“ ändert den Betrieb, mit Bestätigung.
- Es läuft **höchstens ein Lauf** zugleich; er läuft weiter, wenn die Seite geschlossen wird, und lässt sich abbrechen. Nach einem Neustart steht er auf „unterbrochen“, die bisherigen Antworten bleiben.
- **Kein Urteil allein über Farbe**; Statussprache und Tokens wie E2. Zahlen tabellarisch, Hashes und Codes in Monospace.
- Vergleichsaussagen nur bei einem vollständigen Lauf; „nicht belegt“ ist eine gleichwertige Aussage, kein Fehler.
- Barrierefreiheit: Matrix als Tabelle mit Zeilen- und Spaltenköpfen, Zellen per Tastatur erreichbar, Fortschritt `role="status"`.

## 6 Daten für die Fixture

Realistisch aus den Messungen ([benchmarks.md](../../docs/benchmarks.md), Läufe 3–5); der Bildschirm soll mit diesen Zahlen funktionieren:

- **Messpunkte:** gemma4:12b (lokal, 1,4 s Median), Claude Haiku 5.5 (extern, api.anthropic.com, nur Text, ≈ 0,0013 USD je Frage, 3,2 s), gpt-6-luna (extern, api.openai.com, ≈ 0,0008 USD, 2,0 s). Promptprofil P0 als Standard; Luna zusätzlich mit P9.
- **Ergebnisse Abstimmung (33 Fälle × 10):** Haiku 318, Luna 280, gemma4:12b 272; Luna P9 gegen P0 auf Bestätigung: +6,6 Punkte (1,3 … 13,2), *besser*; gemma4:12b gegen Luna auf Bestätigung: −3,7 (−15,8 … +7,6), *nicht belegt*.
- **Typische Fälle:** `doc1-primar-koeniz` „Welche Primarschulen gibt es in Köniz?“ (zwei faire Lesarten); `n03-einwohner-tabelle` „Gemeinden mit mehr als 10 000 Einwohnern“ (Luna P9: 6 von 10 still falsch, alle Gemeinden ohne Filter, die Erklärung behauptet den Filter); `attr-franzoesisch` (ohne bestätigte Codeliste 0 von 10 bei allen); `n13-bahnhof-bern` (verfehlen alle); `n15-je-gemeinde` (Verhaltensfall: nicht beantwortbar).
- **Steckbrief:** Beispieldaten vollständig; ein Kunden-Layer nach schlichtem Import mit 0 % Beschriftungen und unbestätigten Codelisten (Phase 4: gemma4:12b fällt dort von 272 auf 142).

## 7 Nicht Teil dieses Designs

Werkzeugkette in der Bewertung, Läufe in der Sicht eines anderen Kontos, Synonyme und Wertelisten im Steckbrief (E-7), von Hand korrigierte Antworten als Prüffälle, Freigabe durch eine zweite Person, freie Promptprofile.
