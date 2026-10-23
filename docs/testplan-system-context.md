# Testplan: Systemprompt und Kontext (Modus B)

> Stand: 2026-10-13 (Phase 1 abgeschlossen, 8.1) · Ausgangsstand main `0d82853` (V-2 bis V-7) ·
> Beispieldaten `bern-mittelland-2026-10-03` · Ollama 0.34.0, RTX 5060 Ti
> (16 GB) · Vorgänger: [testplan-initial-llm-run.md](testplan-initial-llm-run.md)
> · Messung: [backend/evals/](../backend/evals/README.md)

Dieser Testplan klärt zwei Fragen für die Direktabfrage:

1. **Welches Modell?** Die Referenz ist gemma4:12b, verglichen mit weiteren
   Modellen, die lokal laufen.
2. **Wo steht was im Prompt?** Beispiele, Regeln und Hinweise in der
   Systemnachricht, als Gesprächszüge oder im Kontext der Nutzernachricht,
   dazu Anzahl, Reihenfolge und Umfang der Beispiele.

Abschnitt 2 hält fest, was die bisherigen Läufe dazu schon zeigen.
Abschnitte 3 bis 7 legen fest, wie die weiteren Läufe gemacht und bewertet
werden. Abschnitt 8 nimmt die Ergebnisse auf.

---

## 1 Ausgangslage

### 1.1 Aufbau des Prompts heute

Eine Direktabfrage ohne Vorgeschichte besteht aus **zwei Nachrichten**
([prompt.py](../backend/src/geotandem/model/prompt.py), `build_prompt`):

| # | Nachricht | Abschnitt | Zeichen | Inhalt |
|---|---|---|---:|---|
| 1 | system | Stufen-Systemprompt | 550 | von der Administration geschrieben, je Stufe |
| | | `# Layer-Steckbrief` | 4 118 | Metadaten der Layer des Kontos, nie Inhalte (S3) |
| | | `# Antwortformat` | 1 719 | Regeln zur Antwort, Grenzen der Bedienelemente, V-5, E-6 |
| | | JSON-Schema | 8 628 | das Antwortschema als Text, Tags zuerst (`_tag_first`) |
| | | `# Beispiele` | 4 888 | Regeln V-2 bis V-7 und **7 Beispiele** auf erfundenen Layern |
| | | `# Gespräch` | 139 | Hinweis «erste Frage» (`FIRST`), nur ohne Verlauf und Analyse |
| 2 | user | | | **der Prompttext, sonst nichts** |

Zusammen rund 20 000 Zeichen, gemessen gut 5 000 Tokens (gemma4: 4 894 vor
den Regeln V-2 bis V-7). Das Antwortschema geht zusätzlich als eingeschränkte
Ausgabe (`response_format: json_schema`) mit.

Eine **Folgefrage** fügt zwischen 1 und 2 die früheren Züge ein (höchstens 6,
nur Worte, nie Abfragen). Die letzte Nutzernachricht trägt dann festen
Anwendungstext (Hinweis auf den Entscheid, aktuelle Analyse) vor
`Frage: <Prompttext>`. Der Hinweis `FIRST` entfällt.

### 1.2 Feste Rahmenbedingungen

- **Sicherheitsinvariante** ([security-review.md](../security-review.md),
  «Prompt injection»; Test `test_a_prompt_cannot_change_format_level_or_tools`):
  Bei einer ersten Frage ist die Nutzernachricht der Prompttext und nichts
  sonst. Es gibt genau zwei Nachrichten, und die Systemnachricht ist Byte für
  Byte die einer harmlosen Frage. **Entscheid E-8 (2026-10-12): Anwendungstext
  bleibt in der Systemnachricht.**
  Varianten, die Text in die Nutzernachricht setzen oder Gesprächszüge
  hinzufügen (P2, P3 unten), sind deshalb **nur Messungen**. Ein Einsatz
  bräuchte einen neuen Entscheid und eine Anpassung des Sicherheitsreviews.
- **Nur erfundene Layer in Beispielen**, solange sie für alle Konten gleich
  sind: Der Prompt darf keinen Layer nennen, den ein Konto nicht sieht (S3).
  P7 (Beispiele auf echten Layern) müsste die Beispiele je Konto aus dessen
  Steckbrief erzeugen.
- **Eingeschränkte Ausgabe** bleibt in jeder Variante gleich. Die Grammatik
  verlangt die Reihenfolge des Schemas; der Fix `_tag_first` ist Voraussetzung
  (testplan-initial-llm-run, 3.1).
- **Kontext** 16 384 Tokens (`OLLAMA_CONTEXT_LENGTH`). Mehr Kontext half in
  keinem bisherigen Test (testplan-initial-llm-run, 3.4).

---

## 2 Bisherige Ergebnisse zur Platzierung

Alle Zahlen sind Bestanden/Antworten aus `evals/run.py`; Läufe mit
Temperatur 0,3 haben 33 Fälle × 5 Seeds = 165 Antworten.

### 2.1 Beispiele überhaupt

| Lauf | Fälle, Temperatur × Seeds | gemma4:12b | qwen3:8b |
|---|---|---:|---:|
| Schema-Fix, ohne Beispiele (`fix-only-*`) | 17, 0 × 3 | 24/51 | 28/51 |
| Schema-Fix, mit Beispielen (`fewshot2-*`) | 17, 0 × 3 | **39/51** | 28/51 |

Beispiele helfen dem grösseren Modell stark, dem kleineren kaum.

### 2.2 Form der Beispiele wird kopiert

Die erste Fassung zeigte `related` meist *ohne* Filter auf dem anderen Layer.
Die Modelle übernahmen die Form und liessen «Nationalstrasse», «Aare», «Bahn»
weg (qwen3 27 statt 28/51). Erst Beispiele *mit* Filter und mit Codes, deren
Beschriftung vom Schlüssel abweicht, wirkten. **Folgerung:** Jede Form, die
richtig sein soll, braucht ein Beispiel. Eine Form, die nur in den
Beispielen fehlt, wird seltener.

### 2.3 Hinweise in der Systemnachricht oder in der Nutzernachricht

Fall `x-ohne-kontext`: «passe die Distanz auf 100m an» ohne Vorgeschichte.
Falsch ist jede Antwort, die einen erfundenen Beispiel-Layer nennt
(«Spielplätze nahe Primarschulen» als «letzte Abfrage»).

| Variante | Ort des Hinweises | gemma4 `x-ohne-kontext` | gemma4 gesamt | qwen3 `x-ohne-kontext` | qwen3 gesamt |
|---|---|---:|---:|---:|---:|
| ohne Hinweis (`t3-v0`) | – | 0/5 | 109/165 | 5/5 | 85/165 |
| Einleitung «kein Teil des Gesprächs» im Abschnitt Beispiele (`v27`, T 0, 3 Seeds) | System | 0/3 | – | 0/3² | – |
| `FIRST` vor «Frage:» (`t3-v27b`) | **Nutzernachricht** | **5/5** | **138/165** | 5/5 | 89/165 |
| `FIRST` am Ende der Systemnachricht (`t3-v27c`, gemergt) | System | 0/5 | 130/165 | 5/5 | 93/165 |

² qwen3 gab hier dreimal wörtlich die Beispielabfrage «Eichen in der
Altstadt» zurück.

