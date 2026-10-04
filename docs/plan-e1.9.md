# Plan E1.9 — Grundlage der Mehrsprachigkeit

> Stand: 2026-10-04 · **umgesetzt (WP46–WP52)** · Bezug:
> [anforderungen.md](../anforderungen.md) (F-10.6, F-5.9), [etappen.md 3](../etappen.md),
> [tech-stack.md 4.6](../tech-stack.md)
>
> Continues with WP46. Each WP is one commit and leaves `make gate` green.

## 1 Scope (decided 2026-10-04)

F-10.6 asks for a multilingual interface, source language German. The full
feature stays after E6 ([etappen.md 10](../etappen.md)); **the foundation is
built now**, before E2, because every stage after E1 adds interface text and
moving it out later costs more than writing it into a catalog from the start.

**In E1.9:**

- One message catalog, **German only**, holding every text of the interface:
  user area, admin area, sign-in and setup.
- Sentence builders (condition descriptions, opening notices, import
  messages) as whole messages with placeholders and plurals, not as joined
  fragments.
- One place for the formatting locale (`de-CH`) instead of the literal in
  every `toLocaleString`, `Intl.*` and collator.
- Back-end rejections shown by **code**, translated in the front end; the
  back end's English `message` stays for logs, API clients and later the
  model (F-5.9).
- A **pseudo-locale** and a lint rule, so that the foundation holds without
  a second real language.

**Not in E1.9:** French or any other catalog, a language switcher, a stored
language preference, `Accept-Language`, translated sample data, metadata,
layer titles or code lists (content, not interface), README and `docs/`.
The language of prompts and model explanations is decided in E2.

## 2 Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| L1 | Library | **Lingui 6** (`@lingui/core`, `@lingui/react`, macros, CLI, Vite plugin), ICU MessageFormat, PO catalogs | German source text stays in the components (`<Trans>Sitzung speichern</Trans>`), so code still reads like the design; extraction and compilation at build time; small runtime. i18next is the more widespread fallback ([tech-stack.md 1](../tech-stack.md), rule 4) |
| L2 | Message ids | **Generated from the German source text**, with a `context` where the same German word means two things (e.g. "enthält" as text and as spatial operator) | Unchanged German text needs no renaming; a changed text is a new message for every later translation, which is correct |
| L3 | Macro transform | **Native** (`lingui({ macroTransform: true })`, `@lingui/native-tools`), no Babel | `@vitejs/plugin-react` 6 has no Babel; the planned route through `@rolldown/plugin-babel` turned out unnecessary (section 5) |
| L4 | Formatting locale | Derived from the message locale: `de` → `de-CH` (later `fr` → `fr-CH`, `it` → `it-CH`, `en` → open). One module `i18n/locale.ts` gives number, date, time and collation | Swiss formats are a property of the installation's audience, not of the language alone |
| L5 | Number input | Accepts `.` and `,` as decimal separator, `'`, `’` and spaces as group separators; the display follows L4 | Today `replace(',', '.')` in one field; fr-CH displays `1 234,5`, which must parse back |
| L6 | Back-end messages | The front end shows `code` + `details` through the catalog. Every code the back end can send is listed in one registry, exported to `frontend/error-codes.json` (like `openapi.json`); a test fails when a code has no message. Generic codes the UI shows today (`invalid_query`, `bad_request` reused for different causes) are split into specific ones. An unknown code shows a generic text with the code | Translation needs a stable key; the English text is not one. Splitting codes now is cheap: nothing outside this repo depends on them yet |
| L7 | Pseudo-locale | `pseudo` (accented, about 30 % longer, bracketed ⟦…⟧), chosen by `?lang=pseudo` and kept for the browser tab, `?lang=de` back. Its catalog is a chunk of its own, loaded only when asked for, and offered in no menu | Shows untranslated text and layouts that break with longer text, without a second real language. Reachable in the shipped container, so the end-to-end test (L8) can use it |
| L8 | Tests | Unit and component tests keep asserting German text (the source catalog renders it); one end-to-end smoke test runs the main flow in `pseudo` and fails on any unbracketed text in the main views | 575 existing text assertions stay; the pseudo test is the guard |
| L9 | Quotation marks | Owned by the messages, not by code. German keeps „…" for now | Swiss usage («…») is a separate editorial decision; after E1.9 it is a catalog change only |

