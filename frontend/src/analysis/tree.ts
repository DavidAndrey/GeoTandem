// Pure edits of the condition tree (design B2). Nodes are addressed by id.
import type { AttributeRow, Group, Node, ReferenceRow, Row, SpatialRow } from './model'

let counter = 0
export const newId = (prefix = 'n') =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

export const newAttributeRow = (attr = ''): AttributeRow => ({
  id: newId('a'),
  kind: 'attribute',
  not: false,
  attr,
  operator: 'eq',
  value: null,
  min: null,
  max: null,
  values: [],
})

export const newSpatialRow = (layer = ''): SpatialRow => ({
  id: newId('s'),
  kind: 'spatial',
  not: false,
  operator: 'in',
  layer,
  distance_m: null,
  filter: null,
})

export const newReferenceRow = (layer = ''): ReferenceRow => ({
  id: newId('r'),
  kind: 'reference',
  not: false,
  layer,
  fid: null,
  label: '',
  distance_m: 0,
})

export const newGroup = (op: Group['op'] = 'and'): Group => ({
  id: newId('g'),
  kind: 'group',
  op,
  not: false,
  children: [],
})

export function find(tree: Group, id: string): Node | null {
  if (tree.id === id) return tree
  for (const child of tree.children) {
    const found = child.kind === 'group' ? find(child, id) : child.id === id ? child : null
    if (found) return found
  }
  return null
}

/** Replace the node ``id`` by ``fn(node)``; ``null`` removes it. The root stays. */
export function mapNode(tree: Group, id: string, fn: (node: Node) => Node | null): Group {
  const visit = (node: Node): Node | null => {
    if (node.id === id) return fn(node)
    if (node.kind !== 'group') return node
    return { ...node, children: node.children.map(visit).filter((n): n is Node => n !== null) }
  }
  return (visit(tree) as Group | null) ?? tree
}

export function update<T extends Node>(tree: Group, id: string, patch: Partial<T>): Group {
  return mapNode(tree, id, (node) => ({ ...node, ...patch }) as Node)
}

export function remove(tree: Group, id: string): Group {
  return id === tree.id ? tree : mapNode(tree, id, () => null)
}

export function append(tree: Group, groupId: string, node: Node): Group {
  return mapNode(tree, groupId, (group) =>
    group.kind === 'group' ? { ...group, children: [...group.children, node] } : group,
  )
}

export function rows(tree: Group): Row[] {
  return tree.children.flatMap((child) => (child.kind === 'group' ? rows(child) : [child]))
}

/**
 * Changing the result layer (design B13): attribute conditions refer to the old
 * layer's fields and drop out; spatial and reference conditions stay.
 */
export interface AttributeDrop {
  dropped: AttributeRow[]
}

export function withoutAttributeRows(tree: Group): AttributeDrop & { tree: Group } {
  const dropped = rows(tree).filter((r): r is AttributeRow => r.kind === 'attribute')
  let result = tree
  for (const row of dropped) result = remove(result, row.id)
  return { tree: result, dropped }
}