**Folgerung:** gemma4 folgt einem Hinweis zum Gesprächsstand nur, wenn er in
der Nutzernachricht steht. In der Systemnachricht, auch am Ende direkt vor
der Frage, wirkt er nicht. qwen3 bietet die Beispiele ohnehin nicht als
Verlauf an. Der Unterschied von 8 Antworten bei gemma4 geht auf zwei Fälle
zurück: `x-ohne-kontext` (5 ⇒ 0) und `doc5-aare` (3 ⇒ 0).

### 2.4 Empfindlichkeit für Formulierungen

Ein Satz an einer Stelle des Prompts kippt Fälle an ganz anderer Stelle,
und zwar ganz (5/5 ⇔ 0/5):

| Änderung | Fall, der kippt | Modell |
|---|---|---|
| Regel «von … bis … auf Codes ⇒ `in`» (V-6) | `doc2` «Kategorie I oder II»: 5 ⇒ 0 (UND statt ODER); zurück auf 5 mit «A oder B ⇒ `in`, nie `and`» | gemma4 |
| Satz «Zählen je Gruppe kann die Kette nicht» (V-5) | `log2` «wie viele Schulen in Bern»: 5 ⇒ 0, lehnt jede Zählfrage ab; die Abgrenzung «ohne je/pro» hilft nicht | qwen3 |
| Satz «wie viele … mit query» (E-6) | `doc3`: 3 ⇒ 0 (Filter «Bahn» weggelassen), obwohl die Frage nicht zählt | qwen3 |

**Folgerung:** Eine Variante wird nie an den Fällen gemessen, für die sie
gedacht ist, sondern immer an allen 33. Eine neue Regel braucht ihre
Gegenprobe: Welche Fälle kippen sonst?

### 2.5 Zufall: dieselbe Variante, andere Seeds

| Modell | Seeds 1–5 | Seeds 6–10 | Fälle, die sich bewegen |
|---|---:|---:|---|
| gemma4:12b (`t3-v27c`) | 130/165 | 132/165 | `doc5-aare` 0 ⇒ 1, `x-ohne-kontext` 0 ⇒ 1 |
| qwen3:8b (`t3-v27c`) | 93/165 | 99/165 | `n15-je-gemeinde` 0 ⇒ 5, `in-gemeinde-bahn` 2 ⇒ 5, `dist-nationalstrasse` 5 ⇒ 4, `n04-grosse-gemeinden` 1 ⇒ 0 |

Bei gemma4 ist ein Fall fast immer 0/5 oder 5/5, und der Zufall zwischen
Seed-Blöcken liegt bei ±2 von 165: Unterschiede zwischen Varianten sind dort
echt, kommen aber meist von wenigen ganz kippenden Fällen (2.4).

**qwen3 streut stark:** 93 gegen 99, und ganze Fälle kippen zwischen den
Seed-Blöcken (`n15` 0/5 ⇒ 5/5). Die bisherigen qwen3-Summen der Varianten
(85, 89, 93, 94 von 165) liegen innerhalb dieses Rauschens. Die qwen3-Zeilen
in 2.3 und 2.4 sind deshalb Hinweise, keine Befunde; belastbar sind die
gemma4-Zeilen.

### 2.6 Zum Vergleich: Denken und Kontext

Aus [testplan-initial-llm-run.md](testplan-initial-llm-run.md), 3.3 und 3.4:
qwen3:8b mit Denken 38/51 statt 28/51, bei siebenfacher Antwortzeit. gemma4
mit Denken läuft in eine Schleife, die jeden Kontext füllt (16 k bis 64 k);
die Anwendung meldet das seit E-5 als `model_truncated`.

---

## 3 Methode

- **Messung:** `evals/run.py`, 33 Fälle, **Temperatur 0,3, Seeds 1–5**
  (165 Antworten), Stufe *Prüfen*, Beispieldaten frisch aufgebaut. Ein Lauf
  dauert mit gemma4 rund 4, mit qwen3 rund 8 Minuten.
- **Label:** `<variante>-<modell>`, z. B. `p0-gemma4`, `p3-qwen3`; für den
  zweiten Seed-Block `-s6` anhängen (`--seed-start 6`).
- **Vergleich:** `evals/compare.py <label> <label> …`; mit `--changed` nur
  die Fälle, die sich unterscheiden.
- **Bewertung einer Variante:**
  1. Summe gegen die Referenz P0 *desselben Modells*.
  2. Ein Unterschied gilt als nicht belegt unter **5 von 165** bei gemma4
     (Zufall ±2) und unter **10 von 330** bei qwen3, das immer mit beiden
     Seed-Blöcken (1–5 und 6–10) gemessen wird (Zufall ±6 je Block,
     Abschnitt 2.5). Für ein neues Modell zuerst beide Blöcke von P0 laufen
     lassen und daraus seine Schwelle bestimmen.
  3. Jeder gekippte Fall wird gelesen (`results/*.jsonl`): Ist der Gewinn die
     beabsichtigte Wirkung oder ein Nebeneffekt (2.4)?
  4. Ein Gewinn wird mit **Seeds 6–10** bestätigt.
  5. Eine Variante, die einem der beiden Hauptmodelle um mehr als 5 schadet,
     wird nicht übernommen, auch wenn sie dem anderen nützt.
- **Was zusätzlich festgehalten wird:** mittlere Antwortzeit (in jeder
  Antwort `latency_ms`) und bei Abbrüchen der Code (`error:*`).

---

## 4 Modelle

Stand nach Phase 1 (2026-10-13, Ergebnisse und Begründung in 8.1). Grösse
ist die Grösse in Ollama (`/api/tags`).

| Modell | Grösse | Quant. | Rolle in Phase 2 | Hinweise |
|---|---:|---|---|---|
| gemma4:12b | 8,0 GB | Q4_K_M | **Referenz** | Denken aus (Schleife, 2.6) |
| gemma4:e4b | 6,6 GB | Q4_K_M | **Hauptmodell** (gesetzt) | kleineres gemma: zeigt, ob eine Variante familienspezifisch wirkt |
| qwen3:14b | 9,3 GB | Q4_K_M | **Hauptmodell** (gesetzt) | Denken aus; ersetzt qwen3:8b |
| qwen3.5:9b | 6,6 GB | Q4_K_M | **Hauptmodell** (Platz 4, gesetzt) | Denken aus; gewählt wegen der Antwortzeit (8.1) |
| gpt-oss:20b | 13,8 GB | MXFP4 | nicht gewählt | mit `--effort medium` gleichauf mit der Referenz, aber 3- bis 4-mal so langsam; Denken lässt sich nicht abschalten |
| qwen3:8b | 5,2 GB | Q4_K_M | ausgeschieden | bisheriges zweites Hauptmodell; streut stark (2.5) |
| ministral-3:14b | 9,1 GB | Q4_K_M | ausgeschieden | |
| phi4:latest | 9,1 GB | Q4_K_M | ausgeschieden | nimmt Beispiel-Layer für echt |
| granite4.2:8b | 5,3 GB | Q4_K_M | ausgeschieden | fragt fast immer zurück |
| lfm2.5:8b | 5,2 GB | Q4_K_M | ausgeschieden | nimmt Beispiel-Layer für echt |
| deepseek-r1:8b | 5,2 GB | Q4_K_M | ausgeschieden | 6/99 im Sweep ([benchmarks.md](benchmarks.md), Lauf 1), 57 s je Antwort; nicht erneut gemessen |
| mistral-small:22b, mistral-nemo:12b | 12,6 / 7,1 GB | Q4_0 | ausgeschieden | 64/99 und 52/99 im Sweep; mistral-small läuft nicht ganz im VRAM |

