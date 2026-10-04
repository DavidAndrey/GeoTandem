// Words for the condition tree (design B1 compact tree, B2 editor). Pure.
// Each condition reads as one message, so a language can order it its own
// way; operators are messages too, shared with the editor (plan E1.9, WP48).
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
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

const ATTRIBUTE_OPERATORS: Record<AttributeOperator, MessageDescriptor | string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
  between: msg`zwischen`,
  contains: msg({ message: 'enthält', context: 'text' }),
  starts_with: msg`beginnt mit`,
  ends_with: msg`endet mit`,
  is_empty: msg`ist leer`,
  in: msg`ist eins von`,
}

/** Dates read as dates: "am", "vor", "ab" (plan E1.8, WP40). */
const DATE_OPERATORS: Partial<Record<AttributeOperator, MessageDescriptor>> = {
  eq: msg({ message: 'am', context: 'date' }),
  ne: msg({ message: 'nicht am', context: 'date' }),
  lt: msg({ message: 'vor', context: 'date' }),
  le: msg({ message: 'bis', context: 'date' }),
  gt: msg({ message: 'nach', context: 'date' }),
  ge: msg({ message: 'ab', context: 'date' }),
}

const text = (label: MessageDescriptor | string) =>
  typeof label === 'string' ? label : i18n._(label)

export const operatorLabel = (op: AttributeOperator, type: FieldType | undefined) =>
  text((type === 'date' ? DATE_OPERATORS[op] : undefined) ?? ATTRIBUTE_OPERATORS[op])

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

const SPATIAL_OPERATORS: Record<SpatialOperator, MessageDescriptor> = {
  in: msg`liegt in`,
  outside: msg`liegt ausserhalb`,
  intersects: msg`schneidet`,
  contains: msg({ message: 'enthält', context: 'spatial' }),
  near: msg`≤ Distanz zu`,
  far: msg`> Distanz zu`,
}

export const spatialLabel = (op: SpatialOperator) => text(SPATIAL_OPERATORS[op])

export const SPATIAL_OPERATOR_LIST = Object.keys(SPATIAL_OPERATORS) as SpatialOperator[]

export const needsDistance = (operator: SpatialOperator) =>
  operator === 'near' || operator === 'far'

export function formatScalar(value: unknown): string {
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? t`ja` : t`nein`
  return String(value ?? '')
}

export function formatDistance(meters: number | null): string {
  if (meters === null) return '…'
  const km = formatNumber(meters / 1000)
  const m = formatNumber(meters)
  return meters >= 1000 && meters % 100 === 0 ? t`${km} km` : t`${m} m`
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
  let condition: string
  if (row.operator === 'is_empty')
    condition = t({
      message: `${field} ${op}`,
      comment: 'Attribute condition: field, operator, value(s). Reorder as the language needs.',
    })
  else if (row.operator === 'between') {
    const min = show(row.min ?? '…')
    const max = show(row.max ?? '…')
    condition = t({
      message: `${field} ${op} ${min} – ${max}`,
      comment: 'Attribute condition: field, operator, value(s). Reorder as the language needs.',
    })
  } else if (row.operator === 'in') {
    const values = row.values.length ? row.values.map(show).join(', ') : '…'
    condition = t({
      message: `${field} ${op} ${values}`,
      comment: 'Attribute condition: field, operator, value(s). Reorder as the language needs.',
    })
  } else {
    const value = row.value === null || row.value === '' ? '…' : show(row.value)
    condition = t({
      message: `${field} ${op} ${value}`,
      comment: 'Attribute condition: field, operator, value(s). Reorder as the language needs.',
    })
  }
  return row.not ? negated(condition) : condition
}

const negated = (condition: string) =>
  t({ message: `nicht ${condition}`, comment: 'Any condition, negated' })

export function describeSpatial(row: SpatialRow, labels: Labels, filterLabels?: Labels): string {
  // "≤ 500 m zu Hauptverkehrsstr." (design B1); the other relations read as they are named.
  const layer = row.layer ? labels.layer(row.layer) : '…'
  const distance = formatDistance(row.distance_m)
  const op = spatialLabel(row.operator)
  let condition =
    row.operator === 'near'
      ? t`≤ ${distance} zu ${layer}`
      : row.operator === 'far'
        ? t`> ${distance} zu ${layer}`
        : t({
            message: `${op} ${layer}`,
            comment: 'Spatial condition: relation ("liegt in"), layer',
          })
  if (row.filter) {
    const filter = describeAttribute(row.filter, filterLabels ?? labels)
    condition = t({
      message: `${condition} (${filter})`,
      comment: 'Spatial condition, then the attribute filter on its layer',
    })
  }
  return row.not ? negated(condition) : condition
}

export function describeReference(row: ReferenceRow, labels: Labels): string {
  const fid = row.fid
  const feature = fid === null ? '…' : row.label || t`Objekt ${fid}`
  const layer = row.layer ? labels.layer(row.layer) : '…'
  const distance = formatDistance(row.distance_m)
  const condition =
    row.distance_m > 0 ? t`≤ ${distance} um ${feature} (${layer})` : t`bei ${feature} (${layer})`
  return row.not ? negated(condition) : condition
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
    case 'group': {
      const count = node.children.length
      const condition = node.op === 'and' ? t`Gruppe (UND, ${count})` : t`Gruppe (ODER, ${count})`
      return node.not ? negated(condition) : condition
    }
  }
}
