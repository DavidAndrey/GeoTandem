// One displayed layer on the map: fetched through the query machinery, never
// around it (etappen E1.5), drawn in its own pane so the panel order holds.
import L from 'leaflet'
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DisplayLayer, QueryObject } from '../analysis/model'
import type { LayerInfo, QueryResult } from '../api/client'
import { useLayerFeatures } from './data'
import { shownBounds, useLeafletMap } from './leaflet'
import { featureName, popupContent } from './popup'
import { useAnalysis } from '../analysis/store'
import { useDock } from '../table/dock'
import { useSelection } from '../table/selection'
import { featureStyle, layerColor, markStyle, type HitState, type Mark } from './style'
import { symbolizer, useLegend } from './symbolize'
import { useMapView } from './view'

export function DataLayer({
  layer,
  query,
  order,
  title,
  info,
  hits,
  largerThanLimit,
  onState,
  onPick,
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
  onPick?: (rowId: string, fid: number, label: string) => void
}) {
  const map = useLeafletMap()
  const setLegend = useLegend((s) => s.set)
  const result = useLayerFeatures(query, largerThanLimit, layer.visible)
  const marked = useSelection(
    useShallow((s) => ({
      fids: s.layer === layer.id ? s.fids : NONE,
      hover: s.hover?.layer === layer.id ? s.hover.fid : null,
    })),
  )
  /** Drawn radius per point, so the selection ring fits graduated sizes too. */
  const radii = useRef(new Map<number, number>())

  useEffect(() => {
    onState?.({ error: result.error, count: result.data?.features.length ?? null })
  }, [onState, result.error, result.data])

  useEffect(() => {
    if (!map || !layer.visible || !result.data) return
    const pane = `layer-${layer.id}`
    const element = map.getPane(pane) ?? map.createPane(pane)
    element.style.zIndex = String(400 + order)
    const features = result.data.features
    const symbols = symbolizer(
      layer.symbology,
      (attr) => features.map((f) => f.properties[attr]),
      layerColor(layer),
    )
    setLegend(layer.id, symbols.legend)
    const symbolized = layer.symbology !== null && layer.symbology.kind !== 'single'
    const stateOf = (id: number): HitState => (hits ? (hits.has(id) ? 'hit' : 'miss') : 'plain')
    const styleOf = (f: GeoJSON.Feature | undefined) => {
      const symbol = symbols.of((f?.properties ?? {}) as Record<string, unknown>)
      const style = featureStyle(symbol.color, layer.opacity, stateOf(Number(f?.id)), {
        radius: layer.symbology?.kind === 'graduated_size' ? symbol.radius : undefined,
        symbolized,
      })
      radii.current.set(Number(f?.id), style.radius)
      return style
    }
    const geojson = L.geoJSON(drawable(result.data.features), {
      pane,
      style: styleOf,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { pane, ...styleOf(f) }),
      onEachFeature: (f, shape) => {
        shape.on('click', (event: L.LeafletMouseEvent) => {
          // While measuring, a click sets a point (the map handles it), nothing more.
          if (useMapView.getState().measuring) return
          const properties = (f.properties ?? {}) as Record<string, unknown>
          // While a reference feature is being picked (F-4.3), the click picks it.
          const pick = useMapView.getState().pick
          if (pick && layer.source.kind === 'catalog' && pick.layer === layer.source.layer) {
            onPick?.(pick.rowId, Number(f.id), featureName(properties, info) ?? '')
            return
          }
          // The table jumps to the feature's row (design B8), the popup still opens.
          useSelection.getState().select(layer.id, Number(f.id), true)
          if (useDock.getState().open) useAnalysis.getState().setTableTab(layer.id)
          L.popup()
            .setLatLng(event.latlng)
            .setContent(popupContent(title, properties, info))
            .openOn(map)
        })
      },
    }).addTo(map)
    const bounds = geojson.getBounds()
    if (bounds.isValid()) shownBounds.set(layer.id, bounds)
    return () => {
      geojson.remove()
    }
  }, [map, layer, order, result.data, hits, title, info, onPick, setLegend])

  // Selection and hover on top of the layer, rebuilt alone so hovering a row
  // never redraws the whole layer.
  useEffect(() => {
    if (!map || !layer.visible || !result.data) return
    const marks = new Map<number, Mark>(marked.fids.map((fid) => [fid, 'selected']))
    if (marked.hover !== null && !marks.has(marked.hover)) marks.set(marked.hover, 'hover')
    if (marks.size === 0) return
    const pane = `layer-${layer.id}`
    const markOf = (f: GeoJSON.Feature | undefined) => marks.get(Number(f?.id)) ?? 'hover'
    const chosen = result.data.features.filter((f) => marks.has(f.id))
    const overlay = L.geoJSON(drawable(chosen), {
      pane,
      interactive: false,
      style: (f) => markStyle(markOf(f), 'shape'),
      pointToLayer: (f, latlng) => {
        const mark = markOf(f)
        const radius = radii.current.get(Number(f.id)) ?? 6
        const parts = [
          L.circleMarker(latlng, { pane, interactive: false, ...markStyle(mark, 'ring', radius) }),
        ]
        if (mark === 'selected')
          parts.push(
            L.circleMarker(latlng, {
              pane,
              interactive: false,
              ...markStyle(mark, 'outline', radius),
            }),
          )
        return L.featureGroup(parts)
      },
    }).addTo(map)
    return () => {
      overlay.remove()
    }
    // Same inputs as the layer itself: redrawn after it, so the marks stay on top.
  }, [map, layer, order, result.data, hits, marked])

  return null
}

const NONE: number[] = []

/** Features with a geometry, as GeoJSON; table rows without one are not drawn. */
function drawable(features: QueryResult['features']): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry !== null)
      .map((f) => ({ ...f, geometry: f.geometry as unknown as GeoJSON.Geometry })),
  }
}
