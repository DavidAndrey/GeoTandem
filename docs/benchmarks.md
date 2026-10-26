# Modell-Benchmarks

Vergleich lokaler Modelle über die Evals in [backend/evals](../backend/evals/README.md)
(`cases.json`, direkter Abfragepfad wie in Produktion). Die Datei wird mit jedem
neuen Lauf fortgeschrieben: neue Läufe als eigener Abschnitt unten anfügen, ältere
Abschnitte nicht überschreiben.

Für Administratoren ersetzt seit E3 der Bewertungslauf der Anwendung diese
Läufe (*Administration › Modell › Bewertung*, README *Bewertung im Einsatz*,
[plan-e3.md](plan-e3.md)): dieselben Fälle und derselbe Grader, auf Wunsch
auch auf eigenen Daten. Die Läufe hier bleiben Messungen der Entwicklung mit
dem Harness.

## Lauf 1: alle Ollama-Modelle (2026-10-12)

| | |
|---|---|
| Stand | Commit `a49f82d`, Arbeitsbaum sauber; Auswertung 2026-10-13 |
| Hardware | NVIDIA GeForce RTX 5060 Ti, 16 GB VRAM |
| Ollama | 0.34.0 im Container, `OLLAMA_CONTEXT_LENGTH=16384` |
| Fälle | 33 Fälle × 3 Seeds (1–3) = 99 Läufe je Modell |
| Parameter | Temperatur 0.3, Effort `none`; gpt-oss: Effort `low` (Reasoning nicht abschaltbar) |
| Aufruf | `uv run python evals/run.py --model <m> --label sweep-<m> --effort <e> --temperature 0.3 --repeat 3` |
| Rohdaten | `backend/evals/results/*sweep-*.jsonl` (git-ignoriert, nur lokal) |

### Ergebnis

Sortiert nach Pass.

| Modell | Quant. | Pass | Quote | Latenz Median | Latenz p90 | Gesamtdauer | GPU Ø | VRAM max | CPU-Offload |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| gemma4:12b | | **78** | 79 % | 1,1 s | 1,6 s | 139 s | 77 % | 9,9 GB | nein |
| qwen3:14b | Q4_K_M | 75 | 76 % | 2,7 s | 4,3 s | 315 s | 94 % | 12,1 GB | nein |
| gemma4:e4b | | 75 | 76 % | **0,8 s** | 1,5 s | **105 s** | 72 % | 5,7 GB | nein |
| qwen3.5:9b | Q4_K_M | 66 | 67 % | 1,5 s | 2,4 s | 177 s | 84 % | 7,5 GB | nein |
| mistral-small:22b | Q4_0 | 64 | 65 % | 6,6 s | 11,5 s | 746 s | 40 % | 14,8 GB | **ja, 11 %** |
| phi4:latest | Q4_K_M | 62 | 63 % | 2,0 s | 3,0 s | 234 s | 90 % | 12,5 GB | nein |
| gpt-oss:20b (low) | MXFP4 | 60 | 61 % | 1,7 s | 4,2 s | 532 s | 91 % | 13,3 GB | nein |
| qwen3:8b | | 56 | 57 % | 2,1 s | 3,2 s | 218 s | 91 % | 7,9 GB | nein |
| mistral-nemo:12b | Q4_0 | 52 | 53 % | 1,5 s | 1,9 s | 163 s | 86 % | 10,0 GB | nein |
| deepseek-r1:8b | Q4_K_M | 6 | 6 % | 57 s | 111 s | 6189 s | 96 % | 8,1 GB | nein |

Leere Quantisierung: von Ollama nicht erfasst, nicht nachgeprüft.

### Verdikte je Modell

Zahl der Läufe je Verdikt (Bedeutung siehe [Evals-README](../backend/evals/README.md)).
`wrong` fasst `wrong:*` zusammen.

