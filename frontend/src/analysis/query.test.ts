import { describe, expect, test } from 'vitest'
import { assertValidQuery } from '../test/schema'
import type {
  Analysis,
  AttributeOperator,
  AttributeRow,
  DisplayLayer,
  Group,
  Node,
  Recipe,
  Restriction,
  SpatialOperator,
} from './model'
import { emptyTree, layerQuery, resultQuery, rowQueries, totalQuery } from './query'

const catalog = (id: string, layer = id): DisplayLayer => ({
  id,
  source: { kind: 'catalog', layer },
  visible: true,
  opacity: 1,
  symbology: null,
})

const attribute = (patch: Partial<AttributeRow>): AttributeRow => ({
  id: 'a',
  kind: 'attribute',
  not: false,
  attr: 'typ',
  operator: 'in',
  value: null,
  min: null,
  max: null,
  values: [],
  ...patch,
})

const analysis = (tree: Group, patch: Partial<Analysis> = {}): Analysis => ({
  layers: [catalog('schulen'), catalog('strassen'), catalog('gemeinden')],
  result: 'schulen',
  tree,
  restriction: null,
  ...patch,
})

describe('the reference question', () => {
  // Primarschulen ≤ 500 m von einer Hauptstrasse, in Gemeinden mit Anteil u20 > 20 %.
  const tree: Group = {
    ...emptyTree(),
    children: [
      attribute({ id: 'r1', values: ['primar'] }),
      {
        id: 'r2',
        kind: 'spatial',
        not: false,
        operator: 'near',
        layer: 'strassen',
        distance_m: 500,
        filter: attribute({ attr: 'klasse', operator: 'eq', value: 'haupt' }),
      },
      {
        id: 'r3',
        kind: 'spatial',
        not: false,
        operator: 'in',
        layer: 'gemeinden',
        distance_m: null,
        filter: attribute({ attr: 'anteil_u20', operator: 'gt', value: 20 }),
      },
    ],
  }

  test('becomes one query object with two relations', () => {
    const query = resultQuery(analysis(tree))
    assertValidQuery(query)
    expect(query).toEqual({
      schema_version: '1',
      source: 'schulen',
      output: 'map',
      where: {
        op: 'and',
        args: [
          { op: 'in', attr: 'typ', values: ['primar'] },
          {
            op: 'related',
            layer: 'strassen',
            predicate: 'dwithin',
            distance_m: 500,
            where: { op: 'compare', attr: 'klasse', cmp: 'eq', value: 'haupt' },
          },
          {
            op: 'related',
            layer: 'gemeinden',
            predicate: 'within',
            where: { op: 'compare', attr: 'anteil_u20', cmp: 'gt', value: 20 },
          },
        ],
      },
    })
  })

  test('each condition alone, for the hit counts', () => {
    const queries = rowQueries(analysis(tree))
    expect(queries.map((q) => q.id)).toEqual(['r1', 'r2', 'r3'])
    queries.forEach((q) => assertValidQuery(q.query))
    expect(totalQuery(analysis(tree))).toEqual({
      schema_version: '1',
      source: 'schulen',
      output: 'map',
    })
  })
})

test('outside and farther than are negated relations', () => {
  const spatial = (operator: SpatialOperator): Node => ({
    id: operator,
    kind: 'spatial',
    not: false,
    operator,
    layer: 'gemeinden',
    distance_m: 300,
    filter: null,
  })
  const query = resultQuery(
    analysis({ ...emptyTree(), op: 'or', children: [spatial('outside'), spatial('far')] }),
  )
  assertValidQuery(query)
  expect(query?.where).toEqual({
    op: 'or',
    args: [
      { op: 'not', arg: { op: 'related', layer: 'gemeinden', predicate: 'within' } },
      {
        op: 'not',
        arg: { op: 'related', layer: 'gemeinden', predicate: 'dwithin', distance_m: 300 },
      },
    ],
  })
})

test('incomplete rows are left out, never sent half-made', () => {
  const tree: Group = {
    ...emptyTree(),
    children: [
      attribute({ id: 'empty-list' }),
      attribute({ id: 'no-value', operator: 'gt' }),
      { ...emptyTree('g'), children: [] },
    ],
  }
  const query = resultQuery(analysis(tree))
  expect(query).toEqual({ schema_version: '1', source: 'schulen', output: 'map' })
  expect(rowQueries(analysis(tree))).toEqual([])
})

test('the restriction joins the conditions', () => {
  const query = resultQuery(
    analysis(
      { ...emptyTree(), children: [attribute({ values: ['primar'] })] },
      { restriction: { kind: 'view', bbox: [7.8, 46.8, 8, 47] } },
    ),
  )
  assertValidQuery(query)
  expect(query?.where).toEqual({
    op: 'and',
    args: [
      { op: 'in', attr: 'typ', values: ['primar'] },
      { op: 'bbox', bbox: [7.8, 46.8, 8, 47] },
    ],
  })
})

