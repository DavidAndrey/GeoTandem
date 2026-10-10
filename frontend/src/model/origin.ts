// Origin mark "Modell" (plan P3, design "Herkunftsmarke"): a condition the model
// set carries the mark until its field, operator or value is changed by hand.
// Frontend only and session-local: the marks are a side map next to the
// analysis, keyed by row id, so neither a saved session nor a saved query can
// carry one (both serialise the analysis, never this map).
//
// A mark holds the row's content as the model set it. A row shows the mark
// while its content is still that: a hand edit in the editor hides it at once,
// "Verwerfen" brings it back with the old row, and "Übernehmen" drops the marks
// of changed rows for good (``prune``). Group edits (UND/ODER) and edits of other
// rows leave a row's mark alone.
import type { Group, Row } from '../analysis/model'
import { rows } from '../analysis/tree'

/** Row id → the row's content when the model set it. */
export type OriginMarks = Readonly<Record<string, string>>

/** Canonical JSON without ids: equal for equal content, whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter(([key]) => key !== 'id')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** What a hand edit changes: field, operator, value(s), negation, layer, distance, filter. */
export const fingerprint = (row: Row): string => canonical(row)

/** Marks the rows of ``tree`` (all, or those named in ``ids``) as set by the model. */
export function stamp(marks: OriginMarks, tree: Group, ids?: readonly string[]): OriginMarks {
  const chosen = rows(tree).filter((row) => !ids || ids.includes(row.id))
  return { ...marks, ...Object.fromEntries(chosen.map((row) => [row.id, fingerprint(row)])) }
}

export const isMarked = (marks: OriginMarks, row: Row): boolean =>
  marks[row.id] !== undefined && marks[row.id] === fingerprint(row)

/** Keeps only the marks of rows in ``tree`` that are still as the model set them. */
export function prune(marks: OriginMarks, tree: Group): OriginMarks {
  return Object.fromEntries(
    rows(tree)
      .filter((row) => isMarked(marks, row))
      .map((row) => [row.id, marks[row.id] as string]),
  )
}
