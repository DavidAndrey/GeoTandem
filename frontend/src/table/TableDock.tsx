// Attribute table docked under the map (F-8.2, design B8): one tab per
// displayed layer, the result layer first. Reads the same cached queries as the
// map (plan E1.6 D2), so table and map always show the same result.
import { formatNumber } from '../i18n/locale'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Crosshair, GripVertical } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Analysis, ColumnChoice, DisplayLayer, SortKey } from '../analysis/model'
import { explainColumns, layerQuery, resultLayer, resultQuery } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import type { LayerInfo } from '../api/client'
import { useLayers, useMapConfig } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { useHits, useLayerFeatures } from '../map/data'
import { formatValue } from '../map/popup'
import { useMapView } from '../map/view'
import { catalogInfo, geometryKind, labelAttribute, layerTitle } from '../workplace/layerInfo'
import { MIN_HEIGHT, useDock } from './dock'
import {
  availableColumns,
  orderedColumns,
  shownColumns,
  sortRows,
  tableRows,
  tabOrder,
  type Row,
  type TableColumn,
} from './rows'
import { useSelection } from './selection'

const ROW = 32
const OVERSCAN = 6
/** One empty list, so the selection selector stays stable (a new [] would re-render forever). */
const NONE: number[] = []

const objectCount = (n: number) => {
  const count = formatNumber(n)
  return plural(n, { one: `${count} Objekt`, other: `${count} Objekte` })
}
const selectRow = (id: number) => t`Zeile ${id} auswählen`
const zoomRow = (id: number) => t`Auf Zeile ${id} zoomen`
const moveUp = (column: string) => t`${column} nach oben`
const moveDown = (column: string) => t`${column} nach unten`

