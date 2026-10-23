// A proposed query object as an editor draft (design M4.2, M15.1): the
// analysis ``toAnalysis`` finds for it (analysis/query.ts, D3) over the
// layers the controls know (the catalog, ``useLayers``). Only an object the
// controls show without loss becomes a draft; the server refuses any other
// with ``not_representable`` (D3), so ``null`` here means "not for the
// editor", never a guess. Both sides agree on the shared case list
// (schema/model-cases/represent.json, model/represent.test.ts).
import type { Group, Node } from '../../analysis/model'
import { toAnalysis } from '../../analysis/query'
import type { LayerInfo } from '../../api/client'

export interface Draft {
  /** The catalog layer the query is about. */
  result: string
  tree: Group
}

/**
 * Row ids of one proposal: unique per action, so the origin marks of an
 * earlier answer never fall on this one's rows. ``q0`` is the id
 * ``toAnalysis`` gives the where clause, ``q0.1`` its second argument (the
 * readable tree's, model/readable.ts).
 */
const rowId = (action: number, readable: string) => `m${action}:${readable}`

function withRowIds(node: Node, action: number): Node {
  if (node.kind !== 'group') return { ...node, id: rowId(action, node.id) }
  const children = node.children.map((child) => withRowIds(child, action))
  return { ...node, id: rowId(action, node.id), children }
}

/**
 * The proposal of ``action`` as a draft over the layers of ``catalog``, or
 * ``null`` if the editor cannot show it (or the layer list has not loaded).
 */
export function proposalDraft(
  query: unknown,
  action: number,
  catalog: readonly LayerInfo[] | undefined,
): Draft | null {
  const { analysis } = toAnalysis(query, catalog)
  if (!analysis) return null
  const children = analysis.tree.children.map((child) => withRowIds(child, action))
  // The root keeps the analysis's id: "+ Bedingung" appends to 'root'.
  return { result: analysis.result, tree: { ...analysis.tree, children } }
}

/**
 * The row an assumption's ``condition`` path points at (``Assumption.condition``:
 * indexes into the query's where tree, design M12.1), or ``null`` for the where
 * clause as a whole or a path into nothing.
 */
export function assumptionRow(path: readonly number[], action: number, tree: Group): string | null {
  // A where clause of one condition is the root's only row, ``q0`` (readable.ts).
  const id = rowId(action, ['q0', ...path].join('.'))
  const holds = (node: Node): boolean =>
    node.id === id || (node.kind === 'group' && node.children.some(holds))
  return tree.children.some(holds) ? id : null
}