## 3 Work packages

### WP46 — Lingui in the build (L1, L3, L7)

- Dependencies, `lingui.config.ts` (source `de`, catalogs in
  `frontend/src/locales/`, `pseudoLocale`), Vite plugin with the native
  macro transform, `I18nProvider` in `main.tsx` and in the test render
  helper, `<html lang>` from the active locale.
- `npm run i18n:extract` and `i18n:check` (extraction leaves no diff), run by
  `make gate`.
- `eslint-plugin-lingui` with `no-unlocalized-strings` as **warning**.
- One component converted as a proof (the user menu).
- Measured and noted in section 5: build time before/after, Vitest time,
  bundle size; the CSP still holds (compiled catalogs need no `eval`).
- **Built 2026-10-04.**

### WP47 — One formatting locale (L4, L5)

- `i18n/locale.ts`: `formatNumber`, `formatDate`, `formatDateTime`,
  `formatTime`, `compareText`, `lowerText`, `parseNumber`.
- Every `'de-CH'` literal and the hand-built `dd.mm.yyyy` in
  [describe.ts](../frontend/src/editor/describe.ts) replaced; number inputs
  (condition values, value domains, distances, classes) through
  `parseNumber`.
- Tests: format and parse round trip for `de-CH` and `fr-CH`, so that L5 is
  proven before French exists.
- **Built 2026-10-04.**

### WP48 — Sentence builders as messages

- [describe.ts](../frontend/src/editor/describe.ts) (operators by field
  type, condition text, distances), [notice.ts](../frontend/src/session/notice.ts),
  [session/ui.ts](../frontend/src/session/ui.ts), [queries/ui.ts](../frontend/src/queries/ui.ts),
  [wizard.ts](../frontend/src/admin/wizard.ts): whole sentences with
  placeholders, `plural` for counts ("1 Treffer" / "12 Treffer").
- Operator tables become message descriptors (`msg`), resolved where they
  are shown.
- Tests: existing ones unchanged in content; one test per builder in
  `pseudo`, which shows that no fragment is joined outside a message.
- **Built 2026-10-04.**

### WP49 — User area

- `workplace/`, `map/`, `editor/`, `table/`, `operations/`, `queries/`,
  `session/`, `components/ui.tsx`: every visible text, `aria-label`, `title`
  and placeholder into the catalog.
- Tests: existing component tests green without changes to their text.
- **Built 2026-10-04.**

### WP50 — Admin area, sign-in and setup

- `admin/`, `auth/`: as WP49.
- Tests: as WP49.
- **Built 2026-10-04.**

### WP51 — Back-end rejections by code (L6)

- Back end: one registry of codes (engine, API, accounts, sessions, saved
  queries, import messages) with their `details` keys; generic codes split
  where the UI shows them; `error-codes.json` exported and checked like
  `openapi.json`.
- Front end: `errorText(code, details)` from the catalog, used by
  `components/ui.tsx`, the import wizard and run page, the session and query
  dialogs. Import warnings and errors through the same path.
- Tests: back end, every raised code is in the registry; front end, every
  registry code has a message; the API contract test for the split codes.
- **Built 2026-10-04.**

### WP52 — Guard and docs

- `no-unlocalized-strings` from warning to **error**.
- End-to-end: the reference question of E1 answered in `pseudo` (L8).
- Docs: CONTEXT (Meldungskatalog, Formatierungs-Locale), tech-stack 4.6
  (as built), README (how to add a language), section 5 below.
- **Built 2026-10-04.**

## 4 Order

```
WP46 ── WP47 ── WP48 ── WP49 ── WP50 ── WP51 ── WP52
```

WP46 first: if L3 fails, the library decision is reopened before any text
moves. WP48 before WP49 because the components use the builders. WP51 is
independent of WP49/50 and may move forward if the back end is free.

## 5 Found on the way

- **No Babel needed (WP46).** `@lingui/vite-plugin` 6.9 transforms macros
  natively (`macroTransform: true`); the Babel route of L3 was dropped
  before it was built. The native binary comes as an optional package per
  platform; `node:24-slim` takes the `linux-*-gnu` one.
