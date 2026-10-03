// One displayed layer on the map: fetched through the query machinery, never
// around it (etappen E1.5), drawn in its own pane so the panel order holds.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import { useEffect } from 'react'
import type { DisplayLayer, QueryObject } from '../analysis/model'
import { and } from '../analysis/query'
import { api, type LayerInfo, type QueryResult } from '../api/client'
import { shownBounds, useLeafletMap } from './leaflet'
import { popupContent } from './popup'
import { featureStyle, layerColor, type HitState } from './style'
import { roundBbox, useMapView } from './view'

export function DataLayer({
  layer,
  query,
  order,
  title,
  info,
  hits,
  largerThanLimit,
  onState,
}: {
  layer: DisplayLayer
  query: QueryObject
  /** Higher draws on top. */
  order: number
  title: string
  info: LayerInfo | undefined
  /** Ids of the result's hits; ``null`` when there is nothing to tell apart. */
  hits: Set<number> | null
  /** Too large to fetch whole: fetched by the current view (plan D5). */
  largerThanLimit: boolean
  onState?: (state: { error: unknown; count: number | null }) => void
}) {
  const map = useLeafletMap()
  const bbox = useMapView((s) => s.bbox)
  const viewed = largerThanLimit && bbox ? roundBbox(bbox) : null
  const effective: QueryObject = viewed
    ? { ...query, where: and(query.where, { op: 'bbox', bbox: viewed }) ?? undefined }
    : query
  const result = useQuery({
    queryKey: ['map-layer', effective],
    queryFn: () => api.query(effective),
    placeholderData: keepPreviousData,
    enabled: layer.visible,
  })

  useEffect(() => {
    onState?.({ error: result.error, count: result.data?.features.length ?? null })
  }, [onState, result.error, result.data])

  useEffect(() => {
    if (!map || !layer.visible || !result.data) return
    const pane = `layer-${layer.id}`
    const element = map.getPane(pane) ?? map.createPane(pane)
    element.style.zIndex = String(400 + order)
    const color = layerColor(layer)
    const stateOf = (id: number): HitState => (hits ? (hits.has(id) ? 'hit' : 'miss') : 'plain')
    const geojson = L.geoJSON(drawable(result.data.features), {
      pane,
      style: (f) => featureStyle(color, layer.opacity, stateOf(Number(f?.id))),
      pointToLayer: (f, latlng) =>
        L.circleMarker(latlng, {
          pane,
          ...featureStyle(color, layer.opacity, stateOf(Number(f.id))),
        }),
      onEachFeature: (f, shape) => {
        shape.bindPopup(() =>
          popupContent(title, (f.properties ?? {}) as Record<string, unknown>, info),
        )
      },
    }).addTo(map)
    const bounds = geojson.getBounds()
    if (bounds.isValid()) shownBounds.set(layer.id, bounds)
    return () => {
      geojson.remove()
    }
  }, [map, layer, order, result.data, hits, title, info])

  return null
}

/** Features with a geometry, as GeoJSON; table rows without one are not drawn. */
function drawable(features: QueryResult['features']): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry !== null)
      .map((f) => ({ ...f, geometry: f.geometry as unknown as GeoJSON.Geometry })),
  }
}
