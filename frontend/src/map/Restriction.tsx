// The restriction "Nur in" on the map (F-4.3): drawing it with Geoman, and
// showing it as a dashed outline while it applies.
import '@geoman-io/leaflet-geoman-free'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import L from 'leaflet'
import { useEffect } from 'react'
import type { GeoJSONGeometry, Restriction } from '../analysis/model'
import { useLeafletMap } from './leaflet'
import { ACCENT } from './style'
import { useMapView } from './view'

export function RestrictionLayer({
  restriction,
  onDrawn,
}: {
  restriction: Restriction
  onDrawn: (geometry: GeoJSONGeometry) => void
}) {
  const map = useLeafletMap()
  const drawing = useMapView((s) => s.drawing)
  const setDrawing = useMapView((s) => s.setDrawing)

  useEffect(() => {
    if (!map || !drawing) return
    const finish = (event: { layer: L.Layer }) => {
      const geometry = (event.layer as L.Polygon).toGeoJSON().geometry
      event.layer.remove()
      onDrawn(geometry as GeoJSONGeometry)
      setDrawing(null)
    }
    map.on('pm:create', finish)
    map.pm.enableDraw(drawing === 'rectangle' ? 'Rectangle' : 'Polygon', {
      pathOptions: { color: ACCENT, dashArray: '6 4', fillOpacity: 0.05 },
    })
    return () => {
      map.off('pm:create', finish)
      map.pm.disableDraw()
    }
  }, [map, drawing, onDrawn, setDrawing])

  useEffect(() => {
    if (!map || !restriction) return
    const style = { color: ACCENT, weight: 1.5, dashArray: '6 4', fill: false, interactive: false }
    const outline =
      restriction.kind === 'view'
        ? L.rectangle(
            [
              [restriction.bbox[1], restriction.bbox[0]],
              [restriction.bbox[3], restriction.bbox[2]],
            ],
            style,
          )
        : L.geoJSON(restriction.geometry as GeoJSON.Geometry, { style })
    outline.addTo(map)
    return () => {
      outline.remove()
    }
  }, [map, restriction])

  return null
}
