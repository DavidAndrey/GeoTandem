// A run in words (plan E3, D6, D7, D12, design V4-V7): figures, money, the
// verdicts and their short forms, the comparison words, the matrix's groups
// and the stage-1 diff. Pure, so they are unit-tested.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural, t } from '@lingui/core/macro'
import type {
  AnswerView,
  Cell,
  ComparisonWord,
  DiffEntry,
  Money,
  PointComparison,
  RunCase,
  RunScope,
  PointLabel,
  RunStatus,
  RunSummary,
  Split,
  Verdict,
} from '../../api/client'
import { objectLabel } from '../../editor/describe'
import { errorText } from '../../i18n/errors'
import { dateTimeFormat, formatNumber, parseTimestamp } from '../../i18n/locale'
import type { Change } from '../../model/approval/changes'
import { conditionText, type Words } from '../../model/compare/words'
import type { StatusKey } from '../../model/statusKey'
import { examplesLabel, outputLabel } from '../promptProfile'
import { placementText } from './profileOptions'
import { isBehaviour, kindText, notRun, tagText, type AnswerKind } from './words'

/** Repeats of a case per measuring point: two seed blocks of five, or one (D7, O2). */
export const BLOCK = 5
export const repeats = (scope: RunScope) => (scope === 'full' ? 2 * BLOCK : BLOCK)

// --- addresses (design: Navigation und Adressen) ---------------------------------

export const RUNS = '/admin/bewertung'
export const runPath = (id: number) => `/admin/bewertung/lauf/${id}`
export const NEW_RUN = '/admin/bewertung/lauf/neu'
/** A cell's case in a run (V7); ``split`` keeps the matrix's part for ‹ ›. */
export const casePath = (run: number, caseId: string, point: number, split?: Split | null) =>
  `${runPath(run)}/fall/${encodeURIComponent(caseId)}?punkt=${point}` +
  (split ? `&teil=${split}` : '')

/** The parts of a profile other than the default examples and output: "nur Text". */
function profileExtras(p: PointLabel['prompt_profile']): string[] {
  const parts: string[] = []
  if (p.examples !== 'standard') parts.push(examplesLabel(p.examples))
  if (p.output !== 'constrained') parts.push(outputLabel(p.output))
  return parts
}

/** "gpt-6-luna P9", "Claude Haiku 5.5 P0 · nur Text": a column by connection and profile. */
export function pointName(label: PointLabel): string {
  const p = label.prompt_profile
  return [`${label.connection_name} ${placementText(p.placement)}`, ...profileExtras(p)].join(' · ')
}

/** "lokal · P0", "api.anthropic.com · P0 · nur Text": the line under a column's name. */
export function pointSub(label: PointLabel): string {
  const where = label.locality === 'local' ? t`lokal` : label.host
  const parts = [where, placementText(label.prompt_profile.placement)]
  parts.push(...profileExtras(label.prompt_profile))
  if (label.system_prompt != null) parts.push(t`System-Prompt geändert`)
  return parts.join(' · ')
}

// --- numbers ----------------------------------------------------------------------

