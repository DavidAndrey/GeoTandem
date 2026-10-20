# Testplan: externe Modelle als obere Referenz (Phase 1b)

> Stand: 2026-10-20 · Ausgangsstand main `d42f86a` (H-1 bis H-5) ·
> Beispieldaten `bern-mittelland-2026-10-03` · Einordnung: Phase 1b von
> [testplan-system-context.md](testplan-system-context.md), zwischen Modellwahl
> (Phase 1) und Platzierung (Phase 2) · Messung: [backend/evals/](../backend/evals/README.md)

Ein Zwischenlauf mit je einem Modell von Anthropic und OpenAI, begonnen mit
**OpenAI `gpt-6-luna`**. Er beantwortet zwei Fragen:

1. **Obere Referenz.** Welche Fälle, die gemma4:12b und qwen3:8b verfehlen,
   löst ein Spitzenmodell? Was auch dieses verfehlt, liegt eher am Fall, an
   der Referenzabfrage, am Schema oder an einer Regel des Prompts als am
   Modell. Solche Fälle werden bereinigt, *bevor* Phase 2 Varianten an ihnen
   misst.
2. **Nutzbarkeit.** Lassen sich beide Anbieter über die bestehende
   Anbindung (`openai_compat`, F-7.2) in der Anwendung betreiben:
   Verbindungstest, Direktabfrage, Werkzeugkette, Kennzeichnung (C7)?

---

## 0 Wo dieser Lauf steht

Die Dokumente nummerieren nach mehreren Schemata nebeneinander:

| Kürzel | Bedeutung | Quelle |
|---|---|---|
| E1.x, E2.x … | Etappen und Pakete der Roadmap | [etappen.md](../etappen.md) |
| E-1 … E-8 | *Entscheide* aus dem ersten Modelllauf (nicht Etappen) | [testplan-initial-llm-run.md](testplan-initial-llm-run.md), 6 |
| V-1 … V-10 | Verbesserungen aus der manuellen Prüfung | ebd., 10 |
| Phase 1–3 | Ablauf des Testplans Systemprompt und Kontext | [testplan-system-context.md](testplan-system-context.md), 7 |
| P0 … P9, H-1 … H-5 | Varianten der Platzierung, Erweiterungen des Harness | ebd., 5 und 6 |
| Lauf 1, 2 … | fortgeschriebene Benchmarks | [benchmarks.md](benchmarks.md) |

Stand heute: **Phase 1** ist mit Lauf 1 (zehn Ollama-Modelle) und den
Seed-Blöcken von gemma4 und qwen3 erledigt; **Phase 2** hat ihren Harness
(H-1 bis H-5), aber noch keinen Variantenlauf. Dieser Plan fügt **Phase 1b**
dazwischen ein. Seine Erweiterungen heissen **H-6 …**, seine Entscheide
**X-1 …** (X für extern, ohne Verwechslung mit den Etappen E).

---

## 1 Rahmen

- **Freigabe (Testplan-Abschnitt 4, C6).** Der Steckbrief verlässt das Haus,
  Geodaten-Inhalte nicht. Freigegeben ist nur für die **Beispieldaten**, nie
  für ein echtes Konto (Entscheid X-1, 2026-10-20). In der Anwendung bleibt
  *darf Inhalte erhalten* aus.
- **Art der Anbindung.** OpenAI unterscheidet für Agenten Agents API (OpenAI
  führt die Schleife), Agents SDK (Schleife in der Anwendung, mit SDK) und
  Responses API (direkte Modellaufrufe, Verlauf selbst geführt). GeoTandem
  entspricht der dritten Art, nur über `v1/chat/completions` statt
  `v1/responses`: Die Werkzeugkette (E2.5) ist die eigene Schleife, der
  Verlauf liegt im eigenen Eintrag, und es gibt keinen Zustand beim Anbieter.
  Das bleibt so; ein Wechsel auf Responses oder das SDK widerspräche
  tech-stack 3.5 (ein Adapter, alle Anbieter) und ist für diese Phase nicht
  nötig, weil `gpt-6-luna` Chat Completions unterstützt.
- **Schlüssel** nur aus der Umgebung, nie in einer Datei des Repos, nie in
  `results/*.jsonl` und nie im Laufkopf.
- **Budget:** höchstens 30 USD für die ganze Phase (Abschnitt 6).
- **F-9.1 bleibt unberührt.** `test_offline.py` prüft die Anwendung ohne
  externe Anbindung; der Harness ist nicht Teil von `make gate`.