| Modell | pass | wrong | kind | refused | error | forbidden | other_approach |
|---|---:|---:|---:|---:|---:|---:|---:|
| gemma4:12b | 78 | 9 | 6 | 3 | 0 | 3 | 0 |
| qwen3:14b | 75 | 11 | 9 | 4 | 0 | 0 | 0 |
| gemma4:e4b | 75 | 9 | 10 | 4 | 0 | 1 | 0 |
| qwen3.5:9b | 66 | 16 | 13 | 2 | 0 | 2 | 0 |
| mistral-small:22b | 64 | 13 | 12 | 7 | 0 | 3 | 0 |
| phi4:latest | 62 | 11 | 12 | 8 | 0 | 3 | 3 |
| gpt-oss:20b (low) | 60 | 4 | 18 | 5 | 11 | 1 | 0 |
| qwen3:8b | 56 | 7 | 15 | 18 | 0 | 0 | 3 |
| mistral-nemo:12b | 52 | 17 | 18 | 11 | 0 | 0 | 1 |
| deepseek-r1:8b | 6 | 0 | 93 | 0 | 0 | 0 | 0 |

### Lesart und Grenzen

- Das Rauschen liegt bei 99 Läufen und Temperatur 0.3 bei einigen Punkten. Die
  Rangfolge der Spitze (78 / 75 / 75) ist damit nicht belastbar, der Abstand zu
  den Modellen unter 66 schon.
- GPU Ø ist ein Mittel über alle Stichproben (Intervall 4 s) und enthält die
  Pausen zwischen den Läufen. Es taugt nur zum Vergleich der Modelle. Die
  niedrige Auslastung der Gemmas hängt vermutlich mit ihren kurzen Antworten
  zusammen.
- CPU-Offload folgt aus Ollamas `size` und `size_vram` (`/api/ps`) während des
  Laufs. Nur mistral-small:22b liegt nicht vollständig im VRAM.
- Die Latenz ist `latency_ms` der Modellantwort je Lauf. Gesamtdauer ist die
  Wanduhrzeit des Laufs inklusive Modell-Laden.

### Befunde

- Gemma4 führt bei Genauigkeit und Geschwindigkeit; gemma4:e4b erreicht mit
  5,7 GB VRAM dieselbe Quote wie qwen3:14b bei einem Drittel der Latenz.
- qwen3:14b ist klar besser als qwen3:8b (75 gegen 56).
- gpt-oss:20b hat als einziges Modell `error`-Fälle (11) und viele `kind`-Fälle
  (18). Ursache nicht geprüft; ein Formatproblem mit dem Schema liegt nahe.
- qwen3:8b lehnt mit 18 `refused` am häufigsten ab.
- deepseek-r1:8b antwortet in 93 von 99 Läufen mit `kind` und ist für diesen
  Pfad nicht brauchbar.

### Offen

- Ranking der Spitze mit `--repeat 10` und anderem `--seed-start` absichern.
- gpt-oss mit höherem Effort und die Ursache der `error`-Fälle prüfen.
- Andere Quantisierungen und Kontextlängen.

## Lauf 2: Phase 1 des Testplans (2026-10-13)

| | |
|---|---|
| Stand | Commit `d42f86a`, Arbeitsbaum sauber; `prompt_sha256` `55e708badb92…` für alle Läufe |
| Hardware, Ollama | wie Lauf 1 |
| Fälle | 33 Fälle × Seeds 1–5 und 6–10 = 330 Antworten je Modell |
| Parameter | Temperatur 0.3, Effort `none`; gpt-oss:20b mit `low` und `medium` |
| Aufruf | `uv run python evals/run.py --model <m> --temperature 0.3 --repeat 5 [--seed-start 6] --label p0-<m>[-s6]` |
| Neu gegenüber Lauf 1 | ministral-3:14b, granite4.2:8b, lfm2.5:8b; Tokens und Rohtext je Antwort (H-3, H-4) |

| Modell | Effort | Summe /330 | Seeds 1–5 / 6–10 | Median | Abbrüche |
|---|---|---:|---:|---:|---:|
| gemma4:12b | none | 262 | 130 / 132 | 1,4 s | 0 |
| gpt-oss:20b | medium | 260 | 134 / 126 | 4,5 s | 8 |
| gemma4:e4b | none | 252 | 126 / 126 | 0,8 s | 0 |
| qwen3:14b | none | 250 | 125 / 125 | 3,0 s | 0 |
| qwen3.5:9b | none | 225 | 112 / 113 | 1,6 s | 0 |
| ministral-3:14b | none | 225 | 107 / 118 | 2,6 s | 0 |
| phi4:latest | none | 225 | 111 / 114 | 2,1 s | 0 |
| gpt-oss:20b | low | 194 | 101 / 93 | 1,5 s | 24 |
| granite4.2:8b | none | 20 | 10 / 10 | 3,4 s | 0 |
| lfm2.5:8b | none | 8 | 5 / 3 | 0,8 s | 0 |

