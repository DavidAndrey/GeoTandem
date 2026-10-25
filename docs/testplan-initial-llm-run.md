# Testplan: erster Lauf mit echtem Modell (Modus B)

> Stand: 2026-10-12, nach E2.5 · Branch `model-evals` · Beispieldaten
> `bern-mittelland-2026-10-03` · Ollama 0.34.0 auf RTX 5060 Ti (16 GB) ·
> Bezug: [filters.md](filters.md), [ollama.md](ollama.md),
> [plan-e2.3-e2.6.md](plan-e2.3-e2.6.md), [backend/evals/README.md](../backend/evals/README.md)

Nach E2.5 liess sich zum ersten Mal ein echtes Modell befragen. Die ersten
Versuche waren verwirrend: falsche Antworten, unsinnige Filter. Dieses Dokument
hält fest, was die Ursachen waren, wie wir die Antwortqualität jetzt messen,
was die ersten Messungen zeigen und was zu entscheiden ist.

**Kurz:**

1. Der Hauptgrund war ein **Fehler im Antwortschema**, nicht das Modell:
   Unter eingeschränkter Ausgabe (constrained output) konnte kein Modell eine
   `related`-Bedingung schreiben. Damit scheiterte jede Frage mit Raumbezug.
   Behoben ([3.1](#31-die-grammatik-sperrte-related)).
2. Es gibt jetzt eine **Messung**: 17 Fragen, je dreimal, über den echten
   Ablauf, bewertet über die Objekt-IDs des Ergebnisses ([2](#2-die-messung)).
3. Bestes Ergebnis bisher: **gemma4:12b mit Beispielen im Prompt, 39/51**, bei
   gut einer Sekunde je Antwort. Eingetragen ist heute qwen3:8b ohne Denken:
   17/51 vorher, 28/51 nach dem Fix.
4. **Denken** hebt qwen3:8b auf 38/51, kostet aber das Siebenfache an Zeit.
   gemma4 verfängt sich beim Denken in Schleifen und füllt den Kontext, bis
   keine Antwort mehr kommt, auch mit 32 k und 64 k Kontext. qwen3 braucht
   keinen grösseren Kontext ([3.3](#33-denken), [3.4](#34-grösserer-kontext)).
5. Sieben Entscheide sind offen ([6](#6-offene-entscheide)).

---

## 1 Ausgangslage: die ersten fünf Versuche

Aus `model_action` der Entwicklungsdatenbank, Verbindung „Ollama Qwen3:8b“
(`qwen3:8b`, Temperatur 0, Seed 42, Denken aus), Stufe *Prüfen*:

| # | Frage | Was das Modell schrieb | Ursache |
|---|---|---|---|
| 1 | „Welche Haltestellen liegen nahe an Schulen?“ (direkt) | `near_feature` auf `schulen`, `fid: 0`, Distanz 0 | `related` war unerreichbar (3.1); `near_feature` meint *ein* Objekt mit bekannter fid |
| 2 | „wie viele Schulen gibt es auf der Gemeinde Bern ?“ (direkt) | `gem_nr = 1` in einem `and` mit einem Argument ⇒ `not_representable` | Nummer erfunden (Bern ist 351); `related` unerreichbar; die Darstellbarkeitsprüfung lehnt `and` mit einem Argument ab |
| 3 | dieselbe Frage (Werkzeugkette) | erfundenes `"op": "intersects"` ⇒ `model_query_invalid` | Das Schema der Kette schränkt `where` nicht ein |
| 4 | „Schulen mit Haltestellen maximal 200m entfernt“ (direkt) | drei „ist nicht leer“, **keine** Distanzbedingung | `related` unerreichbar; das Modell füllt mit Bedingungen, die es schreiben kann |
| 5 | „passe die Distanz auf 100m an“ (direkt) | Strassen mit `klasse = kantonsstrasse_a` | Kein Kontext: ohne `parent` keine früheren Züge, die aktuelle Analyse kommt erst mit WP81 (`reference` bleibt `none`) |

**Ausgeschlossen:** abgeschnittener Kontext. Ollama läuft mit
`OLLAMA_CONTEXT_LENGTH=16384`, der Prompt der Direktabfrage hat rund 4 900
Tokens (Systemprompt 0,6 k Zeichen, Layer-Steckbrief 4,1 k, Antwortformat mit
Schema 10 k, Beispiele 3,1 k). Der Steckbrief ist brauchbar: Beschriftungen,
Einheiten, Codelisten.

---

## 2 Die Messung

[backend/evals/](../backend/evals/) fragt ein echtes Modell über den Weg, den
auch die Anwendung nimmt (`direct_prompt`, dann `DirectQuery.ask`: echter
Client, Parser, Prüfung in der Welt des Modells, Darstellbarkeit). Grundlage
sind ein frisch aufgebauter Beispieldatensatz und die Standardstufe. Neu ist
nur die Bewertung. Nicht Teil von `make gate`: Sie braucht einen laufenden
Endpunkt und dauert Minuten.

```sh
cd backend
uv run python evals/run.py --model gemma4:12b --label fewshot2-gemma4
uv run python evals/run.py --model qwen3:8b --effort medium --label think-medium-qwen3
uv run python evals/run.py --model qwen3:8b --no-examples --only doc5-aare --repeat 1
```

| Option | Bedeutung |
|---|---|
| `--model`, `--url` | Modell und Endpunkt (Standard `http://127.0.0.1:11434/v1`) |
| `--effort` | `reasoning_effort` wie in der Verbindung: `none` (Standard), `low`, `medium`, `high`, `default` |
| `--repeat` | Läufe je Fall mit Seed 1…N (Standard 3) |
| `--no-examples` | die Beispiele des Prompts weglassen, um sie zu messen |
| `--only` | nur diese Fälle (IDs mit Komma) |

**Bewertung.** Ein Fall gilt als bestanden, wenn die Anwendung die Abfrage
annimmt und sie **dieselben Objekt-IDs** liefert wie die Referenzabfrage
(`gold`). Eine andere, gleichwertige Schreibweise zählt also als richtig. Wo
eine Frage mehrere faire Lesarten hat („nahe“), prüft `require` die Form
(Quell-Layer, Bedingung, Distanz in einem Bereich). Ergebnisse:
`pass`, `wrong:<erhalten>≠<erwartet>`, `refused:<code>`, `kind:<art>`,
`error:<code>`. Jede Antwort steht in `evals/results/<zeit>-<label>.jsonl`
(nicht im Git).

**Die 17 Fälle** ([cases.json](../schema/eval-cases/start-tuning.json)):

| Gruppe | Fälle | Prüft |
|---|---|---|
| `doc1`–`doc6` | die Beispiele 1–6 aus [filters.md](filters.md#2-beispiele), umformuliert | Raumbezug, ODER, NICHT, Verschachtelung; Trefferzahlen wie im Dokument |
| `log1`, `log2`, `log4` | die Fragen 1, 2 und 4 aus Abschnitt 1, wörtlich | die beobachteten Fehler |
| `attr-*`, `text-*` | einfache Attributfilter | Code, Zahl, Ja/Nein, Textanfang |
| `in-gemeinde-bahn`, `dist-nationalstrasse` | „in Gemeinde X“, Distanz mit Filter auf dem anderen Layer | |
| `none-spitaeler` | eine Frage ohne passenden Layer | erwartet `cannot_answer` |

Die Fragen sind so formuliert, wie Anwender fragen, nicht wie die Titel in
der Dokumentation. Die Beispiele im Prompt verwenden erfundene Layer, damit
kein Fall vom Prompt selbst beantwortet wird.

---

## 3 Befunde

### 3.1 Die Grammatik sperrte `related`

Ollama (wie llama.cpp) setzt das JSON-Schema in eine Grammatik um und lässt
die Eigenschaften eines Objekts **nur in der Reihenfolge des Schemas** zu.
Jede Bedingung begann im Schema mit `op`, nur `RelatedTopological` und
`RelatedByDistance` nicht: Sie erben `layer` und `predicate` von ihren
Basisklassen und setzen `op` zuletzt. Hatte das Modell `{"op":` geschrieben,
war `related` ausgeschlossen. Erreichbar war es nur über `{"layer":`, und so
beginnt kein Modell eine Bedingung.

Nachweis: dieselbe Frage mit und ohne Schema. Ohne Schema schrieb qwen3:8b
die richtige `related`-Bedingung, mit Schema „ist nicht leer“-Füllbedingungen.

**Fix** ([result.py](../backend/src/geotandem/model/result.py),
`_tag_first`): Im Schema, das der Prompt sendet, steht `op` bzw. `kind`
jeder Definition zuerst. Das versionierte Schema
`schema/query-object/v2.json` bleibt unverändert (für einen Validator ist die
Reihenfolge bedeutungslos). Ein Test hält die Reihenfolge für beide Ansätze
fest (`test_each_definition_opens_with_its_tag`).

### 3.2 Beispiele im Prompt

Fünf Beispiele und kurze Regeln
([prompt.py](../backend/src/geotandem/model/prompt.py), `_EXAMPLES`, nur
Direktabfrage), als eigener Abschnitt nach dem Antwortformat:

- „in X“ (X ein Objekt eines anderen Layers) ⇒ `related` mit `within` und
  Namensfilter, nie eine Nummer raten;
- Nähe ⇒ `related` mit `dwithin`, „weiter als“ ⇒ `not` darum; „nahe“ ohne
  Zahl ⇒ 300 m als Annahme; kein `near_feature`;
- ein Filter auf die Objekte des anderen Layers steht in dessen `where`;
- Codes: der Schlüssel, nie die Beschriftung; Ja/Nein mit `true`/`false`;
- keine zusätzlichen „ist nicht leer“; eine einzelne Bedingung nicht in `and`.

Die Beispiele verwenden **erfundene Layer** (baeume, quartiere,
schulhaeuser, parzellen, spielplaetze) mit einem kurzen erfundenen Steckbrief.
So passen sie zu jedem Datenkern, und der Prompt nennt keinen Layer, den ein
Konto nicht sehen darf (S3). Umfang: 3,1 k Zeichen, rund 1 000 Tokens.

Eine erste Fassung zeigte `related` meist *ohne* Filter. Die Modelle
übernahmen die Form und liessen „Nationalstrasse“, „Aare“, „Bahn“ weg (27/51
statt 28/51 bei qwen3). Die zweite Fassung (`fewshot2`) zeigt Distanz *mit*
Filter und Codes, deren Beschriftung vom Schlüssel abweicht.

### 3.3 Denken

`reasoning_effort` der Verbindung schaltet das Denken ein (`none` = aus).

- **qwen3:8b, `medium`: 38/51** statt 28/51. Die mittlere Antwortzeit steigt
  von 2 s auf 15 s. Zwei Aufrufe liefen über 300 s (`llm_timeout`); in der
  Anwendung gilt `MODEL_CALL_S = 120`. Gewonnen werden vor allem die
  verschachtelten und verneinten Fälle (doc3, doc4, doc5).
- **gemma4:12b, `low`: 13/17** (ein Lauf je Fall). Alle vier Fehler sind
  `model_unreadable`. Ursache: Das Modell denkt in Schleifen („Wait, I see
  `sekundar`… no, I see …“), bis der Kontext voll ist. Gemessen an doc4
  (`medium`, 16 k): 4 894 Tokens Prompt, 11 487 Tokens Denken,
  `finish_reason: length`, leerer Inhalt, 104 s.

Die Anwendung meldet dies als `model_unreadable`. Der eigentliche Grund (die
Antwort wurde abgeschnitten) geht verloren ([E-5](#6-offene-entscheide)).

### 3.4 Grösserer Kontext

Der OpenAI-kompatible Endpunkt von Ollama nimmt keine Kontextgrösse je Anfrage
an; sie gilt für den Server (`OLLAMA_CONTEXT_LENGTH=16384`). Für den Test
wurden deshalb Modellvarianten mit grösserem `num_ctx` angelegt. Sie teilen die
Gewichte mit dem Grundmodell, die Serverkonfiguration bleibt unverändert:

```sh
curl -s localhost:11434/api/create \
  -d '{"model":"gemma4:12b-ctx32k","from":"gemma4:12b","parameters":{"num_ctx":32768},"stream":false}'
# ebenso gemma4:12b-ctx64k (65536) und qwen3:8b-ctx40k (40960, das Maximum von qwen3)
# entfernen: docker exec ollama ollama rm gemma4:12b-ctx32k
```

Grenzen der Modelle: gemma4:12b 262 144 Tokens, qwen3:8b 40 960.

Gemessen mit dem Prompt von doc4 (4 894 bzw. 5 016 Tokens), Denken `medium`:

| Modell | Kontext | Ende | Denk- und Antworttokens | Antwort | Dauer |
|---|---:|---|---:|---|---:|
| gemma4:12b | 16 384 | `length` | 11 487 | leer | 104 s |
| gemma4:12b-ctx32k | 32 768 | `length` | 27 874 | leer | 287 s |
| gemma4:12b-ctx64k | 65 536 | `length` | 60 642 | leer | 571 s |
| qwen3:8b (Seed 2) | 16 384 | `stop` | 1 064 | Abfrage | 20 s |
| qwen3:8b-ctx40k (Seed 2) | 40 960 | `stop` | 1 064 | Abfrage | 21 s |

- **gemma4 denkt in einer Schleife**, die jeden Kontext füllt. Mehr Kontext
  verlängert nur die Wartezeit. Mit Denken ist gemma4 hier nicht brauchbar.
- **qwen3 braucht keinen grösseren Kontext:** Prompt, Denken und Antwort
  belegen rund 6 000 Tokens. Die zwei `llm_timeout` des Laufs
  `think-medium-qwen3` (doc4 und doc6, je Seed 2) liessen sich nicht
  wiederholen: Dieselbe Anfrage endete in 20 s. Trotz Seed ist die Ausgabe auf
  der GPU nicht streng wiederholbar; eine gelegentlich lange Denkphase bleibt
  möglich und ist ein Grund für eine Obergrenze ([E-4](#6-offene-entscheide)).

Nebenbei: qwen3 beantwortet doc4 hier mit `typ = "sekundar"` statt
`sekundarstufe = true`. In den Beispieldaten sind das dieselben 62 Schulen;
die Bewertung über die Objekt-IDs zählt beide Lesarten als richtig.

---

## 4 Ergebnisse

Alle Läufe Temperatur 0, Seeds 1–3, Stufe *Prüfen*, Ollama mit 16 k Kontext.

| Label | Modell | Denken | Schema-Fix | Beispiele | Bestanden | Antwortzeit (Median) |
|---|---|---|---|---|---:|---:|
| `baseline-qwen3` | qwen3:8b | aus | – | – | 17/51 | |
| `fewshot-qwen3` | qwen3:8b | aus | – | Fassung 1 | 15/51 | |
| `fix-only-qwen3` | qwen3:8b | aus | ✔ | – | 28/51 | |
| `fix-fewshot-qwen3` | qwen3:8b | aus | ✔ | Fassung 1 | 27/51 | |
| `fewshot2-qwen3` | qwen3:8b | aus | ✔ | Fassung 2 | 28/51 | 2,1 s |
| `think-medium-qwen3` | qwen3:8b | `medium` | ✔ | Fassung 2 | **38/51** | 14,7 s |
| `fix-only-gemma4` | gemma4:12b | aus | ✔ | – | 24/51 | |
| `fewshot2-gemma4` | gemma4:12b | aus | ✔ | Fassung 2 | **39/51** | 1,2 s |
| `think-low-gemma4` | gemma4:12b | `low` | ✔ | Fassung 2 | 13/17 | 13,6 s |
| `codes-qwen3` | qwen3:8b | aus | ✔ | Fassung 2, Codes (E-2) | 30/51 | |
| `codes-gemma4` | gemma4:12b | aus | ✔ | Fassung 2, Codes (E-2) | 39/51 | |
| `e3-qwen3` | qwen3:8b | aus | ✔ | Fassung 2, Codes, Formen (E-3) | 33/51 | |
| `e3-gemma4` | gemma4:12b | aus | ✔ | Fassung 2, Codes, Formen (E-3) | 39/51 | |
| `e6-qwen3` | qwen3:8b | aus | ✔ | wie e3, «wie viele» (E-6) | 30/51 | |
| `e6-gemma4` | gemma4:12b | aus | ✔ | wie e3, «wie viele» (E-6) | **44/51** | |

Ab 2026-10-12 abends: **33 Fälle** (17 + N1–N15 + `x-ohne-kontext`), und
zum Vergleich von Prompt-Varianten **Temperatur 0,3 mit 5 Seeds** (165
Antworten je Lauf), weil bei Temperatur 0 die Seeds fast gleich antworten
(7, Punkt 6):

| Label | Modell | Stand | Temperatur × Seeds | Bestanden |
|---|---|---|---|---:|
| `v0-gemma4` / `v27-gemma4` | gemma4:12b | vor / nach V-2–V-7 | 0 × 3 | 69/99 ⇒ 71/99 |
| `v0-qwen3` / `v27-qwen3` | qwen3:8b | vor / nach V-2–V-7 | 0 × 3 | 51/99 ⇒ 51/99 |
| `t3-v0-gemma4` | gemma4:12b | vor V-2–V-7 | 0,3 × 5 | 109/165 |
| `t3-v27-gemma4` | gemma4:12b | V-2–V-7, erste Fassung | 0,3 × 5 | 134/165 |
| `t3-v27b-gemma4` | gemma4:12b | V-2–V-7, nachgebessert | 0,3 × 5 | **138/165** |
| `t3-v0-qwen3` | qwen3:8b | vor V-2–V-7 | 0,3 × 5 | 85/165 |
| `t3-v27-qwen3` | qwen3:8b | V-2–V-7, erste Fassung | 0,3 × 5 | 94/165 |
| `t3-v27b-qwen3` | qwen3:8b | V-2–V-7, nachgebessert | 0,3 × 5 | 89/165 |
| `t3-v27c-gemma4` | gemma4:12b | wie v27b, Hinweis «erste Frage» in der Systemnachricht (gemergter Stand) | 0,3 × 5 | **130/165** |
| `t3-v27c-qwen3` | qwen3:8b | wie v27b, Hinweis in der Systemnachricht (gemergter Stand) | 0,3 × 5 | 93/165 |

Bei Temperatur 0 sah V-2–V-7 nach +2 aus; mit Streuung sind es bei gemma4
+29 von 165. Ein Vergleich bei Temperatur 0 mit drei Seeds trägt keine
Entscheidung.

Je Fall:

| Fall | baseline-qwen3 | fix-only-qwen3 | fewshot2-qwen3 | think-medium-qwen3 | fix-only-gemma4 | fewshot2-gemma4 | think-low-gemma4 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `doc1-primar-koeniz` | 0/3 | 0/3 | 0/3 | 2/3 | 0/3 | 3/3 | 0/1 |
| `doc2-gut-erschlossen` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 3/3 | 1/1 |
| `doc3-weit-von-bahn` | 0/3 | 0/3 | 0/3 | 3/3 | 0/3 | 3/3 | 1/1 |
| `doc4-ohne-sek` | 0/3 | 0/3 | 0/3 | 2/3 | 0/3 | 0/3 | 0/1 |
| `doc5-aare` | 0/3 | 1/3 | 0/3 | 3/3 | 0/3 | 0/3 | 1/1 |
| `doc6-verschachtelt` | 0/3 | 0/3 | 0/3 | 1/3 | 0/3 | 0/3 | 0/1 |
| `log1-haltestellen-nahe-schulen` | 0/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 1/1 |
| `log2-schulen-in-bern` | 0/3 | 0/3 | 3/3 | 0/3 | 0/3 | 0/3 | 0/1 |
| `log4-schulen-200m` | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| `attr-franzoesisch` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| `attr-schulhaeuser` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| `attr-ohne-kindergarten` | 2/3 | 3/3 | 1/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| `attr-flaeche` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| `text-beginnt-bern` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| `in-gemeinde-bahn` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 3/3 | 1/1 |
| `dist-nationalstrasse` | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| `none-spitaeler` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 |
| **Summe** | **17/51** | **28/51** | **28/51** | **38/51** | **24/51** | **39/51** | **13/17** |

Einfache Attributfilter gelingen von Anfang an. Alles mit Bezug zu einem
anderen Layer scheiterte vor dem Fix ohne Ausnahme.

---

## 5 Verbleibende Fehlerarten

| Fehlerart | Beispiel | Häufig bei |
|---|---|---|
| **Beschriftung statt Code** | `typ = "Primarstufe"` statt `primar`, `verkehrsmittel = "Bahn"` statt `bahn` | qwen3 ohne Denken: häufigste Ursache |
| **Richtung der Beziehung** | Gemeinden `within` Schulen statt `contains` (doc4) | beide |
| **Filter auf dem falschen Layer** | Schulmerkmale im `where` der Haltestellen (doc6) | beide |
| **Zwei Filter auf dem anderen Layer** | Aare *und* Hauptgewässer ⇒ `not_representable`, die Bedienelemente kennen dort nur eine Zeile (doc5) | gemma4 |
| **„Wie viele“ wird abgelehnt** | `cannot_answer`: „kann keine Anzahl berechnen“ (log2) | gemma4 |
| **Bedeutung verwechselt** | „Sekundarstufe I“ als Wert von `typ` statt Ja/Nein-Attribut `sekundarstufe` | qwen3 |
| **Denkschleife** | Kontext voll, leere Antwort, `model_unreadable` | gemma4 mit Denken |

---

## 6 Offene Entscheide

| # | Entscheid | Optionen | Empfehlung | Messbar mit |
|---|---|---|---|---|
| E-1 | **Modell der Verbindung** | qwen3:8b bleibt · gemma4:12b · qwen3:8b mit Denken | gemma4:12b ohne Denken: bestes Ergebnis, schnellste Antwort | Läufe in 4 |
| E-2 | **Beschriftung ⇒ Code** — *umgesetzt 2026-10-12* | – | Die Anwendung liest eine Beschriftung oder einen Code in anderer Schreibweise als den Code, vor der Prüfung, in der Direktabfrage und in jedem Kettenschritt ([labels.py](../backend/src/geotandem/model/labels.py)). Gemessen: qwen3 28 ⇒ 30/51, gemma4 unverändert 39/51. Die Werte stimmen jetzt; was qwen3 noch falsch macht, sind weggelassene Bedingungen, UND statt ODER und `and` mit einem Argument (E-3) | `codes-*` |
| E-3 | **Harmlose Formen** — *umgesetzt 2026-10-12* | – | `and`/`or` mit einem Argument und `not` von `not` werden vor der Prüfung in ihre schlichte Form gebracht, in der Direktabfrage und in jedem Kettenschritt ([shapes.py](../backend/src/geotandem/model/shapes.py)); der Eintrag speichert die schlichte Abfrage, die Antwort des Modells bleibt unverändert. `represent.to_analysis` lehnt diese Formen weiterhin ab (gemeinsame Fälle mit dem Frontend unverändert). Gemessen: qwen3 30 ⇒ 33/51, keine Ablehnung wegen der Form mehr; gemma4 unverändert 39/51. Bekannte Lücke: Der Pfad einer Annahme (`condition`) zeigt nach dem Umschreiben ins Leere, wenn er durch das entfernte `and` führte; «ändern» fehlt dann bei dieser Annahme | `e3-*` |
| E-4 | **Denken** | aus · an mit Obergrenze für die Antwortlänge (`max_tokens`) · je Modell | aus für gemma4 (Schleife, auch mit 64 k Kontext); für qwen3 nur mit Obergrenze und Zeitlimit über 120 s; den Kontext nicht vergrössern, er hilft keinem der beiden | `think-*`, 3.4 |
| E-5 | **Abgeschnittene Antwort melden** — *umgesetzt 2026-10-12* | – | Eigener Code `model_truncated` (502), wenn die Antwort nicht lesbar ist und das Modell an seiner Längengrenze stoppte (`finish_reason: length`); `details` nennt `prompt_tokens` und `completion_tokens`. Eine lesbare Antwort gilt unabhängig vom Grund des Endes. Oberfläche: «Antwort abgeschnitten», Hinweis auf zu langes Denken oder zu kleinen Kontext, Details mit den Tokens, Verweis für Administratoren, «Anbindung wechseln»; in der Kette eigener Text bei der Neuplanung. Geprüft: gemma4 mit Denken endet jetzt `error:model_truncated` statt `model_unreadable` | `e5-probe-gemma4` |
| E-6 | **«Wie viele»-Fragen** — *umgesetzt 2026-10-12* | – | Ein Satz im Antwortformat der Direktabfrage: «Wie viele …?» mit `query` beantworten, die Anwendung zeigt die Anzahl; kein Grund für `cannot_answer`. Gemessen: gemma4 39 ⇒ **44/51** (`log2` 0 ⇒ 2/3, nebenbei `doc5` 0 ⇒ 3/3); qwen3 33 ⇒ 30/51, weil es in `doc3` nun den Filter «Bahn» weglässt, eine Frage, die der Satz nicht betrifft (siehe 7, Punkt 6) | `e6-*` |
| E-7 | **Werte im Steckbrief** (z. B. Gemeindenamen) | nur Metadaten (S3, heute) · kurze Wertelisten für kleine Textfelder · Werkzeug zum Nachschlagen in der Kette | erst messen: Mit dem Fix schreibt das Modell „Bern“, „Köniz“ richtig über den Namen | `log2`, `doc1`, `in-gemeinde-bahn` |
| E-8 | **Hinweis «erste Frage»** — *entschieden 2026-10-12: Systemnachricht* | – | Der Hinweis bleibt am Ende der Systemnachricht; die Invariante «die Nutzernachricht ist der Prompttext und nichts sonst» bleibt unverändert. Das Einsickern der Beispiele bleibt damit bei gemma4 offen (0/5). Weitere Varianten der Platzierung (eigene Systemnachricht, Beispiele als Gesprächszüge, Reihenfolge, Anzahl) und weitere Modelle: [testplan-system-context.md](testplan-system-context.md) *Ergänzt 2026-10-23:* Eine **eigene Systemnachricht** für den Hinweis direkt vor der Frage ist erlaubt (drei Nachrichten statt zwei, Variante P9); die Invariante zur Nutzernachricht gilt weiter. | `t3-v27b` gegen `t3-v27c` |

Nicht in dieser Messung, aber offen:

- **Werkzeugkette:** Ihr Schema schränkt `where` der Schritte nicht ein (Versuch 3
  in Abschnitt 1). Die Messung deckt nur die Direktabfrage ab.
- **Folgefragen** („passe die Distanz an“) wirken erst mit WP81.

---

## 7 Nächste Schritte

1. **E-1 bis E-7 entscheiden.** E-2, E-3 und E-6 sind klein und je mit einem
   Lauf zu belegen.
2. **Fälle ergänzen**, ehe weiter am Prompt gearbeitet wird; 17 Fälle tragen
   noch keinen feinen Vergleich: Zählfragen, Datumsbereiche, `in`-Listen,
   Tabellen-Join (`gemeindedaten`), Rückfragen (`clarification`), und je eine
   Frage pro Fehlerart aus Abschnitt 5. Fälle mit zwei vertretbaren Lesarten,
   die in den Daten verschiedene Objekte liefern, erhalten mehrere
   Referenzabfragen. Vorschlag: die 15 Fragen aus [Abschnitt 9](#9-manuelle-prüfung-15-neue-fragen).
3. **Die Kette messen:** `evals/run.py` um `--approach chain` erweitern
   (Plan prüfen, Schritte ausführen, Ergebnis-IDs vergleichen); vorher das
   `where` der Schritte im Schema einschränken.
4. **Folgefragen messen**, sobald WP81 die aktuelle Analyse mitschickt: Fälle
   mit zwei Zügen.
5. **Als Ritual:** Vor jeder Änderung an Prompt, Schema, Steckbrief oder
   Modell ein Lauf mit neuem Label; das Ergebnis kommt in die Tabelle in
   Abschnitt 4.
6. **Streuung messen:** Bei Temperatur 0 geben die drei Seeds praktisch
   dieselbe Antwort; ein Fall ist damit eine einzige Stichprobe. Ein Satz an
   anderer Stelle des Prompts kippte bei qwen3 `doc3` von 3/3 auf 0/3 (E-6).
   Die Messung sollte mit Temperatur über 0 (z. B. 0,3) und fünf Seeds laufen,
   damit ein Unterschied von wenigen Fällen von Zufall zu trennen ist.

---

## 8 Reproduzieren

```sh
git switch model-evals
cd backend
# Ollama wie in docs/ollama.md, Modelle geladen:
docker exec ollama ollama pull qwen3:8b
docker exec ollama ollama pull gemma4:12b
uv run python evals/run.py --model gemma4:12b --label fewshot2-gemma4
```

Ein Lauf mit 51 Aufrufen dauert ohne Denken 1–4 Minuten, mit Denken rund
25 Minuten (qwen3:8b). Die Ergebnisdateien in `evals/results/` enthalten jede
Antwort im Wortlaut; die Fehler liest man dort.

---

## 9 Manuelle Prüfung: 15 neue Fragen

> Stand 2026-10-12, für einen Lauf von Hand im Arbeitsplatz. Jede Frage zielt
> auf eine Lücke der 17 Fälle oder eine Fehlerart aus Abschnitt 5. Die
> erwarteten Trefferzahlen sind mit der Referenzabfrage auf den Beispieldaten
> gerechnet (unten). Nach der Bewertung kommen die Fragen mit Referenz in
> [cases.json](../schema/eval-cases/start-tuning.json).

**Vorgehen:** Stufe *Prüfen*, Verbindung wie zu bewerten (gemma4:12b ohne
Denken empfohlen, zum Vergleich qwen3:8b). Jede Frage als neue Anfrage, nicht
als Folgefrage. Ansatz «direkt», wo nicht anders vermerkt. Notieren: Antwortart,
Trefferzahl, Erklärung und Annahmen, ✔ / ≈ / ✘.

**Bewertung:** ✔ richtige Treffer *oder* die erwartete Antwortart · ≈ andere,
aber vertretbare Lesart, als Annahme genannt · ✘ falsch, erfunden oder
abgelehnt, wo eine Abfrage möglich war.

| # | Frage | Ansatz | Prüft | Erwartet | Bewertung |
|---|---|---|---|---|---|
| N1 | Wie viele Tramhaltestellen gibt es? | direkt | Zählfrage (E-6), Code über Beschriftung | Abfrage `verkehrsmittel = tram` · **72** || ✔ #13 · 72 (Modell schrieb «Tram», E-2 machte daraus `tram`) |
| N2 | Zeig die Haltestellen der Kategorien III bis V. | direkt | «bis» auf einer Codeliste: Liste statt Bereich | `kategorie` ist eins von III, IV, V · **593** || ✘ #14, #16 · `between` 3–5 auf dem Text-Code ⇒ `wrong_value_type` |
| N3 | Welche Gemeinden haben mehr als 10 000 Einwohner? | direkt, dann Kette | Tabellen-Layer `gemeindedaten`: braucht eine Verknüpfung, die weder Direktabfrage noch Kette kennt | `cannot_answer`, nennt die Verknüpfung mit Gemeindedaten; keine erfundene Bedingung auf `gemeinden`. (Von Hand in Modus A: 10 Gemeinden, Beispiel 8 in filters.md) || ✘ #15, #17 · `einwohner` auf `gemeinden` erfunden ⇒ `unknown_attribute`; Kette #18: Filter auf Tabellen-Layer ⇒ `not_representable` |
| N4 | Zeig mir die grossen Gemeinden. | direkt | Mehrdeutigkeit | Rückfrage (Fläche oder Einwohner?) **oder** Abfrage auf `flaeche_km2` mit Schwelle als Annahme (> 30 km²: **9**) || ≈ #19–21 · gute Rückfrage; zweite Rückfrage mit 50/100/200 km² (grösste Gemeinde 57 km²); mit «30» dann 9 ✔ |
| N5 | In welchen Gemeinden gibt es eine französischsprachige Schule? | direkt | Richtung der Beziehung (`contains`, nicht `within`) | Gemeinden `contains` Schulen (`sprache = fr`) · **1** || ✔ #22 · 1 |
| N6 | Primarschulen höchstens 400 m von einer Tramhaltestelle | direkt | Filter auf dem richtigen Layer: `primar` auf Schulen, `tram` auf Haltestellen | `typ = primar` UND ≤ 400 m zu Haltestellen (`verkehrsmittel = tram`) · **7** || ≈ #23 · `primarstufe = true` statt `typ = primar` ⇒ 16 statt 7, ohne Annahme |
| N7 | Schulen höchstens 300 m von einer Bushaltestelle der Kategorie II | direkt, dann Kette | Zwei Filter auf dem anderen Layer: die Bedienelemente zeigen nur einen | direkt: `cannot_answer` mit Hinweis auf die Kette (keine Abfrage, die einen Filter weglässt); Kette: Haltestellen filtern (bus, II), dann Schulen in der Nähe · **25** || ✘ #24 · Abfrage mit zwei Filtern ⇒ `not_representable` statt `cannot_answer`; Kette #25: «bus» weggelassen, `"of": "1"` ⇒ `model_query_invalid` |
| N8 | Welche Schulen bieten die Sekundarstufe I an? | direkt | Ja/Nein-Attribut gegen Code von `typ` | `sekundarstufe = true` oder `typ = sekundar`, beide **62** (dieselben Schulen) || ✔ #26 (Kette) · 62 |
| N9 | Welche Haltestellen liegen ausserhalb der Stadt Bern? | direkt | Verneinte Raumbeziehung, «Stadt» = Gemeinde | NICHT liegt in Gemeinden (`name = Bern`) · **704** von 961 || ✘ #27, #28 · unnötige Rückfrage; dann Name *enthält* «Bern» ⇒ 644 statt 704 (schliesst auch Bremgarten, Muri, Wohlen bei Bern aus) |
| N10 | Welche Strassen führen durch Köniz? | direkt | Linie zu Fläche: `intersects`, nicht `within` | Strassen schneiden Gemeinden (`name = Köniz`) · **16** || ✘ #29 · `within` statt `intersects` ⇒ 5 statt 16 |
| N11 | Haltestellen mit 1000 bis 5000 Einwohnern im Einzugsgebiet | direkt | Zahlenbereich, «Einwohner» auf dem richtigen Layer (Haltestellen, nicht Gemeindedaten) | `einwohner` zwischen 1000 und 5000 · **399** || ✔ #30 · 399 |
| N12 | Wo sind die Schiffsanlegestellen? | direkt | Code ohne Daten | Abfrage `verkehrsmittel = schiff` · **0** Treffer; ✘ ist ein `cannot_answer` («gibt es nicht»): Das Modell kennt keine Inhalte || ✔ #31 · 0 |
| N13 | Schulen im Umkreis von 1 km um den Bahnhof Bern | direkt | Benanntes Einzelobjekt ohne bekannte fid; Werte unbekannt (E-7) | ≤ 1000 m zu Haltestellen (`name = Bern`; die Bahnhaltestelle heisst «Bern», fid 47) · **4**. Typischer Fehler: «Bahnhof Bern» als Name (0 Treffer) oder `near_feature` mit geratener fid; ≈ wenn die Annahme zum Namen genannt ist || ✘ #32 · Name enthält «Bahnhof Bern» ⇒ 0 (die Haltestelle heisst «Bern»); abgelehnt |
| N14 | Welche Schulen haben mehr als 300 Schülerinnen und Schüler? | direkt | Fehlendes Attribut, keine Ersatzgrösse erfinden | `cannot_answer`, `missing` nennt die Schülerzahl; ✘ eine Bedingung auf `standorte` || ✔ #33 · `missing` nennt die Schülerzahl |
| N15 | Wie viele Schulen gibt es in jeder Gemeinde? | direkt, dann Kette | Zusammenfassung je Gemeinde: kann keiner der Ansätze | `cannot_answer` in beiden; nennt die Zusammenfassung (Modus A kann sie: Bern 27, Köniz 11, Belp 7, …) || ≈ #34 · `cannot_answer` richtig, aber `other_approach: chain`, obwohl die Kette nicht zusammenfassen kann |

Abgedeckt: Zählen (N1, N15), Codelisten (N1, N2, N12), Tabellen-Layer (N3),
Rückfrage (N4), Richtung (N5, N10), falscher Layer (N6, N11), zwei Filter
(N7), Bedeutung (N8), Verneinung (N9), Zahlenbereich (N11), Einzelobjekt (N13),
Ehrlichkeit bei fehlenden Daten (N3, N12, N14, N15), Kette (N3, N7, N15).
Nicht abgedeckt: Datumsbereiche (die Beispieldaten haben kein Datumsattribut)
und Folgefragen (erst mit WP81).

<details>
<summary>Referenzabfragen (Trefferzahlen auf <code>bern-mittelland-2026-10-03</code>)</summary>

```json
{"N1":  {"source":"haltestellen","where":{"op":"compare","attr":"verkehrsmittel","cmp":"eq","value":"tram"}},
 "N2":  {"source":"haltestellen","where":{"op":"in","attr":"kategorie","values":["III","IV","V"]}},
 "N4":  {"source":"gemeinden","where":{"op":"compare","attr":"flaeche_km2","cmp":"gt","value":30}},
 "N5":  {"source":"gemeinden","where":{"op":"related","layer":"schulen","predicate":"contains","where":{"op":"compare","attr":"sprache","cmp":"eq","value":"fr"}}},
 "N6":  {"source":"schulen","where":{"op":"and","args":[{"op":"compare","attr":"typ","cmp":"eq","value":"primar"},{"op":"related","layer":"haltestellen","predicate":"dwithin","distance_m":400,"where":{"op":"compare","attr":"verkehrsmittel","cmp":"eq","value":"tram"}}]}},
 "N7":  {"source":"schulen","where":{"op":"related","layer":"haltestellen","predicate":"dwithin","distance_m":300,"where":{"op":"and","args":[{"op":"compare","attr":"verkehrsmittel","cmp":"eq","value":"bus"},{"op":"compare","attr":"kategorie","cmp":"eq","value":"II"}]}}},
 "N8":  {"source":"schulen","where":{"op":"compare","attr":"sekundarstufe","cmp":"eq","value":true}},
 "N9":  {"source":"haltestellen","where":{"op":"not","arg":{"op":"related","layer":"gemeinden","predicate":"within","where":{"op":"compare","attr":"name","cmp":"eq","value":"Bern"}}}},
 "N10": {"source":"strassen","where":{"op":"related","layer":"gemeinden","predicate":"intersects","where":{"op":"compare","attr":"name","cmp":"eq","value":"Köniz"}}},
 "N11": {"source":"haltestellen","where":{"op":"between","attr":"einwohner","min":1000,"max":5000}},
 "N12": {"source":"haltestellen","where":{"op":"compare","attr":"verkehrsmittel","cmp":"eq","value":"schiff"}},
 "N13": {"source":"schulen","where":{"op":"related","layer":"haltestellen","predicate":"dwithin","distance_m":1000,"where":{"op":"compare","attr":"name","cmp":"eq","value":"Bern"}}}}
```

N3, N14 und N15 haben keine Referenzabfrage: Erwartet ist `cannot_answer`.
N7 ist in der Direktabfrage nicht darstellbar; die Referenz gilt für die Kette.
</details>

---

## 10 Ergebnis der manuellen Prüfung und Verbesserungen

> Stand 2026-10-12. Lauf im Container mit dem Stand von main nach E-2, E-3,
> E-5, E-6 (Image 17:56), gemma4:12b ohne Denken, Stufe *Prüfen*. Datensätze
> #6–#34 in `model_action`; #6 und #7 stammen vom Vorabend, noch ohne
> Schema-Fix, und zählen nicht.

**Ergebnis N1–N15: 6 ✔ · 3 ≈ · 6 ✘.** Dazu die freien Fragen #8–#12:
#8 (79 ✔), #10 Ittigen ✔, #12 Riggisberg ✔, **#11 «wie viele Schulen in
Bern» ✘**: Name *enthält* «Bern» ⇒ 38 statt 27.

Bemerkenswert:

- **Vier der sechs ✘ sind Ablehnungen der Anwendung** (N2, N3, N7 zweimal).
  Das Modell bekommt die Ablehnung nie zu sehen und kann sich nicht
  korrigieren; der Anwender sieht nur eine Fehlermeldung.
- **Zwei Fehler sind still** (#11, N9): Name *enthält* statt *gleich* liefert
  eine plausible, aber falsche Zahl. Gefährlicher als eine Ablehnung, weil
  nichts darauf hinweist.
- **Die Beispiele sickern in den Verlauf** (#9): Auf «passe die Distanz auf
  100m an» bot das Modell «die Distanz in der letzten Abfrage (Spielplätze
  nahe Primarschulen)» an. Das ist Beispiel 2 aus dem Prompt.
- E-2 wirkt im Betrieb (N1: «Tram» ⇒ `tram`).

### Verbesserungen, nach Wirkung geordnet

| # | Verbesserung | Behebt | Art | Aufwand |
|---|---|---|---|---|
| V-1 | **Ein Korrekturversuch nach einer Ablehnung.** Lehnt die Anwendung die Abfrage ab (`unknown_attribute`, `wrong_value_type`, `not_representable`, `model_query_invalid`), bekommt das Modell die Ablehnung einmal zurück: «Deine Abfrage wurde abgewiesen: … Korrigiere sie oder antworte mit cannot_answer.» Der Eintrag hält beide Antworten fest; zählt als ein Aufruf mehr (Tageslimit, Zeitlimit). | N2, N3, N7 (direkt und Kette), voraussichtlich auch #25 | Code (Ablauf, Eintrag) | mittel |
| V-2 | **Namen mit «gleich», nicht «enthält».** Regel im Antwortformat: Ein Objekt mit Namen (Gemeinde, Gewässer) mit `compare eq`; `text_match contains` nur, wenn nach einem Teil des Namens gefragt ist. Dazu ein Beispiel, in dem «Altstadt» auch in «Altstadt-Nord» vorkommt. | #11, N9 (stille Fehler) | Prompt | klein |
| V-3 | **Beispiele klar vom Verlauf trennen.** Den Abschnitt «# Beispiele» einleiten mit: «Erfundene Beispiele, kein Teil des Gesprächs; der Anwender hat sie nie gestellt.» Messen, ob #9 verschwindet; sonst die Beispiele vor den Layer-Steckbrief stellen. | #9 | Prompt | klein |
| V-4 | **Linien und Flächen:** Regel «durch, entlang, quer durch ⇒ `intersects`; `within` nur, wenn das Objekt ganz in der Fläche liegen soll», mit Beispiel auf einem Linien-Layer. | N10 | Prompt | klein |
| V-5 | **Was kein Ansatz kann, ehrlich sagen.** Im Antwortformat der Direktabfrage: Attribute eines Tabellen-Layers (`kind: table`) lassen sich nicht filtern; Verknüpfen, Zusammenfassen, Zählen je Gruppe kann auch die Kette nicht ⇒ `cannot_answer` *ohne* `other_approach`. Dieselbe Regel im Format der Kette. | N3, N15, #18 | Prompt | klein |
| V-6 | **Bereiche auf Codes als Liste.** Regel: «Von … bis …» auf einem Attribut mit `codes` ⇒ `in` mit allen Codes dazwischen, in der Reihenfolge der Codeliste. | N2 | Prompt | klein |
| V-7 | **Rückfragen begrenzen.** Regel: höchstens eine Rückfrage, danach mit Annahme antworten; Optionen nur innerhalb bekannter Wertebereiche (`range`). «Stadt X» heisst Gemeinde X, keine Rückfrage. | N4, N9 | Prompt | klein |
| V-8 | **Metadaten ergänzen (Administration, kein Code):** `range` für `gemeinden.flaeche_km2` (1,3–57,3 km²) und `haltestellen.einwohner`; Beschreibungen, die `schulen.typ` («höchste Stufe») und `schulen.primarstufe` («bietet die Stufe an, auch Schulen mit Sek I») unterscheiden. | N4, N6 | Daten | klein |
| V-9 | **Argumente der Kette im Schema einschränken** (schon offen, Abschnitt 6): `where` als Bedingung, `of` als Zahl. | N7 Kette (#25), Versuch 3 aus Abschnitt 1 | Code (Schema) | mittel |
| V-10 | **Benannte Einzelobjekte** («Bahnhof Bern»): hängt an E-7. Kurzfristig eine Regel «für ein benanntes Objekt den kürzesten Namen verwenden und als Annahme nennen»; langfristig ein Werkzeug, das Namen nachschlägt. | N13 | Prompt / E-7 | klein / gross |

### Umsetzung V-2 bis V-7 (2026-10-12)

Umgesetzt in [prompt.py](../backend/src/geotandem/model/prompt.py) und
[labels.py](../backend/src/geotandem/model/labels.py); gemessen mit 33 Fällen,
Temperatur 0,3, 5 Seeds (Abschnitt 4):

| | Umsetzung | gemma4:12b | qwen3:8b |
|---|---|---|---|
| V-2 | Regel «Namen mit `eq`, nie `text_match`», mit dem Grund (Altstadt/Altstadt-Nord) | n09 0 ⇒ 5/5 | n09 0 ⇒ 5/5 |
| V-3 | Beispiele als «kein Teil des Gesprächs» eingeleitet, *und* ein Hinweis «erste Frage» (`FIRST`), wenn der Prompt auf nichts aufbaut. Die Einleitung allein wirkte nicht. Der Hinweis wirkt bei gemma4 **nur in der Nutzernachricht** (v27b: 5/5); dort verletzt er die Invariante des Sicherheitsreviews «die Nutzernachricht ist der Prompttext und nichts sonst». Gemergt ist er deshalb in der Systemnachricht (v27c), wo er bei gemma4 nicht wirkt: **E-8** | `x-ohne-kontext` v27b 0 ⇒ 5/5, v27c 0/5 | war 5/5, bleibt |
| V-4 | Regel «durch, entlang, in bei Linien ⇒ `intersects`», Beispiel auf erfundenem Linien-Layer `wanderwege` | n10 0 ⇒ 5/5 | n10 1 ⇒ 2/5 |
| V-5 | Tabellen-Layer, Verknüpfen und Zählen je Gruppe in keinem Ansatz ⇒ `cannot_answer` ohne `other_approach`; was die Kette kann. Abgegrenzt: «wie viele» ohne «je» ist kein Zählen je Gruppe | n03 0 ⇒ 5/5, n15 1 ⇒ 5/5 | n15 0 ⇒ 1/5; **log2 5 ⇒ 0/5**: qwen3 lehnt nun jede Zählfrage ab |
| V-6 | «von … bis …» auf Codes ⇒ `in`; «A oder B» auf einem Attribut ⇒ `in`, nie `and` | n02 0 ⇒ 5/5, doc2 bleibt 5/5 | n02 bleibt 5/5 |
| V-7 | höchstens eine Rückfrage; Zahlen in Optionen nur innerhalb `range`; «Stadt X» ist Gemeinde X, mit Beispiel «Stadt Seedorf» | n09 (s. V-2) | n09 (s. V-2) |
| zu E-2 | Codezuordnung ignoriert Leerzeichen, Unterstrich und Bindestrich (`sekundarstufe_i` ⇒ `sekundar`) | n08 4 ⇒ 5/5 | n08 3 ⇒ 5/5 |

Ein Test hält fest, dass jede Beispielantwort des Prompts eine gültige Antwort
ist (`test_every_example_of_the_prompt_is_a_valid_answer`); beim Schreiben
war eine Klammer verrutscht.

Vorbehalt zu qwen3: Derselbe Stand streut zwischen zwei Seed-Blöcken um 6 von
165, ganze Fälle kippen ([testplan-system-context.md](testplan-system-context.md),
2.5). Die qwen3-Spalte zeigt Richtungen; belastbar ist ein qwen3-Befund nur,
wo er über mehrere Läufe gleich bleibt (wie `log2` 0/5 in v27, v27b, v27c).

**Offen nach der Umsetzung:**

- gemma4: n06 liest «Primarschulen» als `primarstufe = true` (16 statt 7):
  V-8 (Beschreibungen in den Metadaten). n07 (zwei Filter) und n13
  («Bahnhof Bern») brauchen V-1 bzw. E-7. doc4, doc6 unverändert 0/5.
- qwen3: lehnt Zählfragen ab (log2, n01), wiederholt bei n12 die Frage als
  Rückfrage, bietet bei n15 trotz Regel die Kette an. Das sind Grenzen des
  kleineren Modells; weitere Regeln dafür würden auf qwen3 hin optimieren.
  Empfehlung bleibt E-1: gemma4:12b.

### Empfohlene Reihenfolge

1. ~~V-2 bis V-7~~ umgesetzt (oben).
   Daraus E-8, entschieden: Systemnachricht. Weiter in
   [testplan-system-context.md](testplan-system-context.md).
2. **V-8** in der Administration, ohne Code.
3. **V-1** als eigenes Arbeitspaket: Es ändert den Ablauf eines Aufrufs und
   den Eintrag (zwei Antworten, Latenz, Tageslimit) und braucht Tests über den
   ganzen Ablauf.
4. **V-9** mit der Messung der Kette (Abschnitt 7, Punkt 3).
