// The words of the model log (design M16, plan section 2): a record's decision
// in one phrase, the key figures as counts with shares, the periods of the
// filter. Pure, so they are unit-tested.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import type {
  Approach,
  CellMode,
  Decision,
  KeyFigures,
  ModelActionSummary,
  ModelActionView,
} from '../../api/client'
import { formatNumber } from '../../i18n/locale'
import { cellLabel, reasonText } from '../approval/governance'

const DECISIONS: Record<Decision, MessageDescriptor> = {
  accepted: msg`angenommen`,
  adjusted: msg`angepasst`,
  rejected: msg`abgelehnt`,
  superseded: msg`übergangen`,
  auto: msg`auto angewendet`,
  proposal_only: msg`nur Vorschlag`,
  aborted: msg`abgebrochen`,
  failed: msg`Fehler`,
}

export const decisionText = (decision: Decision) => i18n._(DECISIONS[decision])

// The reject reasons' words are the approval's (design M5.3): one set for both.
export { reasonText }

type RefusalCode = NonNullable<ModelActionSummary['refusal_code']>

/** Why the application refused an answer (design M3), in a few words for a table cell. */
const REFUSALS: Record<RefusalCode, MessageDescriptor> = {
  invalid_query: msg`Abfrage ungültig`,
  unknown_layer: msg`Layer nicht vorhanden`,
  unknown_attribute: msg`Feld nicht vorhanden`,
  unsupported_operation: msg`Operation nicht möglich`,
  query_too_complex: msg`zu komplex`,
  invalid_query_geometry: msg`Geometrie ungültig`,
  name_clash: msg`Namenskonflikt`,
  key_type_mismatch: msg`Schlüsseltypen passen nicht`,
  attribute_not_text: msg`Feld ist kein Text`,
  attribute_not_numeric: msg`Feld ist keine Zahl`,
  wrong_value_type: msg`Wert passt nicht zum Feld`,
  model_query_invalid: msg`Abfrage ausserhalb des Schemas`,
  limit_exceeded: msg`zu viele Bedingungen`,
  not_representable: msg`nicht darstellbar`,
  step_limit: msg`zu viele Schritte`,
}

export const refusalText = (code: RefusalCode) => i18n._(REFUSALS[code])

const UNDONE = msg`zurückgenommen`

type Outcome = Pick<ModelActionSummary, 'status' | 'decision'> &
  Partial<Pick<ModelActionSummary, 'reject_reason' | 'refusal_code'>>

/**
 * How an entry ended, as the log's column "Entscheidung" says it: the decision
 * ("auto angewendet · zurückgenommen", "abgelehnt · falscher Wert"), else what
 * the record is ("abgewiesen · Layer nicht vorhanden", answered without a
 * proposal, still open).
 */
export function outcomeText(entry: Outcome): string {
  const parts = [baseOutcome(entry)]
  if (entry.status === 'undone') parts.push(i18n._(UNDONE))
  if (entry.reject_reason) parts.push(reasonText(entry.reject_reason))
  if (entry.refusal_code) parts.push(refusalText(entry.refusal_code))
  return parts.join(' · ')
}

function baseOutcome(entry: Outcome): string {
  if (entry.decision) return decisionText(entry.decision)
  switch (entry.status) {
    case 'refused':
      return t`abgewiesen`
    case 'answered':
      return t`ohne Vorschlag`
    case 'thinking':
      return t`Modell arbeitet …`
    default:
      return t`offen`
  }
}

/** The outcome of a full record, as the list says it. */
export const entryOutcome = (view: ModelActionView) =>
  outcomeText({ ...view, refusal_code: view.refusal?.code ?? null })

export const approachText = (approach: Approach) =>
  approach === 'chain' ? t`Werkzeugkette` : t`Direktabfrage`

/** A short approach for the list's column (design M16.1 "Direkt", "Kette"). */
export const approachShort = (approach: Approach) => (approach === 'chain' ? t`Kette` : t`Direkt`)

/**
 * A level cell in words: the matrix's own words (design "Stufen": aus /
 * Freigabe / auto), so the log says what the level popover (M7) says.
 */
export const modeText = (mode: CellMode) => cellLabel(mode)

/** The periods of the filter (design M16.1 "Letzte 30 Tage"); ``null``: all. */
export const PERIODS = [7, 30, 90, 365, null] as const
export type Period = (typeof PERIODS)[number]
export const DEFAULT_PERIOD: Period = 30

export function periodText(days: Period): string {
  if (days === null) return t`Gesamter Zeitraum`
  const n = formatNumber(days)
  return t`Letzte ${n} Tage`
}

/** The start of a period ending at ``now``, as an ISO time (the server takes a zone). */
export const periodStart = (days: Period, now: number): string | undefined =>
  days === null ? undefined : new Date(now - days * 86_400_000).toISOString()

/** A share as a whole percentage: "54 %"; "–" of nothing. */
export const share = (count: number, of: number) =>
  of > 0 ? formatNumber(count / of, { style: 'percent', maximumFractionDigits: 0 }) : '–'

export interface Figure {
  key: string
  label: string
  count: string
  /** The share of the figure it belongs to; none for the total. */
  share?: string
  /** What the share is of, for assistive technology and the tooltip. */
  of?: string
}

/**
 * The key-figure row (design M16.1): proposals, then each decision with its
 * share of them, the undone ones with their share of what they undid, and the
 * acceptance rate of section 2. "nur Vorschlag" and the undone approvals only
 * when there are any.
 */
export function keyFigures(f: KeyFigures): Figure[] {
  const count = (n: number) => formatNumber(n)
  const ofProposals = t`der Vorschläge`
  const decision = (key: Decision, n: number): Figure => ({
    key,
    label: decisionText(key),
    count: count(n),
    share: share(n, f.proposals),
    of: ofProposals,
  })
  const figures: Figure[] = [
    { key: 'proposals', label: t`Vorschläge`, count: count(f.proposals) },
    { ...decision('accepted', f.accepted), label: t`angenommen unverändert` },
  ]
  if (f.undone_after_approval > 0)
    figures.push({
      key: 'undone_after_approval',
      label: t`davon zurückgenommen`,
      count: count(f.undone_after_approval),
      share: share(f.undone_after_approval, f.accepted),
      of: t`der angenommenen`,
    })
  figures.push(
    decision('adjusted', f.adjusted),
    decision('rejected', f.rejected),
    decision('superseded', f.superseded),
  )
  if (f.proposal_only > 0) figures.push(decision('proposal_only', f.proposal_only))
  figures.push(decision('auto', f.auto), {
    key: 'undone',
    label: t`davon zurückgenommen`,
    count: count(f.undone),
    share: share(f.undone, f.auto),
    of: t`der automatisch angewendeten`,
  })
  return figures
}

/** "77 %", or "–" while nothing is decided (plan section 2). */
export const acceptanceRate = (f: KeyFigures) =>
  f.acceptance_rate === null
    ? '–'
    : formatNumber(f.acceptance_rate, { style: 'percent', maximumFractionDigits: 0 })

/** "abgewiesen 3 · abgebrochen 1 · Fehler 2" (design M16.1 note). */
export const notCounted = (f: KeyFigures) =>
  [
    `${t`abgewiesen`} ${formatNumber(f.not_counted.refused)}`,
    `${decisionText('aborted')} ${formatNumber(f.not_counted.aborted)}`,
    `${decisionText('failed')} ${formatNumber(f.not_counted.failed)}`,
  ].join(' · ')