Befunde je Modell, die Ursache der Abbrüche von gpt-oss:20b (leere Antwort
trotz gemeldeter Tokens), die Fälle je Lauf, die Liste der Ergebnisdateien
und der Entscheid für Phase 2 (gemma4:12b, gemma4:e4b, qwen3:14b,
qwen3.5:9b) stehen in
[testplan-system-context.md](testplan-system-context.md), Abschnitt 8.1.

Zu den Fragen unter «Offen» von Lauf 1: Die Spitze ist mit 330 Antworten je
Modell abgesichert (gemma4:12b vor gemma4:e4b und qwen3:14b, Abstand 10 bis
12). Die `error`-Fälle von gpt-oss sind leere Antworten; mit `medium` sind
es 8 statt 24 von 330.

## Lauf 2: obere Referenz und fairer Vergleich (2026-10-20)

| | |
|---|---|
| Stand | Branch `p1b-external-models`, Commit `24b896e` |
| Hardware | wie Lauf 1; gpt-6-luna über api.openai.com |
| Fälle | Tuning-Satz `cases.json` (33) und Held-out-Satz `heldout.json` (38), je × 5 |
| Parameter | Temperatur 0,3, Effort `none`, P0; zwei Seed-Blöcke für «eingesetzt», einer für «nur Text» |
| Plan und Lesart | [testplan-external-models.md](testplan-external-models.md), 9 |

| Modell | Tuning, eingesetzt | Held-out, eingesetzt | Tuning, nur Text | Held-out, nur Text | Latenz Median | Kosten je 165 Fragen |
|---|---:|---:|---:|---:|---:|---:|
| gpt-6-luna | 270/330 (82 %) | **336/380 (88 %)** | 136/165 | 174/190 | 2,0 s | ≈ 0,13 USD |
| gemma4:12b | 262/330 (79 %) | 322/380 (85 %) | 123/165 | 148/190 | 1,4 s | – |
| qwen3:14b | 250/330 (76 %) | 293/380 (77 %) | 115/165 | 130/190 | 2,8 s | – |
| gemma4:e4b | 252/330 (76 %) | 287/380 (76 %) | 89/165 | 104/190 | 0,8 s | – |

Luna und gemma4:12b unterscheiden sich nicht belegbar (Held-out −3,7
Prozentpunkte für gemma4, 95 %: −15,8 … +7,6). Ohne eingeschränkte Ausgabe
verlieren die lokalen Modelle 7 bis 38 Antworten, Luna keine.

## Lauf 3: Claude Sonnet 5.5 und Haiku 5.5 (2026-10-21)

Branch `p1b-claude`; über Anthropics OpenAI-Kompatibilität, nur Text (X-8),
Temperatur 1. Tuning-Läufe aller Modelle mit `evals/regrade.py` gegen die
berichtigten Fälle (`doc1`, `n06`: `gold_any`) neu bewertet, darum weichen
die Zahlen von Lauf 2 ab. Lesart: [testplan-external-models.md](testplan-external-models.md), 9.2.

| Modell | Tuning | Held-out | Latenz Median | Kosten je Frage |
|---|---:|---:|---:|---:|
| claude-haiku-5-5 | 318/330 (96 %) | 374/380 (98 %) | 3,2 s | ≈ 0,0013 USD |
| claude-sonnet-5-5 (1 Block) | 158/165 (96 %) | 185/190 (97 %) | 2,5 s | ≈ 0,024 USD |
| gpt-6-luna | 280/330 (85 %) | 336/380 (88 %) | 2,0 s | ≈ 0,0008 USD |
| gemma4:12b | 272/330 (82 %) | 322/380 (85 %) | 1,4 s | lokal |
| gemma4:e4b | 252/330 (76 %) | 287/380 (76 %) | 0,8 s | lokal |
| qwen3:14b | 250/330 (76 %) | 293/380 (77 %) | 2,8 s | lokal |
| qwen3.5:9b | 225/330 (68 %) | 270/380 (71 %) | 1,6 s | lokal |

