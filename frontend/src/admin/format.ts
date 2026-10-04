// Display helpers for the administration area. Pure, so they are unit-tested.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural, t } from '@lingui/core/macro'
import type { AttributeInfo, ImportStatus, LayerInfo } from '../api/client'
import { dateTimeFormat, formatNumber } from '../i18n/locale'

const POINT = msg`Punkt`
const LINE = msg`Linie`
const AREA = msg({ message: 'Fläche', context: 'geometry' })
const GEOMETRY_LABELS: Record<string, MessageDescriptor> = {
  Point: POINT,
  MultiPoint: POINT,
  LineString: LINE,
  MultiLineString: LINE,
  Polygon: AREA,
  MultiPolygon: AREA,
}

export function layerType(layer: Pick<LayerInfo, 'kind' | 'geometry_type'>): string {
  if (layer.kind === 'table') return t`Tabelle`
  const label = GEOMETRY_LABELS[layer.geometry_type ?? '']
  return label ? i18n._(label) : t`Geometrie`
}

/** `source` is null for anyone but an administrator (security review #20). */
export function sourceLabel(source: string | null): string {
  if (!source) return '–'
  if (source.startsWith('sample:')) return t`Beispieldaten`
  if (source.startsWith('file:')) return source.slice('file:'.length)
  return source || '–'
}

const DATE = { day: '2-digit', month: '2-digit', year: 'numeric' } as const
const DATE_TIME = { ...DATE, hour: '2-digit', minute: '2-digit' } as const

/** The backend sends naive UTC timestamps (SQLite CURRENT_TIMESTAMP). */
function parse(timestamp: string): Date {
  return new Date(/[Zz]|[+-]\d\d:\d\d$/.test(timestamp) ? timestamp : `${timestamp}Z`)
}

export const formatDate = (timestamp: string | null | undefined) =>
  timestamp ? dateTimeFormat(DATE).format(parse(timestamp)) : '–'

export const formatDateTime = (timestamp: string | null | undefined) =>
  timestamp ? dateTimeFormat(DATE_TIME).format(parse(timestamp)) : '–'

const STATUS_LABELS: Record<ImportStatus, MessageDescriptor> = {
  running: msg`läuft`,
  ok: msg`erfolgreich`,
  warning: msg`mit Warnungen`,
  failed: msg`fehlgeschlagen`,
  aborted: msg`abgebrochen`,
}

export const STATUSES = Object.keys(STATUS_LABELS) as ImportStatus[]

export const statusLabel = (status: ImportStatus) => i18n._(STATUS_LABELS[status])

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

/** "118 von 120 Datensätzen übernommen, 2 verworfen" (design D7, D8). */
export function importedText(run: {
  imported_count: number
  read_count: number
  rejected_count: number
}): string {
  const imported = formatNumber(run.imported_count)
  const read = formatNumber(run.read_count)
  const rejected = formatNumber(run.rejected_count)
  return run.rejected_count > 0
    ? t`${imported} von ${read} Datensätzen übernommen, ${rejected} verworfen`
    : t`${imported} von ${read} Datensätzen übernommen`
}

/** Labels of one field's inputs, for assistive technology (design D4, D6). */
export const fieldLabels = (field: string) => ({
  include: t`${field} übernehmen`,
  name: t`Feldname ${field}`,
  label: t`Bezeichnung ${field}`,
  unit: t`Einheit ${field}`,
  forModel: t`${field} für Modell`,
  details: t`Details zu ${field}`,
  min: t`Minimum ${field}`,
  max: t`Maximum ${field}`,
})

/** "1 Datensatz", "1'200 Datensätze". */
export function recordCount(n: number): string {
  const count = formatNumber(n)
  return plural(n, { one: `${count} Datensatz`, other: `${count} Datensätze` })
}

const TYPE_LABELS: Record<string, MessageDescriptor> = {
  integer: msg`Ganzzahl`,
  real: msg`Zahl`,
  text: msg`Text`,
  boolean: msg`Ja/Nein`,
  date: msg`Datum`,
}

/** A field's type in words: "Ganzzahl", "Datum". */
export function typeLabel(type: string): string {
  const label = TYPE_LABELS[type]
  return label ? i18n._(label) : type
}
