// The evaluation's cases in words and the small rules the pages share (plan E3,
// D1-D3, design V1-V3). Pure, so they are unit-tested.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import {
  ApiRequestError,
  type CaseOrigin,
  type CaseStatus,
  type DataState,
  type EvalCase,
  type Split,
} from '../../api/client'
import { errorText, KNOWN_CODES } from '../../i18n/errors'
import { formatNumber } from '../../i18n/locale'
import { queryLayers } from '../../model/dialog/reference'

export type AnswerKind = NonNullable<EvalCase['expect']>
export type OtherApproach = NonNullable<EvalCase['other_approach']>

export const SPLITS: Split[] = ['tuning', 'confirm']
export const ORIGINS: CaseOrigin[] = ['start', 'authored', 'import', 'log']
export const DATA_STATES: DataState[] = ['sample', 'live']
export const ANSWER_KINDS: AnswerKind[] = ['query', 'clarification', 'cannot_answer']

/**
 * Limits of the case format (``evaluation/schemas.py``), held to the server's
 * schema by ``words.test.ts`` (read from ``openapi.json``).
 */
export const MAX_TAGS = 8
export const MAX_READINGS = 4
/** A case's reference passes the checks a model's query passes: at most this
 * many conditions (``MAX_CONDITIONS`` of ``model/schemas.py``, design M3.2, V3.2;
 * the schema has it as the most conditions of a ``require``). */
export const MAX_CONDITIONS = 8
export const CASE_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/
export const TAG = /^[a-z0-9][a-z0-9:-]{0,31}$/
/** Words of the case routes (``RESERVED_IDS``). */
export const RESERVED = ['draft-from-action', 'export', 'import']

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

/** A case a run leaves out (D3): *veraltet* or *ungültig*, both shown grey and struck through. */
export const notRun = (status: CaseStatus | undefined) => status === 'stale' || status === 'invalid'

/** A behaviour case names the expected kind of answer; every other case is a query case. */
export const isBehaviour = (c: EvalCase) => c.expect != null
/** "Abfrage" or "Verhalten" (V1.1). */
export const caseKindShort = (c: EvalCase) => (isBehaviour(c) ? t`Verhalten` : t`Abfrage`)
/** "Abfragefall" or "Verhaltensfall" (V2). */
export const caseKindText = (c: EvalCase) => (isBehaviour(c) ? t`Verhaltensfall` : t`Abfragefall`)

/**
 * The reference query, or the fair readings; empty for other cases
 * (``EvalCase.readings``): the one helper of these pages for it.
 */
