// The analysis state of the classic mode as one store (tech-stack 4.4, plan D1).
// Server state stays in TanStack Query; this holds only what the user built.
import { create } from 'zustand'
import type {
  ColumnChoice,
  DisplayLayer,
  Group,
  Id,
  Node,
  QueryPart,
  QueryRef,
  Recipe,
  Restriction,
  SortKey,
  Symbology,
  TableState,
} from './model'
import type { Analysis } from './model'
import { canBeResult, emptyTree } from './query'
import * as T from './tree'

interface AnalysisStore extends Analysis {
  /** The editor's working copy (design B2): "Übernehmen" writes it, "Verwerfen" drops it. */
  draft: Group | null
  /** Changed since the last save; moving the map does not count (design decision 3). */
  dirty: boolean
  table: TableState
  queryRef: QueryRef | null

  /** ``table``: a table layer, shown in the attribute table only (design B11). */
  addLayer: (layer: string, asResult?: boolean, table?: boolean) => void
  addDerived: (name: string, recipe: Recipe) => Id
  removeLayer: (id: Id) => void
  moveLayer: (id: Id, toIndex: number) => void
  setVisible: (id: Id, visible: boolean) => void
  setOpacity: (id: Id, opacity: number) => void
  setSymbology: (id: Id, symbology: Symbology | null) => void
  updateRecipe: (id: Id, recipe: Recipe, name?: string) => void
  /** Returns the attribute conditions that dropped out (design B13). */
  setResult: (id: Id) => T.AttributeDrop

  edit: () => void
  editNode: <N extends Node>(id: string, patch: Partial<N>) => void
  addNode: (groupId: string, node: Node) => void
  removeNode: (id: string) => void
  apply: () => void
  discard: () => void
  setRestriction: (restriction: Restriction) => void

  setTableTab: (id: Id | null) => void
  setTableMode: (mode: TableState['mode']) => void
  setOnlyView: (onlyView: boolean) => void
  setColumns: (id: Id, choice: ColumnChoice) => void
  /** Header click: ↓ / ↑ / aus; ``additive`` (Shift) sets the second key (design B8). */
  toggleSort: (id: Id, attr: string, additive: boolean) => void

  /** Replaces result layer, conditions and restriction by a saved query's (design B1). */
  applyQuery: (part: QueryPart, ref: QueryRef | null) => void
  setQueryRef: (ref: QueryRef | null) => void

  reset: () => void
  load: (analysis: Analysis, table?: TableState, queryRef?: QueryRef | null) => void
  /** After saving: the state is unchanged, it just no longer counts as unsaved. */
  markSaved: () => void
}

export const emptyTable = (): TableState => ({
  tab: null,
  mode: 'hits',
  onlyView: false,
  columns: {},
  sort: {},
})

/** The next sort after a header click: ↓ / ↑ / aus, at most two keys. */
export function nextSort(sort: SortKey[], attr: string, additive: boolean): SortKey[] {
  const at = sort.findIndex((k) => k.attr === attr)
  const current = sort[at]
  const next: SortKey | null = !current
    ? { attr, dir: 'desc' }
    : current.dir === 'desc'
      ? { attr, dir: 'asc' }
      : null
  if (!additive) return next ? [next] : []
  if (current) return sort.flatMap((k, i) => (i === at ? (next ? [next] : []) : [k]))
  return [...sort.slice(0, 1), { attr, dir: 'desc' }]
}

function withoutKey<T>(record: Record<Id, T>, id: Id): Record<Id, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== id))
}

const initial = (): Analysis & {
  draft: null
  dirty: boolean
  table: TableState
  queryRef: QueryRef | null
} => ({
  layers: [],
  result: null,
  tree: emptyTree(),
  restriction: null,
  draft: null,
  dirty: false,
  table: emptyTable(),
  queryRef: null,
})

const layerPatch =
  (id: Id, patch: Partial<DisplayLayer>) =>
  (s: Analysis): Partial<AnalysisStore> => ({
    layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    dirty: true,
  })