Vor dem Ziehen die aktuellen Namen und Grössen in der Ollama-Bibliothek
prüfen. Ein Modell, das die eingeschränkte Ausgabe nicht beherrscht, zeigt
das als `model_unreadable` in vielen Fällen (die Verbindungsprüfung der
Administration meldet es vorher als `llm_schema_unsupported`); das ist ein
Ergebnis, kein Fehler der Messung.

Externe Modelle (OpenAI-kompatibel, z. B. als obere Referenz) nur mit
Freigabe: Der Steckbrief verlässt dann das Haus. Die Verbindung muss als
extern markiert sein (`marked_external`), und die Administration
entscheidet, ob sie Daten erhalten darf.

---

## 5 Varianten der Platzierung

**Messbar heute** heisst: Die Variante lässt sich im Harness ohne Änderung
der Anwendung erzeugen (Abschnitt 6). **Einsetzbar** heisst: Sie verträgt sich
mit E-8 und S3.

| # | Variante | Was sich ändert | Frage | Messbar heute | Einsetzbar |
|---|---|---|---|---|---|
| **P0** | Referenz (Stand main) | – | – | ✔ | ✔ |
| P1 | Keine Beispiele, Regeln bleiben | Abschnitt `# Beispiele` nur mit den Regeln | Wie viel tragen die Beispiele selbst? | ✔ `--variant p1` | ✔ |
| P2 | Beispiele als Gesprächszüge | je Beispiel ein Paar user/assistant vor der Frage, Systemnachricht ohne Beispiele | Lernen Modelle aus Zügen besser als aus Text? Nimmt das Einsickern (2.3) zu? | ✔ `--variant p2` | ✘ verletzt «zwei Nachrichten» (E-8) |
| P3 | Hinweise und Beispiele in der Nutzernachricht | vor `Frage: <Prompttext>` | Bestätigt sich 2.3 für Beispiele und Regeln, nicht nur für den Hinweis? | ✔ `--variant p3` | ✘ verletzt E-8 |
| P4 | Beispiele ohne Regeln | Regeln V-2 bis V-7 gestrichen, Beispiele bleiben | Reichen Beispiele allein? | ✔ `--variant p4` | ✔ |
| P5 | Beispiele vor dem Steckbrief | Reihenfolge: Systemprompt, Beispiele, Steckbrief, Format, Schema | Wirkt ein Abschnitt stärker am Anfang oder am Ende? | ✔ `--variant p5` | ✔ |
| P6 | Anzahl Beispiele: 3 / 7 / 12 | 3: nur Ort, Nähe, cannot_answer; 12: dazu `in`-Liste, `between`, «ausserhalb», `contains`, Rückfrage, Zählfrage | Wo liegt der Nutzen pro Token? | ✔ `--examples 3`, `--examples 12` | ✔ |
| P7 | Beispiele auf echten Layern | aus dem Steckbrief des Kontos erzeugt | Helfen echte Namen (Gemeinden, Codes) mehr als erfundene? | `--examples`, Beispielsatz noch zu schreiben | nur je Konto erzeugt (S3) |
| P8 | Schema nicht als Text | JSON-Schema (8,6 k Zeichen) nur als eingeschränkte Ausgabe, nicht im Prompt | Kostet der grösste Abschnitt mehr Aufmerksamkeit, als er bringt? | ✔ `--variant p8` | ✔ |
| P9 | Hinweis `FIRST` als eigene Systemnachricht | eine zweite system-Nachricht direkt vor der Frage | Wirkt eine eigene Nachricht wie die Nutzernachricht (2.3), ohne E-8 zu verletzen? | ✔ `--variant p9` | zu prüfen: drei Nachrichten statt zwei, Bypass-Test anpassen |

P9 ist die naheliegende Antwort auf 2.3: Sie hält den Anwendungstext aus der
Nutzernachricht heraus und rückt ihn trotzdem nahe an die Frage.

---

## 6 Voraussetzungen im Harness

Die Varianten entstehen im Harness, nicht in der Anwendung. `DirectQuery.ask`
nimmt ein fertiges `Prompt`; der Harness baut es mit `direct_prompt` und kann
seine Nachrichten vor dem Senden umbauen. So bleibt die Anwendung unberührt,
bis eine Variante gewinnt.

| # | Erweiterung | für |
|---|---|---|
| H-1 | `--variant <name>`: eine Funktion je Variante, die `prompt.messages` umbaut (Abschnitte der Systemnachricht an ihren Überschriften `# …` trennen, umstellen, streichen, als Züge oder eigene Nachricht einsetzen) | P1–P9 |
| H-2 | Beispielsätze als Datei (`evals/examples/*.txt`), auswählbar mit `--examples` | P4, P6, P7 |
| H-3 | Tokens je Antwort festhalten (`prompt_tokens`, `completion_tokens` aus `Completion`, über einen Client, der sie mitschreibt) | Kosten je Variante, P6, P8 |
| H-4 | Rohtext bei `error:*` speichern (heute nur der Code) | Fehler lesen, Denkmodelle |
| H-5 | Laufkopf um Variante und Prompt-Hash ergänzen | Nachvollziehbarkeit |

`--seed-start` (zweiter Seed-Block) und `evals/compare.py` gibt es schon.

**Stand 2026-10-13: H-1 bis H-5 umgesetzt**
([evals/README.md](../backend/evals/README.md), «Prompt variants»):

- H-1: `--variant p0…p9` in `evals/variants.py`; `--show` zeigt die
  Nachrichten eines Falls, ohne ein Modell zu fragen. P2 setzt die Beispiele
  als Züge und lässt die Regeln in der Systemnachricht; P3 verschiebt
  Beispiele, Regeln und `FIRST` in die Nutzernachricht.
- H-2: `evals/examples/3.txt` (Ort, Nähe, cannot_answer) und `12.txt` (die 7
  von P0, dazu `in`-Liste, `between` auf dem erfundenen
  `parzellen.flaeche`, Rückfrage, «wie viele» als Abfrage, «je Quartier» als
  cannot_answer ohne other_approach). Die erfundenen Layer bleiben dieselben,
  die `forbid`-Liste von `x-ohne-kontext` deckt sie weiter ab. Für P7 fehlt
  noch ein Satz auf den Layern der Beispieldaten; er darf keinen Fall
  wörtlich beantworten.
- H-3: `prompt_tokens`, `completion_tokens`, `finish_reason` je Antwort,
  auch bei `error:*`; am Ende des Laufs Median der Antwortzeit und mittlere
  Tokens.
- H-4: bei `error:*` der Rohtext (`raw`) oder die Ursache der Verbindung
  (`cause`).
- H-5: Laufkopf mit `variant`, `examples`, `prompt_sha256` und den Rollen der
  Nachrichten.

---

## 7 Ablauf

