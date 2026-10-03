# Handoff: GeoTandem · Etappe 1 (Klassik-Modus)

## Überblick
Bildschirmreferenz für Etappe E1 (E1.1–E1.7 aus `etappen.md`): Ersteinrichtung, Anmeldung und Rollen, Arbeitsplatz mit Karte, Layer-Panel, globaler Abfrage, Operationen (Puffer, Join, Aggregation), Attributtabelle, Sitzungen und gespeicherte Abfragen sowie die Administration (Datenkatalog, Import, Protokoll, Benutzer, Sichtbarkeit). E1 läuft ohne LLM-Anbindung (F-4.11); der Reiter „Prompt" ist sichtbar, aber deaktiviert.

Vorführung E1: Eine mehrschichtige räumliche Frage wird von Hand gelöst, als Sitzung gespeichert und nach Neustart identisch wiederhergestellt.

## Über die Designdateien
Die Dateien in diesem Paket sind **Designreferenzen in HTML**: Wireframes, die Aufbau, Inhalte und Verhalten zeigen, kein Produktionscode. Aufgabe ist, sie in der Zielumgebung nachzubauen. Laut `tech-stack.md` ist das Vite + TypeScript + React 19, React Router, Leaflet/react-leaflet und Tailwind CSS im Frontend sowie SQLAlchemy mit SpatiaLite (Standard) / PostGIS im Backend. Die HTML-Struktur nicht übernehmen; die Muster der Codebasis verwenden.

`GeoTandem E1 Referenz.dc.html` im Browser öffnen (braucht `support.js` und `_ds/` daneben). Jeder Bildschirm hat einen Code (A1 … D11) und eine Zeile „Von / Nach".

## Fidelity
**Low-fidelity.** Massgeblich sind Struktur, Inhalte, Zustände und Abläufe. Abstände und Grössen sind ungefähr. Für die Gestaltung die Tokens unten verwenden (Classical-Designsystem: Serifen, Haarlinien, Farbe als Kontur statt Fläche, Buttons umrandet).

## Navigation und Adressen
Zwei Bereiche mit fester Kopfzeile.

**Anwendung:** Marke → B1 · Sitzungsname ▾ (C1) · Änderungsanzeige („● ungespeichert" / „gespeichert 14:02") · „Administration" (nur Rolle Administrator) · Benutzermenü (Name, Rolle, Passwort ändern → A4, Abmelden → C5 bei Änderungen, sonst A2).
**Administration:** Marke · „Administration" · „Zur Anwendung" (zurück in die zuletzt offene Sitzung) · Benutzermenü. Darunter die Seitennavigation D1.

| Route | Bildschirm | Hinweis |
|---|---|---|
| `/einrichtung` | A1 | nur solange kein Konto existiert |
| `/anmelden` | A2 | danach letzte Sitzung bzw. Ziel-URL |
| `/passwort` | A4 | Pflichtschritt bei Startpasswort |
| `/` | B1 | letzte Sitzung oder neue, leere (B12) |
| `/sitzung/:id` | B1 + C4/C8 | Sitzung mit eigener Adresse; Prüfung beim Laden |
| `/admin/daten` | D1 + D2 | Standardseite der Administration |
| `/admin/daten/:layer?reiter=` | D3 | Reiter: beschreibung, felder, vorschau, verlauf, darstellung, verwendung |
| `/admin/daten/import?ziel=:layer` | D6 (D4, D11) | ohne `ziel` = neuer Layer |
| `/admin/protokoll`, `/admin/protokoll/:id` | D7, D8 | |
| `/admin/benutzer` | D9 | |
| `/admin/sichtbarkeit` | D10 | |

Ohne Adresse (Panel, Menü, Dialog über der Seite): B2–B7, B8 (Dock), B11–B13, C1–C3, C5, C6, C8, D4, D5, D11. Die vollständige Übergangstabelle steht in der Referenz unter „Globale Navigation und Beziehungen".

## Bildschirme

