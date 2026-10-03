// The visible map area, for layers fetched by view (plan D5) and the
// restriction "Nur in: Ausschnitt". Not part of the analysis: moving the map
// changes nothing that is saved (design decision 3).
import { create } from 'zustand'

export type BBox = [number, number, number, number]

interface MapViewStore {
  bbox: BBox | null
  setBbox: (bbox: BBox) => void
  /** A request from outside the map, e.g. "Auf Layer zoomen" in the panel. */
  zoomRequest: { layer: string; at: number } | null
  zoomTo: (layer: string) => void
  /** Picking a reference feature on the map (F-4.3): the next click on ``layer`` is it. */
  pick: { layer: string; rowId: string } | null
  setPick: (pick: { layer: string; rowId: string } | null) => void
  /** Drawing the restriction "Nur in: Fläche" (F-4.3). */
  drawing: 'rectangle' | 'polygon' | null
  setDrawing: (drawing: 'rectangle' | 'polygon' | null) => void
  /**
   * ``zoom`` fits a feature (⌖ in the table, design B8), ``pan`` only brings it
   * into view, ``view`` restores a saved map view (plan E1.7, D3).
   */
  featureRequest: { bbox: BBox; mode: 'zoom' | 'pan' | 'view'; at: number } | null
  zoomToFeature: (bbox: BBox, mode: 'zoom' | 'pan' | 'view') => void
  /** The editor row whose hits the map shows (design B2 "Aktive Bedingung"). */
  activeRow: string | null
  setActiveRow: (id: string | null) => void
}

export const useMapView = create<MapViewStore>()((set) => ({
  bbox: null,
  setBbox: (bbox) => set({ bbox }),
  zoomRequest: null,
  zoomTo: (layer) => set({ zoomRequest: { layer, at: Date.now() } }),
  pick: null,
  setPick: (pick) => set({ pick }),
  drawing: null,
  setDrawing: (drawing) => set({ drawing }),
  featureRequest: null,
  zoomToFeature: (bbox, mode) => set({ featureRequest: { bbox, mode, at: Date.now() } }),
  activeRow: null,
  setActiveRow: (activeRow) => set({ activeRow }),
}))

/** Rounded so small pans do not refetch everything. */
export function roundBbox(bbox: BBox, digits = 3): BBox {
  const f = 10 ** digits
  return [
    Math.floor(bbox[0] * f) / f,
    Math.floor(bbox[1] * f) / f,
    Math.ceil(bbox[2] * f) / f,
    Math.ceil(bbox[3] * f) / f,
  ]
}