export function readings(c: Pick<EvalCase, 'gold' | 'gold_any'>): Record<string, unknown>[] {
  if (c.gold_any != null) return c.gold_any
  return c.gold != null ? [c.gold] : []
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

/** The layers a query names, sorted, as a live case lists them (``query_layers``). */
export const layersOf = (query: unknown): string[] => queryLayers(query).sort()

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

type Details = Record<string, unknown>

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
const count = (value: unknown) => (typeof value === 'number' ? value : null)

/**
 * Why the check refused a case (``details.reason`` of ``case_invalid``), in
 * words from the details the server sends; ``null`` when this version does not
 * know the reason or a detail it needs is missing.
 */
function reasonText(reason: string, d: Details): string | null {
  switch (reason) {
    case 'too_many': {
      const max = count(d.max)
      return max === null
        ? null
        : t`Neben dem Startbestand sind höchstens ${max} eigene Prüffälle möglich; mit diesen wären es mehr. Bitte zuerst Fälle löschen.`
    }
    case 'duplicate_reading': {
      const same = count(d.same_as)
      if (same === null) return null
      const other = readingName(same)
      return t`Sie ist dieselbe Abfrage wie ${other}, nur anders geschrieben.`
    }
    case 'origin_start':
      return t`Nur Fälle des Startbestands haben die Herkunft „Start".`
    case 'origin_action': {
      const action = count(d.origin_action)
      return action === null ? null : t`Den Eintrag ${action} im Modellprotokoll gibt es nicht.`
    }
    case 'layer_not_listed': {
      const layer = text(d.layer)
      return layer === null
        ? null
        : t`Die Referenz nutzt den Layer „${layer}", der Fall nennt ihn aber nicht unter seinen Layern.`
    }
    case 'layer_not_used': {
      const layer = text(d.layer)
      return layer === null
        ? null
        : t`Der Fall nennt den Layer „${layer}", die Referenz nutzt ihn aber nicht.`
    }
    case 'unknown_attribute': {
      const attribute = text(d.attribute)
      const layer = text(d.layer)
      if (attribute === null) return null
      return layer === null
        ? t`Das Feld „${attribute}" gibt es nicht, oder das Modell kennt es nicht.`
        : t`Das Feld „${attribute}" gibt es im Layer „${layer}" nicht, oder das Modell kennt es nicht.`
    }
    case 'unknown_layer': {
      const layer = text(d.layer)
      return layer === null
        ? null
        : t`Den Layer „${layer}" gibt es nicht, er ist nicht sichtbar oder nicht für das Modell freigegeben.`
    }
    case 'limit_exceeded': {
      const value = count(d.value)
      const max = count(d.max)
      return value === null || max === null
        ? null
        : t`Die Abfrage hat ${value} Bedingungen. Ein Prüffall darf höchstens ${max} haben, wie jede Modellantwort.`
    }
  }
  // Refusal codes of the model path whose words need no detail, or name one.
  const needs = NEEDS[reason]
  if (!needs || !KNOWN_CODES.includes(reason)) return null
  return needs.every((key) => text(d[key]) !== null) ? errorText(reason, d) : null
}

/** Other refusal codes a reading can get, with the details their words need. */
const NEEDS: Record<string, string[]> = {
  not_representable: [],
  query_too_complex: [],
  invalid_query: [],
  model_query_invalid: [],
  unsupported_operation: [],
  invalid_query_geometry: [],
  key_type_mismatch: [],
  attribute_not_text: ['attribute'],
  attribute_not_numeric: ['attribute'],
  wrong_value_type: ['attribute'],
  name_clash: ['attribute'],
}

/**
 * A refusal of a case in words (create, edit, copy, import): for
 * ``case_invalid`` the reason the check gave, with "Lesart B: " in front when
 * the case has several readings; the code's own words when the reason is
 * unknown or a detail is missing, never a sentence with a gap.
 */
export function refusalText(
  code: string,
  details: Details = {},
  options: { readings?: number; fallback?: string } = {},
): string {
  if (code === 'case_invalid') {
    const reason = text(details.reason)
    const words = reason ? reasonText(reason, details) : null
    if (!words) return errorText(code, details)
    const reading = count(details.reading)
    return reading !== null && (options.readings ?? 0) > 1
      ? `${readingName(reading)}: ${words}`
      : words
  }
  return errorText(code, details, options.fallback)
}

/** ``refusalText`` of a failed request. */
export function caseErrorText(error: unknown, readingCount = 1): string {
  if (error instanceof ApiRequestError && error.body?.code)
    return refusalText(error.body.code, error.body.details ?? {}, {
      readings: readingCount,
      fallback: error.message,
    })
  return error instanceof Error ? error.message : String(error)
}

/** V3.2: "Die Analyse hat 10 Bedingungen. Ein Prüffall darf höchstens 8 haben …". */
export function tooManyConditions(n: number): string {
  const max = MAX_CONDITIONS
  return t`Die Analyse hat ${n} Bedingungen. Ein Prüffall darf höchstens ${max} haben, wie jede Modellantwort.`
}

/** One problem of an import in words (V1.3): what is wrong with the case. */
export function importProblemText(code: string, details: Details = {}): string {
  switch (code) {
    case 'case_id_taken':
      return t`Kennung doppelt (schon vorhanden)`
    case 'case_stale':
      return t`Ein Layer der Referenz fehlt oder ist für Sie nicht sichtbar`
    case 'case_invalid': {
      const reason = text(details.reason)
      const words = reason ? reasonText(reason, details) : null
      return words ?? t`Referenzabfrage ungültig oder Fall unvollständig`
    }
    default:
      return errorText(code, details)
  }
}
