// Map search (design B10, plan E1.8 G1): the names of the features in every
// layer this account sees, through the engine like any other query — local,
// case-insensitive by the shared text rules (F-2.14), nothing leaves the
// installation. A hit is zoomed to and marked; on a shown layer it is selected.
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAnalysis } from '../analysis/store'
import { api, type LayerInfo } from '../api/client'
import { useLayers } from '../api/queries'
import { useSelection } from '../table/selection'
import { extent } from '../table/rows'
import { labelAttribute } from '../workplace/layerInfo'
import { useLeafletMap } from './leaflet'
import { toolClass } from './MapView'
import { PER_LAYER, searchQuery } from './search'
import { markStyle } from './style'
import { useMapView } from './view'

const MIN_LENGTH = 2

interface Hit {
  layer: LayerInfo
  fid: number
  label: string
  geometry: GeoJSON.Geometry
}

export function MapSearch() {
  const [open, setOpen] = useState(false)
  const setFound = useMapView((s) => s.setFound)
  return (
    <div className="relative">
      <button
        type="button"
        className={toolClass}
        title="Suchen"
        aria-label="Suchen"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          if (open) setFound(null)
        }}
      >
        <Search size={15} />
      </button>
      {open && (
        <SearchPanel
          onClose={() => {
            setOpen(false)
            setFound(null)
          }}
        />
      )}
    </div>
  )
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  const catalog = useLayers()
  const [text, setText] = useState('')
  const debounced = useDebounced(text.trim(), 300)
  const layers = (catalog.data ?? []).flatMap((layer) => {
    const attr = layer.kind === 'vector' ? labelAttribute(layer) : null
    return attr ? [{ layer, attr }] : []
  })
  const results = useQuery({
    queryKey: ['map-search', debounced, layers.map((l) => l.layer.name)],
    queryFn: () =>
      Promise.all(
        layers.map(async ({ layer, attr }) => {
          const found = await api.query(searchQuery(layer.name, attr, debounced))
          const hits: Hit[] = found.features.slice(0, PER_LAYER).flatMap((f) =>
            f.geometry
              ? [
                  {
                    layer,
                    fid: f.id,
                    label: String(f.properties[attr] ?? ''),
                    geometry: f.geometry as unknown as GeoJSON.Geometry,
                  },
                ]
              : [],
          )
          return { layer, hits, more: found.features.length > PER_LAYER }
        }),
      ),
    enabled: debounced.length >= MIN_LENGTH && layers.length > 0,
  })
  const groups = (results.data ?? []).filter((g) => g.hits.length > 0)
  const first = groups[0]?.hits[0]

  return (
    <div
      role="search"
      aria-label="Kartensuche"
      className="card absolute top-0 right-full mr-2 flex w-80 flex-col gap-2 p-2 text-sm"
    >
      <div className="flex items-center gap-1">
        <input
          className="input flex-1"
          type="search"
          aria-label="Suchbegriff"
          placeholder="Gemeinde, Haltestelle, Schule …"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) choose(first)
            if (e.key === 'Escape') onClose()
          }}
        />
        <button type="button" aria-label="Suche schliessen" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {debounced.length >= MIN_LENGTH && (
        <div className="max-h-80 overflow-auto">
          {results.isPending ? (
            <p className="text-muted">Sucht …</p>
          ) : groups.length === 0 ? (
            <p className="text-muted">Nichts gefunden.</p>
          ) : (
            groups.map((group) => (
              <section key={group.layer.name} aria-label={group.layer.title} className="mb-1">
                <p className="label-caps">{group.layer.title}</p>
                <ul>
                  {group.hits.map((hit) => (
                    <li key={hit.fid}>
                      <button
                        type="button"
                        className="w-full truncate rounded px-1 text-left hover:bg-neutral-200"
                        onClick={() => choose(hit)}
                      >
                        {hit.label}
                      </button>
                    </li>
                  ))}
                </ul>
                {group.more && (
                  <p className="text-muted px-1 text-xs">weitere Treffer — genauer suchen</p>
                )}
              </section>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** Zoom to a hit; select it if its layer is shown, else mark it until the next search. */
function choose(hit: Hit) {
  const view = useMapView.getState()
  const bbox = extent((hit.geometry as { coordinates?: unknown }).coordinates)
  if (bbox) view.zoomToFeature(bbox, 'zoom')
  const shown = useAnalysis
    .getState()
    .layers.find(
      (l) => !l.table && l.source.kind === 'catalog' && l.source.layer === hit.layer.name,
    )
  if (shown) {
    view.setFound(null)
    useSelection.getState().select(shown.id, hit.fid, true)
  } else view.setFound({ geometry: hit.geometry, label: hit.label })
}

/** A found feature of a layer that is not shown: outline and ring, never saved. */
export function FoundOverlay() {
  const map = useLeafletMap()
  const found = useMapView((s) => s.found)
  const layer = useRef<L.GeoJSON | null>(null)
  useEffect(() => {
    if (!map || !found) return
    // A text node, not a string: Leaflet would insert a string as HTML, and the
    // label comes from imported data (as in popup.ts).
    const label = document.createElement('span')
    label.textContent = found.label
    layer.current = L.geoJSON(found.geometry, {
      interactive: false,
      style: () => markStyle('selected', 'shape'),
      pointToLayer: (_, latlng) =>
        L.featureGroup([
          L.circleMarker(latlng, { interactive: false, ...markStyle('selected', 'ring') }),
          L.circleMarker(latlng, { interactive: false, ...markStyle('selected', 'outline') }),
        ]),
    })
      .bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -14] })
      .addTo(map)
    return () => {
      layer.current?.remove()
      layer.current = null
    }
  }, [map, found])
  return null
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return current
}