### A · Zugang (E1.1, E1.4)
- **A1 Ersteinrichtung**: erster Administrator (Benutzername, Passwort ×2), Häkchen „Beispieldatensatz laden" (Standard an) lädt `fixture/beispieldaten.json`. → B1.
- **A2 Anmeldung**: Benutzername, Passwort, „Anmelden". Kein Selbstregistrieren, keine Passwort-Mail („bitte an den Administrator wenden").
- **A3 Anwendersicht**: wie B1, ohne Knopf „Administration", nur freigegebene Layer (Kitas fehlt).
- **A4 Passwort ändern**: Dialog aus dem Benutzermenü (aktuelles, neues ×2, Abbrechen möglich) oder Pflichtseite nach A2 bei Startpasswort (ohne Abbrechen). Regel: mind. 10 Zeichen, ungleich dem alten.

### B · Arbeitsplatz (E1.2, E1.5, E1.6)
- **B1 Arbeitsplatz**: Raster 250 px Seitenleiste | Karte. Seitenleiste von oben: Reiter Klassik | Prompt (deaktiviert, „ab E2"); **Layer** (Ziehgriff, Auge, Symbol aus der Katalog-Darstellung, Name; aktiver Layer klappt Deckkraft-Regler, „Auf Layer zoomen" und ⋯ auf); Gruppe **„Abgeleitet · Sitzung"** mit Herkunft ↰; **Abfrage** (Trefferzahl „7 von 39", Ergebnis-Layer ▾, kompakter Bedingungsbaum, „+ Bedingung", „Bearbeiten ›", Einschränkung „Nur in: Ausschnitt / Fläche ✎"); **Gespeicherte Abfragen** ▾ (Speichern, Speichern unter, Neue Abfrage, Liste nach Ziel-Layer, Verwalten → C6). Karte mit Werkzeugleiste B10, Massstabsleiste, Popup. Darunter angedockt die Tabelle B8 (Trenner zum Verstellen, ⌄ einklappen).
  Regeln: Das Layer-Panel steuert nur die Anzeige. Die Abfrage ist global, mit genau einem Ergebnis-Layer je Sitzung; andere Layer wirken nur als Bedingung.
