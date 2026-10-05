// The map (F-4.9, F-8.1) on plain Leaflet with a thin React layer (tech-stack 4.2).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { Home, Layers, List, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMapConfig } from '../api/queries'
import { fitBbox, MapContext } from './leaflet'
import { useMapView } from './view'

export const toolClass =
  'flex size-7 items-center justify-center hover:bg-neutral-200 disabled:opacity-45'

export function MapView({
  children,
  legend,
  tools,
  leading,
}: {
  children?: ReactNode
  legend?: ReactNode
  /** A further group in the toolbar, e.g. the table toggle. */
  tools?: ReactNode
  /** The first group of the toolbar: search (design B10). */
  leading?: ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<L.Map | null>(null)
  const [showBasemap, setShowBasemap] = useState(true)
  const [showLegend, setShowLegend] = useState(true)
  const config = useMapConfig()
  const setBbox = useMapView((s) => s.setBbox)
  const extent = config.data?.extent_wgs84
  const basemap = config.data?.basemap

  useEffect(() => {
    if (!container.current) return
    const created = L.map(container.current, { zoomControl: false, center: [46.9, 7.9], zoom: 11 })
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(created)
    const report = () => {
      const b = created.getBounds()
      setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
    }
    created.on('moveend', report)
    report()
    // The container changes size when the editor column opens (design B2).
    const resized = new ResizeObserver(() => created.invalidateSize())
    resized.observe(container.current)
    setMap(created)
    return () => {
      resized.disconnect()
      created.remove()
      setMap(null)
    }
  }, [setBbox])

  // The first view shows every layer this account may see.
  const fitted = useRef(false)
  useEffect(() => {
    // A session that is being opened brings its own view (plan E1.7, D3).
    if (map && extent && !fitted.current && !useMapView.getState().featureRequest) {
      map.invalidateSize() // the container may have been sized after the map was made
      fitBbox(map, extent)
      fitted.current = true
    }
  }, [map, extent])

  useEffect(() => {
    if (!map || !basemap || !showBasemap) return
    const tiles = L.tileLayer(basemap.url, {
      attribution: basemap.attribution,
      maxZoom: basemap.max_zoom,
      // The page's Referrer-Policy (same-origin) would send none; tile.openstreetmap.org
      // blocks tiles without one. The origin alone identifies the site, no path leaks.
      referrerPolicy: 'strict-origin',
    }).addTo(map)
    return () => {
      tiles.remove()
    }
  }, [map, basemap, showBasemap])

  const tool = toolClass
  return (
    <div className="relative h-full min-h-64">
      <div
        ref={container}
        className="h-full w-full bg-neutral-200"
        role="region"
        aria-label={t`Karte`}
      />
      <MapContext value={map}>{map && children}</MapContext>
      <div
        role="toolbar"
        aria-label={t`Kartenwerkzeuge`}
        aria-orientation="vertical"
        className="card absolute top-3 right-3 z-[1000] flex flex-col divide-y divide-[var(--color-divider)] py-0.5"
      >
        {leading && <div className="flex flex-col">{leading}</div>}
        <div className="flex flex-col">
          <button
            type="button"
            className={tool}
            title={t`Hineinzoomen`}
            aria-label={t`Hineinzoomen`}
            onClick={() => map?.zoomIn()}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            className={tool}
            title={t`Herauszoomen`}
            aria-label={t`Herauszoomen`}
            onClick={() => map?.zoomOut()}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            className={tool}
            title={t`Alle Layer`}
            aria-label={t`Alle Layer`}
            disabled={!extent}
            onClick={() => map && extent && fitBbox(map, extent)}
          >
            <Home size={15} />
          </button>
        </div>
        <div className="flex flex-col">
          <button
            type="button"
            className={tool}
            title={basemap ? t`Hintergrundkarte ein/aus` : t`Keine Hintergrundkarte konfiguriert`}
            aria-label={t`Hintergrundkarte`}
            aria-pressed={Boolean(basemap) && showBasemap}
            disabled={!basemap}
            onClick={() => setShowBasemap(!showBasemap)}
          >
            <Layers size={15} />
          </button>
          <button
            type="button"
            className={tool}
            title={t`Legende ein/aus`}
            aria-label={t`Legende`}
            aria-pressed={showLegend}
            onClick={() => setShowLegend(!showLegend)}
          >
            <List size={15} />
          </button>
        </div>
        {tools && <div className="flex flex-col">{tools}</div>}
      </div>
      {showLegend && legend && (
        <div className="card absolute right-12 bottom-6 z-[1000] max-w-64 p-2 text-xs">
          {legend}
        </div>
      )}
      {basemap?.external && showBasemap && (
        <p
          className="absolute top-3 left-3 z-[1000] rounded bg-neutral-100/90 px-2 py-0.5 text-xs"
          title={t`Die Kacheln kommen von ausserhalb dieser Installation; der Anbieter sieht den Kartenausschnitt.`}
        >
          <Trans>Hintergrund extern</Trans>
        </p>
      )}
    </div>
  )
}
