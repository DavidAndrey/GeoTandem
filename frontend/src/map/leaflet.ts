// Shared access to the Leaflet map for components drawn inside it.
import type L from 'leaflet'
import { createContext, useContext } from 'react'
import type { BBox } from './view'

export const MapContext = createContext<L.Map | null>(null)
export const useLeafletMap = () => useContext(MapContext)

/** Bounds of what each layer currently shows, for "Auf Layer zoomen" (design B1). */
export const shownBounds = new Map<string, L.LatLngBounds>()

export function fitBbox(map: L.Map, bbox: BBox | number[]) {
  const [west, south, east, north] = bbox as BBox
  map.fitBounds(
    [
      [south, west],
      [north, east],
    ],
    { padding: [24, 24], maxZoom: 17 },
  )
}
