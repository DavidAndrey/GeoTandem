// Analysis state → query objects (schema v2). Pure and exhaustively tested:
// every query the interface sends comes from here (etappen E1.5 "fertig wenn").
// ``toAnalysis`` at the end is the inverse for the model path (D3).
import type { LayerInfo } from '../api/client'
import { operatorsFor, type FieldType } from '../editor/describe'
import type {
  Analysis,
  AttributeRow,
  Column,
  Condition,
  DisplayLayer,
  Group,
  Node,
  QueryObject,
  QueryPart,
  Recipe,
  ReferenceRow,
  Restriction,
  Row,
  Scalar,
  SpatialRow,
} from './model'

const base = (source: string): QueryObject => ({ schema_version: '2', source, output: 'map' })

function negate(condition: Condition | null, not: boolean): Condition | null {
  return condition && not ? { op: 'not', arg: condition } : condition
}

export function and(...conditions: (Condition | null | undefined)[]): Condition | null {
  const present = conditions.filter((c): c is Condition => c != null)
  if (present.length === 0) return null
  if (present.length === 1) return present[0] ?? null
  return { op: 'and', args: present }
}

/** ``null`` while the row is incomplete; such rows are left out, never sent half-made. */
export function attributeCondition(row: AttributeRow): Condition | null {
  const { attr, operator } = row
  if (!attr) return null
  let condition: Condition | null = null
  switch (operator) {
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge':
      if (row.value !== null && row.value !== '')
        condition = { op: 'compare', attr, cmp: operator, value: row.value }
      break
    case 'between':
      if (typeof row.min === 'string' && typeof row.max === 'string') {
        // Dates: "≥ and ≤" with ISO text, so the schema needs no date range (plan E1.8, G3).
        const [from, to] = row.min <= row.max ? [row.min, row.max] : [row.max, row.min]
        if (from && to)
          condition = and(
            { op: 'compare', attr, cmp: 'ge', value: from },
            { op: 'compare', attr, cmp: 'le', value: to },
          )
      } else if (typeof row.min === 'number' && typeof row.max === 'number')
        // Either order: the query object normalises "zwischen 500 und 100" to 100–500.
        condition = { op: 'between', attr, min: row.min, max: row.max }
      break
    case 'contains':
    case 'starts_with':
    case 'ends_with':
      if (typeof row.value === 'string' && row.value !== '')
        condition = {
          op: 'text_match',
          attr,
          text: row.value,
          mode: operator,
          case_sensitive: false,
        }
      break
    case 'is_empty':
      condition = { op: 'is_null', attr }
      break
    case 'in':
      if (row.values.length > 0) condition = { op: 'in', attr, values: row.values }
      break
  }
  return negate(condition, row.not)
}

export function rowCondition(row: Row): Condition | null {
  switch (row.kind) {
    case 'attribute':
      return attributeCondition(row)
    case 'reference':
      if (!row.layer || row.fid === null) return null
      return negate(
        { op: 'near_feature', layer: row.layer, fid: row.fid, distance_m: row.distance_m },
        row.not,
      )
    case 'spatial': {
      if (!row.layer) return null
      const distance = row.distance_m
      const where = row.filter ? attributeCondition(row.filter) : null
      const extra = where ? { where } : {}
      // Two variants (schema v1): only "dwithin" carries a distance, and it must.
      const related = (predicate: 'within' | 'intersects' | 'contains'): Condition => ({
        op: 'related',
        layer: row.layer,
        predicate,
        ...extra,
      })
      const near = (meters: number): Condition => ({
        op: 'related',
        layer: row.layer,
        predicate: 'dwithin',
        distance_m: meters,
        ...extra,
      })
      const needsDistance = row.operator === 'near' || row.operator === 'far'
      if (needsDistance && (distance === null || distance <= 0)) return null
      const meters = distance ?? 0
      const condition: Condition = {
        in: related('within'),
        outside: { op: 'not', arg: related('within') } as Condition,
        intersects: related('intersects'),
        contains: related('contains'),
        near: near(meters),
        far: { op: 'not', arg: near(meters) } as Condition,
      }[row.operator]
      return negate(condition, row.not)
    }
  }
}

