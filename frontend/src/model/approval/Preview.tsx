// The preview of a proposal waiting for approval (design M5.1 "Vorschau 137 →
// 10, gestrichelt auf der Karte"; plan P2): the stored query, run by the
// user's own session, read-only. The count goes into the approval, the ids
// draw a dashed layer over the map. The model never sees it, and ``execute``
// never reuses it: it runs the stored query again.
import { Trans } from '@lingui/react/macro'
import L from 'leaflet'
import { useEffect } from 'react'
import type { QueryObject } from '../../analysis/model'
import type { QueryResult } from '../../api/client'
import { useLayers, useMapConfig } from '../../api/queries'
import { useLayerFeatures } from '../../map/data'
import { useLeafletMap } from '../../map/leaflet'
import { ACCENT } from '../../map/style'
import { useModel } from '../store'
import { readQuery } from '../readable'
import { FRAME } from '../statusKey'
import { awaiting, usePreview } from './waiting'

const PANE = 'model-preview'

/** The dashed layer of the preview's hits (M5.1), drawn above the analysis's layers. */
export function PreviewLayer() {
  const view = useModel(awaiting)
  const preview = usePreview(view)
  const source = view ? readQuery(view.query).source : null
  const catalog = useLayers().data
  const config = useMapConfig()
  const count = catalog?.find((l) => l.name === source)?.feature_count ?? 0
  const query: QueryObject = { schema_version: '2', source: source ?? '', output: 'map' }
  const features = useLayerFeatures(
    query,
    count > (config.data?.max_features ?? Infinity),
    source !== null && preview.data !== undefined,
  )
  const map = useLeafletMap()
  const ids = preview.data?.ids
  const data = features.data

  useEffect(() => {
    if (!map || !ids || !data) return
    const element = map.getPane(PANE) ?? map.createPane(PANE)
    element.style.zIndex = '640'
    element.style.pointerEvents = 'none'
    const shown = new Set(ids)
    const line = { color: ACCENT, weight: 2, dashArray: '4 3', fill: false, interactive: false }
    const layer = L.geoJSON(dashed(data.features, shown), {
      pane: PANE,
      interactive: false,
      style: () => line,
      pointToLayer: (_, latlng) => L.circleMarker(latlng, { pane: PANE, radius: 8, ...line }),
    }).addTo(map)
    return () => {
      layer.remove()
    }
  }, [map, ids, data])
  return null
}

function dashed(features: QueryResult['features'], ids: Set<number>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry !== null && ids.has(Number(f.id)))
      .map((f) => ({ ...f, geometry: f.geometry as unknown as GeoJSON.Geometry })),
  }
}

/** The map's caption while a preview is drawn (design M5.1). */
export function PreviewCaption() {
  const view = useModel(awaiting)
  const preview = usePreview(view)
  if (!view || !preview.data) return null
  return (
    <p className={`card absolute bottom-6 left-3 z-[1000] px-3 py-1 text-sm ${FRAME.dashed}`}>
      <Trans>Vorschau gestrichelt · noch nicht angewendet</Trans>
    </p>
  )
}