Sonnet mit X-10 neu bewertet (Text nach dem JSON-Objekt). Externe Referenzen für
weitere Läufe: claude-haiku-5-5 und gpt-6-luna (X-11).

## Lauf 4: Platzierung, Phase 2 und 3 (2026-10-22/23)

Zehn Varianten der Platzierung (P1–P6, P8, P9; P7 zu E-7 zurückgestellt) auf
den vier lokalen Hauptmodellen und den zwei externen Referenzen, Tuning-Satz;
der einzige Kandidat P9 danach mit Seeds 6–10 und auf dem Held-out-Satz.
Einzelheiten: [testplan-system-context.md](testplan-system-context.md), 8.2
und 8.4.

**Ergebnis:** keine Variante schlägt P0 für alle vier lokalen Modelle. P0 bleibt
die Grundlinie des gemeinsamen Prompts; die Zahlen von Lauf 3 gelten weiter.
Die besten Varianten sind je Modell verschieden (P5 für gemma4:12b, P6 mit 12
Beispielen und P9 für Luna: Held-out 336 ⇒ 361/380). Nebenbei behoben: eine
Ordnung auf einem Ja/Nein-Attribut war ein 500 statt `wrong_value_type`.

## Lauf 5: Metadaten des Steckbriefs, Phase 4 (2026-10-23)

Branch `p4-ablation`; P0 mit weniger Metadaten (`--profile`), sechs Modelle,
Tuning-Satz, je zwei Blöcke (/330). Einzelheiten:
[testplan-system-context.md](testplan-system-context.md), 8.5.

| Modell | P0 | ohne Beschreibungen | ohne Beschriftungen | ohne Codelisten | schlichter Import | Import, Codelisten bestätigt |
|---|---:|---:|---:|---:|---:|---:|
| claude-haiku-5-5 | 318 | 316 | 315 | 252 | 249 | 309 |
| gpt-6-luna | 280 | 276 | 270 | 201 | 183 | 262 |
| gemma4:12b | 272 | 249 | 233 | 189 | 142 | 212 |
| gemma4:e4b | 252 | 264 | 242 | 184 | 157 | 211 |
| qwen3:14b | 250 | 261 | 219 | 177 | 151 | 222 |
| qwen3.5:9b | 225 | 220 | 199 | 154 | 163 | 201 |

**Ergebnis:** Die Codelisten tragen bei allen Modellen am meisten; ein
schlichter Import kostet mehr als der Wechsel des Modells. Die bestätigte
Codeliste des Imports bringt Haiku und Luna fast auf P0, den lokalen Modellen
fehlen danach die Beschriftungen.

## Lauf 6: Werkzeugkette, Phase-1-Basislauf (2026-10-25/26)

Branch `chain-eval`, Commit `4210963`; [plan-chain-eval.md](plan-chain-eval.md),
Phase 1.

Die Werkzeugkette läuft mit `--approach chain`, so wie die Anwendung sie auf
*Automatisch* fährt. Die Direktabfrage läuft als Kontrolle auf denselben vier
Sätzen:
- A: der Startsatz, Tuning und Bestätigung;
- B: die kettentypischen Fälle aus `chain-cases.json` (`kb*`);
- C: die Belastungsfälle aus `chain-cases.json` (`ks*`).

Temperatur 0.3, Effort `none`, `--repeat 5`, zwei Blöcke (Seeds 1–5 und
6–10); Hardware wie Lauf 1. Luna fehlt, weil in der Sitzung kein Schlüssel
gesetzt war. Rohdaten: `backend/evals/results/*-b1-*.jsonl`; ausgewertet mit
`evals/chain_report.py` und `evals/compare.py`.

### Bestehensquote (Kette / direkt, beide Blöcke)

| Modell | A Tuning | A Bestätigung | B Tuning | B Bestätigung | C Tuning | C Bestätigung |
|---|---|---|---|---|---|---|
| gemma4:e4b | 32 % / 78 % | 26 % / 78 % | 3 % / 61 % | 0 % / 62 % | 0 % / 38 % | 6 % / 40 % |
| gemma4:12b | 41 % / 82 % | 41 % / 86 % | 14 % / 64 % | 8 % / 77 % | 8 % / 48 % | 10 % / 39 % |
| qwen3:14b | 45 % / 73 % | 49 % / 77 % | 12 % / 54 % | 6 % / 58 % | 10 % / 22 % | 0 % / 43 % |