- **Cost of the foundation, measured (WP46).** Main bundle 1,038.8 → 1,047.9
  kB (gzip 301.9 → 305.3 kB); build 3.38 → 3.53 s; unit tests 3.55 → 3.70 s.
  The pseudo catalog is a separate chunk of a few hundred bytes. Compiled
  catalogs are parsed JSON, no `eval`: the CSP is unchanged.
- **Production keeps only message ids (WP46).** The plugin strips the German
  source text from the components in a production build; the text comes
  from the compiled `de` catalog. A catalog out of sync with the code would
  therefore show ids, which is why `i18n:check` (`lingui check sync`) runs
  in `make test`.
- **`npm audit` reports `braces` (WP46).** Through `micromatch` in
  `@lingui/cli` and `eslint-plugin-lingui`: stack exhaustion on deeply
  nested glob patterns, no fix released. Both are build tools fed with the
  repository's own patterns; nothing of it reaches the browser. Accepted;
  to be re-checked when a fix is out.
- **Number fields parse themselves (WP47).** Every numeric field but one is
  `type="number"`: the browser reads it in its own locale and hands over
  `1234.5`. L5 is needed only where numbers are typed as text, the value
  list of "ist eins von"; its chips now show numbers in the locale's form.
- **ICU's Swiss group mark changed (WP47).** Current ICU writes de-CH as
  `1'234.5` (ASCII apostrophe), older versions `1’234.5`; fr-CH uses a
  narrow no-break space. `parseNumber` accepts all three.
- **A condition is one message, its operator another (WP48).** "Schulstufe
  ist eins von primar" is the message `{field} {op} {values}` with the
  operator as its own message: the editor lists the operators anyway, and a
  language can still reorder the sentence. A translator's comment says so in
  the catalog. Negation (`nicht {condition}`) and a spatial filter
  (`{condition} ({filter})`) wrap whole conditions, never fragments.
- **Counts format before they are counted (WP48).** ICU's `#` in a plural
  formats with the bare language (`de`, `1.234`), not the region; plurals
  therefore embed the number formatted by L4 and use the count only to
  choose the form.
- **Text built outside React follows the language at the time it is built
  (WP48).** Builders read the global `i18n`; nothing re-renders them on a
  change of language. With one language and `pseudo` chosen on page load
  that is enough; a switcher (section 6) reloads the page.
- **The pseudo check found nothing joined (WP48).** `src/test/pseudo.ts`
  removes everything bracketed and the data a test names; any letter left
  is a fragment outside the catalog. Back-end messages still count as data
  until WP51.
- **Components use the core `t` too (WP49).** Since a change of language
  reloads the page, components call `t` from `@lingui/core/macro` like the
  builders, `<Trans>` where text and markup mix, and `msg` for tables of
  labels at module level (operators, functions, steps). One way everywhere
  instead of a hook here and a macro there.
- **The lint rule sees less than it says (WP49).** `no-unlocalized-strings`
  skips `title` attributes and lowercase single words ("bis", "wo",
  "ungespeichert"), and exempted `new Error(…)`, whose message is shown.
  Errors are no longer exempt; class lists, locale tags and camel-case keys
  are. What the rule cannot see, a test now does: `src/i18n/screens.test.tsx`
  renders the workplace, the session and query dialogs, measuring and all
  four operations in `pseudo` and fails on any text or label outside ⟦…⟧
  that is not data. It found "UND"/"ODER", the condition badges, "… von …"
  hit counts and the eye button's label, all missed by the rule.
- **Two places assembled German from parts (WP49).** The unsaved-changes
  question built "Speichern und {verb}" from a verb each caller passed
  ("öffnen", "abmelden"); callers now pass an action (`open`, `new`,
  `logout`) and the dialog holds the three whole messages. The header's
  "gespeichert 14:02" stripped "heute " from another message with a regular
  expression; it is a message of its own now (`formatSaved`).
- **The condition editor keeps its word order (WP49).** Inline editors read
  as a sentence of fields: "≤ [500] m um [Objekt]", "wo [Feld] [Operator]",
  "als [Name]". The words between the fields are messages with a context
  for translators; a language with another order would need a different
  layout of the row, which is a design question for that language.
- **Addresses stay German (WP49).** `/sitzung/…`, `/anmelden`,
  `/admin/daten` are paths, not text; they are not translated.