/** "82.4 %" (numbers as in Switzerland, ``formatNumber``). */
export const rateText = (rate: number | null | undefined) => {
  if (rate === null || rate === undefined) return '–'
  const value = formatNumber(rate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return t`${value} %`
}

/** "0.92 USD"; the currency code is the price's own (O4). */
export const moneyText = (m: Money) => {
  const amount = formatNumber(m.amount, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${amount} ${m.currency}`
}

/** "2.06 USD · 0.40 EUR"; ``null`` for no priced cost. */
export const moniesText = (list: readonly Money[] | undefined) =>
  list?.length ? list.map(moneyText).join(' · ') : null

/** "1.9 Mio", "850'000". */
export const tokensText = (n: number) => {
  if (n < 1_000_000) return formatNumber(n)
  const value = formatNumber(n / 1_000_000, { maximumFractionDigits: 1 })
  return t`${value} Mio`
}

/** "≈ 17 min", "≈ 40 s". */
export const durationText = (seconds: number) => {
  if (seconds < 60) {
    const s = formatNumber(Math.max(1, Math.round(seconds)))
    return t`≈ ${s} s`
  }
  const m = formatNumber(Math.round(seconds / 60))
  return t`≈ ${m} min`
}

/** "1.4 s". */
export const latencyText = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '–'
  const value = formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return t`${value} s`
}

/** "9 von 10". */
export const ofText = (part: number, whole: number) => {
  const a = formatNumber(part)
  const b = formatNumber(whole)
  return t`${a} von ${b}`
}

/** "+6.6 Punkte (+1.3 … +13.2)": the mean difference and its 95 % interval (D7). */
export function differenceText(c: Pick<PointComparison, 'mean' | 'low' | 'high'>): string {
  const signed = (x: number) =>
    formatNumber(x, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    })
  const mean = signed(c.mean)
  const low = signed(c.low)
  const high = signed(c.high)
  return t`${mean} Punkte (${low} … ${high})`
}

const WORDS: Record<ComparisonWord, MessageDescriptor> = {
  better: msg`besser`,
  worse: msg`schlechter`,
  not_proven: msg`nicht belegt`,
}
/** *besser*, *schlechter*, *nicht belegt* (D7); "nicht belegt" is no failure. */
export const wordText = (word: ComparisonWord) => i18n._(WORDS[word])

// --- a run ------------------------------------------------------------------------

/** The status language of E2 for a run: line style and label, never colour alone. */
export const runStatusKey = (status: RunStatus): StatusKey =>
  status === 'failed' ? 'error' : status

export const scopeText = (scope: RunScope) =>
  scope === 'full' ? t`Vollständig · 2 × 5` : t`Schnelltest · 1 × 5`

export const scopeShort = (scope: RunScope) => (scope === 'full' ? t`Vollständig` : t`Schnelltest`)

/** "41 %" of a running run: rounded, never 100 before the last answer. */
export const progressPercent = (done: number, total: number) =>
  total > 0 ? Math.min(done < total ? 99 : 100, Math.round((done / total) * 100)) : 0

/** Two runs can be put side by side: both done, the same cases (D7, V5.1). */
export function comparable(a: RunSummary, b: RunSummary): string | null {
  const first = a.id
  const second = b.id
  for (const run of [a, b]) {
    const id = run.id
    if (run.status !== 'done')
      return t`#${id} ist nicht vollständig; Gegenüberstellen nur bei vollständigen Läufen.`
  }
  if (a.case_set_hash !== b.case_set_hash)
    return t`#${first} und #${second} haben andere Prüffälle; Gegenüberstellen nur bei gleichen Fällen.`
  return null
}

/** Why a failed run stopped (``RunView.error``), in words. */
export function runErrorText(code: string): string {
  if (code === 'no_cases')
    return t`Keiner der Prüffälle liess sich beim Lauf lesen; der Lauf hat nichts gemessen.`
  if (code === 'internal_error') return errorText(code)
  const words = errorText(code)
  return t`${words} Die Messpunkte dieser Anbindung wurden angehalten.`
}

/** "seit 10:02". */
export const clock = (iso: string) =>
  dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(parseTimestamp(iso))

/** The time left of a running run from its pace so far; ``null`` before the first answer. */
export function remainingSeconds(startedAt: string, done: number, total: number, now: number) {
  if (done <= 0) return null
  const elapsed = (now - parseTimestamp(startedAt).getTime()) / 1000
  return Math.max(0, (elapsed / done) * (total - done))
}

// --- verdicts ---------------------------------------------------------------------

const VERDICTS: Record<Verdict, MessageDescriptor> = {
  pass: msg`richtig`,
  wrong: msg`falsch`,
  refused: msg`abgewiesen`,
  kind: msg`andere Antwortart`,
  other_approach: msg`andere Arbeitsweise`,
  forbidden: msg`unzulässig`,
  error: msg`nicht lesbar · Fehler`,
}
/** The short forms of the matrix (V6.2): f, a, x, w, u, n. */
const SHORT: Record<Exclude<Verdict, 'pass'>, MessageDescriptor> = {
  wrong: msg`f`,
  refused: msg`a`,
  kind: msg`x`,
  other_approach: msg`w`,
  forbidden: msg`u`,
  error: msg`n`,
}
export const SHORT_ORDER: Exclude<Verdict, 'pass'>[] = [
  'wrong',
  'refused',
  'kind',
  'other_approach',
  'forbidden',
  'error',
]

export const verdictText = (v: Verdict) => i18n._(VERDICTS[v])
export const shortText = (v: Exclude<Verdict, 'pass'>) => i18n._(SHORT[v])

/** "f falsch · a abgewiesen · …": the legend above the matrix. */
export const legendText = () =>
  SHORT_ORDER.map((v) => `${shortText(v)} ${verdictText(v)}`).join(' · ')

/** "1 f · 2 a": the rest of a cell, without the passes. */
export function mixText(cell: Pick<Cell, 'verdicts'>): string {
  return SHORT_ORDER.filter((v) => (cell.verdicts[v] ?? 0) > 0)
    .map((v) => `${formatNumber(cell.verdicts[v] ?? 0)} ${shortText(v)}`)
    .join(' · ')
}

/** "6 still falsch". */
export const silentlyText = (n: number) => {
  const count = formatNumber(n)
  return t`${count} still falsch`
}

/** "still falsch": a wrong answer that states no assumption (D6). */
export const isSilentlyWrong = (a: Pick<AnswerView, 'verdict' | 'flags'>) =>
  a.verdict === 'wrong' && (a.flags ?? []).includes('no_assumption')

/** "1.3": the seed block and the repeat within it (V7.1). */
export function repeatNames(answers: readonly AnswerView[]): Map<AnswerView, string> {
  const names = new Map<AnswerView, string>()
  const byBlock = new Map<number, AnswerView[]>()
  for (const a of answers) byBlock.set(a.block, [...(byBlock.get(a.block) ?? []), a])
  for (const [block, list] of byBlock)
    [...list]
      .sort((x, y) => x.seed - y.seed)
      .forEach((a, i) => names.set(a, `${formatNumber(block)}.${formatNumber(i + 1)}`))
  return names
}

/** The answer kind given, for a behaviour case (V7.5). */
export function givenKind(a: AnswerView): string {
  const kind = a.answer?.kind
  if (kind === 'query' || kind === 'clarification' || kind === 'cannot_answer')
    return kindText(kind as AnswerKind)
  if (kind === 'plan') return t`Werkzeugkette`
  return verdictText(a.verdict)
}

/** The code of a refused or failed answer in words; the raw code stays under "Technisch". */
export function answerCodeText(a: Pick<AnswerView, 'code' | 'refusal'>): string {
  const code = a.refusal?.code ?? a.code
  if (!code) return t`Ohne Angabe eines Grundes.`
  return errorText(code, a.refusal?.details ?? {}, a.refusal?.message)
}

// --- the matrix -------------------------------------------------------------------

export interface Group {
  key: string
  title: string
  cases: RunCase[]
}

/**
 * The rows of the matrix (V6.2): the cases that ran on ``split``, grouped by
 * their first tag (the start set's kind: räumlich, Attribut …), behaviour
 * cases together under "Verhalten"; groups in the order of their first case.
 */
export function groupCases(cases: readonly RunCase[], split: Split | null): Group[] {
  const groups = new Map<string, Group>()
  for (const rc of cases) {
    if (notRun(rc.status)) continue
    if (split && rc.case.split !== split) continue
    const behaviour = isBehaviour(rc.case)
    const key = behaviour ? ':behaviour' : (rc.case.tags[0] ?? ':other')
    const title = behaviour
      ? t`Verhalten`
      : rc.case.tags[0]
        ? tagText(rc.case.tags[0])
        : t`ohne Stichwort`
    const group = groups.get(key) ?? { key, title, cases: [] }
    group.cases.push(rc)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** "räumlich · 11 Fälle". */
export const groupTitle = (g: Group) =>
  plural(g.cases.length, { one: `${g.title} · # Fall`, other: `${g.title} · # Fälle` })

/** The key of a cell in ``cellMap``. */
export const cellKey = (caseId: string, point: number) => `${caseId}:${point}`

/** The cells by case and point, built once per render. */
export const cellMap = (cells: readonly Cell[]) =>
  new Map(cells.map((c) => [cellKey(c.case_id, c.point), c]))

/** The case ids in the matrix's order (groups, then their rows) for ‹ › of V7. */
export const matrixOrder = (cases: readonly RunCase[], split: Split | null) =>
  groupCases(cases, split).flatMap((g) => g.cases.map((rc) => rc.case.id))

/** The cells of one point summed over cases: "86 von 110". */
export function sumCells(cells: readonly Cell[], caseIds: ReadonlySet<string>, point: number) {
  let passed = 0
  let answers = 0
  for (const c of cells)
    if (c.point === point && caseIds.has(c.case_id)) {
      passed += c.passed
      answers += c.answers
    }
  return { passed, answers }
}

// --- the stage-1 diff -------------------------------------------------------------

const json = (value: unknown) => JSON.stringify(value)

/** The parts of a query besides ``where`` that decide its features (``diff.PARTS``). */
const PART_LABELS: Record<string, MessageDescriptor> = {
  attribute_join: msg`Verknüpfung`,
  buffer: msg`Puffer`,
  spatial_relation: msg`Räumliche Beziehung`,
  aggregate: msg`Zusammenfassung`,
  columns: msg`Berechnete Spalten`,
  order_by: msg`Sortierung`,
  limit: msg`Begrenzung`,
}
const partText = (path: string) => (PART_LABELS[path] ? i18n._(PART_LABELS[path]) : path)

/** "Begrenzung fehlt: 10", "Puffer zusätzlich: …", "Sortierung geändert: … → …". */
function partChange(entry: DiffEntry): Change {
  const part = partText(entry.path)
  const before = json(entry.reference)
  const after = json(entry.answer)
  if (entry.kind === 'missing') return { sign: '−', text: t`${part} fehlt: ${before}` }
  if (entry.kind === 'added') return { sign: '+', text: t`${part} zusätzlich: ${after}` }
  return { sign: '~', text: t`${part} geändert: ${before} → ${after}` }
}

/**
 * One difference of stage 1 (D5) as a line of the change list (+ − ~, as the
 * approval's): a condition in the editor's words, another part of the query
 * by its name with its JSON.
 */
export function diffChange(entry: DiffEntry, words: Words): Change {
  if (entry.kind !== 'source' && !entry.path.startsWith('where')) return partChange(entry)
  const said = (node: unknown) => conditionText(node, words)
  switch (entry.kind) {
    case 'source': {
      const reference = words.labels.layer(String(entry.reference))
      const answer = words.labels.layer(String(entry.answer))
      return { sign: '~', text: t`Ergebnis-Layer: ${reference} → ${answer}` }
    }
    case 'missing': {
      const text = said(entry.reference)
      return { sign: '−', text: t`fehlende Bedingung: ${text}` }
    }
    case 'added': {
      const text = said(entry.answer)
      return { sign: '+', text: t`zusätzliche Bedingung: ${text}` }
    }
    case 'changed': {
      const before = said(entry.reference)
      const after = said(entry.answer)
      return { sign: '~', text: t`Bedingung „${before}“ als „${after}“` }
    }
  }
}

/** At most this many ids are named; the rest is counted, with the exact total. */
export const IDS_SHOWN = 12

/** "Objekt 14, Objekt 15, … und 77 weitere": ids of a capped list with its exact count. */
export function idsText(ids: readonly number[], count: number): string {
  const shown = ids.slice(0, IDS_SHOWN).map(objectLabel).join(', ')
  const more = count - Math.min(ids.length, IDS_SHOWN)
  if (more <= 0) return shown
  const n = formatNumber(more)
  return t`${shown} und ${n} weitere`
}
