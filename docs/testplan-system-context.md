# Testplan: Systemprompt und Kontext (Modus B)

> Stand: 2026-10-12 · Ausgangsstand main `0d82853` (V-2 bis V-7) ·
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

| Modell | Grösse (Q4_K_M) | Lokal vorhanden | Rolle | Hinweise |
|---|---:|---|---|---|
| gemma4:12b | 8,0 GB | ✔ | **Referenz** | Denken aus (Schleife, 2.6) |
| qwen3:8b | 5,2 GB | ✔ | zweites Hauptmodell | Denken aus; zusätzlich ein Lauf mit `--effort medium` |
| gemma4:e4b | 6,6 GB | ✔ | kleineres gemma | gleiche Familie: zeigt, ob die Beispiele familienspezifisch wirken |
| deepseek-r1:8b | 5,2 GB | ✔ | Denkmodell | im ersten Lauf prüfen, ob `--effort none` das Denken abschaltet; auf `model_truncated` und Zeit achten (Zeitlimit des Laufs 300 s) |
| qwen3:14b | ~9 GB | – | grösseres qwen | passt neben nichts anderem in 16 GB |
| phi4:14b | ~9 GB | – | andere Familie | |
| mistral-small3.2:24b | ~15 GB | – | obere Grenze lokal | knapp im Speicher, vorher allein laden |
| llama3.1:8b | ~5 GB | – | verbreitetes 8B | |

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
| P1 | Keine Beispiele, Regeln bleiben | Abschnitt `# Beispiele` nur mit den Regeln | Wie viel tragen die Beispiele selbst? | teilweise (`--no-examples` entfernt auch die Regeln) | ✔ |
| P2 | Beispiele als Gesprächszüge | je Beispiel ein Paar user/assistant vor der Frage, Systemnachricht ohne Beispiele | Lernen Modelle aus Zügen besser als aus Text? Nimmt das Einsickern (2.3) zu? | nach Harness-Erweiterung | ✘ verletzt «zwei Nachrichten» (E-8) |
| P3 | Hinweise und Beispiele in der Nutzernachricht | vor `Frage: <Prompttext>` | Bestätigt sich 2.3 für Beispiele und Regeln, nicht nur für den Hinweis? | nach Harness-Erweiterung | ✘ verletzt E-8 |
| P4 | Beispiele ohne Regeln | Regeln V-2 bis V-7 gestrichen, Beispiele bleiben | Reichen Beispiele allein? | nach Harness-Erweiterung | ✔ |
| P5 | Beispiele vor dem Steckbrief | Reihenfolge: Systemprompt, Beispiele, Steckbrief, Format, Schema | Wirkt ein Abschnitt stärker am Anfang oder am Ende? | nach Harness-Erweiterung | ✔ |
| P6 | Anzahl Beispiele: 3 / 7 / 12 | 3: nur Ort, Nähe, cannot_answer; 12: dazu `in`-Liste, `between`, «ausserhalb», `contains`, Rückfrage, Zählfrage | Wo liegt der Nutzen pro Token? | 3 ✔ (kürzen), 12 nach Harness-Erweiterung | ✔ |
| P7 | Beispiele auf echten Layern | aus dem Steckbrief des Kontos erzeugt | Helfen echte Namen (Gemeinden, Codes) mehr als erfundene? | nach Harness-Erweiterung | nur je Konto erzeugt (S3) |
| P8 | Schema nicht als Text | JSON-Schema (8,6 k Zeichen) nur als eingeschränkte Ausgabe, nicht im Prompt | Kostet der grösste Abschnitt mehr Aufmerksamkeit, als er bringt? | nach Harness-Erweiterung | ✔ |
| P9 | Hinweis `FIRST` als eigene Systemnachricht | eine zweite system-Nachricht direkt vor der Frage | Wirkt eine eigene Nachricht wie die Nutzernachricht (2.3), ohne E-8 zu verletzen? | nach Harness-Erweiterung | zu prüfen: drei Nachrichten statt zwei, Bypass-Test anpassen |

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

---

## 7 Ablauf

1. **Phase 1, Modellwahl:** P0 auf allen lokalen Modellen aus Abschnitt 4,
   Seeds 1–5; die zwei besten mit Seeds 6–10 bestätigen. Ergebnis: zwei
   Hauptmodelle für Phase 2 (heute gemma4:12b und qwen3:8b).
2. **Phase 2, Platzierung:** H-1 bis H-5 umsetzen. Dann P1, P4, P5, P6, P8, P9
   (einsetzbar) auf beiden Hauptmodellen. P2, P3, P7 als Messung, um zu
   wissen, was E-8 und S3 kosten.
3. **Phase 3, Bestätigung:** Gewinner mit Seeds 6–10. Die 15 Fragen aus
   testplan-initial-llm-run, Abschnitt 9, von Hand in der Anwendung
   nachprüfen. Erst dann wird eine Variante in `prompt.py` übernommen.
4. **Ergebnis** in Abschnitt 8 eintragen. Ein Entscheid, der E-8 oder S3
   berührt, kommt in den Sicherheitsreview.

---

## 8 Ergebnisse

### 8.1 Modelle (P0, Temperatur 0,3)

| Modell | Seeds 1–5 | Seeds 6–10 | Antwortzeit (Median) | Abbrüche | Bemerkung |
|---|---:|---:|---:|---|---|
| gemma4:12b | 130/165 | 132/165 | | | Referenz |
| qwen3:8b | 93/165 | 99/165 | | | streut stark (2.5) |
| gemma4:e4b | | | | | |
| deepseek-r1:8b | | | | | |

### 8.2 Varianten

| Variante | gemma4:12b | qwen3:8b | gekippte Fälle | Entscheid |
|---|---:|---:|---|---|
| P0 | 130/165 | 93/165 | – | Referenz |
| P1 | | | | |
| P4 | | | | |
| P5 | | | | |
| P6 (3) | | | | |
| P6 (12) | | | | |
| P8 | | | | |
| P9 | | | | |
| P2 (nur Messung) | | | | |
| P3 (nur Messung) | 138/165¹ | 89/165¹ | | E-8: nein |
| P7 (nur Messung) | | | | |

¹ Nur der Hinweis `FIRST` in der Nutzernachricht (`t3-v27b`), nicht die
Beispiele.

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
`t3-v27b-*`, `t3-v27c-*`, `t3-v27c-*-s6`.
