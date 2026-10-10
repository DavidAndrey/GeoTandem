// A proposed query object as an editor draft (design M4.2, M15.1): the rows of
// the readable tree (model/readable.ts) become the analysis's rows. Only an
// object the controls show without loss becomes a draft; the server refuses
// any other with ``not_representable`` (D3), so ``null`` here means "not for
// the editor", never a guess. This is the narrow case of E2.3; the general
// inverse ``toAnalysis`` with its shared case list is WP80's.
import type { Group, Node } from '../../analysis/model'
import { readQuery, type ReadNode } from '../readable'

export interface Draft {
  /** The catalog layer the query is about. */
  result: string
  tree: Group
}

/**
 * Row ids of one proposal: unique per action, so the origin marks of an
 * earlier answer never fall on this one's rows. ``q0`` is the readable tree's
 * id of the where clause, ``q0.1`` its second argument (readable.ts).
 */
const rowId = (action: number, readable: string) => `m${action}:${readable}`

function toNode(node: ReadNode, action: number): Node | null {
  if (node.kind === 'opaque' || node.kind === 'within') return null
  if (node.kind !== 'group') return { ...node, id: rowId(action, node.id) }
  const children = node.children.map((child) => toNode(child, action))
  if (children.some((child) => child === null)) return null
  return { ...node, id: rowId(action, node.id), children: children as Node[] }
}

/** The proposal of ``action`` as a draft, or ``null`` if the editor cannot show it. */
export function proposalDraft(query: unknown, action: number): Draft | null {
  const read = readQuery(query)
  // Order, limit, columns …: beyond the editor (D3).
  if (!read.source || read.extra.length > 0) return null
  const children = read.tree.children.map((child) => toNode(child, action))
  if (children.some((child) => child === null)) return null
  // The root keeps the analysis's id: "+ Bedingung" appends to 'root'.
  return { result: read.source, tree: { ...read.tree, children: children as Node[] } }
}
