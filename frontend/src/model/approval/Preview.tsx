// The preview of a proposal waiting for approval (design M5.1 "Vorschau 137 →
// 10, gestrichelt auf der Karte"; plan P2): the stored query, run by the
// user's own session, read-only. The count goes into the approval, the ids
// draw a dashed layer over the map. The model never sees it, and ``execute``
// never reuses it: it runs the stored query again.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import L from 'leaflet'
import { useEffect } from 'react'
import type { QueryObject } from '../../analysis/model'
import type { ModelActionView, QueryResult } from '../../api/client'
import { useLayers, useMapConfig } from '../../api/queries'
import { useLayerFeatures } from '../../map/data'
import { useLeafletMap } from '../../map/leaflet'
import { ACCENT } from '../../map/style'
import { useModel } from '../store'
import { readQuery } from '../readable'
import { FRAME } from '../statusKey'
import { referencesOf, type Reference } from './references'
import { awaiting, usePreview } from './waiting'

const PANE = 'model-preview'
/** Below the dashed hits, above the analysis's layers. */
const REFERENCE_PANE = 'model-reference'
/** The reference's outline: the ink, thin, no fill (context, not a status). */
const REFERENCE_LINE = {
  color: '#201f1d',
  weight: 1.5,
  opacity: 0.75,
  fill: false,
  interactive: false,
}

/** The references of the proposal that waits (review #4d), as the caption and the map name them. */
function useReferences(view: ModelActionView | null): Reference[] {
  const catalog = useLayers().data
  const config = useMapConfig()
  return view ? referencesOf(view, catalog, config.data?.max_features) : []
}

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
  return <ReferenceLayer view={view} />
}

/** What the proposal's spatial conditions refer to, drawn grey under its hits (review #4d). */
function ReferenceLayer({ view }: { view: ModelActionView | null }) {
  const references = useReferences(view)
  return references.map(
    (reference) =>
      reference.query && (
        <ReferenceShapes key={reference.key} query={reference.query} limited={reference.limited} />
      ),
  )
}

function ReferenceShapes({ query, limited }: { query: QueryObject; limited: boolean }) {
  const features = useLayerFeatures(query, limited)
  const map = useLeafletMap()
  const data = features.data
  useEffect(() => {
    if (!map || !data) return
    const element = map.getPane(REFERENCE_PANE) ?? map.createPane(REFERENCE_PANE)
    element.style.zIndex = '630'
    element.style.pointerEvents = 'none'
    const layer = L.geoJSON(drawable(data.features), {
      pane: REFERENCE_PANE,
      interactive: false,
      style: () => REFERENCE_LINE,
      pointToLayer: (_, latlng) =>
        L.circleMarker(latlng, { pane: REFERENCE_PANE, radius: 6, ...REFERENCE_LINE }),
    }).addTo(map)
    return () => {
      layer.remove()
    }
  }, [map, data])
  return null
}

function drawable(features: QueryResult['features']): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry !== null)
      .map((f) => ({ ...f, geometry: f.geometry as unknown as GeoJSON.Geometry })),
  }
}

function dashed(features: QueryResult['features'], ids: Set<number>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry !== null && ids.has(Number(f.id)))
      .map((f) => ({ ...f, geometry: f.geometry as unknown as GeoJSON.Geometry })),
  }
}

/** "Bezug grau: liegt in Gemeinden (Gemeindename = Köniz)"; the whole layer only named. */
function referenceLine({ text, query, limited }: Reference): string {
  if (!query) return t`Bezug: ${text}`
  return limited ? t`Bezug grau: ${text} · im Kartenausschnitt` : t`Bezug grau: ${text}`
}

/** The map's caption while a preview is drawn (design M5.1), with what it refers to (#4d). */
export function PreviewCaption() {
  const view = useModel(awaiting)
  const preview = usePreview(view)
  const references = useReferences(view)
  if (!view || (!preview.data && references.length === 0)) return null
  return (
    <div
      role="note"
      aria-label={t`Vorschau`}
      className={`card absolute bottom-6 left-3 z-[1000] max-w-[70%] px-3 py-1 text-sm ${FRAME.dashed}`}
    >
      {preview.data && (
        <p>
          <Trans>Vorschau gestrichelt · noch nicht angewendet</Trans>
        </p>
      )}
      {references.map((reference) => (
        <p key={reference.key} className="text-xs">
          {referenceLine(reference)}
        </p>
      ))}
    </div>
  )
}
