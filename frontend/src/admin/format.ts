// Display helpers for the administration area. Pure, so they are unit-tested.
import type { AttributeInfo, ImportStatus, LayerInfo } from '../api/client'

const GEOMETRY_LABELS: Record<string, string> = {
  Point: 'Punkt',
  MultiPoint: 'Punkt',
  LineString: 'Linie',
  MultiLineString: 'Linie',
  Polygon: 'Fläche',
  MultiPolygon: 'Fläche',
}

export function layerType(layer: Pick<LayerInfo, 'kind' | 'geometry_type'>): string {
  if (layer.kind === 'table') return 'Tabelle'
  return GEOMETRY_LABELS[layer.geometry_type ?? ''] ?? 'Geometrie'
}

export function sourceLabel(source: string): string {
  if (source.startsWith('sample:')) return 'Beispieldaten'
  if (source.startsWith('file:')) return source.slice('file:'.length)
  return source || '–'
}

const DATE = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
const DATE_TIME = new Intl.DateTimeFormat('de-CH', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** The backend sends naive UTC timestamps (SQLite CURRENT_TIMESTAMP). */
function parse(timestamp: string): Date {
  return new Date(/[Zz]|[+-]\d\d:\d\d$/.test(timestamp) ? timestamp : `${timestamp}Z`)
}

export const formatDate = (timestamp: string | null | undefined) =>
  timestamp ? DATE.format(parse(timestamp)) : '–'

export const formatDateTime = (timestamp: string | null | undefined) =>
  timestamp ? DATE_TIME.format(parse(timestamp)) : '–'

export const STATUS_LABELS: Record<ImportStatus, string> = {
  running: 'läuft',
  ok: 'erfolgreich',
  warning: 'mit Warnungen',
  failed: 'fehlgeschlagen',
  aborted: 'abgebrochen',
}

/**
 * Metadata completeness in four steps (design D2 "●●●○"): layer description,
 * every attribute labelled, every attribute described, every number with a
 * unit or value range and every text with a code list or description.
 */
export function completeness(layer: Pick<LayerInfo, 'description' | 'attributes'>): number {
  const attributes = layer.attributes
  const labelled = (a: AttributeInfo) => a.label.trim() !== '' && a.label !== a.name
  const domain = (a: AttributeInfo) =>
    a.data_type === 'integer' || a.data_type === 'real'
      ? Boolean(a.unit) || Boolean(a.value_domain)
      : a.data_type === 'boolean' || Boolean(a.value_domain) || a.description.trim() !== ''
  return [
    layer.description.trim() !== '',
    attributes.every(labelled),
    attributes.every((a) => a.description.trim() !== ''),
    attributes.every(domain),
  ].filter(Boolean).length
}