1. **Phase 1, Modellwahl:** P0 auf allen lokalen Modellen aus Abschnitt 4,
   Seeds 1–5; die besten mit Seeds 6–10 bestätigen. **Erledigt
   2026-10-13** (8.1): Phase 2 läuft mit vier Modellen, gemma4:12b
   (Referenz), gemma4:e4b, qwen3:14b und qwen3.5:9b. Vor Phase 2 folgt
   Phase 1b.
1b. **Phase 1b, obere Referenz (extern):** P0 auf je einem Modell von
   Anthropic und OpenAI; Fälle, die auch diese verfehlen, vor Phase 2
   bereinigen; dazu die Nutzbarkeit beider Anbieter in der Anwendung.
   Eigener Plan: [testplan-external-models.md](testplan-external-models.md).
   Ergebnis: **claude-haiku-5-5** und **gpt-6-luna** sind die externen
   Referenzen und laufen in Phase 2 neben den vier lokalen Hauptmodellen mit,
   je ein Anbieter, damit keiner bevorzugt wird (X-11).
2. **Phase 2, Platzierung:** H-1 bis H-5 umsetzen (erledigt, Abschnitt 6).
   Dann P1, P4, P5, P6, P8, P9 (einsetzbar) auf allen vier Modellen. P2, P3,
   P7 als Messung, um zu wissen, was E-8 und S3 kosten. Regel 3.5 gilt je
   Modell: Eine Variante, die einem der vier um mehr als seine Schwelle
   schadet, wird nicht übernommen. **Erledigt 2026-10-23** (8.2): Grundlinie
   bleibt P0, einziger Kandidat P9, P7 zu E-7. Haiku und Luna laufen je mit zwei Blöcken
   mit (X-11); ein Schaden bei ihnen über 10 von 330 wird gelesen und im
   Entscheid genannt. Gemessen wird nur auf dem Tuning-Satz: Der
   Held-out-Satz bleibt für die Gewinner in Phase 3, sonst wählt Phase 2 an
   ihm aus (8.3 hat ihn für R1 und S1 schon mitgemessen; übernommen wurde
   nichts).
3. **Phase 3, Bestätigung:** Gewinner mit Seeds 6–10. Die 15 Fragen aus
   testplan-initial-llm-run, Abschnitt 9, von Hand in der Anwendung
   nachprüfen. Erst dann wird eine Variante in `prompt.py` übernommen.
4. **Ergebnis** in Abschnitt 8 eintragen. Ein Entscheid, der E-8 oder S3
   berührt, kommt in den Sicherheitsreview.

---

## 8 Ergebnisse

### 8.1 Modelle (P0, Temperatur 0,3)

**Lauf:** 2026-10-13, Phase 1 nach Abschnitt 3: P0, 33 Fälle, Temperatur
0,3, Seeds 1–5 und 6–10 (je 165 Antworten), Stufe *Prüfen*, Effort `none`
ausser gpt-oss:20b. Commit `d42f86a` (main, Arbeitsbaum sauber), Ollama 0.34.0,
RTX 5060 Ti 16 GB, `OLLAMA_CONTEXT_LENGTH=16384`. Alle Läufe haben denselben
Prompt-Hash `prompt_sha256` =
`55e708badb92a05fae633636946292a947435f6553903966482311dd9c6a2eb2`
(Laufkopf, H-5): Alle Modelle sahen denselben Prompt.

| Modell | Effort | Seeds 1–5 | Seeds 6–10 | Summe /330 | Differenz der Blöcke | Antwortzeit Median | p90 | Antwort-Tokens Ø | Abbrüche (`error:*`) | Abfragen auf Beispiel-Layern | Ergebnis |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| gemma4:12b | none | 130 | 132 | **262** | 2 | 1,4 s | 2,1 s | 79 | 0 | 0 | Referenz |
| gpt-oss:20b | medium | 134 | 126 | **260** | 8 | 4,5 s | 8,8 s | 472 | 8 | 5 | nicht gewählt |
| gemma4:e4b | none | 126 | 126 | **252** | 0 | 0,8 s | 1,5 s | 130 | 0 | 0 | Hauptmodell |
| qwen3:14b | none | 125 | 125 | **250** | 0 | 3,0 s | 4,4 s | 115 | 0 | 0 | Hauptmodell |
| qwen3.5:9b | none | 112 | 113 | 225 | 1 | 1,6 s | 2,4 s | 87 | 0 | 0 | Hauptmodell (Platz 4) |
| ministral-3:14b | none | 107 | 118 | 225 | 11 | 2,6 s | 4,5 s | 119 | 0 | 0 | ausgeschieden |
| phi4:latest | none | 111 | 114 | 225 | 3 | 2,1 s | 3,1 s | 83 | 0 | 12 | ausgeschieden |
| gpt-oss:20b | low | 101 | 93 | 194 | 8 | 1,5 s | 2,5 s | 233 | 24 | 3 | ausgeschieden |
| qwen3:8b¹ | none | 93 | 99 | 192 | 6 | | | | | | ausgeschieden |
| granite4.2:8b | none | 10 | 10 | 20 | 0 | 3,4 s | 4,0 s | 195 | 0 | 0 | ausgeschieden |
| lfm2.5:8b | none | 5 | 3 | 8 | 2 | 0,8 s | 1,1 s | 167 | 0 | 178 | ausgeschieden |

¹ Läufe `t3-v27c-qwen3` und `t3-v27c-qwen3-s6` vom 2026-10-12 (Abschnitt 2.5),
vor H-3: ohne Zeiten und Tokens im Laufkopf.

Antwortzeit und Tokens über beide Blöcke (330 Antworten). «Abfragen auf
Beispiel-Layern»: Antworten, deren Abfrage einen erfundenen Layer der
Beispiele nennt (`baeume`, `quartiere`, `schulhaeuser`, `parzellen`,
`spielplaetze`, `wanderwege`, `orte`), als `source` oder als Bezugslayer.

**Reproduzierbarkeit:** Die neuen Läufe von gemma4:12b geben Fall für Fall
dieselben Zahlen wie `t3-v27c-gemma4` und `-s6` vom Vortag (130 und 132,
dieselben zwei Fälle verschieden; verglichen sind die Zahlen je Fall, nicht
der Wortlaut). Die älteren gemma4-Zahlen in diesem Dokument bleiben gültig.
gpt-oss:20b dagegen antwortet auf denselben Seed nicht immer gleich (unten).

**Schwellen für Phase 2** (3, Punkt 2), aus der Differenz der Blöcke:
gemma4:12b ±2, gemma4:e4b und qwen3:14b ±0 in der Summe, aber einzelne Fälle
wandern um bis zu 3 von 5 (qwen3:14b `n15` 5 ⇒ 2, `doc6` 2 ⇒ 4,
`x-ohne-kontext` 3 ⇒ 5), deshalb auch für sie **5 von 165**. qwen3.5:9b
(Differenz 1, Fälle wandern um bis zu 3 von 5: `in-gemeinde-bahn` 1 ⇒ 3,
`n13` 5 ⇒ 2) ebenso **5 von 165**. gpt-oss:20b `medium` (nicht gewählt)
streut um 8 und bräuchte immer beide Blöcke.

#### Befunde je Modell

Aus den Antworten in `results/*.jsonl` gelesen; Beispiele wörtlich gekürzt.