- **Vergleich mit Vorbehalt.** Externe Modelle laufen mit Temperatur 1 und
  ohne wirksamen Seed (Abschnitt 2). Ihre Summe ist eine Obergrenze, kein
  Messwert auf derselben Skala wie die lokalen Läufe mit 0,3.

---

## 2 Bekannte Unterschiede der Anbieter

Abgeglichen mit dem Code (`llm/openai_compat.py`, `evals/run.py`) und mit
Anthropics Dokumentation zur OpenAI-Kompatibilität
(`platform.claude.com/docs/en/api/openai-sdk`, Stand 2026-10-13). Was dort
nicht steht, prüft der Rauchtest (Schritt 1); in der Spalte steht dann «?».

| Was der Adapter sendet | Anthropic (Kompatibilität) | OpenAI | Folge für den Lauf |
|---|---|---|---|
| `temperature` (immer, Vorgabe 0) | Claude 4.7 und später: **jeder Wert unter 1 ⇒ 400** | GPT-5.x: vermutlich nur 1 bzw. nur ohne Denken ? | `--temperature 1`; in der Anwendung Temperatur 1 in der Anbindung |
| `seed` (immer) | ignoriert | ? | Wiederholungen sind unabhängige Stichproben, Seed-Blöcke reproduzieren nichts |
| `reasoning_effort` (ausser `default`) | **ignoriert**; Claude 5.x denkt immer, Opus 5.5 mit Effort `medium` | `gpt-6-luna`: `none` … `max`, Vorgabe `medium`; **Werkzeugaufrufe über Chat Completions nur mit `none`** | Anthropic `--effort default`; Luna `none` (Hauptlauf), `low` als Vergleich nur für die Direktabfrage; die Anbindung in der Anwendung braucht `none`, sonst bricht die Werkzeugkette |
| `response_format: json_schema` (ohne `strict`) | **ignoriert**: das Schema wirkt nur als Text im Prompt | `gpt-6-luna`: Structured Outputs unterstützt; ohne `strict: true` keine Garantie ? | Anteil `model_unreadable` getrennt ausweisen; P8 ist bei Anthropic sinnlos |
| mehrere `system`-Nachrichten | zu einer zusammengezogen und vorangestellt | getrennt | P9 entspricht bei Anthropic P0 |
| `tools` | unterstützt, `strict` ignoriert | unterstützt | Verbindungstest `tool_call` sollte grün sein |
| Header (Allowlist + `Authorization: Bearer`) | Bearer wird angenommen; `anthropic-workspace-id` würde gestrichen | Bearer | Anthropic: einen **Schlüssel für genau einen Workspace** verwenden |
| API-Schlüssel | – | – | der Harness setzt ihn mit `--api-key-env` (H-6) |
| Prompt-Caching | nicht über die Kompatibilität | automatisch | nur Kosten, nicht das Ergebnis |

Folgerung: Für den Lauf genügt **eine** Änderung am Harness (H-6). Die
Anwendung kommt ohne Änderung aus, solange die Anbindung eine Temperatur
trägt, die der Anbieter annimmt (Claude: 1; Luna: Rauchtest), und bei Luna
Effort `none`.

---

## 3 Erweiterungen im Harness

| # | Erweiterung | für |
|---|---|---|
| H-6 | `--api-key-env NAME`: den Schlüssel aus der Umgebungsvariable `NAME` in `Endpoint.api_key`; der Laufkopf nennt den Host von `--url` und den Namen der Variable, nie den Wert | beide Anbieter |
| H-7 | Laufkopf um `host` ergänzen; `compare.py` zeigt zusätzlich die Zahl `error:*` je Lauf | Auswertung |

**Stand 2026-10-20: H-6 und H-7 umgesetzt.** Der Laufkopf nennt `host` und
`api_key_env` (den Namen, nicht den Wert); die Ergebnisdateien enthalten den
Schlüssel nie, weil `cause` keine Antwortkörper und keine Header trägt (C13).

Kein eigener Adapter für Anthropic: [tech-stack.md](../tech-stack.md) 3.5
legt `openai_compat` als einzigen Adapter fest. Ob die ignorierte
eingeschränkte Ausgabe das Ergebnis drückt, zeigt der Lauf (X-3).

---

## 4 Modelle