export function nodeCondition(node: Node): Condition | null {
  if (node.kind !== 'group') return rowCondition(node)
  const parts = node.children.map(nodeCondition).filter((c): c is Condition => c !== null)
  if (parts.length === 0) return null
  const combined: Condition =
    parts.length === 1 ? (parts[0] as Condition) : { op: node.op, args: parts }
  return negate(combined, node.not)
}

export function restrictionCondition(restriction: Restriction): Condition | null {
  if (!restriction) return null
  if (restriction.kind === 'view') return { op: 'bbox', bbox: restriction.bbox }
  return { op: 'geometry', geometry: restriction.geometry, predicate: 'intersects' }
}

// --- layers ---------------------------------------------------------------------------

/** Aggregations summarise; conditions would filter before summarising (plan S2). */
export const canBeResult = (layer: DisplayLayer) =>
  !layer.table && (layer.source.kind === 'catalog' || layer.source.recipe.op !== 'aggregate')

export function recipeQuery(recipe: Recipe, filtered: Condition | null = null): QueryObject {
  switch (recipe.op) {
    case 'buffer':
      return {
        ...base(recipe.layer),
        buffer: { distance_m: recipe.distance_m },
        ...(recipe.onlyFiltered && filtered ? { where: filtered } : {}),
      }
    case 'join': {
      const field = recipe.join.fields[0] ?? ''
      const name = (recipe.join.prefix ?? '') + field
      return {
        ...base(recipe.layer),
        attribute_join: recipe.join,
        ...(recipe.keepUnmatched
          ? {}
          : { where: { op: 'not', arg: { op: 'is_null', attr: name } } }),
      }
    }
    case 'aggregate':
      return { ...base(recipe.layer), aggregate: recipe.aggregate }
  }
}

/** The text attribute that names a feature of ``layer``, if the catalog knows one. */
export type LabelOf = (layer: string) => string | null

/**
 * All features of a displayed layer, as drawn on the map and listed in the table.
 * The result layer also carries the columns that explain its hits (design B8).
 */
export function layerQuery(
  layer: DisplayLayer,
  analysis?: Analysis,
  labelOf?: LabelOf,
): QueryObject {
  const query =
    layer.source.kind === 'catalog'
      ? base(layer.source.layer)
      : recipeQuery(layer.source.recipe, analysis ? filteredSourceOf(layer, analysis) : null)
  const columns =
    analysis && layer.id === resultLayer(analysis)?.id
      ? explainColumns(analysis, labelOf).map((c) => c.column)
      : []
  return {
    ...query,
    ...(columns.length ? { columns } : {}),
    ...(layer.symbology ? { symbology: layer.symbology } : {}),
  }
}

// --- computed columns (schema v2, design B8) ------------------------------------------

export interface ExplainColumn {
  column: Column
  /** The spatial row it explains. */
  row: string
  /** "berechnet" (a distance) or "aus Raumfilter" (a value of the related feature). */
  kind: 'distance' | 'value'
}

const MAX_NAME = 63

function columnName(...parts: string[]): string {
  return ['calc', ...parts].join('_').slice(0, MAX_NAME)
}

/**
 * One column per complete spatial row that shows why a feature is a hit: the
 * distance for "≤ / > Distanz", the related area's name and filtered attribute
 * for "liegt in / ausserhalb / schneidet". Names follow the content, so the same
 * row keeps its column when others change.
 */
export function explainColumns(analysis: Analysis, labelOf: LabelOf = () => null): ExplainColumn[] {
  const found: ExplainColumn[] = []
  const add = (row: string, kind: ExplainColumn['kind'], column: Column) => {
    if (found.some((c) => JSON.stringify(c.column) === JSON.stringify(column))) return
    let name = column.name
    for (let i = 2; found.some((c) => c.column.name === name); i++)
      name = `${column.name.slice(0, MAX_NAME - 3)}_${i}`
    found.push({ row, kind, column: { ...column, name } })
  }
  const walk = (node: Node) => {
    if (node.kind === 'group') return node.children.forEach(walk)
    if (node.kind === 'reference') {
      if (!node.layer || node.fid === null) return
      add(node.id, 'distance', {
        fn: 'distance_to',
        name: columnName('distanz', node.layer, String(node.fid)),
        layer: node.layer,
        where: { op: 'compare', attr: 'fid', cmp: 'eq', value: node.fid },
      })
      return
    }
    if (node.kind !== 'spatial' || !node.layer) return
    const filter = node.filter ? attributeCondition(node.filter) : null
    if (node.operator === 'near' || node.operator === 'far') {
      add(node.id, 'distance', {
        fn: 'distance_to',
        name: columnName(
          'distanz',
          node.layer,
          ...(filter && node.filter ? [node.filter.attr] : []),
        ),
        layer: node.layer,
        ...(filter ? { where: filter } : {}),
      })
      return
    }
    if (node.operator === 'contains') return
    const predicate = node.operator === 'intersects' ? 'intersects' : 'within'
    const attrs = [labelOf(node.layer), filter && node.filter ? node.filter.attr : null]
    for (const attr of attrs) {
      if (!attr) continue
      add(node.id, 'value', {
        fn: 'value_of',
        name: columnName(node.layer, attr),
        layer: node.layer,
        attr,
        predicate,
      })
    }
  }
  walk(analysis.tree)
  return found
}

