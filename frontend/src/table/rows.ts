// The attribute table's rows and columns (F-8.2, design B8): pure functions over
// the features the map already fetched, so table and map show the same result.
import { t } from '@lingui/core/macro'
import type { Analysis, ColumnChoice, DisplayLayer, SortKey } from '../analysis/model'
import { resultLayer, type ExplainColumn } from '../analysis/query'
import type { LayerInfo, QueryResult } from '../api/client'
import type { BBox } from '../map/view'
import { panelOrder } from '../workplace/layerInfo'
import { collator } from '../i18n/locale'

type Feature = QueryResult['features'][number]

export interface Row {
  id: number
  properties: Record<string, unknown>
  hit: boolean
  /** Extent in WGS84; null for table rows without geometry. */
  bbox: BBox | null
}

export interface TableColumn {
  name: string
  label: string
  unit: string | null
  numeric: boolean
  /** Shown as dd.mm.yyyy (plan E1.8, WP40). */
  date?: boolean
  /** "berechnet" (distance) or "aus Raumfilter" (value of a related feature). */
  computed: ExplainColumn['kind'] | null
}

/** Rows of one tab: hits only or all (design B8), optionally within the map view. */
export function tableRows(
  features: Feature[],
  hits: Set<number> | null,
  mode: 'hits' | 'all',
  view: BBox | null,
): Row[] {
  return features.flatMap((f) => {
    const hit = hits === null || hits.has(f.id)
    if (mode === 'hits' && !hit) return []
    const bbox = f.geometry ? extent(f.geometry.coordinates) : null
    if (view && (!bbox || !overlaps(bbox, view))) return []
    return [{ id: f.id, properties: f.properties as Record<string, unknown>, hit, bbox }]
  })
}

/** Extent of GeoJSON coordinates in WGS84; ``null`` for none. */
export function extent(coordinates: unknown): BBox | null {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity]
  const walk = (c: unknown) => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      box[0] = Math.min(box[0], c[0])
      box[1] = Math.min(box[1], c[1])
      box[2] = Math.max(box[2], c[0])
      box[3] = Math.max(box[3], c[1])
    } else c.forEach(walk)
  }
  walk(coordinates)
  return box[0] <= box[2] ? box : null
}

const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

const empty = (v: unknown) => v === null || v === undefined || v === ''

function compare(a: unknown, b: unknown, text: Intl.Collator): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return text.compare(String(a), String(b))
}

/** Multi-key sort; empty values last in either direction, fid as the final key (F-8.9). */
export function sortRows(rows: Row[], sort: SortKey[]): Row[] {
  const text = collator({ numeric: true, sensitivity: 'base' })
  return [...rows].sort((x, y) => {
    for (const { attr, dir } of sort) {
      const a = x.properties[attr]
      const b = y.properties[attr]
      if (empty(a) || empty(b)) {
        if (empty(a) && empty(b)) continue
        return empty(a) ? 1 : -1
      }
      const order = compare(a, b, text)
      if (order !== 0) return dir === 'asc' ? order : -order
    }
    return x.id - y.id
  })
}

/**
 * Every column the tab can show, in default order: the catalog's attributes,
 * then others the result carries (joined fields, metrics), then computed ones.
 */
export function availableColumns(
  info: LayerInfo | undefined,
  keys: string[],
  explain: ExplainColumn[],
  related: (layer: string) => LayerInfo | undefined,
): TableColumn[] {
  const present = new Set(keys)
  const computed = new Map(explain.map((c) => [c.column.name, c]))
  const attributes = info?.attributes ?? []
  const known = attributes
    .filter((a) => present.has(a.name))
    .map((a) => ({
      name: a.name,
      label: a.label || a.name,
      unit: a.unit ?? null,
      numeric: a.data_type === 'integer' || a.data_type === 'real',
      date: a.data_type === 'date',
      computed: null,
    }))
  const others = keys
    .filter((k) => !computed.has(k) && !attributes.some((a) => a.name === k))
    .map((k) => ({ name: k, label: k, unit: null, numeric: false, computed: null }))
  const explained = keys.flatMap((k) => {
    const c = computed.get(k)
    return c ? [explainedColumn(c, related(c.column.layer))] : []
  })
  return [...known, ...others, ...explained]
}

function explainedColumn(c: ExplainColumn, info: LayerInfo | undefined): TableColumn {
  const title = info?.title ?? c.column.layer
  if (c.column.fn === 'distance_to')
    return {
      name: c.column.name,
      label: t`Distanz ${title}`,
      unit: 'm',
      numeric: true,
      computed: c.kind,
    }
  const attr = c.column.attr
  const meta = info?.attributes.find((a) => a.name === attr)
  const isLabel = ['name', 'bezeichnung', 'titel'].includes(attr) || !meta?.label
  return {
    name: c.column.name,
    label: isLabel ? title : `${meta?.label ?? attr} (${title})`,
    unit: meta?.unit ?? null,
    numeric: meta?.data_type === 'integer' || meta?.data_type === 'real',
    computed: c.kind,
  }
}

/** The chosen columns in the chosen order; columns new since the choice appear at the end. */
export function shownColumns(available: TableColumn[], choice: ColumnChoice | undefined) {
  if (!choice) return available
  const rank = (name: string) => {
    const i = choice.order.indexOf(name)
    return i === -1 ? choice.order.length : i
  }
  return available
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c.name) - rank(b.c.name) || a.i - b.i)
    .map(({ c }) => c)
    .filter((c) => !choice.hidden.includes(c.name))
}

/** All available columns in the order the menu shows them (design B8 "Spalten ▾"). */
export function orderedColumns(available: TableColumn[], choice: ColumnChoice | undefined) {
  return shownColumns(available, choice && { ...choice, hidden: [] })
}

/** Result layer first, then the panel's order (design B8). */
export function tabOrder(analysis: Analysis): DisplayLayer[] {
  const result = resultLayer(analysis)
  const rest = panelOrder(analysis.layers).filter((l) => l.id !== result?.id)
  return result ? [result, ...rest] : rest
}
