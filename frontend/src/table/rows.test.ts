import { expect, test } from 'vitest'
import type { ExplainColumn } from '../analysis/query'
import type { LayerInfo, QueryResult } from '../api/client'
import { attribute, layer } from '../test/fixtures'
import { availableColumns, shownColumns, sortRows, tableRows, type Row } from './rows'

type Feature = QueryResult['features'][number]

const point = (id: number, x: number, y: number, properties: Record<string, unknown>): Feature =>
  ({ type: 'Feature', id, properties, geometry: { type: 'Point', coordinates: [x, y] } }) as Feature

const row = (id: number, properties: Record<string, unknown>): Row => ({
  id,
  properties,
  hit: true,
  bbox: null,
})

test('hits or all, and only the map view (design B8)', () => {
  const features = [
    point(1, 7.5, 46.9, {}),
    point(2, 7.6, 46.9, {}),
    point(3, 8.5, 47.5, {}),
    { type: 'Feature', id: 4, properties: {}, geometry: null } as Feature,
  ]
  const hits = new Set([1, 3])
  expect(tableRows(features, hits, 'hits', null).map((r) => r.id)).toEqual([1, 3])
  const all = tableRows(features, hits, 'all', null)
  expect(all.map((r) => [r.id, r.hit])).toEqual([
    [1, true],
    [2, false],
    [3, true],
    [4, false],
  ])
  expect(tableRows(features, hits, 'all', [7, 46, 8, 47]).map((r) => r.id)).toEqual([1, 2])
  // Without conditions every feature is a hit.
  expect(tableRows(features, null, 'hits', null)).toHaveLength(4)
})

test('a polygon is in view when its extent overlaps it', () => {
  const area = {
    type: 'Feature',
    id: 1,
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [7, 46],
          [8, 46],
          [8, 47],
          [7, 46],
        ],
      ],
    },
  } as Feature
  expect(tableRows([area], null, 'all', [7.9, 46.9, 9, 48])).toHaveLength(1)
  expect(tableRows([area], null, 'all', [8.1, 46.9, 9, 48])).toHaveLength(0)
})

test('sorting: numbers as numbers, de-CH collation, empty values last, fid breaks ties', () => {
  const rows = [
    row(1, { name: 'Zürich', n: 10 }),
    row(2, { name: 'Ägerten', n: 9 }),
    row(3, { name: 'aarau', n: null }),
    row(4, { name: 'Bern', n: 10 }),
    row(5, { name: '', n: 100 }),
  ]
  const ids = (sorted: Row[]) => sorted.map((r) => r.id)
  expect(ids(sortRows(rows, [{ attr: 'n', dir: 'desc' }]))).toEqual([5, 1, 4, 2, 3])
  expect(ids(sortRows(rows, [{ attr: 'n', dir: 'asc' }]))).toEqual([2, 1, 4, 5, 3])
  expect(ids(sortRows(rows, [{ attr: 'name', dir: 'asc' }]))).toEqual([3, 2, 4, 1, 5])
  expect(
    ids(
      sortRows(rows, [
        { attr: 'n', dir: 'desc' },
        { attr: 'name', dir: 'asc' },
      ]),
    ),
  ).toEqual([5, 4, 1, 2, 3])
  expect(ids(sortRows(rows, []))).toEqual([1, 2, 3, 4, 5])
})

const schulen: LayerInfo = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  attributes: [
    attribute({ name: 'name', data_type: 'text', label: 'Name' }),
    attribute({ name: 'typ', data_type: 'text', label: 'Schulart' }),
    attribute({ name: 'schueler', data_type: 'integer', label: 'Schüler' }),
  ],
})
const strassen = layer({ name: 'strassen', title: 'Hauptverkehrsstrassen', attributes: [] })

test('columns: catalog order and labels, then other fields, then computed ones', () => {
  const explain: ExplainColumn[] = [
    {
      row: 'r2',
      kind: 'distance',
      column: { fn: 'distance_to', name: 'calc_distanz_strassen', layer: 'strassen' },
    },
  ]
  const keys = ['schueler', 'calc_distanz_strassen', 'extra', 'name', 'typ']
  const columns = availableColumns(schulen, keys, explain, (l) =>
    l === 'strassen' ? strassen : undefined,
  )
  expect(columns.map((c) => [c.name, c.label])).toEqual([
    ['name', 'Name'],
    ['typ', 'Schulart'],
    ['schueler', 'Schüler'],
    ['extra', 'extra'],
    ['calc_distanz_strassen', 'Distanz Hauptverkehrsstrassen'],
  ])
  const distance = columns.at(-1)
  expect(distance).toMatchObject({
    label: 'Distanz Hauptverkehrsstrassen',
    unit: 'm',
    numeric: true,
    computed: 'distance',
  })
})

test('the column choice keeps its order and lets new columns appear', () => {
  const col = (name: string) => ({ name, label: name, unit: null, numeric: false, computed: null })
  const available = ['a', 'b', 'c', 'd'].map(col)
  const choice = { order: ['c', 'a', 'b'], hidden: ['b'] }
  expect(shownColumns(available, choice).map((c) => c.name)).toEqual(['c', 'a', 'd'])
  expect(shownColumns(available, undefined).map((c) => c.name)).toEqual(['a', 'b', 'c', 'd'])
})