/** "Nur gefilterte Objekte" (design B4): the result's conditions, if the buffer is about it. */
function filteredSourceOf(layer: DisplayLayer, analysis: Analysis): Condition | null {
  if (layer.source.kind !== 'derived' || layer.source.recipe.op !== 'buffer') return null
  const result = analysis.layers.find((l) => l.id === analysis.result)
  if (result?.source.kind !== 'catalog' || result.source.layer !== layer.source.recipe.layer)
    return null
  return resultWhere(analysis)
}

export function resultLayer(analysis: Analysis): DisplayLayer | null {
  const layer = analysis.layers.find((l) => l.id === analysis.result)
  return layer && canBeResult(layer) ? layer : null
}

/** The conditions of the query: tree plus restriction ("Nur in"). */
export function resultWhere(analysis: Analysis): Condition | null {
  return and(nodeCondition(analysis.tree), restrictionCondition(analysis.restriction))
}

/** The analysis as one query object: the result layer under all conditions. */
export function resultQuery(analysis: Analysis): QueryObject | null {
  const layer = resultLayer(analysis)
  if (!layer) return null
  const query = layerQuery(layer)
  const where = and(query.where, resultWhere(analysis))
  return { ...query, ...(where ? { where } : {}) }
}

/** The result layer without conditions: the "von 39" of "7 von 39". */
export function totalQuery(analysis: Analysis): QueryObject | null {
  const layer = resultLayer(analysis)
  return layer ? layerQuery(layer) : null
}

/** Each row alone on the result layer, for "Trefferzahl je Bedingung" (design B2). */
export function rowQueries(analysis: Analysis): { id: string; query: QueryObject }[] {
  const layer = resultLayer(analysis)
  if (!layer) return []
  const total = layerQuery(layer)
  const rows: Row[] = []
  const walk = (node: Node) =>
    node.kind === 'group' ? node.children.forEach(walk) : rows.push(node)
  walk(analysis.tree)
  return rows.flatMap((row) => {
    const condition = rowCondition(row)
    if (!condition) return []
    const where = and(total.where, condition)
    return [{ id: row.id, query: { ...total, ...(where ? { where } : {}) } }]
  })
}

export const emptyTree = (id = 'root'): Group => ({
  id,
  kind: 'group',
  op: 'and',
  not: false,
  children: [],
})

// --- query → analysis (D3, plan WP80) ---------------------------------------------------
//
// ``toAnalysis`` is ``to_analysis`` of the backend's ``model/represent.py``,
// rewritten in TypeScript: the same refusals, the same choices where several
// analyses give one query, and the same check at the end, that ``resultQuery``
// of the analysis found gives the query back in canonical form. Both sides run
// the shared case list (schema/model-cases/represent.json, represent.test.ts).
// It serves the model path, so it finds only what the editor's draft of a
// proposal takes (model/panel/draft.ts): a condition tree, never a restriction
// ("Nur in" is the map's), never a symbology, never ``not`` of a ``not``.
// Where several analyses give the same query, it picks:
//
// - the root is an ``and`` group, never negated; an ``and`` at the top gives its
//   arguments as the root's children, anything else is the root's only child;
// - ``not`` of a ``within`` relation is "liegt ausserhalb", ``not`` of a distance
//   relation "> Distanz zu"; otherwise ``not`` sets the node's NICHT;
// - ``and`` of a ``ge`` and a ``le`` compare on one date field, both ISO dates in
//   order, is one date range row ("zwischen").
//
// The controls know the layers from the catalog (the layer list, ``useLayers``):
// the result is a vector layer; a row names a field of its layer with an
// operator ``operatorsFor`` offers for the field's type, a number range on a
// number field and a date range on a date field; a relation or reference names
// another vector layer, never the result layer itself; a relation's filter is
// one attribute row of the related layer, without NICHT.
//
// Input is raw JSON, as the record holds it: keys that are null set nothing,
// and the schema's defaults count as written (``text_match`` without ``mode``).
// Node ids are the readable tree's (model/readable.ts): ``q0`` is the where
// clause, ``q0.1`` its second argument, ``q0.1.where`` a relation's filter.

