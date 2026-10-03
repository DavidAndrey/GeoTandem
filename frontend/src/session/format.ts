// The analysis state as a session saves it (design C7; plan E1.7, S5): what
// the user built, the table's columns and sort, and the map view. Versioned,
// so a later version can read what an earlier one wrote.
import type {
  Analysis,
  DisplayLayer,
  Group,
  Node,
  QueryRef,
  Row,
  TableState,
} from '../analysis/model'
import type { BBox } from '../map/view'

export const STATE_VERSION = 1

export interface SavedState {
  analysis: Analysis
  table: TableState
  /** The map view when saved; moving the map is no change, but opening restores it (plan D3). */
  view: BBox | null
  /** The saved query it came from (plan E1.7b, Q6); added later, absent in older states. */
  queryRef?: QueryRef | null
}

export class SessionFormatError extends Error {}

export function toSaved(saved: SavedState): {
  state_version: number
  state: Record<string, unknown>
} {
  const { analysis, table, view, queryRef } = saved
  return {
    state_version: STATE_VERSION,
    state: {
      layers: analysis.layers,
      result: analysis.result,
      tree: analysis.tree,
      restriction: analysis.restriction,
      table,
      view,
      // ``query.id`` is what the server counts as a use of the saved query (design C6).
      query: queryRef ?? null,
    },
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads a saved state; refuses versions it does not know instead of guessing. */
export function fromSaved(version: number, state: unknown): SavedState {
  if (version !== STATE_VERSION)
    throw new SessionFormatError(
      `Die Sitzung wurde mit Format ${version} gespeichert; diese Version liest Format ${STATE_VERSION}.`,
    )
  if (
    !isObject(state) ||
    !Array.isArray(state.layers) ||
    !isObject(state.tree) ||
    state.tree.kind !== 'group' ||
    !isObject(state.table)
  )
    throw new SessionFormatError('Die gespeicherte Sitzung ist unvollständig.')
  return {
    analysis: {
      layers: state.layers as DisplayLayer[],
      result: typeof state.result === 'string' ? state.result : null,
      tree: state.tree as unknown as Group,
      restriction: (state.restriction ?? null) as Analysis['restriction'],
    },
    table: state.table as unknown as TableState,
    view: Array.isArray(state.view) && state.view.length === 4 ? (state.view as BBox) : null,
    queryRef: isObject(state.query) ? (state.query as unknown as QueryRef) : null,
  }
}

/** Catalog layers a displayed layer needs: its own, or its recipe's sources. */
export function layersOf(layer: DisplayLayer): string[] {
  if (layer.source.kind === 'catalog') return [layer.source.layer]
  const recipe = layer.source.recipe
  switch (recipe.op) {
    case 'buffer':
      return [recipe.layer]
    case 'join':
      return [recipe.layer, recipe.join.layer]
    case 'aggregate':
      return [recipe.layer, recipe.aggregate.by_layer]
  }
}

export interface Removed {
  layers: DisplayLayer[]
  /** Conditions on a layer that is gone; removed and listed (plan D5). */
  rows: Row[]
  /** The result layer is gone: the session opens without a result (design C8). */
  result: boolean
}

/**
 * Fits a saved state to the layers this account can use now (design C8):
 * layers that are gone, or derived from one that is, leave the analysis, and
 * so do conditions on them. Everything removed is reported, nothing silently.
 */
export function reconcile(
  saved: SavedState,
  available: Set<string>,
): { saved: SavedState; removed: Removed } {
  const { analysis, table } = saved
  const gone = analysis.layers.filter((l) => !layersOf(l).every((name) => available.has(name)))
  const goneIds = new Set(gone.map((l) => l.id))
  const rows: Row[] = []
  const keep = (node: Node): Node | null => {
    if (node.kind === 'group')
      return { ...node, children: node.children.map(keep).filter((n): n is Node => n !== null) }
    if (node.kind !== 'attribute' && node.layer && !available.has(node.layer)) {
      rows.push(node)
      return null
    }
    return node
  }
  const result = analysis.result !== null && goneIds.has(analysis.result)
  const without = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !goneIds.has(id)))
  return {
    saved: {
      ...saved,
      analysis: {
        ...analysis,
        layers: analysis.layers.filter((l) => !goneIds.has(l.id)),
        result: result ? null : analysis.result,
        tree: keep(analysis.tree) as Group,
      },
      table: {
        ...table,
        tab: table.tab && goneIds.has(table.tab) ? null : table.tab,
        columns: without(table.columns),
        sort: without(table.sort),
      },
    },
    removed: { layers: gone, rows, result },
  }
}

export const nothingRemoved = (removed: Removed) =>
  removed.layers.length === 0 && removed.rows.length === 0 && !removed.result
