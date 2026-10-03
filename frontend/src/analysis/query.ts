// Analysis state → query objects (schema v1). Pure and exhaustively tested:
// every query the interface sends comes from here (etappen E1.5 "fertig wenn").
import type {
  Analysis,
  AttributeRow,
  Condition,
  DisplayLayer,
  Group,
  Node,
  QueryObject,
  Recipe,
  Restriction,
  Row,
} from './model'

const base = (source: string): QueryObject => ({ schema_version: '1', source, output: 'map' })

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
      // Either order: the query object normalises "zwischen 500 und 100" to 100–500.
      if (row.min !== null && row.max !== null)
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
  layer.source.kind === 'catalog' || layer.source.recipe.op !== 'aggregate'

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

/** All features of a displayed layer, as drawn on the map. */
export function layerQuery(layer: DisplayLayer, analysis?: Analysis): QueryObject {
  const query =
    layer.source.kind === 'catalog'
      ? base(layer.source.layer)
      : recipeQuery(layer.source.recipe, analysis ? filteredSourceOf(layer, analysis) : null)
  return layer.symbology ? { ...query, symbology: layer.symbology } : query
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