export function TableDock() {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const tab = useAnalysis((s) => s.table.tab)
  const setTableTab = useAnalysis((s) => s.setTableTab)
  const { open, height, setOpen } = useDock()
  const catalog = useLayers()
  const layers = tabOrder(analysis)
  const active = layers.find((l) => l.id === tab) ?? layers[0]
  if (!active) return null

  if (!open)
    return (
      <div className="flex justify-end border-t border-[var(--color-divider)] pt-1">
        <button type="button" className="btn text-xs" onClick={() => setOpen(true)}>
          <ChevronUp size={13} aria-hidden /> <Trans>Attributtabelle öffnen</Trans>
        </button>
      </div>
    )

  return (
    <section aria-label={t`Attributtabelle`} className="flex min-h-0 flex-col" style={{ height }}>
      <Divider />
      <div className="flex min-h-0 flex-1 flex-col gap-2 pt-2">
        <div role="tablist" aria-label={t`Tabellen`} className="flex flex-wrap gap-x-4 gap-y-1">
          {layers.map((layer) => {
            const selected = layer.id === active.id
            const isResult = layer.id === analysis.result
            return (
              <button
                key={layer.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-state={selected ? 'active' : 'inactive'}
                className={`tab text-sm ${selected ? 'text-accent-700' : 'text-muted'}`}
                onClick={() => setTableTab(layer.id)}
              >
                {layerTitle(layer, catalog.data)}
                {isResult && (
                  <span className="ml-1 text-xs">
                    <Trans>(Ergebnis)</Trans>
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <LayerTable
          key={active.id}
          layer={active}
          analysis={analysis}
          catalog={catalog.data}
          onCollapse={() => setOpen(false)}
        />
      </div>
    </section>
  )
}

/** The handle between map and table: drag or arrow keys change the height. */
function Divider() {
  const { height, setHeight } = useDock()
  const start = useRef<{ y: number; height: number } | null>(null)
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t`Höhe der Tabelle`}
      aria-valuenow={height}
      aria-valuemin={MIN_HEIGHT}
      tabIndex={0}
      className="flex h-2.5 shrink-0 cursor-row-resize items-center justify-center border-t border-[var(--color-divider)] hover:bg-neutral-200"
      onPointerDown={(e) => {
        start.current = { y: e.clientY, height }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const max = window.innerHeight * 0.7
        setHeight(Math.min(max, start.current.height + start.current.y - e.clientY))
      }}
      onPointerUp={() => (start.current = null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') setHeight(height + 24)
        if (e.key === 'ArrowDown') setHeight(height - 24)
      }}
    >
      <span aria-hidden className="h-0.5 w-8 rounded bg-neutral-400" />
    </div>
  )
}

function LayerTable({
  layer,
  analysis,
  catalog,
  onCollapse,
}: {
  layer: DisplayLayer
  analysis: Analysis
  catalog: LayerInfo[] | undefined
  onCollapse: () => void
}) {
  const s = useAnalysis(
    useShallow((st) => ({
      mode: st.table.mode,
      onlyView: st.table.onlyView,
      choice: st.table.columns[layer.id],
      sort: st.table.sort[layer.id],
      setTableMode: st.setTableMode,
      setOnlyView: st.setOnlyView,
      setColumns: st.setColumns,
      toggleSort: st.toggleSort,
    })),
  )
  const config = useMapConfig()
  const info = catalogInfo(layer, catalog)
  const isTable = geometryKind(layer, catalog) === 'table'
  const labelOf = useCallback(
    (name: string) => labelAttribute(catalog?.find((l) => l.name === name)),
    [catalog],
  )
  const largerThanLimit = (info?.feature_count ?? 0) > (config.data?.max_features ?? Infinity)
  const features = useLayerFeatures(layerQuery(layer, analysis, labelOf), largerThanLimit)
  const isResult = layer.id === resultLayer(analysis)?.id
  const hits = useHits(isResult ? resultQuery(analysis) : null).ids
  const onlyView = !isTable && (s.onlyView || features.viewed)
  const bbox = useMapView((st) => (onlyView ? st.bbox : null))

  const all = useMemo(() => features.data?.features ?? [], [features.data])
  const mode = hits ? s.mode : 'all'
  const sort = useMemo(() => s.sort ?? [], [s.sort])
  const rows = useMemo(
    () => sortRows(tableRows(all, hits, mode, bbox), sort),
    [all, hits, mode, bbox, sort],
  )
  const explain = isResult ? explainColumns(analysis, labelOf) : []
  const keys = Object.keys(all[0]?.properties ?? {})
  const available = availableColumns(info, keys, explain, (name) =>
    catalog?.find((l) => l.name === name),
  )
  const columns = shownColumns(available, s.choice)
  const title = layerTitle(layer, catalog)
  const hitsShown = formatNumber(hits?.size ?? 0)
  const allShown = formatNumber(all.length)
  const maxFeatures = formatValue(config.data?.max_features, null)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {hits ? (
          <div role="group" aria-label={t`Anzeige`} className="flex">
            <ModeButton pressed={mode === 'hits'} onClick={() => s.setTableMode('hits')}>
              <Trans>Treffer ({hitsShown})</Trans>
            </ModeButton>
            <ModeButton pressed={mode === 'all'} onClick={() => s.setTableMode('all')}>
              <Trans>Alle ({allShown})</Trans>
            </ModeButton>
          </div>
        ) : (
          <span className="text-muted">{objectCount(all.length)}</span>
        )}
        {!isTable && (
          <label
            className="flex items-center gap-1.5"
            title={t`Reine Anzeige: blendet Zeilen ausserhalb des Kartenausschnitts aus, ändert den Filter nicht.`}
          >
            <input
              type="checkbox"
              checked={onlyView}
              disabled={features.viewed}
              onChange={(e) => s.setOnlyView(e.target.checked)}
            />
            <Trans>nur aktueller Kartenausschnitt</Trans>
          </label>
        )}
        <span className="flex-1" />
        <ColumnMenu
          available={available}
          choice={s.choice}
          onChange={(choice) => s.setColumns(layer.id, choice)}
        />
        <button
          type="button"
          className="btn border-transparent px-1"
          aria-label={t`Tabelle einklappen`}
          title={t`Einklappen`}
          onClick={onCollapse}
        >
          <ChevronDown size={15} />
        </button>
      </div>
      {features.viewed && (
        <p className="text-muted text-xs">
          <Trans>
            Nur der Kartenausschnitt ist geladen: der Layer hat mehr als {maxFeatures} Objekte.
          </Trans>
        </p>
      )}
      {features.error ? (
        <ErrorNotice error={features.error} />
      ) : (
        <Grid
          layer={layer}
          title={title}
          rows={rows}
          columns={columns}
          sort={sort}
          loading={features.isPending}
          empty={
            mode === 'hits'
              ? t`Keine Treffer.`
              : onlyView
                ? t`Kein Objekt im Kartenausschnitt.`
                : t`Keine Objekte.`
          }
          onSort={(attr, additive) => s.toggleSort(layer.id, attr, additive)}
        />
      )}
      <Footer layer={layer} />
    </div>
  )
}

function ModeButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={`btn -ml-px text-sm first:ml-0 ${pressed ? 'btn-primary bg-accent-100' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Grid({
  layer,
  title,
  rows,
  columns,
  sort,
  loading,
  empty,
  onSort,
}: {
  layer: DisplayLayer
  title: string
  rows: Row[]
  columns: TableColumn[]
  sort: SortKey[]
  loading: boolean
  empty: string
  onSort: (attr: string, additive: boolean) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const selection = useSelection(
    useShallow((st) => ({
      fids: st.layer === layer.id ? st.fids : NONE,
      hover: st.hover?.layer === layer.id ? st.hover.fid : null,
      select: st.select,
      toggle: st.toggle,
      setAll: st.setAll,
      setHover: st.setHover,
    })),
  )
  const zoomToFeature = useMapView((st) => st.zoomToFeature)
  const focus = useSelection((st) => (st.layer === layer.id ? st.focus : null))

  // A feature picked on the map: scroll its row into view (design B8).
  useEffect(() => {
    const element = scroller.current
    if (!focus || !element) return
    const index = rows.findIndex((r) => r.id === focus.fid)
    if (index === -1) return
    const top = index * ROW
    const visible = element.clientHeight - ROW // below the sticky header
    if (top < element.scrollTop || top > element.scrollTop + visible)
      element.scrollTop = Math.max(0, top - visible / 2)
    // Only a new pick scrolls, not a re-sorted list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    setViewport(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // Windowed: only the rows in view are in the DOM (plan E1.6 D4). Without a
  // layout (tests, first paint) a fixed number is shown.
  const count = viewport > 0 ? Math.ceil(viewport / ROW) + 2 * OVERSCAN : 60
  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const shown = rows.slice(start, start + count)
  const after = Math.max(0, rows.length - start - shown.length)
  const selected = new Set(selection.fids)
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-auto"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <table
        className="data-table w-full table-fixed text-sm [font-feature-settings:'tnum']"
        aria-label={t`Attribute von ${title}`}
        aria-rowcount={rows.length + 1}
      >
        <thead className="sticky top-0 z-10 bg-[var(--color-bg)]">
          <tr aria-rowindex={1}>
            <th className="w-8">
              <input
                type="checkbox"
                aria-label={t`Alle Zeilen auswählen`}
                checked={allSelected}
                disabled={rows.length === 0}
                onChange={() =>
                  selection.setAll(layer.id, allSelected ? [] : rows.map((r) => r.id))
                }
              />
            </th>
            {columns.map((column) => {
              const at = sort.findIndex((k) => k.attr === column.name)
              const key = sort[at]
              return (
                <th
                  key={column.name}
                  aria-sort={!key ? 'none' : key.dir === 'asc' ? 'ascending' : 'descending'}
                  className={column.numeric ? 'text-right' : ''}
                >
                  <button
                    type="button"
                    className={`inline-flex max-w-full items-center gap-0.5 truncate font-semibold ${key ? 'text-accent-700' : ''}`}
                    title={t`Sortieren: ↓ / ↑ / aus · Umschalt für zweite Sortierung`}
                    onClick={(e) => onSort(column.name, e.shiftKey)}
                  >
                    <span className="truncate">{column.label}</span>
                    {key &&
                      (key.dir === 'desc' ? (
                        <ArrowDown size={13} aria-hidden />
                      ) : (
                        <ArrowUp size={13} aria-hidden />
                      ))}
                    {key && sort.length > 1 && <sup aria-hidden>{at + 1}</sup>}
                  </button>
                </th>
              )
            })}
            <th className="w-8">
              <span className="sr-only">
                <Trans>Zoomen</Trans>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden style={{ height: start * ROW }} />}
          {shown.map((row, i) => {
            const isSelected = selected.has(row.id)
            return (
              <tr
                key={row.id}
                aria-rowindex={start + i + 2}
                aria-selected={isSelected}
                data-fid={row.id}
                style={{ height: ROW }}
                className={`cursor-pointer ${isSelected ? 'bg-accent-100 shadow-[inset_3px_0_0_var(--color-accent)]' : selection.hover === row.id ? 'bg-neutral-200' : ''} ${row.hit ? '' : 'text-muted'}`}
                onClick={() => {
                  selection.select(layer.id, row.id)
                  // Brings the feature into view without changing the zoom (design B8).
                  if (row.bbox) zoomToFeature(row.bbox, 'pan')
                }}
                onPointerEnter={() => selection.setHover({ layer: layer.id, fid: row.id })}
                onPointerLeave={() => selection.setHover(null)}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={selectRow(row.id)}
                    checked={isSelected}
                    onChange={() => selection.toggle(layer.id, row.id)}
                  />
                </td>
                {columns.map((column) => (
                  <td
                    key={column.name}
                    className={`truncate ${column.numeric ? 'text-right' : ''} ${isSelected ? 'font-semibold' : ''}`}
                  >
                    {cell(row.properties[column.name], column)}
                  </td>
                ))}
                <td>
                  {row.bbox && (
                    <button
                      type="button"
                      className="text-muted hover:text-ink"
                      aria-label={zoomRow(row.id)}
                      title={t`Auf Objekt zoomen`}
                      onClick={(e) => {
                        e.stopPropagation()
                        selection.select(layer.id, row.id)
                        if (row.bbox) zoomToFeature(row.bbox, 'zoom')
                      }}
                    >
                      <Crosshair size={14} />
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {after > 0 && <tr aria-hidden style={{ height: after * ROW }} />}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="text-muted px-2 py-3 text-sm">{loading ? t`Lädt …` : empty}</p>
      )}
    </div>
  )
}

function cell(value: unknown, column: TableColumn): string {
  // Distances to whole metres: centimetres would pretend a precision the data lacks.
  if (column.computed === 'distance' && typeof value === 'number')
    return formatValue(Math.round(value), column.unit)
  return formatValue(value, column.unit, column.date ? 'date' : undefined)
}

/** "Spalten ▾" (design B8): show, hide and order; computed columns are marked. */
function ColumnMenu({
  available,
  choice,
  onChange,
}: {
  available: TableColumn[]
  choice: ColumnChoice | undefined
  onChange: (choice: ColumnChoice) => void
}) {
  const ordered = orderedColumns(available, choice)
  const hidden = new Set(choice?.hidden ?? [])
  const names = ordered.map((c) => c.name)
  const moveTo = (from: number, to: number) => {
    if (from === to) return
    const order = [...names]
    const [moved] = order.splice(from, 1)
    if (moved === undefined) return
    order.splice(to, 0, moved)
    onChange({ order, hidden: [...hidden] })
  }
  const move = (index: number, by: number) => moveTo(index, index + by)
  // Dragged by the handle (design B8); the arrows stay for keyboards.
  const [dragged, setDragged] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  return (
    <Popover.Root>
      <Popover.Trigger className="btn text-sm">
        <Trans>Spalten</Trans> <ChevronDown size={13} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          aria-label={t`Spalten`}
          className="card z-[1100] w-80 p-3 text-sm shadow-[var(--shadow-md)]"
        >
          <p className="label-caps mb-1">
            <Trans>Spalten</Trans>
          </p>
          <ul className="flex max-h-72 flex-col gap-0.5 overflow-auto">
            {ordered.map((column, index) => (
              <li
                key={column.name}
                className={`flex items-center gap-2 ${over === index && dragged !== index ? 'border-accent border-t-2' : 'border-t-2 border-transparent'} ${dragged === index ? 'opacity-50' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDragged(index)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', column.name)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(index)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragged !== null) moveTo(dragged, index)
                  setDragged(null)
                  setOver(null)
                }}
                onDragEnd={() => {
                  setDragged(null)
                  setOver(null)
                }}
              >
                <GripVertical size={13} aria-hidden className="text-muted shrink-0 cursor-grab" />
                <label className="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!hidden.has(column.name)}
                    onChange={(e) =>
                      onChange({
                        order: names,
                        hidden: e.target.checked
                          ? [...hidden].filter((n) => n !== column.name)
                          : [...hidden, column.name],
                      })
                    }
                  />
                  <span className="flex-1">{column.label}</span>
                </label>
                {column.computed && (
                  <span className="chip text-[11px]">
                    {column.computed === 'distance' ? t`berechnet` : t`aus Raumfilter`}
                  </span>
                )}
                <button
                  type="button"
                  className="btn border-transparent px-0.5"
                  aria-label={moveUp(column.label)}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="btn border-transparent px-0.5"
                  aria-label={moveDown(column.label)}
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={13} />
                </button>
              </li>
            ))}
          </ul>
          <p className="text-muted mt-2 text-xs">
            <Trans>
              Fachliche Namen aus dem Datenkatalog · Auswahl wird mit der Sitzung gespeichert
            </Trans>
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Footer({ layer }: { layer: DisplayLayer }) {
  const count = useSelection((st) => (st.layer === layer.id ? st.fids.length : 0))
  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        type="button"
        className="btn text-sm"
        disabled
        title={t`Export der Ergebnisdaten folgt in E5 (F-8.6)`}
      >
        <Trans>Export · ab E5</Trans>
      </button>
      <span className="flex-1" />
      {count > 0 && <span className="text-muted">{count} ausgewählt</span>}
    </div>
  )
}
