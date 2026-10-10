// The status language of Modus B (design E2 "Statussprache"): a line style and
// a text label, never a colour of its own. Dashed = proposal, plan, run; solid
// accent = applied; grey with the label struck through = undone, rejected,
// refused, stale, aborted; black = clarification, message, error (nothing
// proposed). Only the Classical tokens; the text always says the status.
//
// The words and styles live here; ``StatusLabel`` (status.tsx) draws them.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ActionStatus, ModelActionView } from '../api/client'
import { proposalOnly } from './approval/governance'

/** The states the design names; more than ``ActionStatus``, which has no "veraltet". */
export type StatusKey =
  | 'thinking'
  | 'awaiting'
  | 'proposal'
  | 'approved'
  | 'applied'
  | 'auto'
  | 'by_hand'
  | 'rejected'
  | 'superseded'
  | 'undone'
  | 'refused'
  | 'stale'
  | 'running'
  | 'done'
  | 'aborted'
  | 'limited'
  | 'clarification'
  | 'message'
  | 'error'

export type LineStyle = 'dashed' | 'applied' | 'void' | 'message'

const LABELS: Record<StatusKey, MessageDescriptor> = {
  thinking: msg`Modell arbeitet …`,
  awaiting: msg`wartet auf Freigabe`,
  proposal: msg`Vorschlag`,
  approved: msg`freigegeben`,
  applied: msg`angewendet`,
  auto: msg`automatisch angewendet`,
  by_hand: msg`von Hand übernommen`,
  rejected: msg`abgelehnt`,
  superseded: msg`übergangen`,
  undone: msg`zurückgenommen`,
  refused: msg`abgewiesen`,
  stale: msg`veraltet`,
  running: msg`läuft`,
  done: msg`fertig`,
  aborted: msg`abgebrochen`,
  limited: msg`angehalten · Begrenzung`,
  clarification: msg`Rückfrage`,
  message: msg`Meldung`,
  error: msg`Fehler`,
}

export const STATUS_KEYS = Object.keys(LABELS) as StatusKey[]

export function lineStyle(key: StatusKey): LineStyle {
  switch (key) {
    case 'applied':
    case 'auto':
    case 'by_hand':
      return 'applied'
    case 'rejected':
    case 'superseded':
    case 'undone':
    case 'refused':
    case 'stale':
    case 'aborted':
      return 'void'
    case 'clarification':
    case 'message':
    case 'error':
      return 'message'
    default:
      return 'dashed'
  }
}

/** The status in words, in the active language. */
export const statusText = (key: StatusKey): string => i18n._(LABELS[key])

/** Border of a card or tree in a status's line style (an answer card, a plan, a run). */
export const FRAME: Record<LineStyle, string> = {
  dashed: 'border border-dashed border-accent',
  applied: 'border border-accent',
  void: 'border border-neutral-400',
  message: 'border border-ink',
}

export interface StatusOptions {
  /** The answer no longer fits the analysis (design M11.3 "veraltet"). */
  stale?: boolean
}

/** The design's status of an action record. */
export function statusKey(view: ModelActionView, options: StatusOptions = {}): StatusKey {
  if (options.stale) return 'stale'
  const status: ActionStatus = view.status
  switch (status) {
    case 'thinking':
      return 'thinking'
    case 'refused':
      return 'refused'
    case 'answered':
      return view.answer?.kind === 'clarification' ? 'clarification' : 'message'
    case 'proposed':
      // The server's flag (D1): applied by hand only, else it waits for approval.
      return proposalOnly(view) ? 'proposal' : 'awaiting'
    case 'approved':
      return 'approved'
    case 'running':
      // A chain halted before a step that needs approval is ``proposed`` again (P4).
      return 'running'
    case 'done':
      return 'done'
    case 'limited':
      return view.stop_reason === 'aborted' || view.stop_reason === 'interrupted'
        ? 'aborted'
        : 'limited'
    case 'applied':
      if (view.decision === 'auto') return 'auto'
      return view.applied_by_hand ||
        view.decision === 'proposal_only' ||
        view.decision === 'adjusted'
        ? 'by_hand'
        : 'applied'
    case 'rejected':
      return 'rejected'
    case 'superseded':
      return 'superseded'
    case 'undone':
      return 'undone'
    case 'aborted':
      return 'aborted'
    case 'failed':
      return 'error'
  }
}
