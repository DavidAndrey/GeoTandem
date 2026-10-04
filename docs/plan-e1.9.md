# Plan E1.9 — Grundlage der Mehrsprachigkeit

> Stand: 2026-10-04 · **geplant (WP46–WP52)** · Bezug:
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
| L3 | Babel | Lingui's macros need Babel; `@vitejs/plugin-react` 6 has none. Added through `@rolldown/plugin-babel` **for the macro only** | The supported path for Vite 8 (`@lingui/vite-plugin` 6.9 peers). Measured in WP46 (build time, Vitest, HMR); if it is unacceptable, fallback is `msg` descriptors without macros |
| L4 | Formatting locale | Derived from the message locale: `de` → `de-CH` (later `fr` → `fr-CH`, `it` → `it-CH`, `en` → open). One module `i18n/locale.ts` gives number, date, time and collation | Swiss formats are a property of the installation's audience, not of the language alone |
| L5 | Number input | Accepts `.` and `,` as decimal separator, `'`, `’` and spaces as group separators; the display follows L4 | Today `replace(',', '.')` in one field; fr-CH displays `1 234,5`, which must parse back |
| L6 | Back-end messages | The front end shows `code` + `details` through the catalog. Every code the back end can send is listed in one registry, exported to `frontend/error-codes.json` (like `openapi.json`); a test fails when a code has no message. Generic codes the UI shows today (`invalid_query`, `bad_request` reused for different causes) are split into specific ones. An unknown code shows a generic text with the code | Translation needs a stable key; the English text is not one. Splitting codes now is cheap: nothing outside this repo depends on them yet |
| L7 | Pseudo-locale | `pseudo` (accented, about 30 % longer, bracketed), selectable in development by `?lang=pseudo`; not offered in production | Shows untranslated text and layouts that break with longer text, without a second real language |
| L8 | Tests | Unit and component tests keep asserting German text (the source catalog renders it); one end-to-end smoke test runs the main flow in `pseudo` and fails on any unbracketed text in the main views | 575 existing text assertions stay; the pseudo test is the guard |
| L9 | Quotation marks | Owned by the messages, not by code. German keeps „…" for now | Swiss usage («…») is a separate editorial decision; after E1.9 it is a catalog change only |

## 3 Work packages

### WP46 — Lingui in the build (L1, L3, L7)

- Dependencies, `lingui.config.ts` (source `de`, catalogs in
  `frontend/src/locales/`, `pseudoLocale`), Vite plugin with
  `@rolldown/plugin-babel` for the macro, `I18nProvider` in `main.tsx` and in
  the test render helper, `<html lang>` from the active locale.
- `npm run i18n:extract` and `i18n:check` (extraction leaves no diff), run by
  `make gate`.
- `eslint-plugin-lingui` with `no-unlocalized-strings` as **warning**.
- One component converted as a proof (the user menu).
- Measured and noted in section 5: build time before/after, Vitest time,
  bundle size; the CSP still holds (compiled catalogs need no `eval`).

### WP47 — One formatting locale (L4, L5)

- `i18n/locale.ts`: `formatNumber`, `formatDate`, `formatDateTime`,
  `formatTime`, `compareText`, `lowerText`, `parseNumber`.
- Every `'de-CH'` literal and the hand-built `dd.mm.yyyy` in
  [describe.ts](../frontend/src/editor/describe.ts) replaced; number inputs
  (condition values, value domains, distances, classes) through
  `parseNumber`.
- Tests: format and parse round trip for `de-CH` and `fr-CH`, so that L5 is
  proven before French exists.

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

### WP49 — User area

- `workplace/`, `map/`, `editor/`, `table/`, `operations/`, `queries/`,
  `session/`, `components/ui.tsx`: every visible text, `aria-label`, `title`
  and placeholder into the catalog.
- Tests: existing component tests green without changes to their text.

### WP50 — Admin area, sign-in and setup

- `admin/`, `auth/`: as WP49.
- Tests: as WP49.

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

### WP52 — Guard and docs

- `no-unlocalized-strings` from warning to **error**.
- End-to-end: the reference question of E1 answered in `pseudo` (L8).
- Docs: CONTEXT (Meldungskatalog, Formatierungs-Locale), tech-stack 4.6
  (as built), README (how to add a language), section 5 below.

## 4 Order

```
WP46 ── WP47 ── WP48 ── WP49 ── WP50 ── WP51 ── WP52
```

WP46 first: if L3 fails, the library decision is reopened before any text
moves. WP48 before WP49 because the components use the builders. WP51 is
independent of WP49/50 and may move forward if the back end is free.

## 5 Found on the way

*(filled in during implementation)*

## 6 Adding a language later

What remains for French (and then Italian, English) once E1.9 is built:

1. `fr` in `lingui.config.ts`, `npm run i18n:extract`, translate
   `fr.po` (with a GIS glossary: couche, tampon, jointure spatiale, commune …).
2. A language switcher and where the choice is kept (browser or account),
   a decision of its own; the sign-in page needs a language before any account.
3. `i18n:check` with `--strict` for `fr`, so missing messages fail the gate.
4. A layout pass in the real language; `pseudo` has caught most of it.
5. Open then, not now: translated sample data and metadata, the language of
   prompts and model explanations (E2), the evaluation set (E3).