/**
 * The analysis the controls show for a query (``analysis``), or the part they
 * cannot show (``part``: the first top-level field in schema order or the
 * condition ``op``, represent.py ``NotRepresentable``; the refusal's
 * ``details.part`` on the server).
 */
export type Representation = { analysis: QueryPart; part: null } | { analysis: null; part: string }

/** The query object's fields in schema order (``QueryObject``), for the part a refusal names. */
const QUERY_FIELDS = [
  'schema_version',
  'source',
  'attribute_join',
  'where',
  'buffer',
  'spatial_relation',
  'aggregate',
  'columns',
  'select',
  'order_by',
  'limit',
  'symbology',
  'output',
]

/** What a proposal may set; the controls also write ``symbology``, the draft does not take it. */
const ALLOWED_FIELDS = ['schema_version', 'source', 'where', 'output']

/** Lists the schema fills in by default: empty, they set nothing. */
const LIST_DEFAULTS = ['columns', 'order_by']

const COMPARE: readonly string[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge']
const TEXT_MODES: readonly string[] = ['contains', 'starts_with', 'ends_with']
const TOPOLOGICAL: Record<string, SpatialRow['operator']> = {
  within: 'in',
  intersects: 'intersects',
  contains: 'contains',
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const unset = (value: unknown) =>
  value === null || value === undefined || (Array.isArray(value) && value.length === 0)

/** Thrown inside ``toAnalysis`` only and caught there: the first part the controls cannot show. */
class NotRepresentable {
  readonly part: string
  constructor(part: string) {
    this.part = part
  }
}

/** Defaults the schema fills in where a condition leaves them out (``geotandem_query.models``). */
const CONDITION_DEFAULTS: Record<string, Json> = {
  text_match: { mode: 'contains', case_sensitive: false },
  near_feature: { distance_m: 0 },
  geometry: { predicate: 'intersects' },
}

/**
 * A query object as the server compares it (``canonical_json``): sorted keys,
 * nothing null, the schema's defaults filled in, a version 0 or 1 read as 2 and
 * a number range's bounds in order (the schema normalises them, ``Between``).
 */
export function canonicalQuery(query: unknown): string {
  const filled = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(filled)
    if (!isObject(value)) return value
    const op = typeof value.op === 'string' ? value.op : ''
    const out: Json = { ...CONDITION_DEFAULTS[op] }
    for (const [key, inner] of Object.entries(value))
      if (inner !== null && inner !== undefined) out[key] = filled(inner)
    if (op === 'between' && isNumber(out.min) && isNumber(out.max) && out.min > out.max)
      [out.min, out.max] = [out.max, out.min]
    return out
  }
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted)
    if (!isObject(value)) return value
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    )
  }
  if (!isObject(query)) return JSON.stringify(query)
  const top: Json = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue
    if (LIST_DEFAULTS.includes(key) && Array.isArray(value) && value.length === 0) continue
    top[key] = filled(value)
  }
  const version = top.schema_version
  top.schema_version = version === undefined || version === '0' || version === '1' ? '2' : version
  top.output ??= 'map'
  return JSON.stringify(sorted(top))
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

/** The query the editor's draft of ``part`` sends: ``resultQuery`` on its catalog layer. */
function partQuery(part: QueryPart): QueryObject | null {
  const layer: DisplayLayer = {
    id: part.result,
    source: { kind: 'catalog', layer: part.result },
    visible: true,
    opacity: 1,
    symbology: null,
  }
  return resultQuery({ layers: [layer], result: layer.id, tree: part.tree, restriction: null })
}

/**
 * The analysis the controls show for ``query`` over the layers of ``catalog``,
 * or the part they cannot show without loss (D3). Never a guess: whatever is
 * found writes the query back (``resultQuery``) in canonical form. Without a
 * catalog (the layer list still loading) every source is unknown.
 */