- **B2 Abfrage-Editor**: Panel zwischen Seitenleiste (abgedunkelt) und Karte. UND/ODER am Gruppenkopf, verschachtelbare Gruppen, Zeilentyp „Attribut" oder „Raum", Trefferzahl je Bedingung allein rechts. Aktive Zeile wird auf der Karte gezeigt. „Übernehmen" schreibt ins Abfrageobjekt, „Verwerfen" stellt den vorigen Stand wieder her. Werteditor je Operator: Vergleich (= ≠ < ≤ > ≥), Bereich (zwischen, mit Histogramm), Text (enthält, beginnt mit, endet mit, ist leer), Liste (ist eins von, Chips). Raumbeziehungen: liegt in, liegt ausserhalb, schneidet, berührt, ≤ / > Distanz zu, enthält; optional NICHT.
- **B3 Layer-Menü ⋯**: Katalog-Layer: Auf Layer zoomen · Tabelle öffnen · Als Ergebnis-Layer · Puffer … · Join … · Aggregieren … · Im Datenkatalog öffnen (Admin) · Aus Analyse entfernen. Abgeleiteter Layer: dieselben Anzeige-Aktionen · Parameter ändern · Darstellung … · In Datenkatalog übernehmen (Admin) · Löschen (nennt abhängige abgeleitete Layer). Entfernen fragt nach, wenn der Layer Ergebnis-Layer oder in einer Bedingung ist.
- **B4 Puffer**: Distanz + m/km, „Überlappende verschmelzen", „Nur gefilterte Objekte", Name (Vorgabe „Puffer 500 m"), Vorschau.
- **B5 Join**: Geometrie-Layer.Schlüssel = Tabelle.Schlüssel, Trefferquote („36 / 38"), ohne Treffer behalten/verwerfen, Feldauswahl.
- **B6 Aggregation**: Für jedes Gebiet aus Layer X; Kennzahlen Anzahl, Summe, Mittelwert, Min, Max mit neuem Feldnamen; Zuordnung liegt in / schneidet.
- **B7 Darstellung abgeleiteter Layer** (entschieden): automatische Vorgabe (Puffer: Akzentfläche halbtransparent; Aggregation: Klassen über erste Kennzahl; Join: Darstellung des Geometrie-Layers) plus Schnellwahl des Feldes, kein voller Editor.
- **B8 Attributtabelle**: Reiter je Layer (Ergebnis-Layer zuerst) · Treffer / Alle · „nur aktueller Kartenausschnitt" (reine Anzeige) · Spalten ▾ (sortierbar, berechnete Spalten markiert) · Sortieren per Spaltenkopf (↓/↑/aus, Umschalt = zweite Sortierung) · Kästchen-Mehrfachauswahl · ⌖ zoomt · „Auswahl als Filter".
- **B9 Kartenzustände**: Treffer = Akzent, kein Treffer (bei „Alle") = 35 % Deckkraft, ausgewählt = Umriss 2 px + gestrichelter Ring. Hover auf Zeile hebt kurz hervor.
- **B10 Kartenwerkzeuge**: senkrechte Leiste oben rechts, 24 px breit, Gruppen durch Haarlinien: Suche | + − Home Standort | Info Messen Auswahl Zeichnen | Grundkarte Legende. Beschriftung als Tooltip.
- **B11 Layer hinzufügen**: Popover an „+ Layer"; Suche über Namen und Synonyme, nur für die Rolle sichtbare Layer, bereits verwendete ausgegraut, Mehrfachauswahl, „Neue Daten importieren" (Admin → D6). Tabellen ohne Geometrie nur als Tabellenreiter/Join-Quelle.
- **B12 Leerzustände**: neue Sitzung ohne Layer; Abfrage mit 0 Treffern (Bedingung mit 0 markiert, „Bedingungen prüfen ›"); leerer Katalog („+ Importieren", „Beispieldatensatz laden").
- **B13 Ergebnis-Layer wechseln**: listet wegfallende Attribut-Bedingungen und bleibende Raumbedingungen; Option „vorher speichern unter".

### C · Sitzung und Abfragen (E1.7)
- **C1 Sitzungsmenü**: Speichern (⌘S) · Speichern unter … · Neue Sitzung · Zuletzt (2) · Alle öffnen … · Diese Sitzung löschen.
- **C2 Speichern unter**: Name, Notiz, Zusammenfassung des Gespeicherten, Ergebnis-Stempel.
- **C3 Sitzungen**: Suche; Spalten Name, Ziel-Layer, Treffer, Geändert, ⋯ (Öffnen, Umbenennen, Duplizieren, Löschen); Kennzeichen „Daten neu".
- **C4 Öffnen mit Prüfung**: Abfrage neu ausführen und mit dem Stempel vergleichen. Gleich → Hinweis „identisch", schliesst nach einigen Sekunden. Abweichend → bleibender Hinweis mit Ursache aus `datenstand`, Aktionen „Unterschied in Tabelle zeigen" / „Mit aktuellen Daten übernehmen" (setzt neuen Stempel).
- **C5 Ungespeicherte Änderungen**: bei Öffnen, Neue Sitzung, Abmelden: Speichern und öffnen · Verwerfen · Abbrechen.
- **C6 Abfragen verwalten**: Tabelle Name, Ziel-Layer, Bedingungen, Geändert, Geteilt, ⋯. Geteilt = für alle lesbar, Ändern erzeugt Kopie. Löschen fragt nach, wenn in einer Sitzung verwendet.
- **C7 Gespeicherter Zustand**: siehe `schema/sitzung.example.json`.
- **C8 Fehlender Layer**: Ergebnis-Layer fehlt → Sitzung öffnet ohne Ergebnis, Aktionen „Layer wiederherstellen" (Admin) / „Anderen Ergebnis-Layer wählen". Bedingungs-Layer fehlt → Bedingung abgeschaltet und markiert, Ergebnis gilt als abweichend.

### D · Administration (E1.3, E1.4)
- **D1 Rahmen**: Seitennavigation 170 px: Daten (Datenkatalog, Importprotokoll) · Zugang (Benutzer, Sichtbarkeit) · ausgegraut ohne Funktion: Modelle ab E2, Bewertung ab E3, MCP ab E4.
- **D2 Datenkatalog**: Suche, Filter Alle/Unvollständig, „+ Importieren"; Spalten Layer, Typ, Quelle, Stand, Objekte, Metadaten (●○ vier Stufen), Für Modell, Letzter Import (Status mit Popover → D8), ⋯ (Öffnen, Aktualisieren, Duplizieren, Löschen).
- **D3 Layer-Detail**: Kopf mit Name (umbenennbar), Aktualisieren, Löschen; Reiter Beschreibung (Text für Mensch und Modell, Quelle, Stand, Synonyme, Sichtbarkeit) · Felder (Typ, Bezeichnung, Einheit, Für Modell, aufklappbar: Beschreibung, Synonyme, Wertebereich, Anzeigename) · Vorschau (Karte, Steckbrief, Tabelle) · Verlauf (Versionen + Importe, Bericht, Wiederherstellen) · Darstellung (Einzelfarbe / Kategorien / Klassen / Abgestufte Grösse; Feld, Methode Quantile/gleiche Intervalle, Klassenzahl, Farbverlauf, Histogramm mit Grenzen, Umriss, Deckkraft, Legende; gilt global) · Verwendung (Sitzungen, gespeicherte Abfragen, Prüffälle ab E3, Sichtbarkeit je Rolle).
- **D4 Aktualisieren mit Vergleich**: letzter Schritt des Assistenten bei bestehendem Layer: Änderungen (+ neu / ~ geändert / − entfällt), Vorversion 90 Tage behalten, Betroffene Sitzungen und Abfragen. „Ersetzen" erhöht die Version.
- **D5 Löschen**: listet Verwendungen; Standard Archivieren, alternativ endgültig.
- **D6 Import-Assistent**: 1 Datei (CSV, GeoPackage, Shapefile-zip, GeoJSON; oder WFS/Datenbanktabelle) · 2 Geobezug (Geometrie / X-Y / Schlüssel auf Layer; CRS erkannt, wählbar) · 3 Felder (Bezeichnung, Einheit, Für Modell) · 4 Prüfen (✓/⚠/○ mit Sprung zur Korrektur, Kartenvorschau). Warnungen blockieren nicht.
- **D7 Importprotokoll**: Suche, Status-Filter, Zeitraum, CSV-Export; inklusive abgebrochener Versuche.
- **D8 Importvorgang**: Kopfdaten, Ablauf mit Dauer je Schritt, Warnungen mit „Zeilen ↓"/„Zeigen", Entscheidungen im Assistenten, „Erneut importieren".
- **D9 Benutzer**: Tabelle; ⋯ = Rolle ändern, Passwort zurücksetzen, Sperren, Löschen; neues Konto mit erzeugtem Startpasswort und „Bei erster Anmeldung ändern". Letzter Administrator nicht sperr- oder herabstufbar.
- **D10 Sichtbarkeit**: Matrix Layer × Rolle; Vorgabe für neue Layer „erst nach Freigabe".
- **D11 Import fehlgeschlagen**: Fehler blockieren „Weiter" (Datei nicht lesbar → Trennzeichen/Kodierung wählen, „Erneut lesen"; Schlüssel ohne Zuordnung → Vorschlag einer passenden Spalte). Jeder Versuch wird als ✗ protokolliert.

## Verhalten und Zustand
- **Abfrageobjekt** (E1.2) ist die einzige Wahrheit: Jede Bedienung in B1/B2/B8 schreibt hinein; Karte, Trefferzahlen und Tabelle leiten sich daraus ab. `{ ziel: layerId, baum: { op: "UND"|"ODER", kinder: [Bedingung|Gruppe] } }`, Bedingung `{ typ: "attribut"|"raum", nicht?: bool, ... }`.
- **Abgeleitete Layer** sind Rezepte (`op`, `quelle`, Parameter), keine gespeicherten Geometrien; sie werden beim Öffnen neu berechnet. „Neu berechnen, wenn Filter sich ändert" gilt für Aggregationen über gefilterte Quellen.
- **Ungespeichert**: jede Änderung an Layern, Abfrage, abgeleiteten Layern, Tabellenspalten oder Sortierung. Verschieben/Zoomen allein nicht.
- **Ergebnis-Stempel**: Trefferzahl, Hash der sortierten Objekt-IDs, Version je beteiligtem Layer. Vergleich beim Öffnen (C4) ohne Modell (F-8.9).
- **Rollen**: Administrator sieht alles inkl. Admin-Bereich; Anwender nur freigegebene Layer, kein Admin. Sitzungen sind privat, geteilt werden nur Abfragen (lesend).
- **Für Modell**: wird in E1 gepflegt und gespeichert (D2, D3, D6), wirkt erst ab E2.
- **Nicht gespeichert**: Tabellenauswahl, offene Popups.

## Entscheidungen aus dem Review
1. Abgeleitete Layer: Vorgabe + Schnellwahl. 2. Sitzungen privat, Abfragen teilbar. 3. Verschieben/Zoomen setzen kein „ungespeichert". 4. Protokolle und verworfene Zeilen werden aufbewahrt. 5. Spätere Admin-Gruppen ausgegraut. 6. „Für Modell" schon in E1.

Offen mit Vorschlag: 7. Aufbewahrung Protokoll 2 Jahre, verworfene Zeilen 90 Tage. 8. Massstabsleiste ja, Koordinaten nur im Info-Werkzeug.

## Design-Tokens (Classical)
- Farben: Grund `#f3f2f2`, Fläche `#eae9e9`, Text `#201f1d`, Akzent `#b68235` (Text im Akzent: accent-700), Trennlinie Text 16 % auf transparent; Neutral 500 `#9b9797`, 600 `#7d7979`, 700 `#605d5d`. Ramps 100–900 in `_ds/…/styles.css`.
- Schrift: Überschriften „Cormorant Garamond" (max. Semibold 600), Text „Lora". Zahlen in Tabellen tabellarisch (`font-feature-settings: "tnum"`).
- Abstand: 4.6 · 9.2 · 13.8 · 18.4 · 27.6 · 36.8 px. Radius: 2 · 4 · 7 px.
- Schatten: sm `0 1px 2px` Ink 14 %, md `0 3px 10px` Ink 16 % (Popover, Menüs).
- Muster: Buttons umrandet (1 px Akzent, transparent), nie gefüllt; Karten umrandet; aktive Reiter/Segmente mit 2 px Akzent-Unterstrich; Fokus `outline: 2px solid accent; offset 2px`; deaktiviert 45 % Deckkraft.
- Icons: Lucide. Die Unicode-Zeichen in den Wireframes (⌕ ⓘ ⟷ ▢ ✎ ▦ ≡ ⌖ ⋯) sind Platzhalter für die entsprechenden Lucide-Icons.

## Daten
`fixture/beispieldaten.json` beschreibt den Beispieldatensatz, auf den alle Bildschirme abgestimmt sind (Layer, Versionen, Konten, Sitzungen, Abfragen, Referenzfrage mit erwarteten Zahlen). Er eignet sich als E1.1-Fixture und als Testerwartung für E1.7.

## Dateien
- `screenshots/`: ein PNG je Bildschirm (`A1.png` … `D11.png`, Dateiname = Code), dazu `00-navigation.png` (Kopfzeilen, Gruppen, Vorführablauf, Übergänge, Adressen) und `00-datenstand.png`. Jedes Bild enthält unten die Zeile „Von / Nach" und die Notiz.
- `GeoTandem E1 Referenz.dc.html`: Referenz aller E1-Bildschirme mit Navigation, Übergängen, Datenstand und Entscheidungen.
- `support.js`, `_ds/…/styles.css`, `_ds/…/_ds_bundle.js`: zum Öffnen der Referenz im Browser nötig.
- `fixture/beispieldaten.json`, `schema/sitzung.example.json`.
- Projektdokumente (nicht enthalten, im Repository): `anforderungen.md` (F-Nummern an den Bildschirmen), `etappen.md`, `tech-stack.md`, `bewertung.md`.
