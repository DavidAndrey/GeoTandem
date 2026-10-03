// The analysis state of the classic mode as one store (tech-stack 4.4, plan D1).
// Server state stays in TanStack Query; this holds only what the user built.
import { create } from 'zustand'
import type { DisplayLayer, Group, Id, Node, Recipe, Restriction, Symbology } from './model'
import type { Analysis } from './model'
import { canBeResult, emptyTree } from './query'
import * as T from './tree'

interface AnalysisStore extends Analysis {
  /** The editor's working copy (design B2): "Übernehmen" writes it, "Verwerfen" drops it. */
  draft: Group | null
  /** Changed since the last save; moving the map does not count (design decision 3). */
  dirty: boolean

  addLayer: (layer: string, asResult?: boolean) => void
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

  reset: () => void
  load: (analysis: Analysis) => void
}

const initial = (): Analysis & { draft: null; dirty: boolean } => ({
  layers: [],
  result: null,
  tree: emptyTree(),
  restriction: null,
  draft: null,
  dirty: false,
})

const layerPatch =
  (id: Id, patch: Partial<DisplayLayer>) =>
  (s: Analysis): Partial<AnalysisStore> => ({
    layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    dirty: true,
  })

export const useAnalysis = create<AnalysisStore>()((set, get) => ({
  ...initial(),

  addLayer: (layer, asResult) =>
    set((s) => {
      if (s.layers.some((l) => l.id === layer)) return s
      const added: DisplayLayer = {
        id: layer,
        source: { kind: 'catalog', layer },
        visible: true,
        opacity: 1,
        symbology: null,
      }
      // New layers go on top; the first one becomes the result layer.
      const result = asResult || s.result === null ? layer : s.result
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
    const { layers, tree, result } = get()
    const layer = layers.find((l) => l.id === id)
    if (!layer || !canBeResult(layer) || id === result) return { dropped: [] }
    const { tree: kept, dropped } = T.withoutAttributeRows(tree)
    set({ result: id, tree: kept, draft: null, dirty: true })
    return { dropped }
  },

  edit: () => set((s) => (s.draft ? s : { draft: s.tree })),
  editNode: (id, patch) => set((s) => ({ draft: T.update(s.draft ?? s.tree, id, patch) })),
  addNode: (groupId, node) => set((s) => ({ draft: T.append(s.draft ?? s.tree, groupId, node) })),
  removeNode: (id) => set((s) => ({ draft: T.remove(s.draft ?? s.tree, id) })),
  apply: () => set((s) => (s.draft ? { tree: s.draft, draft: null, dirty: true } : s)),
  discard: () => set({ draft: null }),
  setRestriction: (restriction) => set({ restriction, dirty: true }),

  reset: () => set(initial()),
  load: (analysis) => set({ ...analysis, draft: null, dirty: false }),
}))

/** The analysis as the query sees it: the draft counts while the editor is open. */
export const currentAnalysis = (s: AnalysisStore): Analysis => ({
  layers: s.layers,
  result: s.result,
  tree: s.draft ?? s.tree,
  restriction: s.restriction,
})
