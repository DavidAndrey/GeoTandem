// Analysis state → query objects (schema v2). Pure and exhaustively tested:
// every query the interface sends comes from here (etappen E1.5 "fertig wenn").
import type {
  Analysis,
  AttributeRow,
  Column,
  Condition,
  DisplayLayer,
  Group,
  Node,
  QueryObject,
  Recipe,
  Restriction,
  Row,
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