Die Namen werden im Rauchtest über `/v1/models` des Anbieters bestätigt, nicht
aus diesem Dokument übernommen.

| Anbieter | Modell | Rolle | Effort |
|---|---|---|---|
| Anthropic | `claude-sonnet-5-5` | Hauptlauf | `default` (nicht steuerbar) |
| Anthropic | `claude-opus-5-5` | Obergrenze, wenn Sonnet Fälle verfehlt | `default` |
| OpenAI | `gpt-6-luna` | **erster Hauptlauf** | `none`, dann `low` |
| OpenAI | grösseres Modell der GPT-6-Reihe | nur wenn Luna Fälle verfehlt, die gemma4 löst | `none` |

---

## 5 Ablauf

1. **Vorbereitung.** X-1 festhalten. Schlüssel als `ANTHROPIC_API_KEY` und
   `OPENAI_API_KEY` in der Shell. H-6 und H-7 umsetzen; nach dem ersten Lauf
   prüfen, dass der Schlüssel in keiner Ergebnisdatei steht.
2. **Rauchtest je Anbieter** (drei Fälle, ein Seed, wenige Cent):
   ```sh
   uv run python evals/run.py --url https://api.openai.com/v1 \
     --api-key-env OPENAI_API_KEY --model gpt-6-luna \
     --effort none --temperature 0.3 --repeat 1 \
     --only log1-haltestellen-nahe-schulen,doc2-gut-erschlossen,x-ohne-kontext --label x-smoke-luna
   uv run python evals/run.py --url https://api.anthropic.com/v1 \
     --api-key-env ANTHROPIC_API_KEY --model claude-sonnet-5-5 \
     --effort default --temperature 1 --repeat 1 \
     --only log1-haltestellen-nahe-schulen,doc2-gut-erschlossen,x-ohne-kontext --label x-smoke-sonnet
   ```
   Klärt die «?» aus Abschnitt 2: Welche Parameter führen zu 400
   (`llm_rejected`)? Kommt das JSON ohne Code-Zaun (sonst `model_unreadable`)?
   Kosten je Aufruf aus `prompt_tokens`/`completion_tokens`. Bei OpenAI
   zusätzlich `--temperature 0.3`, um zu sehen, ob es angenommen wird.
3. **Verbindungstest in der Anwendung** je Anbieter: Anbindung anlegen
   (Temperatur 1, Effort wie in 4, *darf Inhalte erhalten* aus), Test unter
   *Administration*. Erwartet: `reachable`, `authorised`, `model`,
   `json_schema`, `tool_call` grün; das Kennzeichen «extern · ‹Host›» im
   Arbeitsplatz (C7). Abweichungen werden notiert, nicht behoben.
4. **P0-Lauf** je Hauptmodell: 33 Fälle × 5 Wiederholungen, Label
   `x-p0-<modell>`. Opus 5.5 nur, wenn Sonnet weniger als 155/165 erreicht.
5. **Auswertung** mit `compare.py --changed x-p0-sonnet p0-gemma4 p0-qwen3 …`.
   Jeder Fall unter 5/5 bei einem externen Modell wird gelesen und einer
   Klasse zugeordnet:
   | Klasse | Kennzeichen | Folge |
   |---|---|---|
   | **Fall** | beide externen Modelle verfehlen ihn, mit derselben vertretbaren Lesart | Referenzabfrage, `also` oder Wortlaut anpassen; als Änderung an `cases.json` begründen |
   | **Regel** | die Antwort folgt einer Regel oder einem Beispiel des Prompts wörtlich | Kandidat für Phase 2 (P1, P4) |
   | **Schema/Anwendung** | `refused:*` oder `model_unreadable` bei gültiger Absicht | Befund für die Anwendung, nicht für den Prompt |
   | **Modell lokal** | extern 5/5, lokal unter 5/5 | bleibt Gegenstand von Phase 2 |
6. **Anwendung von Hand:** 5 der 15 Fragen aus testplan-initial-llm-run,
   Abschnitt 9, je Anbieter als Direktabfrage und als Werkzeugkette
   (E2.5), Stufe *Prüfen*. Festgehalten: Ergebnis, Antwortzeit, Fehlercodes.
7. **Ergebnis** in [benchmarks.md](benchmarks.md) als *Lauf 2* und in
   Abschnitt 7 unten; bereinigte Fälle mit neuem Lauf von `p0-gemma4` und
   `p0-qwen3`, damit Phase 2 auf der neuen Grundlinie startet.

