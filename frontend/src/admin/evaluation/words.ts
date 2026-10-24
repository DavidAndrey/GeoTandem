// The evaluation's cases in words and the small rules the pages share (plan E3,
// D1-D3, design V1-V3). Pure, so they are unit-tested.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import type { ApiRequestError, CaseOrigin, DataState, EvalCase, Split } from '../../api/client'
import { errorText, KNOWN_CODES } from '../../i18n/errors'
import { formatNumber } from '../../i18n/locale'

export type AnswerKind = NonNullable<EvalCase['expect']>
export type OtherApproach = NonNullable<EvalCase['other_approach']>

export const SPLITS: Split[] = ['tuning', 'confirm']
export const ORIGINS: CaseOrigin[] = ['start', 'authored', 'import', 'log']
export const DATA_STATES: DataState[] = ['sample', 'live']
export const ANSWER_KINDS: AnswerKind[] = ['query', 'clarification', 'cannot_answer']

/** Limits of the case format (``evaluation/schemas.py``). */
export const MAX_TAGS = 8
export const MAX_READINGS = 4
/** A case's reference passes the checks a model's query passes: at most this
 * many conditions (``MAX_CONDITIONS`` of ``model/schemas.py``, design M3.2, V3.2). */
export const MAX_CONDITIONS = 8
export const CASE_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/
export const TAG = /^[a-z0-9][a-z0-9:-]{0,31}$/
const RESERVED = ['export', 'import', 'draft-from-action']

const SPLIT_LABELS: Record<Split, MessageDescriptor> = {
  tuning: msg`Abstimmung`,
  confirm: msg`Bestätigung`,
}
const ORIGIN_LABELS: Record<CaseOrigin, MessageDescriptor> = {
  start: msg`Start`,
  authored: msg`Arbeitsplatz`,
  import: msg`Import`,
  log: msg`Protokoll`,
}
const DATA_STATE_LABELS: Record<DataState, MessageDescriptor> = {
  sample: msg`Beispieldaten`,
  live: msg`Betriebsdaten`,
}
const KIND_LABELS: Record<AnswerKind, MessageDescriptor> = {
  query: msg`Abfrage`,
  clarification: msg`Rückfrage`,
  cannot_answer: msg`Nicht beantwortbar`,
}
const APPROACH_LABELS: Record<OtherApproach, MessageDescriptor> = {
  chain: msg`Andere Arbeitsweise vorschlagen (Werkzeugkette)`,
  direct: msg`Andere Arbeitsweise vorschlagen (Direktabfrage)`,
  none: msg`Keine andere Arbeitsweise vorschlagen`,
}
/** The start set's tags in words (``schema/eval-cases``); others show as written. */
const TAG_LABELS: Record<string, MessageDescriptor> = {
  spatial: msg`räumlich`,
  attribute: msg`Attribut`,
  combination: msg`Kombination`,
  'two-layers': msg`zwei Layer`,
  in: msg`liegt in`,
  near: msg`Nähe`,
  'in-list': msg`Werteliste`,
  negation: msg`Verneinung`,
  range: msg`Bereich`,
  code: msg`Codeliste`,
  count: msg`Zählung`,
  ambiguous: msg`mehrdeutig`,
  clarification: msg`Rückfrage`,
  chain: msg`Werkzeugkette`,
  nesting: msg`Verschachtelung`,
  text: msg`Text`,
  'unknown-layer': msg`unbekannter Layer`,
  'unknown-attribute': msg`unbekanntes Feld`,
  table: msg`Tabelle`,
  outside: msg`ausserhalb`,
  'per-group': msg`je Gruppe`,
  language: msg`Sprache`,
  'out-of-scope': msg`ausserhalb des Auftrags`,
  safety: msg`Sicherheit`,
  'needs-values': msg`braucht Werte`,
  context: msg`Kontext`,
  null: msg`leer`,
}

export const splitText = (split: Split) => i18n._(SPLIT_LABELS[split])
export const originText = (origin: CaseOrigin) => i18n._(ORIGIN_LABELS[origin])
export const dataStateText = (state: DataState) => i18n._(DATA_STATE_LABELS[state])
export const kindText = (kind: AnswerKind) => i18n._(KIND_LABELS[kind])
export const approachText = (approach: OtherApproach) => i18n._(APPROACH_LABELS[approach])
export const tagText = (tag: string) => (TAG_LABELS[tag] ? i18n._(TAG_LABELS[tag]) : tag)
export const tagList = (tags: readonly string[]) => tags.map(tagText).join(' · ')

/** A behaviour case names the expected kind of answer; every other case is a query case. */
export const isBehaviour = (c: EvalCase) => c.expect != null
/** "Abfrage" or "Verhalten" (V1.1). */
export const caseKindShort = (c: EvalCase) => (isBehaviour(c) ? t`Verhalten` : t`Abfrage`)
/** "Abfragefall" or "Verhaltensfall" (V2). */
export const caseKindText = (c: EvalCase) => (isBehaviour(c) ? t`Verhaltensfall` : t`Abfragefall`)