export function toAnalysis(
  query: unknown,
  catalog: readonly LayerInfo[] | undefined,
): Representation {
  try {
    return { analysis: findAnalysis(query, catalog ?? []), part: null }
  } catch (error) {
    if (error instanceof NotRepresentable) return { analysis: null, part: error.part }
    throw error
  }
}

function findAnalysis(query: unknown, catalog: readonly LayerInfo[]): QueryPart {
  if (!isObject(query)) throw new NotRepresentable('source')
  for (const name of QUERY_FIELDS)
    if (!ALLOWED_FIELDS.includes(name) && !unset(query[name])) throw new NotRepresentable(name)
  // A key the schema does not know: the server refuses such an object outright.
  const unknown = Object.keys(query).find((k) => !QUERY_FIELDS.includes(k) && !unset(query[k]))
  if (unknown !== undefined) throw new NotRepresentable(unknown)
  if (!unset(query.output) && query.output !== 'map') throw new NotRepresentable('output')
  const source = typeof query.source === 'string' ? query.source : null
  // A table layer is never the result (B11).
  if (catalog.find((l) => l.name === source)?.kind !== 'vector' || source === null)
    throw new NotRepresentable('source')
  const tree = unset(query.where) ? emptyTree() : new Inverse(catalog, source).root(query.where)
  const part: QueryPart = { result: source, tree, restriction: null }
  const written = partQuery(part)
  // A safety net: the inverse is meant to fail first, naming the part.
  if (!written || canonicalQuery(written) !== canonicalQuery(query))
    throw new NotRepresentable('where')
  return part
}

/** ``_Inverse`` of represent.py: the conditions of a raw where clause as rows and groups. */
class Inverse {
  readonly catalog: readonly LayerInfo[]
  readonly source: string
  constructor(catalog: readonly LayerInfo[], source: string) {
    this.catalog = catalog
    this.source = source
  }

  root(condition: unknown): Group {
    if (
      isObject(condition) &&
      condition.op === 'and' &&
      Array.isArray(condition.args) &&
      condition.args.length >= 2 &&
      this.dates(condition, this.source, 'q0') === null
    ) {
      const children = condition.args.map((arg, i) => this.node(arg, this.source, `q0.${i}`))
      return { ...emptyTree(), children }
    }
    return { ...emptyTree(), children: [this.node(condition, this.source, 'q0')] }
  }

  fieldType(layer: string, attr: string, op: string): FieldType {
    const info = this.catalog.find((l) => l.name === layer)
    const found = info?.attributes.find((a) => a.name === attr)?.data_type
    // Not a field the editor lists.
    if (found === undefined) throw new NotRepresentable(op)
    return found
  }

  /** ``ge`` and ``le`` on one date field, ISO dates in order: a date range row. */
  dates(condition: Json, layer: string, id: string): AttributeRow | null {
    if (!Array.isArray(condition.args) || condition.args.length !== 2) return null
    const [low, high] = condition.args as unknown[]
    if (!isObject(low) || !isObject(high) || low.op !== 'compare' || high.op !== 'compare')
      return null
    const attr = low.attr
    if (low.cmp !== 'ge' || high.cmp !== 'le' || typeof attr !== 'string' || attr !== high.attr)
      return null
    const [from, to] = [low.value, high.value]
    if (typeof from !== 'string' || typeof to !== 'string') return null
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return null
    if (from > to || this.fieldType(layer, attr, 'compare') !== 'date') return null
    return attributeRow(id, attr, { operator: 'between', min: from, max: to })
  }

  /** ``row``, if the editor offers its operator for the field's type. */
  attribute(op: string, layer: string, row: AttributeRow): AttributeRow {
    const type = this.fieldType(layer, row.attr, op)
    if (!operatorsFor(type).includes(row.operator)) throw new NotRepresentable(op)
    // A date range comes as ge and le.
    if (row.operator === 'between' && type !== 'integer' && type !== 'real')
      throw new NotRepresentable(op)
    return row
  }

  /** Relations and references name another vector layer (``LayerSelect``). */
  otherLayer(layer: unknown, op: string): string {
    const info = this.catalog.find((l) => l.name === layer)
    if (info?.kind !== 'vector' || info.name === this.source) throw new NotRepresentable(op)
    return info.name
  }

