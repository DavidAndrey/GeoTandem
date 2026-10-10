// Origin mark "Modell" (plan P3, design "Herkunftsmarke"): a condition the model
// set carries the mark until its field, operator or value is changed by hand.
// Frontend only and session-local: the marks are a side record next to the
// analysis, keyed by row id, so neither a saved session nor a saved query can
// carry one (both serialise the analysis, never this record).
//
// A hand edit of a row in the editor touches it: the mark is hidden at once,
// "Übernehmen" drops it for good, "Verwerfen" brings it back with the old row.
// Changing a value and back again still counts as an edit. Group edits
// (UND/ODER) and edits of other rows leave a row's mark alone.
import type { Group, Row } from '../analysis/model'
import { find, rows } from '../analysis/tree'

type Ids = Readonly<Record<string, true>>

export interface Origin {
  /** Rows the model set, as applied. */
  marks: Ids
  /** Rows edited by hand in the open editor draft. */
  touched: Ids
}

export const NO_ORIGIN: Origin = { marks: {}, touched: {} }

const only = (ids: string[]): Ids => Object.fromEntries(ids.map((id) => [id, true] as const))

const without = (ids: Ids, drop: string[]): Ids =>
  only(Object.keys(ids).filter((id) => !drop.includes(id)))

/** Marks the rows of ``tree`` (all, or those named in ``ids``) as set by the model. */
export function stamp(origin: Origin, tree: Group, ids?: readonly string[]): Origin {
  const chosen = rows(tree)
    .map((row) => row.id)
    .filter((id) => !ids || ids.includes(id))
  return { marks: { ...origin.marks, ...only(chosen) }, touched: without(origin.touched, chosen) }
}

export const isMarked = (origin: Origin, row: Row): boolean =>
  origin.marks[row.id] === true && origin.touched[row.id] !== true

/** A hand edit of row ``id`` in ``tree`` with ``patch``; edits of a group touch nothing. */
export function touch(origin: Origin, tree: Group, id: string, patch: object): Origin {
  const node = find(tree, id)
  if (!node || node.kind === 'group' || origin.touched[id]) return origin
  const before = new Map<string, unknown>(Object.entries(node))
  const changed = Object.entries(patch).some(
    ([key, value]) => JSON.stringify(before.get(key)) !== JSON.stringify(value),
  )
  return changed ? { ...origin, touched: { ...origin.touched, [id]: true } } : origin
}

/** "Übernehmen": the marks of the draft's untouched rows stay, the others are gone. */
export const applied = (origin: Origin, draft: Group): Origin => ({
  marks: only(
    rows(draft)
      .filter((row) => isMarked(origin, row))
      .map((row) => row.id),
  ),
  touched: {},
})

/** "Verwerfen": the edits are gone, so are their touches; marks of the tree's rows stay. */
export const discarded = (origin: Origin, tree: Group): Origin => ({
  marks: only(
    rows(tree)
      .filter((row) => origin.marks[row.id])
      .map((row) => row.id),
  ),
  touched: {},
})