- **gemma4:12b** (Referenz): unverändert. Scheitert ganz an `doc4-ohne-sek`,
  `doc6`, `n06`, `n07`, `n13` und fast ganz an `doc5-aare` und
  `x-ohne-kontext` (Abschnitt 2.3).
- **gemma4:e4b**: gleich stabil wie gemma4:12b, im Median fast doppelt so
  schnell (0,8 gegen 1,4 s).
  Scheitert ganz, wo gemma4:12b besteht: `log2` «wie viele Schulen … Bern»
  mit `cannot_answer` (das Muster aus 2.4), `in-gemeinde-bahn` ohne den
  Filter «Bahn» (18 statt 1 Objekt), `n03` mit einer Abfrage auf die Tabelle
  `gemeindedaten`. Löst `n06` (10/10), das gemma4:12b und qwen3:14b nie lösen.
- **qwen3:14b**: Summe gleich in beiden Blöcken, Fälle wandern (oben).
  Dieselben drei Lücken wie gemma4:e4b (`log2`, `in-gemeinde-bahn`, `n03`),
  dazu `n05` (dreimal `unknown_attribute`). Besser als beide gemmas bei
  `doc5-aare` (10/10) und `doc6` (6/10).
- **gpt-oss:20b, `medium`**: beste Summe im ersten Block (134), 126 im
  zweiten. Ergänzt die Referenz: löst `doc5-aare` (10/10), `in-gemeinde-bahn`
  (10/10) und `n06` (9/10), wo gemma4:12b 1, 10 und 0 hat. Restliche Fehler
  wie bei anderen: «Bahnhof Bern» als Name einer Haltestelle (`n13`, 0/10),
  zwei Bedingungen im Filter eines `related` (`n07`), die Beispielabfragen
  als Optionen der Rückfrage in `x-ohne-kontext` (0/10). 8 leere Antworten
  (`model_unreadable`, unten). Kosten: 4,5 s Median, 8,8 s p90, rund
  15 Minuten je Block (gemma4:12b 4 bis 5).
- **gpt-oss:20b, `low`**: instabil (101 gegen 93) und 24 leere Antworten.
  Erfindet Lücken: `doc1` «Der Layer "schulen" enthält keine Informationen
  über den Namen der Gemeinde» (`cannot_answer`), `n01` «keine Zählung»;
  in `log2` eine Rückfrage nach der Gemeindenummer mit erfundenen Optionen
  («gem_nr 1001», «gem_nr 2002»). Einmal der Beispiel-Layer `orte` (`n09`).
- **qwen3.5:9b**: stabil (112/113), schnell, ohne Abbrüche, aber 25 bis 37
  unter den vier oben. Platz 4 (Entscheid unten).
- **ministral-3:14b**: streut am stärksten (107 gegen 118). Fragt zurück,
  wo eine Annahme genügt: `n09` «Welche Stadt ist gemeint?» mit Bern,
  Münchenbuchsee, Zollikofen, Worb; `n13` mit erfundenen Bahnhöfen
  («Bahnhof Bern Lötschberg»); `doc6` 8/10 Rückfragen. Lehnt `log2` als
  «Zählung je Gruppe» ab. `log4` mit einer ungefragten Bedingung
  `is_null name` auf den Haltestellen (0 statt 79 Objekte, 9/10).
- **phi4**: nimmt die Beispiele für echt: `n06` immer auf dem Beispiel-Layer
  `schulhaeuser` (`unknown_layer`, 10/10), `x-ohne-kontext` bietet die
  Beispielabfragen als frühere Abfragen an (10/10). Dazu falsche Werte
  («Sekundarstufe I» als `typ = "sek"`, `doc4`; «die Aare» ohne Namen als
  alle Hauptgewässer, `doc5`), Rückfragen statt Antwort (`n12`) und zwei
  Bedingungen im Filter eines `related` (`n07`, `n13`).
- **granite4.2:8b**: 155 von 165 Antworten sind Rückfragen, auch bei
  `attr-flaeche` («Bitte bestätige …, wenn ja, bitte mit 'yes' antworten»).
  Besteht nur die zwei Fälle, in denen eine Rückfrage gilt (`n04`,
  `x-ohne-kontext`, je 10/10). Unbrauchbar.
- **lfm2.5:8b**: 178 von 330 Abfragen auf Beispiel-Layern (`schulhaeuser`
  usw.), Erklärungen auf Englisch. Unbrauchbar.

#### gpt-oss:20b: leere Antworten

Alle 32 Abbrüche von gpt-oss:20b (24 `low`, 8 `medium`) sind
`model_unreadable` mit «not JSON: Expecting value at char 0» oder
`model_truncated` (2, bei 10 802 und 10 803 Antwort-Tokens). Der Rohtext
(`raw`, H-4) ist in **jedem** Fall leer, obwohl Ollama 38 bis 10 803
Antwort-Tokens meldet.

Nachgeprüft mit einer direkten Anfrage an `/v1/chat/completions` (dieselben
Nachrichten, dasselbe Schema als `response_format`, Temperatur 0,3):

- Dieselbe Anfrage mit demselben Seed (`doc6` Seed 1, `log4` Seed 2,
  `doc1` Seed 4 achtmal, `n03` Seed 1 `medium`) antwortet nun lesbar:
  Der Fehler kommt nicht aus dem Seed.
- `attr-schulhaeuser` mit Seeds 11–30 (`low`): **3 von 20 leer**. Das Feld
  `reasoning` ist jedes Mal kurz und richtig («Need to query schulen layer,
  attribute standorte >3. Use compare gt.»), `content` ist `''`, gemeldet
  werden 98, 2 922 und 3 995 Antwort-Tokens.

Das Modell denkt also richtig und schreibt dann eine Antwort, die nicht
ankommt; die Tokens gehen in eine Ausgabe, die Ollama nicht zurückgibt.
Vermutung, nicht geprüft: Unter der eingeschränkten Ausgabe schreibt
gpt-oss Leerraum, den die Grammatik vor dem JSON erlaubt, bis zum Stopp
oder zur Längengrenze. Die Anwendung meldet das richtig als
`model_unreadable` bzw. `model_truncated`. Mit `medium` tritt es seltener
auf (8 von 330 gegen 24 von 330). Offen: Ursache bei Ollama prüfen; ob die
Anwendung eine leere Antwort einmal wiederholen soll, ist ein eigener
Entscheid.

#### Fälle, die alle vier Modelle nicht lösen

Über die vier Modelle von Phase 2 (je 10 Antworten): `n07-zwei-filter`
(0, 0, 0, 1: zwei Bedingungen auf dem Bezugslayer, die die Bedienelemente
nicht zeigen) und `n13-bahnhof-bern` (0, 3, 0, 0: «Bahnhof Bern» ist kein
Name im Layer). `x-ohne-kontext` (1, 6, 8, 0) und `doc6` (0, 0, 6, 5) lösen
nur einzelne. Das sind die Fälle, an denen Phase 2 eine Wirkung zeigen kann.

#### Entscheid Phase 1

- **Gesetzt** (2026-10-13): gemma4:12b (Referenz), gemma4:e4b, qwen3:14b.
  qwen3:8b scheidet aus: 58 bis 70 unter diesen dreien und streut stark.
