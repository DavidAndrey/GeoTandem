import { describe, expect, test } from 'vitest'
import { assertValidQuery } from '../test/schema'
import type {
  Analysis,
  AttributeRow,
  DisplayLayer,
  Group,
  Node,
  Recipe,
  Restriction,
  SpatialOperator,
} from './model'
import { emptyTree, explainColumns, layerQuery, resultQuery, rowQueries, totalQuery } from './query'
import { random, randomNode } from '../test/random'

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
      schema_version: '2',
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
      schema_version: '2',
      source: 'schulen',
      output: 'map',
    })
  })

  test('the result layer carries columns that explain its hits (design B8)', () => {
    const state = analysis(tree)
    const labelOf = (layer: string) => (layer === 'gemeinden' ? 'name' : null)
    expect(explainColumns(state, labelOf)).toEqual([
      {
        row: 'r2',
        kind: 'distance',
        column: {
          fn: 'distance_to',
          name: 'calc_distanz_strassen_klasse',
          layer: 'strassen',
          where: { op: 'compare', attr: 'klasse', cmp: 'eq', value: 'haupt' },
        },
      },
      {
        row: 'r3',
        kind: 'value',
        column: {
          fn: 'value_of',
          name: 'calc_gemeinden_name',
          layer: 'gemeinden',
          attr: 'name',
          predicate: 'within',
        },
      },
      {
        row: 'r3',
        kind: 'value',
        column: {
          fn: 'value_of',
          name: 'calc_gemeinden_anteil_u20',
          layer: 'gemeinden',
          attr: 'anteil_u20',
          predicate: 'within',
        },
      },
    ])
    const shown = layerQuery(catalog('schulen'), state, labelOf)
    assertValidQuery(shown)
    expect(shown.columns).toHaveLength(3)
    // Other layers, the result query and the counts stay as they were (F-8.9).
    expect(layerQuery(catalog('strassen'), state, labelOf).columns).toBeUndefined()
    expect(resultQuery(state)?.columns).toBeUndefined()
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
  expect(query).toEqual({ schema_version: '2', source: 'schulen', output: 'map' })
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
    const shown = layerQuery(catalog('schulen'), state, () => 'name')
    assertValidQuery(shown)
    const names = (shown.columns ?? []).map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  }
})

test('the schema check itself rejects invalid queries', () => {
  expect(() => assertValidQuery({ schema_version: '2', source: 'Schulen' })).toThrow()
  // Since option A the schema is the whole contract: a distance relation
  // without distance is rejected here, not only by the server.
  expect(() =>
    assertValidQuery({
      schema_version: '2',
      source: 'schulen',
      where: { op: 'related', layer: 'strassen', predicate: 'dwithin' },
    }),
  ).toThrow()
  expect(() =>
    assertValidQuery({ schema_version: '2', source: 'schulen', where: { op: 'touches' } }),
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
