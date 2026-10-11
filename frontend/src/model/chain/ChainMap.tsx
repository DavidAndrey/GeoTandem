// A chain's intermediate results on the map (design M9.1, M9.4): dimmed, in
// accent 300 for the latest complete step and grey for the earlier ones, with
// a caption that says they are not applied. Each step's result is a query
// object (``StepView.query``, WP75): nothing is materialised on the server.
// The client runs it as the user through Modus A (``POST /api/query/ids``,
// with the user's own visibility) and draws those features of its layer. A
// buffer step shows the features it buffers. A finished chain's result (M9.3)
// is drawn dashed over them: "vorgemerkt", not applied. The sidebar names the
// state too ("Zwischenstand · Kette", ``ChainPending``). Never the analysis:
// that changes only on *übernehmen*.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import L from 'leaflet'
import { useEffect } from 'react'
import type { QueryObject } from '../../analysis/model'
import type { ModelActionView, QueryResult, StepView } from '../../api/client'
import { useLayers, useMapConfig } from '../../api/queries'
import { formatNumber } from '../../i18n/locale'
import { hitsOf } from '../../i18n/phrases'
import { ACCENT } from '../../map/style'
import { useHits, useLayerFeatures } from '../../map/data'
import { useLeafletMap } from '../../map/leaflet'
import { compactQuery } from '../readable'
import { FRAME } from '../statusKey'
import { useModel, type ModelState } from '../store'
import { adoptedHits, finished, isChain, phaseOf, placeOf, planned, type Phase } from './steps'

const PANE = 'model-chain'

/** Accent 300 and neutral 400 of the Classical tokens (design "Zwischenstände"). */
const LATEST = '#facb8d'
const EARLIER = '#bab6b6'

const SHOWN: readonly Phase[] = ['running', 'halt', 'done', 'stopped']

/**
 * The chain being run or waiting to be adopted: the record polled, else the
 * open one. A direct repeat of a chain (WP76) waits beside it, thinking or
 * pending, and supersedes nothing: the chain's result stays drawn meanwhile.
 */
function liveChain(state: ModelState): ModelActionView | null {
  const id = state.running?.id ?? state.pending
  const found = id === null ? undefined : state.views[id]
  const view =
    found && !isChain(found) && found.compare_of != null ? state.views[found.compare_of] : found
  return view && isChain(view) && SHOWN.includes(phaseOf(view)) ? view : null
}

/** The steps with a complete result, in order: their queries are drawn. */
const drawn = (view: ModelActionView): StepView[] =>
  view.steps.filter((s) => (s.status === 'ok' || s.status === 'empty') && s.query)

/** The dimmed results of the live chain's steps, under every other model layer. */
export function ChainLayer() {
  const view = useModel(liveChain)
  const steps = view ? drawn(view) : []
  const result = view && phaseOf(view) === 'done' ? view.query : null
  return (
    <>
      {steps.map((step, i) => (
        <StepLayer
          key={`${view?.id}:${step.position}`}
          query={step.query as QueryObject}
          color={i === steps.length - 1 ? LATEST : EARLIER}
        />
      ))}
      {/* M9.3: the result to adopt, dashed: marked, not applied. */}
      {result && <StepLayer key={`${view?.id}:result`} query={result} color={ACCENT} dashed />}
    </>
  )
}

/**
 * One step's result: its query's ids as the user, those features of its
 * layer; ``dashed`` for the result to adopt (M9.3).
 */
