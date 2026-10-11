// What a level decides for an answer, in the interface's words (design M5,
// M6.3, M7; plan D1, D2). The level's name is free text from the
// administrator: nothing here keys on it, only on the matrix and the record's
// ``governance``, both as the server sent them.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import type { CellMode, ModelActionView, OpClass, RejectReason } from '../../api/client'
import { formatNumber } from '../../i18n/locale'

/** The classes in the matrix's order (design M7.1, M7.2 "Spalten"). */
export const OP_CLASSES: readonly OpClass[] = ['catalog', 'query', 'spatial', 'derive', 'display']

/** Class → cell, as the server sends a level's matrix. */
export type Matrix = ModelActionView['level']['matrix']

const CLASS_LABELS: Record<OpClass, MessageDescriptor> = {
  catalog: msg`Katalog lesen`,
  query: msg`Attributfilter`,
  spatial: msg`Raumfilter`,
  derive: msg`Abgeleitete Layer`,
  display: msg`Darstellung`,
}

const CELL_LABELS: Record<CellMode, MessageDescriptor> = {
  off: msg({ message: 'aus', context: 'level cell' }),
  approve: msg({ message: 'Freigabe', context: 'level cell' }),
  auto: msg({ message: 'auto', context: 'level cell' }),
}

/** The short column of M7.2: A = auto, F = Freigabe, – = aus. */
const CELL_SHORT: Record<CellMode, MessageDescriptor> = {
  off: msg({ message: '–', comment: 'Short level cell: off' }),
  approve: msg({ message: 'F', comment: 'Short level cell: Freigabe (approval)' }),
  auto: msg({ message: 'A', comment: 'Short level cell: auto' }),
}

/** The optional chip of a rejection (design M5.3), in the design's order. */
const REASONS: Record<RejectReason, MessageDescriptor> = {
  misunderstood: msg`falsch verstanden`,
  wrong_layer: msg`falscher Layer`,
  wrong_value: msg`falscher Wert`,
  other: msg({ message: 'anderes', context: 'reject reason' }),
}

export const REASON_ORDER = Object.keys(REASONS) as RejectReason[]

export const reasonText = (reason: RejectReason) => i18n._(REASONS[reason])

export const classLabel = (k: OpClass) => i18n._(CLASS_LABELS[k])
export const cellLabel = (cell: CellMode) => i18n._(CELL_LABELS[cell])
export const cellShort = (cell: CellMode) => i18n._(CELL_SHORT[cell])

/** "1 Bedingung", "3 Bedingungen". */
export function conditionCount(n: number) {
  const count = formatNumber(n)
  return plural(n, { one: `${count} Bedingung`, other: `${count} Bedingungen` })
}

/** "Attributfilter, Raumfilter". */
export const classList = (classes: readonly OpClass[]) => classes.map(classLabel).join(', ')

/**
 * The model may only propose (M4, D1, plan section 2): the server's stored
 * ``proposal_only`` (a class of the answer was ``off`` at the level as it
 * was). The user applies such a proposal by hand, ``approve`` is refused, and
 * an overtaken one ends ``proposal_only``. The one predicate for it: status,
 * approval, auto run and the decision of an overtaken record all ask this,
 * never the matrix.
 */
export const proposalOnly = (view: ModelActionView): boolean => view.proposal_only

/** A query answer waiting for the user's approval (M5): a cell ``approve``, not proposal-only. */
export const needsApproval = (view: ModelActionView): boolean =>
  view.status === 'proposed' &&
  view.answer?.kind === 'query' &&
  !proposalOnly(view) &&
  view.governance?.cell === 'approve'

/** A query proposal the user applies by hand in the editor (M4.1): proposal-only, still open. */
export const byHandOnly = (view: ModelActionView): boolean =>
  view.status === 'proposed' && view.answer?.kind === 'query' && proposalOnly(view)

/**
 * An ``auto`` answer the server stored ``approved``: the client executes it at
 * once (P7). Never a repeat (``compare_of``, WP76): the server stores it
 * ``proposed`` whatever the cell, so one that is ``approved`` was approved by
 * the person, whose *Diese übernehmen* executes it (store.py ``_unasked``).
 */
export const autoReady = (view: ModelActionView): boolean =>
  view.status === 'approved' &&
  view.decision === null &&
  view.answer?.kind === 'query' &&
  !proposalOnly(view) &&
  view.governance?.cell === 'auto' &&
  view.compare_of == null

/** The classes of an answer whose cells differ (M6.3): the list says why the strictest governs. */
export const mixed = (view: ModelActionView): boolean => {
  const { governance } = view
  if (!governance) return false
  const cells = new Set(governance.classes.map((k) => view.level.matrix[k]))
  return cells.size > 1
}
