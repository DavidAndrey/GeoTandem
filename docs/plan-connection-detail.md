# Plan: a detail page for each model connection

> Status: built 2026-11-07 (section 7). Decided with the user: own route (B), the
> dropdown shows names only, unsaved changes are confirmed before leaving,
> «Neue Anbindung» in the dropdown and the top bar, no test or delete in the
> top bar, no anchors or tabs, the form regrouped with plain labels, the new
> wording also on the evaluation pages, no folded groups; D4 and D7 as
> recommended.

## 1 Why

Today **Bearbeiten** opens the form inline between the intro and the list
(`ConnectionsPage.tsx`, `editing` state):

- The form is long, so the list ends up far below it, and the page doesn't
  scroll to the form. From a row lower down, the form opens off-screen.
- The list stays usable while editing. **Bearbeiten** on another row swaps
  the form (`key={editing.id}`) and silently drops unsaved changes.
- A row's test result shows up between the form and the list.
- No URL: the back button closes nothing, and an edit view can't be linked.
- The form's order is technical. Data release sits last, and the prompt
  settings use evaluation codes («Platzierung», «P0/P5/P9», «erzwungen»)
  that admins don't recognize.

## 2 Decisions

| # | Question | Decision / recommendation | Why |
|---|---|---|---|
| D1 | Where editing happens | Own routes: `/admin/modelle/:id` and `/admin/modelle/neu`. The list `/admin/modelle` shows only the table | Like `daten/:layer`, `bewertung/faelle/:id`, `protokoll/:id`; back button and links work |
| D2 | Navigation in the detail view | Top bar: `← Alle Anbindungen`, a native `<select>` with the connection names (plus a last option «Neue Anbindung …»), and a «+ Neue Anbindung» button. No test or delete there | Decided by the user |
| D3 | Unsaved changes | Changing the dropdown, `← Alle Anbindungen`, «Neue Anbindung», **Abbrechen** and any in-app link ask first («Änderungen verwerfen?»); closing or reloading the tab asks the browser's question. The `useAskBeforeLeaving` hook of `CaseDetailPage.tsx` moves to a shared module and is reused. As there, the browser's back button is not caught (`BrowserRouter` has no `useBlocker`) | Decided by the user; one way of asking in the whole admin area |
| D4 | After **Speichern** | **Recommendation:** stay on the detail page with a short note «Gespeichert». A new connection goes to `/admin/modelle/:id` (`replace`), where data release can then be granted. **Abbrechen** goes back to the list | The page is now a place to work in; saving a new one leads straight into its data release (group 2) |
| D5 | Status in the detail view | A read-only line under the top bar: locality badge, freigegeben / nicht freigegeben, voreingestellt, Letzter Test, Zuletzt bewertet (the list's `LastTest` and `LastRun` reused) | Today you only see these in the list |
| D6 | The list | The name becomes a link to the detail page. The row menu keeps **Bearbeiten** (now a link), **Verbindung testen** and **Löschen**. The «+ Anbindung» button goes to `/neu` | Rows stay quick to act on |
| D7 | «Zur Anbindung» from a run (`RunPage.tsx:660`) | **Recommendation:** links to `/admin/modelle/:id`. `useTargetRow` and the `#anbindung-N` highlight go; old `#anbindung-N` links fall back to the plain list | The detail page is the better target; the highlight was a stand-in for it (design review 6) |
| D8 | Unknown id | A short message «Anbindung nicht gefunden» with a link back to the list, not the global 404 | The connection may have just been deleted by someone else |

## 3 The form

Five groups, each a `fieldset` with a heading and a one-line purpose. On wide
screens, label and hint on the left, input on the right. On narrow screens,
stacked. Nothing is folded.

| Group | Purpose line | Fields |
|---|---|---|
| 1 **Verbindung** | Wo das Modell läuft und wie man es erreicht | Name · Adresse · Modell · API-Schlüssel · Zeitlimit (s) |
| 2 **Nutzung und Datenschutz** | Wer die Anbindung wählen kann und was sie erhält | *Verfügbarkeit:* Für Anwender freigegeben · Voreingestellt. *Datenschutz:* Als extern behandeln … · Darf Dateninhalte erhalten (new connection: today's note «nach dem Speichern änderbar») · the release confirmation · «Der Text der Anfrage geht in jedem Fall an das Modell.» |
| 3 **Antwortverhalten** | Wie das Modell antwortet | Temperatur · Seed · Denkaufwand · Kontextlänge |
| 4 **Prompt und Prüfung** | Feinabstimmung; welche Einstellung einem Modell hilft, zeigt ein Bewertungslauf | Beispiele im Prompt · Reihenfolge im Prompt · Antwortformat · Gegenprüfung |
| 5 **Kosten und Grenzen** | Optional | Preise je Mio. Tokens (Eingabe, Ausgabe, Währung) · Anfragen pro Tag begrenzen |

The form's actions (**Abbrechen**, **Verbindung testen**, **Speichern**) sit
in a bar stuck to the bottom of the window. The draft's test result stays
directly above that bar.

### Labels and hints

| Today | New label | New hint / options |
|---|---|---|
| Temperatur | Temperatur | 0 = immer gleich, höher = vielfältiger |
| Seed | Seed | Gleicher Wert → wiederholbare Antworten (wording to match what the back end does with an empty field: no seed sent) |
| Kontextlänge | Kontextlänge (Tokens) | today's hint |
| Denkaufwand | Denkaufwand | Wie lange das Modell vor der Antwort nachdenken darf; nur bei Modellen, die es unterstützen |
| Beispiele | Beispiele im Prompt | today's hint |
| Platzierung | **Reihenfolge im Prompt** | Standard (P0) · Beispiele vor dem Steckbrief (P5) · Hinweis „erste Frage" als eigene Systemnachricht (P9). The hint explains the selected option in one sentence |
| Ausgabeformat: erzwungen / nur Text | **Antwortformat**: Schema erzwungen / Schema nur im Prompt | today's hint, shortened |
| Prüfung durch die Werkzeugkette | **Gegenprüfung**: Aus / Mit der Werkzeugkette prüfen | Jede Antwort wird zusätzlich mit der Werkzeugkette gefragt; weicht sie ab, ist die Antwort als unsicher markiert. Etwa doppelte Modellzeit, zählt zum Anfragelimit |
| Promptprofil (legend) | gone; group 4 instead | – |
| Freigabe (legend) | gone; group 2 instead | – |

The codes P0/P5/P9 stay in parentheses so the run pages still match.

### The same words on the evaluation pages

`placementLabel` and `outputLabel` (`promptProfile.ts`) change, and so do the
words around them:

- `RunPage.tsx`: the profile diff rows «Platzierung» → «Reihenfolge»,
  «Ausgabe» → «Antwortformat».
- `NewRunPage.tsx`: «Platzierung von Messpunkt N» → «Reihenfolge von
  Messpunkt N»; the column head «Promptprofil · Beispiele · Platzierung ·
  Ausgabe» → «Promptprofil · Beispiele · Reihenfolge · Antwortformat».
- `profileOptions.ts`, `runWords.ts`: the short lines read «Standard · P0 ·
  Schema erzwungen».
- `ModelActionPage.tsx`: checked for the same labels.

«Promptprofil» stays the word for the whole set on the evaluation pages
(CONTEXT.md term).

## 4 Work packages

1. **Routes and pages:** `ConnectionsPage` (list only) and a new
   `ConnectionDetailPage` for `modelle/:id` and `modelle/neu` in `App.tsx`;
   the admin navigation stays on «Modellanbindungen» for both (`within`).
   The top bar (D2), the status line (D5), unknown id (D8), save behaviour (D4).
2. **Ask before leaving:** move `useAskBeforeLeaving` and its dialog out of
   `CaseDetailPage.tsx` into a shared module. `dirty` = form differs from
   `fromConnection(connection)` (or from `blank` for a new one). Wire the
   dropdown, the back link, «Neue Anbindung» and Abbrechen through it (D3).
3. **The form:** regroup into the five groups, the two-column layout, the
   sticky action bar, the labels and hints (section 3).
4. **The list:** name as link, Bearbeiten as link, «+ Anbindung» to `/neu`
   (D6); drop `useTargetRow`; «Zur Anbindung» in `RunPage.tsx` to the
   detail page (D7).
5. **Shared labels:** `promptProfile.ts` and the evaluation pages (section 3).
6. **i18n:** `npm run i18n:extract`, the new strings in `de.po` and
   `pseudo.po`, `i18n:check`.
7. **Tests:** `connections.test.tsx` (routes, dropdown, asking before
   leaving, save stays/redirects, unknown id), `matrix.test.tsx` and
   `runs.test.tsx` (link and labels), e2e `connections.spec.ts` (form on
   `/neu`, then the row) and `acceptance-e3.spec.ts` (`#anbindung-N` target,
   «Platzierung von Messpunkt», «~ Platzierung: P0 → P9»).
8. **Docs:** CONTEXT.md: *Promptprofil* names «Reihenfolge (Platzierung)»
   and «Antwortformat»; *Prüfung durch die Kette* notes the form label
   «Gegenprüfung». README if it describes the form.

## 5 Out of scope

- Test and delete in the detail view's top bar (decided).
- Anchors, tabs or folded groups (decided).
- Any change to what is stored or sent: fields, API and validation stay as
  they are.
- Catching the browser's back button with unsaved changes (needs a data
  router instead of `BrowserRouter`).

## 6 Open

None. The Seed hint follows `openai_compat.py` (an empty seed is not sent).

## 7 Built (2026-11-07)

- **Pages:** `ConnectionsPage.tsx` (list), `ConnectionDetailPage.tsx`
  (`modelle/:id`, `modelle/neu`), `ConnectionForm.tsx` (the form),
  `connectionParts.tsx` (test steps, last test, last run),
  `connectionPaths.ts`. The admin navigation stays on *Modellanbindungen*
  below `/admin/modelle`.
- **Asking before leaving:** `components/askBeforeLeaving.ts`, shared with
  the case page. The form reports `dirty` (form differs from the saved state);
  the page asks on the dropdown, «Neue Anbindung», Abbrechen and any in-app link.
- **After saving:** the form takes the stored connection as its new saved
  state and shows «Gespeichert»; a new one moves to its page with the same note.
- **Wording:** as section 3. Two small additions: a hint for *Zeitlimit* and
  for *Denkaufwand*; the price rule («beide Beträge und die Währung, oder
  keines davon») moved from the group's text to the first price field. The
  placement hints follow `prompt.py`: P0 puts the examples last, P5 before
  the layer profile, P9 sends «erste Frage des Gesprächs» as its own system
  message right before the question.
- **Tests:** `connections.test.tsx` gained the page, the dropdown, asking,
  saving and an unknown id; the e2e flows land on the new page after saving
  and go back by *Alle Anbindungen*; `acceptance-e3` follows *Zur Anbindung*
  to the page.
