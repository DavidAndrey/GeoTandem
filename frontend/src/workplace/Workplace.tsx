// Workplace of the classic mode (design B1): sidebar with layers and query,
// map beside it. Everything on the map comes from query objects (E1.5).
import { useShallow } from 'zustand/react/shallow'
import { Tabs } from 'radix-ui'
import { useCallback, useEffect } from 'react'
import type { DisplayLayer, GeoJSONGeometry, ReferenceRow } from '../analysis/model'
import { layerQuery, resultQuery, resultWhere, rowQueries } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import type { LayerInfo } from '../api/client'
import { useLayers, useMapConfig } from '../api/queries'
import { EditorPanel } from '../editor/EditorPanel'
import L from 'leaflet'
import { Table2 } from 'lucide-react'
import { useHits } from '../map/data'
import { DataLayer } from '../map/DataLayer'
import { RestrictionLayer } from '../map/Restriction'
import { fitBbox, shownBounds, useLeafletMap } from '../map/leaflet'
import { MapView, toolClass } from '../map/MapView'
import { ACCENT, layerColor } from '../map/style'
import { useLegend } from '../map/symbolize'
import { useMapView } from '../map/view'
import { useDock } from '../table/dock'
import { TableDock } from '../table/TableDock'
import { catalogInfo, geometryKind, labelAttribute, layerTitle, panelOrder } from './layerInfo'
import { LayerPanel } from './LayerPanel'
import { QueryPanel } from './QueryPanel'
import { SavedQueries } from '../queries/SavedQueries'
import { Swatch } from './Swatch'

export function Workplace() {
  const editing = useAnalysis((s) => s.draft !== null)
  return (
    <div
      className={`grid h-full gap-4 ${editing ? 'grid-cols-[250px_460px_minmax(0,1fr)]' : 'grid-cols-[250px_minmax(0,1fr)]'}`}
    >
      <aside
        className={`flex min-h-0 flex-col gap-4 overflow-auto pr-1 ${editing ? 'pointer-events-none opacity-50' : ''}`}
        aria-label="Seitenleiste"
        inert={editing}
      >
        <Tabs.Root defaultValue="klassik">
          <Tabs.List
            className="flex gap-4 border-b border-[var(--color-divider)]"
            aria-label="Arbeitsweise"
          >
            <Tabs.Trigger value="klassik" className="tab text-sm">
              Klassik
            </Tabs.Trigger>
            <Tabs.Trigger value="prompt" className="tab text-muted text-sm" disabled>
              Prompt · ab E2
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="klassik" className="flex flex-col gap-5 pt-3">
            <LayerPanel />
            <QueryPanel />
            <SavedQueries />
          </Tabs.Content>
        </Tabs.Root>
      </aside>
      {editing && <EditorPanel />}
      <div className="flex min-h-0 flex-col">
        <MapLayers />
        <TableDock />
      </div>
    </div>
  )
}

function MapLayers() {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const { editNode, setRestriction } = useAnalysis(
    useShallow((s) => ({ editNode: s.editNode, setRestriction: s.setRestriction })),
  )
  const { activeRow, setPick } = useMapView(
    useShallow((s) => ({ activeRow: s.activeRow, setPick: s.setPick })),
  )
  const editing = useAnalysis((s) => s.draft !== null)
  const catalog = useLayers()
  const config = useMapConfig()
  // While a row is active in the editor the map shows its hits alone (design B2).
  const active =
    editing && activeRow ? rowQueries(analysis).find((r) => r.id === activeRow) : undefined
  const where = active ? active.query.where : resultWhere(analysis)
  const shown = active ? active.query : resultQuery(analysis)
  // Hits of the result layer, told apart only while there are conditions (design B9).
  const hitIds = useHits(shown).ids
  const visible = panelOrder(analysis.layers).filter((l) => l.visible)
  const maxFeatures = config.data?.max_features ?? Infinity
  const onPick = useCallback(
    (rowId: string, fid: number, label: string) => {
      editNode<ReferenceRow>(rowId, { fid, label })
      setPick(null)
    },
    [editNode, setPick],
  )
  const onDrawn = useCallback(
    (geometry: GeoJSONGeometry) => setRestriction({ kind: 'shape', geometry }),
    [setRestriction],
  )
  const resultTitle = analysis.layers.find((l) => l.id === analysis.result)
  const labelOf = useCallback(
    (layer: string) => labelAttribute(catalog.data?.find((l) => l.name === layer)),
    [catalog.data],
  )

  return (
    <div className="relative min-h-0 flex-1">
      <MapView
        tools={<TableToggle />}
        legend={
          visible.length > 0 && (
            <Legend
              layers={visible}
              catalog={catalog.data}
              hits={Boolean(where)}
              result={analysis.result}
            />
          )
        }
      >
        {/* Drawn in the order the panel shows (top first), not the store's. */}
        {panelOrder(analysis.layers).map((layer, index) => {
          const info = catalogInfo(layer, catalog.data)
          return (
            <DataLayer
              key={layer.id}
              layer={layer}
              query={layerQuery(layer, analysis, labelOf)}
              order={analysis.layers.length - index}
              title={layerTitle(layer, catalog.data)}
              info={info}
              hits={layer.id === analysis.result ? hitIds : null}
              largerThanLimit={(info?.feature_count ?? 0) > maxFeatures}
              onPick={onPick}
            />
          )
        })}
        <RestrictionLayer restriction={analysis.restriction} onDrawn={onDrawn} />
        <ZoomOnRequest layers={analysis.layers} catalog={catalog.data} />
        <FeatureOnRequest />
      </MapView>
      {active && hitIds && resultTitle && (
        <p role="status" className="card absolute bottom-6 left-3 z-[1000] px-3 py-1 text-sm">
          Aktive Bedingung: {hitIds.size} {layerTitle(resultTitle, catalog.data)}
        </p>
      )}
    </div>
  )
}