/** The reference query, or the fair readings; empty for other cases (``cases.readings``). */
export function readings(c: Pick<EvalCase, 'gold' | 'gold_any'>): Record<string, unknown>[] {
  return c.gold_any ?? (c.gold ? [c.gold] : [])
}

/** The readings back into a case: one is ``gold``, several are ``gold_any``. */
export function withReadings(c: EvalCase, docs: Record<string, unknown>[]): EvalCase {
  return docs.length > 1
    ? { ...c, gold: null, gold_any: docs }
    : { ...c, gold: docs[0] ?? null, gold_any: null }
}

/** "14 Treffer". */
export const hitsText = (n: number) => {
  const count = formatNumber(n)
  return t`${count} Treffer`
}

/** "Lesart A", "Lesart B" … (V2.3). */
export const readingName = (index: number) => {
  const letter = String.fromCharCode(65 + index)
  return t`Lesart ${letter}`
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const LAYER_KEYS = ['source', 'layer', 'by_layer']

/** The layers a query names: source, relations, references, joins (``query_layers``). */
export function layersOf(query: unknown): string[] {
  const found = new Set<string>()
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (isObject(value))
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'symbology') continue
        if (LAYER_KEYS.includes(key) && typeof inner === 'string') found.add(inner)
        else walk(inner)
      }
  }
  walk(query)
  return [...found].sort()
}

/**
 * A query object as a case stores its reference: as the harness writes it,
 * without ``schema_version``, ``output`` and what only the map uses.
 */
export function referenceOf(query: Record<string, unknown>): Record<string, unknown> {
  const dropped = ['schema_version', 'output', 'symbology', 'columns']
  return Object.fromEntries(Object.entries(query).filter(([key]) => !dropped.includes(key)))
}

/**
 * A case as it is sent: without ``null`` and without empty defaults, so it is
 * stored with the fields it has and exports as it was written (F-3.13).
 */
export function caseBody(c: EvalCase): EvalCase {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(c)) {
    if (value === null || value === undefined) continue
    if (['also', 'forbid', 'layers'].includes(key) && Array.isArray(value) && !value.length)
      continue
    if (key === 'note' && value === '') continue
    body[key] = value
  }
  return body as unknown as EvalCase
}

/** A case id from a question: "Schulen in Köniz" → "e-schulen-in-koeniz". */
export function idFrom(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug ? `e-${slug}` : ''
}

/** Why an id cannot be a case's, or ``null`` if it can. */
export function idProblem(id: string): string | null {
  if (!CASE_ID.test(id) || RESERVED.includes(id))
    return t`Kennung: Kleinbuchstaben, Ziffern, „-" und „.", höchstens 63 Zeichen, am Anfang ein Buchstabe oder eine Ziffer.`
  return null
}

/** Why a tag cannot be one, or ``null``. */
export function tagProblem(tag: string): string | null {
  if (!TAG.test(tag))
    return t`Stichwort: Kleinbuchstaben, Ziffern, „-" und „:", höchstens 32 Zeichen.`
  return null
}

/**
 * A refusal of a case in words: for ``case_invalid`` the reason the check gave
 * (a refusal code of the model path, such as ``unknown_layer``), when this
 * version knows it; otherwise the code's own words.
 */
export function caseErrorText(error: ApiRequestError): string {
  const body = error.body
  if (!body) return error.message
  const details = body.details ?? {}
  const reason = typeof details.reason === 'string' ? details.reason : null
  // The case route names the reason only, not the count (``cases.check_case``).
  if (body.code === 'case_invalid' && reason === 'limit_exceeded') return tooManyConditions()
  if (body.code === 'case_invalid' && reason && KNOWN_CODES.includes(reason))
    return errorText(reason, details)
  return error.message
}

/** V3.2: "Die Analyse hat 10 Bedingungen. Ein Prüffall darf höchstens 8 haben …". */
export function tooManyConditions(count?: number): string {
  const max = MAX_CONDITIONS
  if (count === undefined)
    return t`Die Abfrage hat mehr als ${max} Bedingungen. Ein Prüffall darf höchstens ${max} haben, wie jede Modellantwort.`
  return t`Die Analyse hat ${count} Bedingungen. Ein Prüffall darf höchstens ${max} haben, wie jede Modellantwort.`
}

/** One problem of an import in words (V1.3): what is wrong with the case. */
export function importProblemText(code: string): string {
  switch (code) {
    case 'case_id_taken':
      return t`Kennung doppelt (schon vorhanden)`
    case 'case_stale':
      return t`Ein Layer der Referenz fehlt oder ist für Sie nicht sichtbar`
    case 'case_invalid':
      return t`Referenzabfrage ungültig oder Fall unvollständig`
    default:
      return errorText(code)
  }
}
