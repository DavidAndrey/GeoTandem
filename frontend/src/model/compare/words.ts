// The comparison in words (design M10.2, M10.3; plan WP76, WP78). The server
// gives the difference and its reason as data (``Comparison``); the words are
// the interface's own. A condition is said as the editor and the answer say it
// (editor/describe.ts over the rows of readable.ts), so there is no second
// describer; a layer by its catalog title.
import { t } from '@lingui/core/macro'
import type { CompareReason, FeatureRef } from '../../api/client'
import { describe, objectLabel } from '../../editor/describe'
import type { labelsFor } from '../../editor/fields'
import { formatNumber } from '../../i18n/locale'
import { compactQuery, readCondition } from '../readable'

/** What ``describe`` needs: the labels of the result layer and of a related layer's fields. */
export type Words = Pick<ReturnType<typeof labelsFor>, 'labels' | 'filterLabels'>

/**
 * One condition of the reason as the controls say it. The server sends a full
 * dump (``where: null`` on a relation without filter, a text match's
 * defaults): read as compact, as every query is. A condition the controls
 * cannot show stays JSON, never guessed.
 */
export function conditionText(condition: unknown, words: Words): string {
  const node = readCondition(compactQuery(condition), 'reason')
  switch (node.kind) {
    case 'opaque': {
      const json = node.json
      return t`ohne Klartext: ${json}`
    }
    case 'within':
      return node.shape === 'view' ? t`nur im Kartenausschnitt` : t`nur in der Fläche`
    default:
      return describe(node, words.labels, words.filterLabels)
  }
}

/** The names of the sides, as the dialog's columns are headed. */
export interface Sides {
  left: string
  right: string
}

/**
 * The structured reason (WP76) as sentences: another result layer, by title;
 * or the conditions that differ one by one, each side's in the editor's words,
 * or present on one side only. ``null`` gives none: the server says one only
 * where the two queries show it.
 */
export function reasonLines(
  reason: CompareReason | null | undefined,
  words: Words,
  sides: Sides,
): string[] {
  if (!reason) return []
  const { left: leftSide, right: rightSide } = sides
  if (reason.kind === 'source') {
    const left = words.labels.layer(reason.left)
    const right = words.labels.layer(reason.right)
    return [
      t`Die Treffer sind Objekte verschiedener Layer: ${leftSide} liefert „${left}“, ${rightSide} „${right}“.`,
    ]
  }
  return reason.changes.map(({ left, right }) => {
    const before = left ? conditionText(left, words) : ''
    const after = right ? conditionText(right, words) : ''
    if (left && right) return t`${leftSide} „${before}“, ${rightSide} „${after}“`
    if (left) return t`Nur ${leftSide}: „${before}“`
    return t`Nur ${rightSide}: „${after}“`
  })
}

/** "2 nur links, 1 nur rechts" (design M10.3). */
export function differenceTitle(onlyLeft: number, onlyRight: number): string {
  const left = formatNumber(onlyLeft)
  const right = formatNumber(onlyRight)
  return t`${left} nur links, ${right} nur rechts`
}

/** At most this many names per side; the rest is counted. */
export const NAMES_SHOWN = 12

/** "Primarstufe Wichtrach, Objekt 7 und 3 weitere": a feature without a name by its id. */
export function featureNames(features: readonly FeatureRef[]): string {
  const shown = features
    .slice(0, NAMES_SHOWN)
    .map((f) => f.name ?? objectLabel(f.id))
    .join(', ')
  const more = features.length - NAMES_SHOWN
  if (more <= 0) return shown
  const count = formatNumber(more)
  return t`${shown} und ${count} weitere`
}
