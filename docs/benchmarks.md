# Modell-Benchmarks

Vergleich lokaler Modelle über die Evals in [backend/evals](../backend/evals/README.md)
(`cases.json`, direkter Abfragepfad wie in Produktion). Die Datei wird mit jedem
neuen Lauf fortgeschrieben: neue Läufe als eigener Abschnitt unten anfügen, ältere
Abschnitte nicht überschreiben.

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