export const useAnalysis = create<AnalysisStore>()((set, get) => ({
  ...initial(),

  addLayer: (layer, asResult, table) =>
    set((s) => {
      if (s.layers.some((l) => l.id === layer)) return s
      const added: DisplayLayer = {
        id: layer,
        source: { kind: 'catalog', layer },
        visible: true,
        opacity: 1,
        symbology: null,
        ...(table ? { table: true } : {}),
      }
      // New layers go on top; the first one becomes the result layer — never a table.
      const result = !table && (asResult || s.result === null) ? layer : s.result
      return { layers: [added, ...s.layers], result, dirty: true }
    }),

  addDerived: (name, recipe) => {
    const id = T.newId('d')
    set((s) => ({
      layers: [
        {
          id,
          source: { kind: 'derived', name, recipe },
          visible: true,
          opacity: 0.8,
          symbology: null,
        },
        ...s.layers,
      ],
      dirty: true,
    }))
    return id
  },

  removeLayer: (id) =>
    set((s) => ({
      layers: s.layers.filter((l) => l.id !== id),
      result: s.result === id ? null : s.result,
      table: {
        ...s.table,
        tab: s.table.tab === id ? null : s.table.tab,
        columns: withoutKey(s.table.columns, id),
        sort: withoutKey(s.table.sort, id),
      },
      dirty: true,
    })),

  moveLayer: (id, toIndex) =>
    set((s) => {
      const layers = s.layers.filter((l) => l.id !== id)
      const moved = s.layers.find((l) => l.id === id)
      if (!moved) return s
      layers.splice(Math.max(0, Math.min(toIndex, layers.length)), 0, moved)
      return { layers, dirty: true }
    }),

  setVisible: (id, visible) => set(layerPatch(id, { visible })),
  setOpacity: (id, opacity) => set(layerPatch(id, { opacity })),
  setSymbology: (id, symbology) => set(layerPatch(id, { symbology })),
  updateRecipe: (id, recipe, name) =>
    set((s) => ({
      layers: s.layers.map((l) =>
        l.id === id && l.source.kind === 'derived'
          ? { ...l, source: { kind: 'derived', name: name ?? l.source.name, recipe } }
          : l,
      ),
      dirty: true,
    })),

  setResult: (id) => {
    const { layers, tree, draft, result } = get()
    const layer = layers.find((l) => l.id === id)
    if (!layer || !canBeResult(layer) || id === result) return { dropped: [] }
    // While the editor is open the change belongs to the draft, like any other edit.
    const { tree: kept, dropped } = T.withoutAttributeRows(draft ?? tree)
    set(draft ? { result: id, draft: kept, dirty: true } : { result: id, tree: kept, dirty: true })
    return { dropped }
  },

  edit: () => set((s) => (s.draft ? s : { draft: s.tree })),
  editNode: (id, patch) => set((s) => ({ draft: T.update(s.draft ?? s.tree, id, patch) })),
  addNode: (groupId, node) => set((s) => ({ draft: T.append(s.draft ?? s.tree, groupId, node) })),
  removeNode: (id) => set((s) => ({ draft: T.remove(s.draft ?? s.tree, id) })),
  apply: () => set((s) => (s.draft ? { tree: s.draft, draft: null, dirty: true } : s)),
  discard: () => set({ draft: null }),
  setRestriction: (restriction) => set({ restriction, dirty: true }),

  setTableTab: (tab) => set((s) => ({ table: { ...s.table, tab } })),
  setTableMode: (mode) => set((s) => ({ table: { ...s.table, mode } })),
  setOnlyView: (onlyView) => set((s) => ({ table: { ...s.table, onlyView } })),
  setColumns: (id, choice) =>
    set((s) => ({
      table: { ...s.table, columns: { ...s.table.columns, [id]: choice } },
      dirty: true,
    })),
  toggleSort: (id, attr, additive) =>
    set((s) => ({
      table: {
        ...s.table,
        sort: { ...s.table.sort, [id]: nextSort(s.table.sort[id] ?? [], attr, additive) },
      },
      dirty: true,
    })),

  applyQuery: (part, queryRef) =>
    set((s) => {
      // The result layer joins the map if it is not shown yet.
      const shown = s.layers.some((l) => l.id === part.result)
      const layers: DisplayLayer[] = shown
        ? s.layers
        : [
            {
              id: part.result,
              source: { kind: 'catalog', layer: part.result },
              visible: true,
              opacity: 1,
              symbology: null,
            },
            ...s.layers,
          ]
      return {
        layers,
        result: part.result,
        tree: part.tree,
        restriction: part.restriction,
        draft: null,
        queryRef,
        dirty: true,
      }
    }),
  setQueryRef: (queryRef) => set({ queryRef }),

  reset: () => set(initial()),
  load: (analysis, table, queryRef) =>
    set({
      ...analysis,
      table: table ?? emptyTable(),
      queryRef: queryRef ?? null,
      draft: null,
      dirty: false,
    }),
  markSaved: () => set({ dirty: false }),
}))

/** The analysis as the query sees it: the draft counts while the editor is open. */
export const currentAnalysis = (s: AnalysisStore): Analysis => ({
  layers: s.layers,
  result: s.result,
  tree: s.draft ?? s.tree,
  restriction: s.restriction,
})