- **Platz 4: qwen3.5:9b** (Entscheid 2026-10-13): Die Antwortzeit ist ein
  Vorteil für die Anwendung. 1,6 s Median gegen 4,5 s bei gpt-oss:20b,
  stabil (112/113), ohne Abbrüche. In Kauf genommen: 25 bis 37 unter den
  drei anderen und eine zweite qwen-Familie neben qwen3:14b.
- **Nicht gewählt: gpt-oss:20b mit `--effort medium`**: Summe gleichauf mit
  der Referenz (260 gegen 262), eine dritte Modellfamilie und das einzige
  Denkmodell; löst Fälle, die die Referenz nicht löst (oben). Dagegen: 3-
  bis 4-mal so lange wie gemma4:12b, streut um 8 (immer beide Blöcke, ein
  Variantenlauf rund 30 Minuten) und bricht in 2 bis 3 % der Antworten
  leer ab.
- Ausgeschieden: ministral-3:14b, phi4, granite4.2:8b, lfm2.5:8b,
  gpt-oss:20b mit `low`, sowie aus dem Sweep deepseek-r1:8b,
  mistral-small:22b und mistral-nemo:12b.

#### Fälle je Lauf

`evals/compare.py` über alle Läufe von Phase 1 (bestanden von 5 je Fall und
Block):

| Fall | p0-gemma4_12b | p0-gemma4_12b-s6 | p0-gemma4_e4b | p0-gemma4_e4b-s6 | p0-qwen3_14b | p0-qwen3_14b-s6 | p0-gpt-oss-medium | p0-gpt-oss-medium-s6 | p0-gpt-oss-low | p0-gpt-oss-low-s6 | p0-qwen3.5_9b | p0-qwen3.5_9b-s6 | p0-ministral-3_14b | p0-ministral-3_14b-s6 | p0-phi4 | p0-phi4-s6 | p0-granite4.2_8b | p0-granite4.2_8b-s6 | p0-lfm2.5_8b | p0-lfm2.5_8b-s6 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `doc1-primar-koeniz` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | 0/5 | 1/5 | 2/5 | 1/5 | 5/5 | 5/5 | 4/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `doc2-gut-erschlossen` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `doc3-weit-von-bahn` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 1/5 | 0/5 | 4/5 | 5/5 | 4/5 | 4/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `doc4-ohne-sek` | 0/5 | 0/5 | 4/5 | 5/5 | 5/5 | 4/5 | 3/5 | 3/5 | 4/5 | 1/5 | 3/5 | 4/5 | 0/5 | 2/5 | 0/5 | 1/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `doc5-aare` | 0/5 | 1/5 | 3/5 | 2/5 | 5/5 | 5/5 | 5/5 | 5/5 | 3/5 | 0/5 | 4/5 | 5/5 | 3/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `doc6-verschachtelt` | 0/5 | 0/5 | 0/5 | 0/5 | 2/5 | 4/5 | 2/5 | 3/5 | 0/5 | 0/5 | 0/5 | 0/5 | 1/5 | 0/5 | 1/5 | 1/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `log1-haltestellen-nahe-schulen` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `log2-schulen-in-bern` | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | 4/5 | 0/5 | 0/5 | 0/5 | 2/5 | 0/5 | 1/5 | 1/5 | 5/5 | 4/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `log4-schulen-200m` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 4/5 | 5/5 | 5/5 | 5/5 | 0/5 | 1/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `attr-franzoesisch` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 3/5 | 1/5 |
| `attr-schulhaeuser` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 3/5 | 4/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `attr-ohne-kindergarten` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `attr-flaeche` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 1/5 | 0/5 |
| `text-beginnt-bern` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `in-gemeinde-bahn` | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | 5/5 | 5/5 | 1/5 | 0/5 | 1/5 | 3/5 | 0/5 | 0/5 | 4/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `dist-nationalstrasse` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 4/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `none-spitaeler` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n01-tram-zaehlen` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 4/5 | 0/5 | 0/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n02-kategorie-bereich` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n03-einwohner-tabelle` | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | 2/5 | 5/5 | 2/5 | 2/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n04-grosse-gemeinden` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 4/5 | 4/5 | 1/5 | 0/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 |
| `n05-gemeinde-franz-schule` | 5/5 | 5/5 | 1/5 | 2/5 | 0/5 | 0/5 | 3/5 | 2/5 | 1/5 | 0/5 | 2/5 | 3/5 | 4/5 | 5/5 | 3/5 | 2/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n06-primar-tram` | 0/5 | 0/5 | 5/5 | 5/5 | 0/5 | 0/5 | 4/5 | 5/5 | 2/5 | 1/5 | 0/5 | 0/5 | 2/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n07-zwei-filter` | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 1/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n08-sekundarstufe` | 5/5 | 5/5 | 4/5 | 3/5 | 5/5 | 5/5 | 4/5 | 3/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n09-ausserhalb-bern` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 3/5 | 4/5 | 5/5 | 5/5 | 0/5 | 0/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n10-strassen-durch-koeniz` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 3/5 | 4/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n11-einwohner-bereich` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 1/5 | 2/5 |
| `n12-schiff-leer` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 4/5 | 3/5 | 1/5 | 4/5 | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n13-bahnhof-bern` | 0/5 | 0/5 | 2/5 | 1/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 5/5 | 2/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n14-schuelerzahl` | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 3/5 | 3/5 | 5/5 | 5/5 | 4/5 | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `n15-je-gemeinde` | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 2/5 | 5/5 | 2/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 4/5 | 2/5 | 4/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `x-ohne-kontext` | 0/5 | 1/5 | 3/5 | 3/5 | 3/5 | 5/5 | 0/5 | 0/5 | 1/5 | 0/5 | 1/5 | 2/5 | 0/5 | 0/5 | 0/5 | 0/5 | 5/5 | 5/5 | 0/5 | 0/5 |
| **Summe** | **130/165** | **132/165** | **126/165** | **126/165** | **125/165** | **125/165** | **134/165** | **126/165** | **101/165** | **93/165** | **112/165** | **113/165** | **107/165** | **118/165** | **111/165** | **114/165** | **10/165** | **10/165** | **5/165** | **3/165** |

#### Läufe

Ergebnisdateien in `backend/evals/results/` (nicht im Git; jede Antwort im
Wortlaut, mit Tokens, Rohtext bei Abbruch und Laufkopf):

