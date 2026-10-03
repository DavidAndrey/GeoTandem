// Which features are selected in the table and on the map (design B8, B9).
// Not part of the analysis and not saved (design C7: "Tabellenauswahl").
import { create } from 'zustand'
import type { Id } from '../analysis/model'

interface SelectionStore {
  /** Displayed layer the selection belongs to. */
  layer: Id | null
  fids: number[]
  /** Briefly highlighted while the pointer is over a row. */
  hover: { layer: Id; fid: number } | null
  /** Last feature picked on the map: the table scrolls to it. */
  focus: { fid: number; at: number } | null
  /** Row or map click: this feature alone. */
  select: (layer: Id, fid: number, fromMap?: boolean) => void
  /** Checkbox: add or remove one feature. */
  toggle: (layer: Id, fid: number) => void
  setAll: (layer: Id, fids: number[]) => void
  setHover: (hover: { layer: Id; fid: number } | null) => void
  clear: () => void
}

export const useSelection = create<SelectionStore>()((set) => ({
  layer: null,
  fids: [],
  hover: null,
  focus: null,
  select: (layer, fid, fromMap = false) =>
    set({ layer, fids: [fid], ...(fromMap ? { focus: { fid, at: Date.now() } } : {}) }),
  toggle: (layer, fid) =>
    set((s) => {
      const fids = s.layer === layer ? s.fids : []
      return {
        layer,
        fids: fids.includes(fid) ? fids.filter((f) => f !== fid) : [...fids, fid],
      }
    }),
  setAll: (layer, fids) => set({ layer, fids }),
  setHover: (hover) => set({ hover }),
  clear: () => set({ layer: null, fids: [], hover: null, focus: null }),
}))
