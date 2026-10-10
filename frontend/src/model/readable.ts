// A query object read back into condition rows, for display only (design M2,
// M5: "lesbare Abfrage im Bedingungsbaum-Stil"). The rows are those of the
// editor (analysis/model.ts), so the existing words (editor/describe.ts) say
// them; a condition the controls cannot show stays as JSON, never guessed.
//
// Input is raw JSON on purpose: a refused answer keeps its query as the model
// wrote it (plan WP62), and it must still be viewable. This is not the
// inverse ``toAnalysis`` of plan D3 (WP80): nothing here enters the analysis.
import type {
  AttributeOperator,
  AttributeRow,
  Group,
  ReferenceRow,
  Row,
  Scalar,
  SpatialRow,
} from '../analysis/model'

/** A condition without a row form: shown as its JSON. */
export interface Opaque {
  id: string
  kind: 'opaque'
  json: string
}

/** "Nur in: Ausschnitt / Fläche" inside a query object. */
export interface Within {
  id: string
  kind: 'within'
  shape: 'view' | 'shape'
}

export interface ReadGroup {
  id: string
  kind: 'group'
  op: Group['op']
  not: boolean
  children: ReadNode[]
}

export type ReadNode = Row | ReadGroup | Opaque | Within

export interface ReadQuery {
  /** The result layer, if the object names one. */
  source: string | null
  tree: ReadGroup
  /** Top-level parts beyond the conditions (order, limit, buffer …): only under "Technisch". */
  extra: string[]
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const COMPARE: readonly string[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge']
const TEXT_MODES: readonly string[] = ['contains', 'starts_with', 'ends_with']

const attributeRow = (id: string, attr: string, patch: Partial<AttributeRow>): AttributeRow => ({
  id,
  kind: 'attribute',
  not: false,
  attr,
  operator: 'eq',
  value: null,
  min: null,
  max: null,
  values: [],
  ...patch,
})

function readAttribute(c: Json, id: string): AttributeRow | null {
  if (c.op === 'not' && isObject(c.arg)) {
    const row = readAttribute(c.arg, id)
    return row && { ...row, not: !row.not }
  }
  const attr = c.attr
  if (typeof attr !== 'string') return null
  switch (c.op) {
    case 'compare':
      return typeof c.cmp === 'string' && COMPARE.includes(c.cmp) && isScalar(c.value)
        ? attributeRow(id, attr, { operator: c.cmp as AttributeOperator, value: c.value })
        : null
    case 'between':
      return typeof c.min === 'number' && typeof c.max === 'number'
        ? attributeRow(id, attr, { operator: 'between', min: c.min, max: c.max })
        : null
    case 'text_match':
      return typeof c.mode === 'string' && TEXT_MODES.includes(c.mode) && typeof c.text === 'string'
        ? attributeRow(id, attr, { operator: c.mode as AttributeOperator, value: c.text })
        : null
    case 'is_null':
      return attributeRow(id, attr, { operator: 'is_empty' })
    case 'in':
      return Array.isArray(c.values) && c.values.every(isScalar)
        ? attributeRow(id, attr, { operator: 'in', values: c.values })
        : null
    default:
      return null
  }
}

const PREDICATES: Record<string, SpatialRow['operator']> = {
  within: 'in',
  intersects: 'intersects',
  contains: 'contains',
  dwithin: 'near',
}

function readRelated(c: Json, id: string): SpatialRow | null {
  const operator = typeof c.predicate === 'string' ? PREDICATES[c.predicate] : undefined
  if (c.op !== 'related' || typeof c.layer !== 'string' || !operator) return null
  const distance = typeof c.distance_m === 'number' ? c.distance_m : null
  if (operator === 'near' && distance === null) return null
  let filter: AttributeRow | null = null
  if (c.where !== undefined) {
    filter = isObject(c.where) ? readAttribute(c.where, `${id}.where`) : null
    if (!filter) return null
  }
  return {
    id,
    kind: 'spatial',
    not: false,
    operator,
    layer: c.layer,
    distance_m: operator === 'near' ? distance : null,
    filter,
  }
}

function readReference(c: Json, id: string): ReferenceRow | null {
  if (c.op !== 'near_feature' || typeof c.layer !== 'string' || typeof c.fid !== 'number')
    return null
  const distance = typeof c.distance_m === 'number' ? c.distance_m : 0
  return {
    id,
    kind: 'reference',
    not: false,
    layer: c.layer,
    fid: c.fid,
    label: '',
    distance_m: distance,
  }
}

const negate = (node: ReadNode): ReadNode =>
  node.kind === 'opaque' || node.kind === 'within' ? node : { ...node, not: !node.not }

/** One condition of a query object as a row, a group, or JSON. */
export function readCondition(c: unknown, id: string): ReadNode {
  const opaque: Opaque = { id, kind: 'opaque', json: JSON.stringify(c) }
  if (!isObject(c)) return opaque
  if (c.op === 'and' || c.op === 'or') {
    if (!Array.isArray(c.args)) return opaque
    return {
      id,
      kind: 'group',
      op: c.op,
      not: false,
      children: c.args.map((arg, i) => readCondition(arg, `${id}.${i}`)),
    }
  }
  if (c.op === 'not') {
    // "liegt ausserhalb" and "> Distanz zu" are negations in the schema (v1).
    const related = isObject(c.arg) ? readRelated(c.arg, id) : null
    if (related?.operator === 'in') return { ...related, operator: 'outside' }
    if (related?.operator === 'near') return { ...related, operator: 'far' }
    const inner = readCondition(c.arg, id)
    return inner.kind === 'opaque' ? opaque : negate(inner)
  }
  if (c.op === 'bbox') return { id, kind: 'within', shape: 'view' }
  if (c.op === 'geometry') return { id, kind: 'within', shape: 'shape' }
  return readAttribute(c, id) ?? readRelated(c, id) ?? readReference(c, id) ?? opaque
}

const SHOWN = ['schema_version', 'source', 'output', 'where']

/** A query object as a readable tree under one root group. */
export function readQuery(query: unknown): ReadQuery {
  // The root's id is the analysis's (query.ts ``emptyTree``).
  const root: ReadGroup = { id: 'root', kind: 'group', op: 'and', not: false, children: [] }
  if (!isObject(query)) return { source: null, tree: root, extra: [] }
  const extra = Object.keys(query).filter((key) => !SHOWN.includes(key))
  const source = typeof query.source === 'string' ? query.source : null
  if (query.where === undefined || query.where === null) return { source, tree: root, extra }
  const where = readCondition(query.where, 'q0')
  const tree =
    where.kind === 'group' && !where.not
      ? { ...where, id: root.id }
      : { ...root, children: [where] }
  return { source, tree, extra }
}