  node(condition: unknown, layer: string, id: string): Node {
    if (!isObject(condition) || typeof condition.op !== 'string')
      throw new NotRepresentable('where')
    const c = condition
    const op = condition.op
    const row = (patch: Partial<AttributeRow>) => {
      if (typeof c.attr !== 'string') throw new NotRepresentable(op)
      return this.attribute(op, layer, attributeRow(id, c.attr, patch))
    }
    switch (op) {
      case 'and':
      case 'or': {
        if (!Array.isArray(c.args) || c.args.length < 2) throw new NotRepresentable(op)
        const dates = op === 'and' ? this.dates(c, layer, id) : null
        if (dates) return dates
        const children = c.args.map((arg, i) => this.node(arg, layer, `${id}.${i}`))
        return { id, kind: 'group', op, not: false, children }
      }
      case 'not':
        if (isObject(c.arg) && c.arg.op === 'not') throw new NotRepresentable(op)
        return negated(this.node(c.arg, layer, id))
      case 'compare':
        if (typeof c.cmp !== 'string' || !COMPARE.includes(c.cmp) || !isScalar(c.value))
          throw new NotRepresentable(op)
        if (c.value === '') throw new NotRepresentable(op)
        return row({ operator: c.cmp as AttributeRow['operator'], value: c.value })
      case 'between': {
        if (!isNumber(c.min) || !isNumber(c.max)) throw new NotRepresentable(op)
        // Either order: the schema normalises "zwischen 4 und 2" to 2–4.
        const [min, max] = c.min <= c.max ? [c.min, c.max] : [c.max, c.min]
        return row({ operator: 'between', min, max })
      }
      case 'in':
        if (!Array.isArray(c.values) || c.values.length === 0 || !c.values.every(isScalar))
          throw new NotRepresentable(op)
        return row({ operator: 'in', values: c.values })
      case 'text_match': {
        const mode = c.mode ?? 'contains'
        if (typeof mode !== 'string' || !TEXT_MODES.includes(mode)) throw new NotRepresentable(op)
        if ((c.case_sensitive ?? false) !== false) throw new NotRepresentable(op)
        if (typeof c.text !== 'string' || c.text === '') throw new NotRepresentable(op)
        return row({ operator: mode as AttributeRow['operator'], value: c.text })
      }
      case 'is_null':
        return row({ operator: 'is_empty' })
      case 'near_feature': {
        const distance = c.distance_m ?? 0
        if (typeof c.fid !== 'number' || !Number.isInteger(c.fid)) throw new NotRepresentable(op)
        if (!isNumber(distance) || distance < 0) throw new NotRepresentable(op)
        const reference: ReferenceRow = {
          id,
          kind: 'reference',
          not: false,
          layer: this.otherLayer(c.layer, op),
          fid: c.fid,
          label: '',
          distance_m: distance,
        }
        return reference
      }
      case 'related': {
        const predicate = typeof c.predicate === 'string' ? c.predicate : ''
        const topological = TOPOLOGICAL[predicate]
        const distance = predicate === 'dwithin' && isNumber(c.distance_m) ? c.distance_m : null
        if (!topological && distance === null) throw new NotRepresentable(op)
        const related = this.otherLayer(c.layer, op)
        const spatial: SpatialRow = {
          id,
          kind: 'spatial',
          not: false,
          operator: topological ?? 'near',
          layer: related,
          distance_m: distance,
          filter: this.filter(c.where, related, `${id}.where`),
        }
        return spatial
      }
    }
    // bbox and geometry: the map's restriction, never the model's.
    throw new NotRepresentable(op)
  }

  /**
   * A relation's filter: one attribute row of the related layer ("+ Filter"),
   * which has no NICHT toggle.
   */
  filter(where: unknown, layer: string, id: string): AttributeRow | null {
    if (unset(where)) return null
    const node = this.node(where, layer, id)
    if (node.kind !== 'attribute' || node.not) throw new NotRepresentable('related')
    return node
  }
}

function negated(node: Node): Node {
  // Never negated already: ``not`` of a ``not`` is refused above.
  if (node.kind === 'spatial' && (node.operator === 'in' || node.operator === 'near'))
    return { ...node, operator: node.operator === 'in' ? 'outside' : 'far' }
  return { ...node, not: true }
}