function StepLayer({
  query,
  color,
  dashed = false,
}: {
  query: QueryObject
  color: string
  dashed?: boolean
}) {
  // As written (compact); the server already sends it so.
  const step = compactQuery(query) as QueryObject
  const ids = useHits(step).ids
  const catalog = useLayers().data
  const config = useMapConfig()
  const count = catalog?.find((l) => l.name === step.source)?.feature_count ?? 0
  const layer: QueryObject = { schema_version: '2', source: step.source, output: 'map' }
  const features = useLayerFeatures(
    layer,
    count > (config.data?.max_features ?? Infinity),
    ids !== null,
  )
  const map = useLeafletMap()
  const data = features.data
  useEffect(() => {
    if (!map || !data || !ids) return
    const element = map.getPane(PANE) ?? map.createPane(PANE)
    element.style.zIndex = '420'
    element.style.pointerEvents = 'none'
    const style = dashed
      ? { color, weight: 2, dashArray: '4 3', fill: false, interactive: false }
      : {
          color,
          weight: 1.5,
          opacity: 0.7,
          fillColor: color,
          fillOpacity: 0.35,
          interactive: false,
        }
    const shown = L.geoJSON(collection(data.features, ids), {
      pane: PANE,
      interactive: false,
      style: () => style,
      pointToLayer: (_, latlng) =>
        L.circleMarker(latlng, { pane: PANE, radius: dashed ? 8 : 5, ...style }),
    }).addTo(map)
    return () => {
      shown.remove()
    }
  }, [map, data, ids, color, dashed])
  return null
}

function collection(
  features: QueryResult['features'],
  ids: Set<number>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry !== null && ids.has(Number(f.id)))
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
        {phaseOf(view) === 'done' ? (
          <Trans>Ergebnis gestrichelt · vorgemerkt, nicht angewendet</Trans>
        ) : (
          <Trans>Zwischenstand gedämpft · nicht angewendet</Trans>
        )}
      </p>
      <ul>
        {steps.map((step, i) => {
          const n = formatNumber(placeOf(view, step))
          const hits = step.hits != null ? formatNumber(step.hits) : null
          const latest = i === steps.length - 1
          return (
            <li key={step.position} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-sm border border-neutral-500"
                style={{ background: latest ? LATEST : EARLIER }}
              />
              {hits !== null ? t`Schritt ${n} · ${hits}` : t`Schritt ${n}`}
              <span className="text-muted">{` · ${step.text}`}</span>
              {/* Not by colour alone: the latest says so. */}
              {latest && (
                <span className="font-semibold">
                  <Trans>(zuletzt)</Trans>
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The sidebar's "Zwischenstand · Kette" (design M9.1, M9.3, M9.4): what the
 * chain has so far, beside the analysis it has not changed. Running: the
 * last step that ran; done: the result, marked; stopped: the result to adopt.
 */
export function ChainPending() {
  const view = useModel(liveChain)
  const catalog = useLayers().data
  if (!view) return null
  const phase = phaseOf(view)
  const steps = planned(view)
  const last = steps.filter(finished).pop()
  const total = formatNumber(steps.length)
  const hits = adoptedHits(view)
  const source = (view.query as { source?: string } | null)?.source
  const all = catalog?.find((l) => l.name === source)?.feature_count
  let line: string
  if (phase === 'done' && hits !== null) {
    const shown = all != null ? hitsOf(hits, all) : formatNumber(hits)
    line = t`Ergebnis ${shown} · vorgemerkt`
  } else if (phase === 'stopped') {
    const stamped = view.steps.find((s) => s.stamp)
    const at = stamped ? formatNumber(placeOf(view, stamped)) : null
    const count = hits !== null ? formatNumber(hits) : null
    line =
      at && count
        ? t`Schritt ${at} · ${count} Treffer übernehmbar`
        : view.query
          ? t`Zwischenstand übernehmbar`
          : t`nichts zu übernehmen`
  } else if (last) {
    const at = formatNumber(placeOf(view, last))
    const count = last.hits != null ? formatNumber(last.hits) : null
    line = count ? t`Schritt ${at} von ${total} · ${count}` : t`Schritt ${at} von ${total}`
  } else line = t`noch kein Schritt gelaufen`
  return (
    <div
      role="note"
      aria-label={t`Zwischenstand · Kette`}
      className={`flex flex-col gap-1 rounded p-2 text-xs ${FRAME.dashed}`}
    >
      <p className="label-caps">
        <Trans>Zwischenstand · Kette</Trans>
      </p>
      <p>{line}</p>
      <p className="text-muted">
        <Trans>nicht angewendet</Trans>
      </p>
    </div>
  )
}
