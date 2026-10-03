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
}

export const useMapView = create<MapViewStore>()((set) => ({
  bbox: null,
  setBbox: (bbox) => set({ bbox }),
  zoomRequest: null,
  zoomTo: (layer) => set({ zoomRequest: { layer, at: Date.now() } }),
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