- **Label tables become descriptors (WP50).** Roles, import statuses, field
  types, geometry kinds, import steps and the admin navigation were
  constants of translated strings, evaluated once at import time, before a
  language is active. They are `msg` descriptors now, read through small
  functions (`roleLabel`, `statusLabel`, `typeLabel`) where they are shown.
  The wizard showed raw field types ("integer") and now shows the same
  words as the layer page.
- **Names stay names (WP50).** Coordinate systems ("CH1903+ / LV95"),
  encodings ("Windows-1252"), `docker logs`, `GEOTANDEM_SETUP_TOKEN`, MCP
  and the stage codes are not messages; the lint rule is told so where they
  are defined.
- **The admin screens are checked in pseudo too (WP50).**
  `src/i18n/admin-screens.test.tsx` renders every admin page, each layer
  tab, the import wizard through all four steps, sign-in, setup and the
  password page. A word inside a nested element of a message (`<Trans>…
  <span>auswählen</span></Trans>`) is pseudo text without brackets of its
  own; the check counts words without any plain ASCII letter as pseudo.
- **The registry, as built (WP51).** `geotandem/codes.py` lists 90 codes
  with a line of English each; `geotandem codes export` writes
  `frontend/error-codes.json` (`make gen`), a back-end test compares the two
  like `openapi.json`. `tests/test_codes.py` reads the source for every code
  literal (class attribute, keyword, code followed by its message, the
  reason of a rejected row) and fails on one not registered, and on a
  registered one no longer raised. Detail keys are not part of the registry:
  each message reads the details it knows and words the rest generally.
- **Six causes left `invalid_query` (WP51).** Value of the wrong type,
  `text_match` on non-text, metric over non-numbers, a drawn area that is
  invalid, a name taken by a join, column or metric, and join keys of
  different types now have codes of their own (`wrong_value_type`,
  `attribute_not_text`, `attribute_not_numeric`, `invalid_query_geometry`,
  `name_clash`, `key_type_mismatch`); `invalid_query` stays for the rest.
  A layer name that is no identifier is `invalid_layer_name`, no longer the
  generic `bad_request`. [docs/filters.md](filters.md) 3.5 lists them.
- **Findings carry their values (WP51).** Import messages had numbers and
  names only inside the English text. `Message` gained `details` (columns
  of a duplicate header, the target layer of ambiguous keys, the type of a
  column stored as text); a refused import keeps its error's details; the
  blocked decisions name their layer, column or EPSG code. Times of day
  stored as text are `times_as_text`, no longer a second meaning of
  `stored_as_text`. The session check sends `error_code` and
  `error_details` beside its English `error`.
- **One place turns a code into words (WP51).** `ApiRequestError` takes its
  message from `errorText(code, details)`, so every view that shows
  `error.message` reads German without knowing about codes; the password
  rules the access pages kept themselves are gone. A code the interface does
  not know yet shows the back end's English rather than nothing. The
  reasons in the table of rejected rows were codes shown as they are; they
  are worded too.

- **The end-to-end pass sees what the fakes cannot (WP52).**
  `e2e/tests/pseudo.spec.ts` builds the reference question in German, saves
  it, reopens the page with `?lang=pseudo` and checks the restored workplace,
  the opening notice and the admin catalog and log against the real data,
  with the pseudo catalog loaded under the real Content-Security-Policy.
  Views that need clicks to reach (dialogs, the table, the operations) stay
  with the unit screen tests: their buttons have no German name to find in
  pseudo. Text the back end owns (layer titles, labels, values) is taken
  from `/api/layers`, not listed by hand.
- **The rule is an error now (WP52).** `no-unlocalized-strings` fails the
  lint on any new text outside the catalog. What it cannot see is left to
  the screen tests, as found in WP49.

## 6 Adding a language later

What remains for French (and then Italian, English) once E1.9 is built:

1. `fr` in `lingui.config.ts`, `npm run i18n:extract`, translate
   `fr.po` (with a GIS glossary: couche, tampon, jointure spatiale, commune …).
2. A language switcher and where the choice is kept (browser or account),
   a decision of its own; the sign-in page needs a language before any account. Switching reloads the page (WP48).
3. `i18n:check` with `--strict` for `fr`, so missing messages fail the gate.
4. A layout pass in the real language; `pseudo` has caught most of it.
5. Open then, not now: translated sample data and metadata, the language of
   prompts and model explanations (E2), the evaluation set (E3).
