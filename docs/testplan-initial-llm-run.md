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

**Die 17 Fälle** ([cases.json](../backend/evals/cases.json)):

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
`sekundarstufe = true`. Das ist eine vertretbare Lesart, die der Fall heute
als falsch zählt ([7](#7-nächste-schritte), Punkt 2).

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
| E-5 | **Abgeschnittene Antwort melden** | `model_unreadable` wie heute · eigener Code (z. B. `llm_truncated`) aus `finish_reason: length` | eigener Code, damit Administratoren Kontext oder Denken anpassen | – |
| E-6 | **„Wie viele“-Fragen** | wie heute · Regel im Antwortformat: die Objekte liefern, die Anwendung zeigt die Anzahl | Regel ergänzen | `log2` |
| E-7 | **Werte im Steckbrief** (z. B. Gemeindenamen) | nur Metadaten (S3, heute) · kurze Wertelisten für kleine Textfelder · Werkzeug zum Nachschlagen in der Kette | erst messen: Mit dem Fix schreibt das Modell „Bern“, „Köniz“ richtig über den Namen | `log2`, `doc1`, `in-gemeinde-bahn` |

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
   Frage pro Fehlerart aus Abschnitt 5. Fälle mit zwei vertretbaren Lesarten
   (doc4: `typ = "sekundar"` oder `sekundarstufe = true`) erhalten mehrere
   Referenzabfragen.
3. **Die Kette messen:** `evals/run.py` um `--approach chain` erweitern
   (Plan prüfen, Schritte ausführen, Ergebnis-IDs vergleichen); vorher das
   `where` der Schritte im Schema einschränken.
4. **Folgefragen messen**, sobald WP81 die aktuelle Analyse mitschickt: Fälle
   mit zwei Zügen.
5. **Als Ritual:** Vor jeder Änderung an Prompt, Schema, Steckbrief oder
   Modell ein Lauf mit neuem Label; das Ergebnis kommt in die Tabelle in
   Abschnitt 4.

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