| Label | Datei |
|---|---|
| `p0-gemma4_e4b` | `20261013-174101-p0-gemma4_e4b.jsonl` |
| `p0-gemma4_e4b-s6` | `20261013-174452-p0-gemma4_e4b-s6.jsonl` |
| `p0-qwen3_14b` | `20261013-174729-p0-qwen3_14b.jsonl` |
| `p0-qwen3_14b-s6` | `20261013-175608-p0-qwen3_14b-s6.jsonl` |
| `p0-qwen3.5_9b` | `20261013-180451-p0-qwen3.5_9b.jsonl` |
| `p0-qwen3.5_9b-s6` | `20261013-180956-p0-qwen3.5_9b-s6.jsonl` |
| `p0-phi4` | `20261013-183514-p0-phi4.jsonl` |
| `p0-phi4-s6` | `20261013-184138-p0-phi4-s6.jsonl` |
| `p0-gpt-oss-low` | `20261013-184748-p0-gpt-oss-low.jsonl` |
| `p0-gpt-oss-low-s6` | `20261013-185655-p0-gpt-oss-low-s6.jsonl` |
| `p0-gpt-oss-medium` | `20261013-190409-p0-gpt-oss-medium.jsonl` |
| `p0-ministral-3_14b` | `20261013-191830-p0-ministral-3_14b.jsonl` |
| `p0-ministral-3_14b-s6` | `20261013-192626-p0-ministral-3_14b-s6.jsonl` |
| `p0-granite4.2_8b` | `20261013-193432-p0-granite4.2_8b.jsonl` |
| `p0-granite4.2_8b-s6` | `20261013-194338-p0-granite4.2_8b-s6.jsonl` |
| `p0-lfm2.5_8b` | `20261013-195258-p0-lfm2.5_8b.jsonl` |
| `p0-lfm2.5_8b-s6` | `20261013-195526-p0-lfm2.5_8b-s6.jsonl` |
| `p0-gemma4_12b` | `20261013-195752-p0-gemma4_12b.jsonl` |
| `p0-gemma4_12b-s6` | `20261013-200241-p0-gemma4_12b-s6.jsonl` |
| `p0-gpt-oss-medium-s6` | `20261013-200710-p0-gpt-oss-medium-s6.jsonl` |
| `t3-v27c-qwen3`, `t3-v27c-qwen3-s6` | `20261012-192916-t3-v27c-qwen3.jsonl`, `20261012-201518-t3-v27c-qwen3-s6.jsonl` |

### 8.2 Varianten

Tuning-Satz, lokale Modelle Seeds 1–5 (/165), je Modell gegen sein P0
(Schwellen in 8.1); Haiku und Luna je zwei Blöcke (/330, X-11). P0 gegen die
heutigen Fälle neu bewertet (`gold_any` für `doc1` und `n06`).

| Variante | gemma4:12b | gemma4:e4b | qwen3:14b | qwen3.5:9b | Haiku 5.5 | Luna | gekippte Fälle | Entscheid |
|---|---:|---:|---:|---:|---:|---:|---|---|
| P0 | 135 | 126 | 125 | 112 | 318 | 280 | – | Referenz |
| P1 | 127 (−8) | **97 (−29)** | **96 (−29)** | **75 (−37)** | 314 (−4) | 264 (−16) | breit | **verworfen**: die Beispiele tragen die kleinen Modelle |
| P4 | 125 (−10) | 125 (−1) | 121 (−4) | 99 (−13) | 318 (±0) | 272 (−8) | breit | **verworfen**: die Regeln tragen gemma4:12b und qwen3.5:9b |
| P5 | **144 (+9)** | 120 (−6) | 125 (±0) | 99 (−13) | 317 (−1) | 272 (−8) | | **verworfen**: gemma4:e4b −6, qwen3.5:9b −13 |
| P6 (3) | 121 (−14) | 115 (−11) | 120 (−5) | 96 (−16) | 316 (−2) | 281 (+1) | breit | **verworfen** |
| P6 (12) | 132 (−3) | 131 (+5) | 125 (±0) | 103 (−9) | 318 (±0) | **293 (+13)** | qwen3:14b `doc6` 2⇒5, `log2` 0⇒5, aber `doc3` 5⇒2, `doc5` 5⇒1; gemma4:12b `n03` 5⇒0 | **verworfen**: qwen3.5:9b −9 |
| P8 | 123 (−12) | 111 (−15) | 111 (−14) | 80 (−32) | **256 (−62)** | 272 (−8) | breit; Haiku 31 unlesbar | **verworfen**: alle verlieren; ohne eingeschränkte Ausgabe fehlt das Schema ganz |
| P9 | 138 (+3) | **132 (+6)** | 125 (±0) | 107 (−5) | 320 (+2) | 285 (+5) | `x-ohne-kontext` gemma4:12b 0⇒5, e4b 3⇒5 (beabsichtigt); Luna `n03` 10⇒1, davon 6 **still falsch** | **Kandidat für Phase 3**, mit Vorbehalt (unten) |
| P2 (nur Messung) | 120 (−15) | 112 (−14) | 121 (−4) | 99 (−13) | 309 (−9) | **134 (−146)** | Luna hält die erfundenen Beispiel-Layer für die echten (89 × `cannot_answer`) | E-8: nein; Züge sickern ein (2.3) |
| P3 (nur Messung) | 127 (−8)¹ | 134 (+8) | 118 (−7) | 103 (−9) | 316 (−2) | 276 (−4) | | E-8: nein; P9 erreicht mehr |
| P7 (nur Messung) | – | – | – | – | – | – | – | **zurückgestellt** zu E-7 (unten) |

Lauf 2026-10-22, 56 Läufe, keine Abbrüche; Labels `<variante>-<modell>`, P6
als `p6e3-*` und `p6e12-*` (`--variant p0 --examples 3|12`), extern
`<variante>-haiku`, `-haiku-s6`, `-luna`, `-luna-s6`. Kosten extern ≈ 5 USD.

**Befunde**

1. **Beispiele und Regeln tragen beide.** Ohne Beispiele (P1) verlieren die
   drei kleineren lokalen Modelle rund 30 von 165, ohne Regeln (P4)
   gemma4:12b und qwen3.5:9b 10 bis 13. Drei Beispiele (P6) sind zu wenig,
   zwölf helfen Luna (+13) und gemma4:e4b (+5), schaden aber qwen3.5:9b
   (−9) und verschieben bei qwen3:14b Fälle in beide Richtungen.
2. **Haiku ist gegen die Platzierung unempfindlich** (±4), ausser bei P8:
   Haiku bekommt keine eingeschränkte Ausgabe, ohne den Schematext fehlt ihm
   das Schema ganz. P8 wäre nur möglich, wenn Anbieter ohne eingeschränkte
   Ausgabe den Text behalten.
3. **P5 ist modellabhängig:** gemma4:12b +9, qwen3.5:9b −13. Kein
   gemeinsamer Gewinn.
4. **P9 wirkt wie beabsichtigt** (2.3): Der Hinweis `FIRST` direkt vor der
   Frage löst `x-ohne-kontext` bei beiden gemma4-Modellen. Kein lokales
   Modell verliert mehr als 5 (qwen3.5:9b genau −5: `n13` 5⇒3, `n14` 3⇒1).
   **Vorbehalt:** Luna beantwortet `n03` («Gemeinden mit mehr als 10 000
   Einwohnern», Einwohner nur im Tabellen-Layer) in 6 von 10 Antworten mit
   allen Gemeinden ohne Filter, die Erklärung behauptet aber «mehr als
   10’000 Einwohnern». Die Anwendung nimmt die Abfrage an. Unter P0 kommt
   das bei keinem Modell vor (lokal 15 × Abweisung, sonst bestanden).
5. **Befund für die Anwendung, unabhängig von P9:** Die Prüfung erkennt nicht,
   dass eine Erklärung einen Filter nennt, den die Abfrage nicht hat (wie S1,
   8.3). Abhilfe wäre die Annahme «ohne Filter» als Hinweis in der
   Anwendung oder ein Abgleich der Bedingungen mit `assumptions`; das ist ein
   eigener Entscheid.

