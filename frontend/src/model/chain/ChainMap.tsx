// A chain's intermediate results on the map (design M9.1, M9.4): dimmed, in
// accent 300 for the latest complete step and grey for the earlier ones, with
// a caption that says they are not applied. Drawn from what the contract gives
// per step: ``layer``, the intermediate layer the step made (session-scoped,
// owned by the action, WP74), read through ``/api/query`` like any layer, and
// the step's count for the caption. Never the analysis: that changes only on
// *übernehmen*.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import L from 'leaflet'
import { useEffect } from 'react'
import type { QueryObject } from '../../analysis/model'
import type { ModelActionView, QueryResult, StepView } from '../../api/client'
import { formatNumber } from '../../i18n/locale'
import { useLayerFeatures } from '../../map/data'
import { useLeafletMap } from '../../map/leaflet'
import { FRAME } from '../statusKey'
import { useModel, type ModelState } from '../store'
import { isChain, phaseOf, placeOf, type Phase } from './steps'

const PANE = 'model-chain'

/** Accent 300 and neutral 400 of the Classical tokens (design "Zwischenstände"). */
const LATEST = '#facb8d'
const EARLIER = '#bab6b6'

const SHOWN: readonly Phase[] = ['running', 'halt', 'done', 'stopped']

/** The chain being run or waiting to be adopted: the record polled, else the open one. */
function liveChain(state: ModelState): ModelActionView | null {
  const id = state.running?.id ?? state.pending
  const view = id === null ? undefined : state.views[id]
  return view && isChain(view) && SHOWN.includes(phaseOf(view)) ? view : null
}

/** The steps with a complete result and a layer of their own, in order. */
const drawn = (view: ModelActionView): StepView[] =>
  view.steps.filter((s) => (s.status === 'ok' || s.status === 'empty') && s.layer)

/** The dimmed layers of the live chain, under every other model layer. */
export function ChainLayer() {
  const view = useModel(liveChain)
  const steps = view ? drawn(view) : []
  return (
    <>
      {steps.map((step, i) => (
        <StepLayer
          key={`${view?.id}:${step.position}`}
          layer={step.layer ?? ''}
          color={i === steps.length - 1 ? LATEST : EARLIER}
        />
      ))}
    </>
  )
}

function StepLayer({ layer, color }: { layer: string; color: string }) {
  const query: QueryObject = { schema_version: '2', source: layer, output: 'map' }
  const features = useLayerFeatures(query, false)
  const map = useLeafletMap()
  const data = features.data
  useEffect(() => {
    if (!map || !data) return
    const element = map.getPane(PANE) ?? map.createPane(PANE)
    element.style.zIndex = '420'
    element.style.pointerEvents = 'none'
    const style = {
      color,
      weight: 1.5,
      opacity: 0.7,
      fillColor: color,
      fillOpacity: 0.35,
      interactive: false,
    }
    const shown = L.geoJSON(collection(data.features), {
      pane: PANE,
      interactive: false,
      style: () => style,
      pointToLayer: (_, latlng) => L.circleMarker(latlng, { pane: PANE, radius: 5, ...style }),
    }).addTo(map)
    return () => {
      shown.remove()
    }
  }, [map, data, color])
  return null
}

function collection(features: QueryResult['features']): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry !== null)
      .map((f) => ({ ...f, geometry: f.geometry as unknown as GeoJSON.Geometry })),
  }
}

/** The map's caption while a chain's intermediate results are drawn (design M9.1, M9.4). */
export function ChainCaption() {
  const view = useModel(liveChain)
  const steps = view ? drawn(view) : []
  if (!view || steps.length === 0) return null
  return (
    <div
      role="note"
      aria-label={t`Zwischenstand der Kette`}
      className={`card absolute bottom-6 left-3 z-[1000] flex flex-col gap-0.5 px-3 py-1 text-xs ${FRAME.dashed}`}
    >
      <p className="text-sm">
        <Trans>Zwischenstand gedämpft · nicht angewendet</Trans>
      </p>
      <ul>
        {steps.map((step, i) => {
          const n = formatNumber(placeOf(view, step))
          const hits = step.hits != null ? formatNumber(step.hits) : null
          return (
            <li key={step.position} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-sm border border-neutral-500"
                style={{ background: i === steps.length - 1 ? LATEST : EARLIER }}
              />
              {hits !== null ? t`Schritt ${n} · ${hits}` : t`Schritt ${n}`}
              <span className="text-muted">{` · ${step.text}`}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
