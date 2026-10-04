// Measuring on the map (design B10, plan E1.8 G2): click points, read the
// geodesic length or area. A view tool like zoom — not saved, no query.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import L from 'leaflet'
import { Ruler, X } from 'lucide-react'
import { useEffect, useMemo, useReducer } from 'react'
import { useLeafletMap } from './leaflet'
import { areaOf, formatArea, formatLength, lengthOf, reduceDrawing, type LatLng } from './measure'
import { toolClass } from './MapView'
import { useMapView } from './view'

const INK = '#201f1d'

/** ⟷ in the toolbar: starts and ends measuring. */
export function MeasureToggle() {
  const measuring = useMapView((s) => s.measuring)
  const setMeasuring = useMapView((s) => s.setMeasuring)
  return (
    <button
      type="button"
      className={toolClass}
      title={t`Messen`}
      aria-label={t`Messen`}
      aria-pressed={measuring !== null}
      onClick={() => setMeasuring(measuring ? null : 'line')}
    >
      <Ruler size={15} />
    </button>
  )
}

/** The measurement on the map and its readout; lives inside the map. */
function areaText({ area, perimeter }: { area: number; perimeter: number }) {
  const surface = formatArea(area)
  const length = formatLength(perimeter)
  return t`${surface} · Umfang ${length}`
}

export function Measurement() {
  const measuring = useMapView((s) => s.measuring)
  // Keyed by the mode: switching between distance and area starts afresh.
  return measuring ? <Measuring key={measuring} mode={measuring} /> : null
}

function Measuring({ mode }: { mode: 'line' | 'area' }) {
  const map = useLeafletMap()
  const setMeasuring = useMapView((s) => s.setMeasuring)
  const [state, dispatch] = useReducer(reduceDrawing, {
    points: [],
    cursor: null,
    done: false,
    exit: false,
  })
  const { points, cursor, done } = state
  const measuring = mode

  useEffect(() => {
    if (state.exit) setMeasuring(null)
  }, [state.exit, setMeasuring])

  useEffect(() => {
    if (!map) return
    const container = map.getContainer()
    container.style.cursor = 'crosshair'
    map.doubleClickZoom.disable()
    const at = (e: L.LeafletMouseEvent): LatLng => [e.latlng.lat, e.latlng.lng]
    const click = (e: L.LeafletMouseEvent) => dispatch({ type: 'add', point: at(e) })
    const move = (e: L.LeafletMouseEvent) => dispatch({ type: 'move', point: at(e) })
    const finish = () => dispatch({ type: 'finish' })
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'escape' })
    }
    map.on('click', click)
    map.on('mousemove', move)
    map.on('dblclick', finish)
    window.addEventListener('keydown', key)
    return () => {
      container.style.cursor = ''
      map.doubleClickZoom.enable()
      map.off('click', click)
      map.off('mousemove', move)
      map.off('dblclick', finish)
      window.removeEventListener('keydown', key)
    }
  }, [map])

  // The drawing: the points so far, and while drawing the segment to the pointer.
  const drawn = useMemo<LatLng[]>(
    () => (!done && cursor && points.length > 0 ? [...points, cursor] : points),
    [done, cursor, points],
  )
  useEffect(() => {
    if (!map || drawn.length === 0) return
    const style = { color: INK, weight: 2, dashArray: '6 4', interactive: false }
    const shape =
      measuring === 'area' && drawn.length >= 3
        ? L.polygon(drawn, { ...style, fillColor: INK, fillOpacity: 0.08 })
        : L.polyline(drawn, style)
    const vertices = points.map((p) =>
      L.circleMarker(p, {
        radius: 3,
        color: INK,
        fillColor: '#fff',
        fillOpacity: 1,
        weight: 1.5,
        interactive: false,
      }),
    )
    const group = L.featureGroup([shape, ...vertices]).addTo(map)
    return () => {
      group.remove()
    }
  }, [map, measuring, drawn, points])

  const length = lengthOf(drawn)
  const area = areaOf(drawn)
  return (
    <section
      aria-label={t`Messen`}
      className="card absolute top-3 right-12 z-[1000] flex w-64 flex-col gap-2 p-2 text-sm"
    >
      <div className="flex items-center gap-1">
        <div role="group" aria-label={t`Messart`} className="flex flex-1">
          {(['line', 'area'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={measuring === mode}
              className={`btn -ml-px text-xs first:ml-0 ${measuring === mode ? 'btn-primary bg-accent-100' : ''}`}
              onClick={() => setMeasuring(mode)}
            >
              {mode === 'line' ? t`Strecke` : t`Fläche`}
            </button>
          ))}
        </div>
        <button type="button" aria-label={t`Messen beenden`} onClick={() => setMeasuring(null)}>
          <X size={15} />
        </button>
      </div>
      <p role="status" aria-label={t`Messwert`} className="font-semibold">
        {measuring === 'line' ? formatLength(length) : drawn.length >= 3 ? areaText(area) : '–'}
      </p>
      <p className="text-muted text-xs">
        <Trans>
          Klicken setzt Punkte, Doppelklick schliesst ab, Esc beginnt neu. Gemessen auf dem
          Ellipsoid (WGS84).
        </Trans>
      </p>
    </section>
  )
}