---

## 6 Kosten

Ein P0-Lauf: 165 Aufrufe × gut 5 000 Tokens Eingabe ≈ 0,9 M Eingabe; die
Ausgabe ist klein, Denken kommt aber hinzu (bei Claude nicht abschaltbar).

| Modell | Preis Eingabe / Ausgabe je 1 M | Lauf (Schätzung) |
|---|---:|---:|
| claude-sonnet-5-5 | 2 / 10 USD | 2–4 USD |
| claude-opus-5-5 | 4 / 20 USD | 4–8 USD |
| gpt-6-luna | 0,10 / 0,50 USD | **etwa 0,10–0,20 USD** |

Rauchtests, zwei Hauptläufe, ein Opus-Lauf und die Prüfung von Hand liegen
zusammen unter 30 USD. Die tatsächlichen Tokens stehen nach dem Lauf in jeder
Antwort (H-3).

---

## 7 Offene Entscheide

| # | Entscheid | Empfehlung |
|---|---|---|
| X-1 | **Freigabe**: Steckbrief der Beispieldaten an Anthropic und OpenAI — *entschieden 2026-10-20* | ja, nur Beispieldaten, nur für diese Phase; *darf Inhalte erhalten* bleibt aus |
| X-2 | **Temperatur in der Anbindung**: Claude 5.x lehnt jeden Wert unter 1 ab, die Vorgabe ist 0 | vorerst 1 von Hand eintragen; falls der Rauchtest das auch für OpenAI zeigt: Vorgabe 1 für externe Anbindungen oder eine Option «nicht senden» (ändert C4) |
| X-3 | **Eingeschränkte Ausgabe bei Anthropic**: ignoriert, das Schema wirkt nur als Text | nach dem Lauf: nichts tun, solange `model_unreadable` unter 2 % liegt; sonst einen nativen Adapter abwägen (ändert tech-stack 3.5) |
| X-4 | **`strict: true` für OpenAI** | nur wenn der Lauf Antworten ausserhalb des Schemas zeigt; vorher prüfen, ob das Antwortschema die strikte Teilmenge erfüllt |
| X-5 | **Erschöpftes Guthaben erkennen** (8.1) — *umgesetzt 2026-10-20* | `type` und `code` des Fehlerkörpers gegen `QUOTA_CODES`; Code `llm_quota_exhausted`, keine Wiederholung, im Arbeitsplatz «Grenzwert erreicht» mit Hinweis an die Administration; C9 und C13 ergänzt ([plan-e2.0-e2.2.md](plan-e2.0-e2.2.md)), Sicherheitsreview nachgeführt |
| X-6 | **Antwortschema verpacken** (8.1) — *umgesetzt 2026-10-20* | im Adapter nur als Rückfallebene, wenn der Anbieter das Schema mit `param: response_format` abweist; für alle Anbieter verpackt kostete gemma4 −15/330 (Regel 3.5 des Kontext-Testplans: nicht übernommen) |
| X-7 | **Antwort in einem Code-Zaun** — *umgesetzt 2026-10-20* | `parse_answer` nimmt genau einen ```` ```json ```` -Zaun um das Objekt ab; ohne eingeschränkte Ausgabe schreiben gemma4 (und vermutlich Claude) ihn fast immer. Text um den Zaun bleibt `model_unreadable` |

---

## 8 Ergebnisse

### 8.1 Rauchtest

| Anbieter | Modell | angenommene Parameter | abgelehnt | JSON lesbar | Kosten je Aufruf |
|---|---|---|---|---|---:|
| Anthropic | | | | | |
| OpenAI | | | | | |

**2026-10-20, `gpt-6-luna`, erster Versuch (`x-smoke-luna`):** 0/3, jede
Antwort `error:llm_rate_limited` nach zwei Wiederholungen. Ursache laut
Antwortkörper (von Hand gelesen): `insufficient_quota` /
`credit_balance_exhausted`, das Konto hat kein Guthaben. Der Schlüssel ist
gültig: Im Verbindungstest sind `reachable` (127 Modelle), `authorised` und
`model` grün, `json_schema` scheitert mit HTTP 429. Der Schlüssel steht in
keiner Ergebnisdatei. Weiter, sobald Guthaben geladen ist.

**2026-10-20, nach dem Aufladen:** Verbindungstest der Anwendung **grün**
(alle Schritte, `json_schema` 3,8 s, `tool_call` 4,1 s; Temperatur 0,3,
Effort `none`). Der Rauchtest dagegen 0/3 mit `llm_rejected`, mit Temperatur
0,3 wie 1: OpenAI weist das Antwortschema ab, «schema must have type 'object'
and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level».
Das Antwortschema der Direktabfrage ist eine `oneOf`-Vereinigung der
Antwortarten; Ollama nimmt sie an, OpenAI nicht. Der Verbindungstest prüft nur
ein schlichtes Objekt und merkte es deshalb nicht.

**Behoben mit X-6** (Adapter): Ein Schema, dessen Wurzel kein schlichtes
Objekt ist, geht zuerst unverändert hinaus. Weist der Anbieter es mit 400 und
`param: response_format` ab, fragt der Adapter einmal neu mit
`{"answer": …}` (`$defs` an der Wurzel) und verpackt für diese Adresse und
dieses Modell von da an immer; die Antwort wird ausgepackt. Eine nicht
verpackte Antwort (Anthropic wertet `response_format` nicht aus) gilt wie
bisher. Die erste Fassung verpackte für alle Anbieter und kostete gemma4
15 von 330 Antworten (8.2); Ollama erhält deshalb dieselbe Anfrage wie vorher.
Rauchtest mit der Rückfallebene: 3/3 (`x-smoke-luna-fallback`).

| Anbieter | Modell | angenommene Parameter | abgelehnt | JSON lesbar | Kosten je Aufruf |
|---|---|---|---|---|---:|
| OpenAI | `gpt-6-luna` | `temperature` 0,3 und 1, `seed`, `reasoning_effort: none`, `json_schema` (verpackt), `tools` | `json_schema` mit `oneOf` an der Wurzel | ja, 165/165 | ≈ 0,0008 USD (7 400 Tokens Eingabe, 100 Ausgabe) |

**Befund für die Anwendung (X-5):** OpenAI meldet ein erschöpftes Guthaben
als 429. Der Adapter liest den Antwortkörper nicht (C13), nennt es deshalb
«The endpoint limits requests» und wiederholt zweimal ohne Aussicht. Eine
Administratorin sucht so am falschen Ort. Vorschlag: aus dem Fehlerkörper nur
das Feld `error.code` lesen und gegen eine feste Liste prüfen (z. B.
`insufficient_quota` ⇒ eigener Code `llm_quota_exhausted`, keine
Wiederholung); kein Text des Körpers gelangt nach aussen.

### 8.2 P0

| Modell | Bestanden | `model_unreadable` | übrige `error:*` | Antwortzeit (Median) | Kosten |
|---|---:|---:|---:|---:|---:|
| gemma4:12b (Referenz, T 0,3, Seeds 1–5 / 6–10) | 130 / 132 | 0 | 0 | 1,1 s | – |
| gemma4:12b, Schema immer verpackt (erste Fassung X-6, **verworfen**) | 126 / 121 | 0 | 0 | 1,5 s | – |
| qwen3:14b (T 0,3) | 125/165 | 0 | 0 | | – |
| **gpt-6-luna** (`none`, T 0,3) | **136/165** | 0 | 0 | 2,1 s | ≈ 0,13 USD |
| claude-sonnet-5-5 | | | | | |

Luna liest im Mittel 7 438 Tokens Eingabe gegen 5 573 bei gemma4: derselbe
Prompt, ein anderer Tokenizer.

### 8.3 Fälle nach Klasse

| Fall | gemma4:12b | qwen3:14b | Luna | Klasse | Befund | Folge |
|---|---:|---:|---:|---|---|---|
| `n13-bahnhof-bern` | 0/5 | 0/5 | 0/5 | **Anwendung** | alle schreiben `name = "Bahnhof Bern"`, die Haltestelle heisst «Bern» | kein Modell kann den Wert aus Metadaten wissen: E-7 (Werte im Steckbrief) |
| `n07-zwei-filter` | 0/5 | 0/5 | 0/5 | **Schema** | alle schreiben zwei Bedingungen auf den Bezugslayer, obwohl die Regel eine einzige verlangt; die Anwendung weist sie als `not_representable` ab | die Grenze ins Schema der Direktabfrage (`_controls_only`), statt sie nur zu sagen; die Abweisung als Netz wirkt |
| `doc1-primar-koeniz` | 5/5 | 5/5 | 0/5 | **Fall** | Luna liest «Primarschulen» als `primarstufe = true` (8 statt 4), zudem dreimal `contains` statt `within` | zweite Referenzabfrage `primarstufe = true` prüfen (testplan-initial-llm-run 7.2); `contains` ist falsch |
| `doc4-ohne-sek` | 0/5 | 5/5 | 2/5 | **Regel** | «In welchen Gemeinden …» gilt als Zählen je Gruppe: `cannot_answer` mit Verweis auf «Verknüpfen und Zusammenfassen» | die Regel «je Gemeinde» schärfer abgrenzen; Kandidat für Phase 2 |
| `doc6-verschachtelt`, `n06-primar-tram`, `x-ohne-kontext` | 0/5 | 2, 0, 3 | 2, 3, 5 | Modell lokal | Luna löst sie (teilweise) | bleibt Gegenstand von Phase 2 |

### 8.4 Anwendung

| Anbieter | Verbindungstest | Direktabfrage (5) | Werkzeugkette (5) | Bemerkungen |
|---|---|---|---|---|

---

## 9 Fairer Vergleich und Held-out-Fragen

Der erste Vergleich (8.2) war in fünf Punkten schief. So wird er gerade gestellt:

| Schieflage | Massnahme |
|---|---|
| Luna 165, die lokalen Modelle 330 Antworten | zweiter Block für Luna (`x-p0-luna-s6`) |
| Ausgabe verschieden erzwungen: Grammatik (Ollama), verpackt (Luna), gar nicht (Claude) | zusätzlich eine gemeinsame Bedingung **nur Text** (`--no-format`, H-8) neben «wie eingesetzt» |
| Prompt an gemma4 und qwen3 abgestimmt (V-2 bis V-7 aus ihren Fehlern) | **Held-out-Satz** [heldout.json](../backend/evals/heldout.json): 38 Fragen, an denen nie abgestimmt wird |
| vertretbare Lesart als falsch bewertet (`doc1`) | `gold_any`: mehrere Referenzabfragen, jede gilt |
| Summe ohne Streuung; fünf Antworten eines Falls sind nicht unabhängig | `compare.py --stats`: je Fall gepaart, besser/schlechter/gleich, mittlerer Unterschied mit Bootstrap-Intervall über die Fälle, Vorzeichentest; `--by-tag` je Fähigkeit |

**Befund vorweg (Tuning-Satz, P0, je zwei Blöcke gegen gemma4:12b):** kein
Unterschied ist belegt. Luna +3,0 Prozentpunkte (95 %: −7,9 … +13,6, ein
Block), gemma4:e4b −3,0, qwen3:14b −3,6; nur 9 der 33 Fälle unterscheiden
sich überhaupt. 15 Fälle bestehen alle Modelle.

**Held-out-Satz** (Entwurf 2026-10-20, zur Durchsicht): 30 Abfragen und 8
Verhaltensfälle (Rückfrage, Kette, Puffer, Löschen, Injektion, unbekannter
Layer, Tabelle, Zählen je Gruppe). Jede Referenzabfrage ist gegen die
Beispieldaten und die Prüfung der Direktabfrage gelaufen, und eine
naheliegende falsche Lesart liefert andere Objekte (`h14` musste dafür
umformuliert werden: Mit nur einer französischsprachigen Schule unterschied
die Klammerung nichts). Drei Fälle fragen dasselbe in drei Wortlauten
(`paraphrase:muensingen`), zwei in Englisch und Mundart (`language`).
Nicht verwendete Attribute sind jetzt abgedeckt: `gewaesser.typ`,
`laenge_km`, `haltestellen.arbeitsplaetze`, `strassen.klasse`,
`schulen.standorte`.

**Tags im Tuning-Satz:** `n13` trägt `needs-values` (die Bahnhaltestelle
heisst «Bern», daneben gibt es «Bern, Hauptbahnhof»; kein Modell kann das aus
Metadaten wissen), `doc1` hat `gold_any` (`typ` ist die *höchste* Stufe, eine
Schule mit `primarstufe` ist auch eine Primarschule).

**Läufe:** je Modell (gpt-6-luna, gemma4:12b, gemma4:e4b, qwen3:14b)
Held-out mit zwei Blöcken, dazu «nur Text» auf beiden Sätzen mit einem Block.
Labels `ho-*`, `ho-*-s6`, `tx-*`, `txho-*`.

### 9.1 Ergebnisse

(folgt)