/** ▦ in the toolbar (design B10): opens and closes the attribute table. */
function TableToggle() {
  const { open, setOpen } = useDock()
  const hasLayers = useAnalysis((s) => s.layers.length > 0)
  return (
    <button
      type="button"
      className={toolClass}
      title="Attributtabelle ein/aus"
      aria-label="Attributtabelle"
      aria-pressed={open}
      disabled={!hasLayers}
      onClick={() => setOpen(!open)}
    >
      <Table2 size={15} />
    </button>
  )
}

/** A feature picked in the table: ⌖ zooms to it, a row click only pans it into view. */
function FeatureOnRequest() {
  const map = useLeafletMap()
  const request = useMapView((s) => s.featureRequest)
  useEffect(() => {
    if (!map || !request) return
    const [west, south, east, north] = request.bbox
    const bounds = L.latLngBounds([south, west], [north, east])
    const apply = () => {
      if (request.mode === 'view') map.fitBounds(bounds)
      else if (request.mode === 'zoom') map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17 })
      else if (!map.getBounds().contains(bounds)) map.panTo(bounds.getCenter())
    }
    // Leaflet drops an animated zoom asked for while another one runs (e.g. ⌖ right
    // after "Auf Layer zoomen"); it is applied when that one ends instead.
    if (isZooming(map)) {
      map.once('zoomend', apply)
      return () => {
        map.off('zoomend', apply)
      }
    }
    apply()
  }, [map, request])
  return null
}

/** Leaflet keeps this flag private; there is no public way to ask. */
const isZooming = (map: L.Map) =>
  Boolean((map as unknown as { _animatingZoom?: boolean })._animatingZoom)

function ZoomOnRequest({
  layers,
  catalog,
}: {
  layers: DisplayLayer[]
  catalog: LayerInfo[] | undefined
}) {
  const map = useLeafletMap()
  const request = useMapView((s) => s.zoomRequest)
  useEffect(() => {
    if (!map || !request) return
    const layer = layers.find((l) => l.id === request.layer)
    const bbox = layer ? catalogInfo(layer, catalog)?.bbox_wgs84 : null
    if (bbox) fitBbox(map, bbox)
    else {
      const bounds = shownBounds.get(request.layer)
      if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 })
    }
    // Only a new request zooms, not a changed layer list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, request])
  return null
}

function Legend({
  layers,
  catalog,
  hits,
  result,
}: {
  layers: DisplayLayer[]
  catalog: LayerInfo[] | undefined
  hits: boolean
  result: string | null
}) {
  const entries = useLegend((s) => s.entries)
  return (
    <section aria-label="Legende">
      <p className="label-caps mb-1">Legende</p>
      <ul className="flex flex-col gap-0.5">
        {layers.map((layer) => {
          const kind = geometryKind(layer, catalog)
          const title = layerTitle(layer, catalog)
          if (hits && layer.id === result)
            return (
              <li key={layer.id}>
                <div className="flex items-center gap-1.5">
                  <Swatch kind={kind} color={ACCENT} /> {title} · Treffer
                </div>
                <div className="flex items-center gap-1.5 opacity-50">
                  <Swatch kind={kind} color={layerColor(layer)} /> {title} · übrige
                </div>
              </li>
            )
          const classes = entries[layer.id] ?? []
          return (
            <li key={layer.id}>
              <div className="flex items-center gap-1.5">
                {classes.length === 0 && <Swatch kind={kind} color={layerColor(layer)} />} {title}
              </div>
              {classes.length > 0 && (
                <ul className="ml-3">
                  {classes.map((entry) => (
                    <li key={entry.label} className="flex items-center gap-1.5">
                      {entry.radius ? (
                        <span
                          aria-hidden
                          className="inline-block rounded-full border border-neutral-600"
                          style={{
                            width: entry.radius * 2,
                            height: entry.radius * 2,
                            background: entry.color,
                          }}
                        />
                      ) : (
                        <Swatch kind={kind} color={entry.color} />
                      )}
                      {entry.label}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