Gepaart je Fall, Kette minus direkt, auf den Bestätigungsfällen:

| Modell | A | B |
|---|---:|---:|
| gemma4:e4b | −56 Punkte | −62 Punkte |
| gemma4:12b | −50 Punkte | −69 Punkte |
| qwen3:14b | −32 Punkte | −52 Punkte |

- Jedes Intervall liegt unter null. Besser als die Direktabfrage ist die
  Kette in zwei Fällen, beide bei gemma4:12b (einer in A, einer in B).
- Von den Antworten, die die Direktabfrage auf Bestätigungsfällen verfehlt,
  holt die Kette 0 % (e4b), 4 % (12b) und 2 % (qwen3:14b).
- Rauschen zwischen den Blöcken: Kette +3,6 / +2,9 / +0,9 Punkte, direkt
  +2,5 / +0,2 / −1,9 Punkte (e4b / 12b / qwen3:14b).

### Verhalten (alle Sätze, beide Blöcke)

| | Kette e4b | direkt e4b | Kette 12b | direkt 12b | Kette qwen3:14b | direkt qwen3:14b |
|---|---|---|---|---|---|---|
| pass | 19 % | 70 % | 29 % | 76 % | 32 % | 66 % |
| still falsch | 1 % | 6 % | 2 % | 8 % | 0 % | 16 % |
| erster Aufruf ein Plan | 72 % | – | 83 % | – | 86 % | – |
| davon Plan angenommen | 19 % | – | 33 % | – | 40 % | – |
| Kette lief zu Ende | 149 | – | 291 | – | 373 | – |
| davon pass / still falsch | 83 % / 6 % | – | 81 % / 6 % | – | 76 % / 1 % | – |
| mit Re-Plan | 0 % | – | 1 % | – | 1 % | – |
| Latenz Median | 1,5 s | 0,9 s | 3,3 s | 1,3 s | 7,4 s | 3,4 s |
| s je richtige Antwort | 9,8 | 1,5 | 11,8 | 1,8 | 23,1 | 5,7 |
| Tokens je richtige Antwort | 29 500 | 8 200 | 19 100 | 7 400 | 17 500 | 9 000 |

Abgewiesene Pläne, nach dem ersten Fehler (1843 über alle drei Modelle):

| Fehler | Pläne |
|---|---:|
| Schrittnummer als Text | 448 |
| `where` ohne lesbare Bedingung (`$ref`, `$op` oder verschachteltes `where`) | 353 |
| `layer` und `of` zugleich, oder keins von beiden | 260 |
| Verweis auf keinen früheren Schritt | 122 |
| erfundener `text_match`-Modus | 99 |
| `not_representable` | 116 |

Der Rest sind weitere Schemafehler.

Ohne Plan beim ersten Aufruf fragt gemma4:e4b oft zurück: 212 Rückfragen,
wo eine Abfrage fällig war. qwen3:14b hat 6 Zeitüberschreitungen
(`llm_timeout`).

**Ergebnis:** Die Kette scheitert am Format, nicht am Denken.

- **Format:** Zwei Drittel bis vier Fünftel der Pläne werden schon bei der
  Prüfung abgewiesen, weil die Argumente der Schritte nicht dem Schema der
  Werkzeuge folgen. Die erzwungene Ausgabe der Kette lässt `arguments` frei
  (plan-chain-eval, F6), die der Direktabfrage nicht.
- **Inhalt:** Eine Kette, die angenommen wird und zu Ende läuft, besteht zu
  76–83 % und ist seltener still falsch als die Direktabfrage.
- **Re-Plans:** Ein abgewiesener Plan bekommt keinen Re-Plan. Re-Plans kommen
  deshalb kaum vor (1 %) und retten keinen Fall.
- **Regel:** Nach der Regel aus plan-chain-eval 8 ist auf diesem Stand jedes
  der drei Modelle *nicht empfohlen*, weil weniger als 50 % der ersten Pläne
  angenommen werden. Das ist ein Befund über die ausgelieferte Kette, nicht
  über die Modelle.
