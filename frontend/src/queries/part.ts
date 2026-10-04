// The query part of the analysis, as a saved query holds it (plan E1.7b, Q1).
// Pure: what can be saved, whether it changed, how it fits today's layers.
import { t } from '@lingui/core/macro'
import type { Analysis, Group, Node, QueryPart, QueryRef, Row } from '../analysis/model'
import { resultLayer } from '../analysis/query'

export const QUERY_STATE_VERSION = 1

/** The part to save; ``null`` without a result layer or on a derived one (Q2). */
export function queryPart(analysis: Analysis): QueryPart | null {
  const layer = resultLayer(analysis)
  if (!layer || layer.source.kind !== 'catalog') return null
  return { result: layer.source.layer, tree: analysis.tree, restriction: analysis.restriction }
}

export const snapshotOf = (part: QueryPart | null) => JSON.stringify(part)

/** Changed since it was opened or saved ("geändert"). */
export function isChanged(analysis: Analysis, ref: QueryRef | null): boolean {
  return ref !== null && snapshotOf(queryPart(analysis)) !== ref.snapshot
}

/**
 * Whether choosing another query would lose work (design B1 "bei Änderungen
 * mit Rückfrage"): a changed saved query, or conditions never saved at all.
 */
export function wouldLose(analysis: Analysis, ref: QueryRef | null): boolean {
  if (ref) return isChanged(analysis, ref)
  return analysis.tree.children.length > 0 || analysis.restriction !== null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads a saved query's state; ``null`` if it is not one this version knows. */
export function partFrom(version: number, state: unknown): QueryPart | null {
  if (version !== QUERY_STATE_VERSION || !isObject(state)) return null
  const tree = state.tree
  if (typeof state.result !== 'string' || !isObject(tree) || tree.kind !== 'group') return null
  return {
    result: state.result,
    tree: tree as unknown as Group,
    restriction: (state.restriction ?? null) as QueryPart['restriction'],
  }
}

/** Fits a saved query to the layers available now (like a session, design C8). */
export function fitQuery(
  part: QueryPart,
  available: Set<string>,
): { part: QueryPart; removed: Row[] } | null {
  if (!available.has(part.result)) return null
  const removed: Row[] = []
  const keep = (node: Node): Node | null => {
    if (node.kind === 'group')
      return { ...node, children: node.children.map(keep).filter((n): n is Node => n !== null) }
    if (node.kind !== 'attribute' && node.layer && !available.has(node.layer)) {
      removed.push(node)
      return null
    }
    return node
  }
  return { part: { ...part, tree: keep(part.tree) as Group }, removed }
}

/** "1 A · 2 R" (design C6). */
export function conditionLabel(c: { attribute: number; spatial: number; restriction: boolean }) {
  const parts = [
    c.attribute ? `${c.attribute} A` : '',
    c.spatial ? `${c.spatial} R` : '',
    c.restriction ? t`Fläche` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'keine'
}