6. **Was E-8 kostet (P2, P3, 2026-10-23): nichts.** Beispiele als
   Gesprächszüge (P2) schaden allen, am meisten Luna: Es liest die Züge als
   früheres Gespräch über die erfundenen Layer und antwortet in 89 von 330
   Fällen «die bekannten Layer enthalten keine Schulen». Alles in die
   Nutzernachricht (P3) ist modellabhängig (gemma4:e4b +8, die übrigen −2 bis
   −9). P9 hält zwei Nachrichten ohne Anwendungstext beim Nutzer und
   erreicht bei fünf von sechs Modellen mehr als P3 (gemma4:e4b 132 gegen
   134).
7. **Absturz in der Prüfung, behoben.** Unter P2 schrieb qwen3.5:9b einmal
   `compare` mit `le` auf einem Ja/Nein-Attribut; die Prüfung liess es
   durch, SQLAlchemy warf `ArgumentError`, der Lauf brach ab. Das betraf jede
   Abfrage mit Ordnung auf einem Ja/Nein-Attribut, nicht nur Modus B. Jetzt
   weist `compile` `lt`/`le`/`gt`/`ge` und `between` auf Ja/Nein-Attributen
   als `wrong_value_type` ab (Test in `test_engine.py`); der Lauf
   `p2-qwen3.5_9b` ist danach neu gelaufen.

**Phase 2 abgeschlossen (2026-10-23).** Grundlinie bleibt P0; einziger
Kandidat ist P9.

**P7 zurückgestellt (2026-10-23).** Ein Beispielsatz auf den Layern der
Beispieldaten müsste erst so geschrieben werden, dass er keinen Fall wörtlich
beantwortet, sonst misst P7 die Fälle statt der Platzierung. Und selbst ein
Gewinn wäre nur einsetzbar, wenn die Anwendung die Beispiele je Konto erzeugt
(S3). Beides gehört zu E-7 (Werte im Steckbrief): kontoeigenes Wissen für das
Modell. P7 wird dort gemessen.

**Einordnung (2026-10-23):** Phase 2 setzt die **Grundlinie für einen
gemeinsamen Prompt**. Die Ergebnisse zeigen schon, dass die beste Platzierung
je Modell verschieden ist (P5, P6 (12)); längerfristig ist ein Prompt je
Modell oder Modellfamilie wahrscheinlich. Diese Grundlinie ist der Massstab,
an dem ein solcher Ansatz sich messen muss.

**Weiter mit Phase 3 für P9:** Seeds 6–10 der vier lokalen Modelle,
Held-out-Satz für alle sechs, `n03` unter P9 bei Luna lesen; vorher klären,
ob drei Nachrichten mit E-8 vereinbar sind (Bypass-Test, Sicherheitsreview).

¹ Früher (Abschnitt 2.3) 138/165 mit nur dem Hinweis `FIRST` in der Nutzernachricht (`t3-v27b`), nicht den
Beispielen; qwen3:8b damals 89/165 gegen 93/165 (Abschnitt 2.3).

### 8.3 Regel- und Schemavarianten aus Phase 1b (2026-10-21)

Aus den Befunden der oberen Referenz
([testplan-external-models.md](testplan-external-models.md), 9.1). Je ein
Block auf dem Tuning-Satz (33 × 5) und dem Held-out-Satz (38 × 5), gegen P0
derselben Modelle; Branches `p2-related-rule` (`2da7575`) und
`p2-related-schema` (`7e97264`), **nicht gemergt**.

| Variante | Änderung | gemma4:12b T / H | gemma4:e4b T / H | qwen3:14b T / H | qwen3.5:9b T / H | Zielfälle | Entscheid |
|---|---|---:|---:|---:|---:|---|---|
| P0 | – | 130 · 132 / 162 · 160 | 126 · 126 / 142 · 145 | 125 · 125 / 146 · 147 | 112 · 113 / 131 · 139 | – | Referenz |
| **R1** | Satz «Eine Bedingung auf die Objekte eines anderen Layers ist kein Verknüpfen …» im Antwortformat | 130 / 164 | 126 / 141 | 122 / **135** | 106 / 122 | gemma4 `doc4`, `h23`, `h27` bleiben 0/5 | **verworfen**: kein Zielgewinn, qwen3:14b −11 im Held-out |
| **S1** | im Schema der Direktabfrage `where` eines `related` nur eine Attributbedingung | 133 / 163 | 126 / 140 | 120 / 153 | 108 / 127 | `n07`, `h32`: alle `kind:query` | **verworfen**: Abfragen werden still falsch |

T = Tuning (/165), H = Held-out (/190); P0 mit beiden Seed-Blöcken.

**R1: Was die Regel nicht trifft.** gemma4:12b schreibt bei `h23` jetzt eine
Abfrage statt `cannot_answer`, aber mit verkehrter Richtung
(Gemeinde `within` Haltestelle statt `contains`, 74 statt 36 Gemeinden). Bei
`doc4` und `h27` denkt es an die Gemeindenummer und den Tabellen-Layer
(«über eine Gemeindennummer auf einen Table-Layer zu aggregieren»). qwen3:14b
lässt bei `h23` neu den Filter «Bahn» weg. Die gemeinsame Ursache bei mehreren
Modellen (auch Luna, `h18`, `h25`, `doc1`) ist die **Richtung von
`predicate`**, nicht die Regel zum Verknüpfen. Nächste Variante R2: die
Richtung im Schema und in den Regeln eindeutig beschreiben («Objekte der
Quelle liegen *in* den Objekten von `layer`: `within`»).

**S1: Eine Grenze im Schema kann gefährlicher sein als die Abweisung.** Mit
nur einer erlaubten Bedingung lässt jedes Modell in **40 von 40** Antworten
auf `n07`/`h32` eine der beiden weg (nur «Bus» oder nur «Kategorie II»), und
die Anwendung nimmt die Abfrage an: Die Nutzerin sieht ein falsches Ergebnis
ohne Hinweis. Heute weist die Anwendung die Abfrage mit zwei Bedingungen als
`not_representable` ab, das ist das sichere Verhalten. Die Grenze bleibt
deshalb in der Prüfung, nicht im Schema. Allgemein: Die eingeschränkte Ausgabe
zwingt eine Form; sie wählt nicht `cannot_answer`, wenn die Form fehlt.
Nebenbefund: qwen3:14b gewinnt unter S1 `h18` und `h25` (0 ⇒ 5/5), weil es
die Gemeindeliste als `in` statt als Gruppe schreibt.

---

## 9 Reproduzieren

```sh
cd backend
uv run python evals/run.py --model gemma4:12b --temperature 0.3 --repeat 5 --label p0-gemma4
uv run python evals/run.py --model gemma4:12b --temperature 0.3 --repeat 5 --seed-start 6 --label p0-gemma4-s6
uv run python evals/compare.py --changed p0-gemma4 p0-gemma4-s6
```

Die Ergebnisdateien (`evals/results/`, nicht im Git) enthalten jede Antwort
im Wortlaut. Die Läufe dieses Dokuments: `t3-v0-*`, `t3-v27-*`,
`t3-v27b-*`, `t3-v27c-*`, `t3-v27c-*-s6`; Phase 1: `p0-*` (Liste in 8.1).
gpt-oss:20b braucht `--effort medium` (bzw. `low`); alle anderen laufen mit
dem Standard `none`.
