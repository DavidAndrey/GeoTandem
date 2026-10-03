// Layer panel (design B1, B3; F-4.1): order, visibility, opacity. It controls
// only the display; the query is edited below.
import { ChevronDown, ChevronRight, Eye, EyeOff, GripVertical } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { DisplayLayer } from '../analysis/model'
import { canBeResult } from '../analysis/query'
import { useAnalysis } from '../analysis/store'
import { rows } from '../analysis/tree'
import type { LayerInfo } from '../api/client'
import { useLayers, useMe } from '../api/queries'
import { ConfirmDialog, Menu, MenuItem } from '../components/ui'
import { layerColor } from '../map/style'
import { useMapView } from '../map/view'
import { OperationDialog, type Operation } from '../operations/OperationDialog'
import { AddLayers } from './AddLayers'
import { geometryKind, layerTitle } from './layerInfo'
import { Swatch } from './Swatch'

export function LayerPanel() {
  const layers = useAnalysis((s) => s.layers)
  const catalog = useLayers()
  const catalogLayers = layers.filter((l) => l.source.kind === 'catalog')
  const derived = layers.filter((l) => l.source.kind === 'derived')

  return (
    <section aria-labelledby="layers-title">
      <div className="mb-1 flex items-center">
        <h2 id="layers-title" className="label-caps flex-1">
          Layer
        </h2>
        <AddLayers />
      </div>
      {layers.length === 0 && (
        <p className="text-muted py-2 text-sm">
          Noch keine Layer. Über „+ Layer" kommen sie aus dem Katalog.
        </p>
      )}
      <LayerList layers={catalogLayers} catalog={catalog.data} />
      {derived.length > 0 && (
        <>
          <h3 className="label-caps mt-3 mb-1">Abgeleitet · Sitzung</h3>
          <LayerList layers={derived} catalog={catalog.data} />
        </>
      )}
    </section>
  )
}

function LayerList({
  layers,
  catalog,
}: {
  layers: DisplayLayer[]
  catalog: LayerInfo[] | undefined
}) {
  const all = useAnalysis((s) => s.layers)
  const moveLayer = useAnalysis((s) => s.moveLayer)
  const [dragged, setDragged] = useState<string | null>(null)
  return (
    <ul className="flex flex-col">
      {layers.map((layer) => (
        <li
          key={layer.id}
          draggable
          onDragStart={() => setDragged(layer.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragged && dragged !== layer.id)
              moveLayer(
                dragged,
                all.findIndex((l) => l.id === layer.id),
              )
            setDragged(null)
          }}
        >
          <LayerRow layer={layer} catalog={catalog} />
        </li>
      ))}
    </ul>
  )
}

function LayerRow({ layer, catalog }: { layer: DisplayLayer; catalog: LayerInfo[] | undefined }) {
  const navigate = useNavigate()
  const me = useMe()
  const s = useAnalysis()
  const zoomTo = useMapView((v) => v.zoomTo)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [operation, setOperation] = useState<Operation | null>(null)
  const kind = geometryKind(layer, catalog)
  const title = layerTitle(layer, catalog)
  const index = s.layers.findIndex((l) => l.id === layer.id)
  const isResult = s.result === layer.id
  const name = layer.source.kind === 'catalog' ? layer.source.layer : null
  const usedInConditions =
    name !== null && rows(s.tree).some((r) => 'layer' in r && r.layer === name)

  return (
    <div className={`rounded-[var(--radius-md)] ${open ? 'bg-neutral-200/60' : ''}`}>
      <div className="flex items-center gap-1.5 py-0.5 text-sm">
        <GripVertical size={13} aria-hidden className="text-muted cursor-grab" />
        <button
          type="button"
          aria-label={`${title} ${layer.visible ? 'ausblenden' : 'einblenden'}`}
          aria-pressed={layer.visible}
          onClick={() => s.setVisible(layer.id, !layer.visible)}
        >
          {layer.visible ? <Eye size={14} /> : <EyeOff size={14} className="text-muted" />}
        </button>
        <Swatch kind={kind} color={layerColor(layer)} />
        <button
          type="button"
          className={`flex flex-1 items-center gap-1 text-left ${layer.visible ? '' : 'text-muted'}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="flex-1">{title}</span>
          {isResult && <span className="chip chip-active text-[11px]">Ergebnis</span>}
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
      {open && (
        <div className="mb-1 ml-5 flex flex-col gap-1.5 pb-1.5 pr-1 text-xs">
          <label className="flex items-center gap-2">
            Deckkraft
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              aria-label={`Deckkraft ${title}`}
              value={Math.round(layer.opacity * 100)}
              onChange={(e) => s.setOpacity(layer.id, Number(e.target.value) / 100)}
              className="accent-[var(--color-accent)] flex-1"
            />
            <span className="w-10 shrink-0 text-right">{Math.round(layer.opacity * 100)} %</span>
          </label>
          <div className="flex items-center gap-1">
            <button type="button" className="btn text-xs" onClick={() => zoomTo(layer.id)}>
              Auf Layer zoomen
            </button>
            <Menu label={`Aktionen für ${title}`}>
              <MenuItem onSelect={() => zoomTo(layer.id)}>Auf Layer zoomen</MenuItem>
              {!isResult && canBeResult(layer) && (
                <MenuItem onSelect={() => s.setResult(layer.id)}>Als Ergebnis-Layer</MenuItem>
              )}
              {kind !== 'table' && layer.source.kind === 'catalog' && (
                <>
                  <MenuItem onSelect={() => setOperation('buffer')}>Puffer …</MenuItem>
                  <MenuItem onSelect={() => setOperation('join')}>Join …</MenuItem>
                  <MenuItem onSelect={() => setOperation('aggregate')}>Aggregieren …</MenuItem>
                </>
              )}
              <MenuItem onSelect={() => setOperation('symbology')}>Darstellung …</MenuItem>
              {index > 0 && (
                <MenuItem onSelect={() => s.moveLayer(layer.id, index - 1)}>Nach oben</MenuItem>
              )}
              {index < s.layers.length - 1 && (
                <MenuItem onSelect={() => s.moveLayer(layer.id, index + 1)}>Nach unten</MenuItem>
              )}
              {me.data?.role === 'admin' && name && (
                <MenuItem onSelect={() => navigate(`/admin/daten/${name}`)}>
                  Im Datenkatalog öffnen
                </MenuItem>
              )}
              <MenuItem
                danger
                onSelect={() =>
                  isResult || usedInConditions ? setRemoving(true) : s.removeLayer(layer.id)
                }
              >
                {layer.source.kind === 'derived' ? 'Löschen' : 'Aus Analyse entfernen'}
              </MenuItem>
            </Menu>
          </div>
        </div>
      )}
      {operation && (
        <OperationDialog layer={layer} operation={operation} onClose={() => setOperation(null)} />
      )}
      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setRemoving(false)}
          title={`„${title}" entfernen?`}
          confirm="Entfernen"
          onConfirm={() => {
            s.removeLayer(layer.id)
            setRemoving(false)
          }}
        >
          <p>
            {isResult
              ? 'Der Layer ist Ergebnis-Layer; die Abfrage hat danach kein Ergebnis mehr.'
              : 'Der Layer wird in einer Bedingung verwendet; die Bedingung wirkt weiter, der Layer wird nur nicht mehr angezeigt.'}
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
