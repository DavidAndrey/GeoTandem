// A query object read back into condition rows (design M2, M5: "lesbare
// Abfrage im Bedingungsbaum-Stil"). The rows are those of the editor
// (analysis/model.ts), so the existing words (editor/describe.ts) say them; a
// condition the controls cannot show stays as JSON, never guessed.
//
// Two readers: the answer's tree shows it, and the draft of a proposal
// (panel/draft.ts) takes its rows into the editor, from where the user's
// "Übernehmen" brings them into the analysis. So the rows must write back
// exactly the query they were read from (``resultQuery``); the shared case
// list of plan D3 (schema/model-cases/represent.json, represent.test.ts) holds
// both sides to it. This is the narrow inverse of E2.3, not WP80's general
// ``toAnalysis``.
//
// Input is raw JSON on purpose: a refused answer keeps its query as the model
// wrote it (plan WP62), and it must still be viewable. Keys that are null or
// empty mean "not set" (``compactQuery``), however the JSON came.
import type {
  AttributeOperator,
  AttributeRow,
  ReferenceRow,
  Scalar,
  SpatialRow,
} from '../analysis/model'
import type { Opaque, TreeGroup, TreeNode } from '../editor/CompactTree'

export type ReadGroup = TreeGroup
export type ReadNode = TreeNode

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

/**
 * A query object without the keys that set nothing: ``null``, an empty list or
 * an empty object, at any depth. The editor writes none of them; a server or
 * a model may send them all (``buffer: null``, ``columns: []``).
 */
export function compactQuery(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactQuery)
  if (!isObject(value)) return value
  const kept: Json = {}
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null || inner === undefined) continue
    const compacted = compactQuery(inner)
    if (Array.isArray(compacted) && compacted.length === 0) continue
    if (isObject(compacted) && Object.keys(compacted).length === 0) continue
    kept[key] = compacted
  }
  return kept
}

const COMPARE: readonly string[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge']
const TEXT_MODES: readonly string[] = ['contains', 'starts_with', 'ends_with']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * ``and`` of a ``ge`` and a ``le`` on one attribute, ISO dates in order: the one
 * date range row the editor writes so (analysis/query.ts, plan E1.8 G3). On a
 * field that is no date the server refuses such a query (text has no ≥ or ≤).
 */
function readDateRange(c: Json, id: string): AttributeRow | null {
  if (c.op !== 'and' || !Array.isArray(c.args) || c.args.length !== 2) return null
  const [low, high] = c.args as unknown[]
  if (!isObject(low) || !isObject(high) || low.op !== 'compare' || high.op !== 'compare')
    return null
  if (low.cmp !== 'ge' || high.cmp !== 'le' || typeof low.attr !== 'string') return null
  const [from, to] = [low.value, high.value]
  if (low.attr !== high.attr || typeof from !== 'string' || typeof to !== 'string') return null
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return null
  return attributeRow(id, low.attr, { operator: 'between', min: from, max: to })
}

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
    // ``not`` of a ``not`` is no row the editor writes (the server refuses it, D3).
    const row = c.arg.op === 'not' ? null : readAttribute(c.arg, id)
    return row && { ...row, not: true }
  }
  if (c.op === 'and') return readDateRange(c, id)
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
    case 'text_match': {
      // The controls match without case only (query.ts); the schema's defaults are
      // "contains" and the same.
      const mode = c.mode ?? 'contains'
      return typeof mode === 'string' &&
        TEXT_MODES.includes(mode) &&
        typeof c.text === 'string' &&
        (c.case_sensitive === undefined || c.case_sensitive === false)
        ? attributeRow(id, attr, { operator: mode as AttributeOperator, value: c.text })
        : null
    }
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

/** One condition of a query object as a row, a group, or JSON. */
export function readCondition(c: unknown, id: string): ReadNode {
  const opaque: Opaque = { id, kind: 'opaque', json: JSON.stringify(c) }
  if (!isObject(c)) return opaque
  const range = readDateRange(c, id)
  if (range) return range
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
    // ``not`` of a ``not``: the editor writes it only as a negated group around
    // one negated row, which a draft does not rebuild; the server refuses it (D3).
    if (isObject(c.arg) && c.arg.op === 'not') return opaque
    // "liegt ausserhalb" and "> Distanz zu" are negations in the schema (v1).
    const related = isObject(c.arg) ? readRelated(c.arg, id) : null
    if (related?.operator === 'in') return { ...related, operator: 'outside' }
    if (related?.operator === 'near') return { ...related, operator: 'far' }
    const inner = readCondition(c.arg, id)
    // "Nur in" has no negation in the controls: say nothing rather than the opposite.
    if (inner.kind === 'opaque' || inner.kind === 'within') return opaque
    return { ...inner, not: !inner.not }
  }
  if (c.op === 'bbox') return { id, kind: 'within', shape: 'view' }
  // A drawn area restricts by "schneidet" only (query.ts ``restrictionCondition``).
  if (c.op === 'geometry')
    return c.predicate === undefined || c.predicate === 'intersects'
      ? { id, kind: 'within', shape: 'shape' }
      : opaque
  return readAttribute(c, id) ?? readRelated(c, id) ?? readReference(c, id) ?? opaque
}

const SHOWN = ['schema_version', 'source', 'output', 'where']

/** A query object as a readable tree under one root group. */
export function readQuery(raw: unknown): ReadQuery {
  // The root's id is the analysis's (query.ts ``emptyTree``).
  const root: ReadGroup = { id: 'root', kind: 'group', op: 'and', not: false, children: [] }
  const query = compactQuery(raw)
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