test('derived layers are query objects', () => {
  const recipes: Recipe[] = [
    { op: 'buffer', layer: 'strassen', distance_m: 500, onlyFiltered: false },
    {
      op: 'join',
      layer: 'gemeinden',
      join: {
        layer: 'bevoelkerung',
        left_key: 'gem_nr',
        right_key: 'gem_nr',
        fields: ['einwohner'],
      },
      keepUnmatched: false,
    },
    {
      op: 'aggregate',
      layer: 'schulen',
      aggregate: {
        by_layer: 'gemeinden',
        predicate: 'within',
        area_fields: ['name'],
        metrics: [{ fn: 'count', as: 'anzahl' }],
      },
    },
  ]
  for (const recipe of recipes) {
    const layer: DisplayLayer = {
      ...catalog('x'),
      source: { kind: 'derived', name: recipe.op, recipe },
      symbology: { kind: 'single', color: '#b68235' },
    }
    assertValidQuery(layerQuery(layer))
  }
})

test('an aggregation cannot be the result layer (plan S2)', () => {
  const aggregation: DisplayLayer = {
    ...catalog('agg'),
    source: {
      kind: 'derived',
      name: 'Schulen je Gemeinde',
      recipe: {
        op: 'aggregate',
        layer: 'schulen',
        aggregate: {
          by_layer: 'gemeinden',
          predicate: 'within',
          area_fields: [],
          metrics: [{ fn: 'count', as: 'n' }],
        },
      },
    },
  }
  expect(resultQuery(analysis(emptyTree(), { layers: [aggregation], result: 'agg' }))).toBeNull()
})

// --- every edit, at random ------------------------------------------------------

function random(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const OPERATORS: AttributeOperator[] = [
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'between',
  'contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'in',
]
const SPATIAL: SpatialOperator[] = ['in', 'outside', 'intersects', 'contains', 'near', 'far']

function randomNode(next: () => number, depth: number, id: { n: number }): Node {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)] as T
  const maybe = <T>(value: T): T | null => (next() < 0.25 ? null : value)
  const kind =
    depth > 2
      ? pick(['attribute', 'spatial', 'reference'])
      : pick(['group', 'attribute', 'spatial', 'reference'])
  const key = `n${id.n++}`
  if (kind === 'group')
    return {
      id: key,
      kind: 'group',
      op: pick(['and', 'or'] as const),
      not: next() < 0.3,
      children: Array.from({ length: Math.floor(next() * 4) }, () =>
        randomNode(next, depth + 1, id),
      ),
    }
  if (kind === 'reference')
    return {
      id: key,
      kind: 'reference',
      not: next() < 0.3,
      layer: pick(['strassen', '']),
      fid: maybe(Math.floor(next() * 10)),
      label: '',
      distance_m: Math.floor(next() * 1000),
    }
  const filter = (): AttributeRow => ({
    id: `${key}f`,
    kind: 'attribute',
    not: next() < 0.3,
    attr: pick(['typ', 'schueler', '']),
    operator: pick(OPERATORS),
    value: maybe(pick<string | number | boolean>(['primar', 12, 3.5, true, ''])),
    min: maybe(Math.floor(next() * 100)),
    max: maybe(Math.floor(next() * 100)),
    values: next() < 0.3 ? [] : [pick<string | number>(['a', 2])],
  })
  if (kind === 'attribute') return filter()
  return {
    id: key,
    kind: 'spatial',
    not: next() < 0.3,
    operator: pick(SPATIAL),
    layer: pick(['strassen', 'gemeinden', '']),
    distance_m: maybe(Math.floor(next() * 2000) - 100),
    filter: next() < 0.5 ? null : filter(),
  }
}

test('every random analysis yields only valid query objects', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed)
    const id = { n: 0 }
    const tree: Group = {
      ...emptyTree(),
      op: next() < 0.5 ? 'and' : 'or',
      not: next() < 0.2,
      children: Array.from({ length: 1 + Math.floor(next() * 5) }, () => randomNode(next, 1, id)),
    }
    const restriction: Restriction =
      next() < 0.3 ? { kind: 'view', bbox: [7.8, 46.8, 8, 47] } : null
    const state = analysis(tree, { restriction })
    const result = resultQuery(state)
    assertValidQuery(result)
    for (const { query } of rowQueries(state)) assertValidQuery(query)
  }
})

test('the schema check itself rejects invalid queries', () => {
  expect(() => assertValidQuery({ schema_version: '1', source: 'Schulen' })).toThrow()
  // Since option A the schema is the whole contract: a distance relation
  // without distance is rejected here, not only by the server.
  expect(() =>
    assertValidQuery({
      schema_version: '1',
      source: 'schulen',
      where: { op: 'related', layer: 'strassen', predicate: 'dwithin' },
    }),
  ).toThrow()
  expect(() =>
    assertValidQuery({ schema_version: '1', source: 'schulen', where: { op: 'touches' } }),
  ).toThrow()
})

test('a reversed range is sent as typed; the query object normalises it', () => {
  const tree: Group = {
    ...emptyTree(),
    children: [attribute({ operator: 'between', attr: 'schueler', min: 500, max: 100 })],
  }
  const query = resultQuery(analysis(tree))
  assertValidQuery(query)
  expect(query?.where).toEqual({ op: 'between', attr: 'schueler', min: 500, max: 100 })
})
