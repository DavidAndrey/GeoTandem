// Words for the condition tree (design B1 compact tree, B2 editor). Pure.
import type {
  AttributeOperator,
  AttributeRow,
  Node,
  ReferenceRow,
  SpatialOperator,
  SpatialRow,
} from '../analysis/model'
import type { AttributeInfo } from '../api/client'
import { formatIsoDate, formatNumber } from '../i18n/locale'

export type FieldType = AttributeInfo['data_type']

export const ATTRIBUTE_OPERATORS: Record<AttributeOperator, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
  between: 'zwischen',
  contains: 'enthält',
  starts_with: 'beginnt mit',
  ends_with: 'endet mit',
  is_empty: 'ist leer',
  in: 'ist eins von',
}

/** Dates read as dates: "am", "vor", "ab" (plan E1.8, WP40). */
const DATE_OPERATORS: Partial<Record<AttributeOperator, string>> = {
  eq: 'am',
  ne: 'nicht am',
  lt: 'vor',
  le: 'bis',
  gt: 'nach',
  ge: 'ab',
}

export const operatorLabel = (op: AttributeOperator, type: FieldType | undefined) =>
  (type === 'date' ? DATE_OPERATORS[op] : undefined) ?? ATTRIBUTE_OPERATORS[op]

/** Operators by field type (design B2: "die Operatoren richten sich nach dem Feldtyp"). */
export function operatorsFor(type: FieldType | undefined): AttributeOperator[] {
  switch (type) {
    case 'date':
      return ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'is_empty']
    case 'integer':
    case 'real':
      return ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'in', 'is_empty']
    case 'boolean':
      return ['eq', 'is_empty']
    default:
      return ['eq', 'ne', 'contains', 'starts_with', 'ends_with', 'in', 'is_empty']
  }
}

export const SPATIAL_OPERATORS: Record<SpatialOperator, string> = {
  in: 'liegt in',
  outside: 'liegt ausserhalb',
  intersects: 'schneidet',
  contains: 'enthält',
  near: '≤ Distanz zu',
  far: '> Distanz zu',
}

export const needsDistance = (operator: SpatialOperator) =>
  operator === 'near' || operator === 'far'

export function formatScalar(value: unknown): string {
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? 'ja' : 'nein'
  return String(value ?? '')
}

export function formatDistance(meters: number | null): string {
  if (meters === null) return '…'
  return meters >= 1000 && meters % 100 === 0
    ? `${formatNumber(meters / 1000)} km`
    : `${formatNumber(meters)} m`
}

type Labels = {
  field: (name: string) => string
  layer: (name: string) => string
  /** The field's type, where known: dates read and show as dates. */
  type?: (name: string) => FieldType | undefined
}

export function describeAttribute(row: AttributeRow, labels: Labels): string {
  const field = row.attr ? labels.field(row.attr) : '…'
  const type = row.attr ? labels.type?.(row.attr) : undefined
  const op = operatorLabel(row.operator, type)
  const show = (v: unknown) =>
    type === 'date' && typeof v === 'string' ? formatIsoDate(v) : formatScalar(v)
  let value = ''
  if (row.operator === 'between') value = `${show(row.min ?? '…')} – ${show(row.max ?? '…')}`
  else if (row.operator === 'in') value = row.values.length ? row.values.map(show).join(', ') : '…'
  else if (row.operator !== 'is_empty')
    value = row.value === null || row.value === '' ? '…' : show(row.value)
  return `${row.not ? 'nicht ' : ''}${field} ${op}${value ? ` ${value}` : ''}`
}

export function describeSpatial(row: SpatialRow, labels: Labels, filterLabels?: Labels): string {
  // "≤ 500 m zu Hauptverkehrsstr." (design B1); the other relations read as they are named.
  const op = needsDistance(row.operator)
    ? `${row.operator === 'near' ? '≤' : '>'} ${formatDistance(row.distance_m)} zu`
    : SPATIAL_OPERATORS[row.operator]
  const layer = row.layer ? labels.layer(row.layer) : '…'
  const filter = row.filter ? ` (${describeAttribute(row.filter, filterLabels ?? labels)})` : ''
  return `${row.not ? 'nicht ' : ''}${op} ${layer}${filter}`
}

export function describeReference(row: ReferenceRow, labels: Labels): string {
  const feature = row.fid === null ? '…' : row.label || `Objekt ${row.fid}`
  const distance = row.distance_m > 0 ? `≤ ${formatDistance(row.distance_m)} um ` : 'bei '
  return `${row.not ? 'nicht ' : ''}${distance}${feature} (${row.layer ? labels.layer(row.layer) : '…'})`
}

export function describe(
  node: Node,
  labels: Labels,
  filterLabels?: (layer: string) => Labels,
): string {
  switch (node.kind) {
    case 'attribute':
      return describeAttribute(node, labels)
    case 'spatial':
      return describeSpatial(node, labels, filterLabels?.(node.layer))
    case 'reference':
      return describeReference(node, labels)
    case 'group':
      return `${node.not ? 'nicht ' : ''}Gruppe (${node.op === 'and' ? 'UND' : 'ODER'}, ${node.children.length})`
  }
}
