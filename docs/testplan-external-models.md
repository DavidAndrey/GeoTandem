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
| X-5 | **Erschöpftes Guthaben erkennen** (8.1) | `error.code` gegen eine feste Liste lesen, eigener Code ohne Wiederholung; braucht eine Ergänzung von C13 im Sicherheitsreview |

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
| gemma4:12b (Referenz, T 0,3) | 130/165 | | | | – |
| qwen3:8b (T 0,3) | 93/165 | | | | – |
| gpt-6-luna (`none`) | | | | | |
| claude-sonnet-5-5 | | | | | |

### 8.3 Fälle nach Klasse

| Fall | gemma4 | qwen3 | Claude | OpenAI | Klasse | Folge |
|---|---:|---:|---:|---:|---|---|

### 8.4 Anwendung

| Anbieter | Verbindungstest | Direktabfrage (5) | Werkzeugkette (5) | Bemerkungen |
|---|---|---|---|---|
