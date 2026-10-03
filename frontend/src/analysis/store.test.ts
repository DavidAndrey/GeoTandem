import { beforeEach, expect, test } from 'vitest'
import { assertValidQuery } from '../test/schema'
import { resultQuery } from './query'
import { currentAnalysis, nextSort, useAnalysis } from './store'
import { newAttributeRow, newSpatialRow } from './tree'

const store = () => useAnalysis.getState()

beforeEach(() => store().reset())

test('the first layer becomes the result layer; new layers go on top', () => {
  store().addLayer('schulen')
  store().addLayer('strassen')
  expect(store().result).toBe('schulen')
  expect(store().layers.map((l) => l.id)).toEqual(['strassen', 'schulen'])
  store().moveLayer('strassen', 1)
  expect(store().layers.map((l) => l.id)).toEqual(['schulen', 'strassen'])
  expect(store().dirty).toBe(true)
})

test('the editor works on a draft until applied (design B2)', () => {
  store().addLayer('schulen')
  const row = { ...newAttributeRow('typ'), operator: 'in' as const, values: ['primar'] }
  store().edit()
  store().addNode('root', row)
  expect(store().tree.children).toHaveLength(0)
  expect(currentAnalysis(store()).tree.children).toHaveLength(1)

  store().discard()
  expect(currentAnalysis(store()).tree.children).toHaveLength(0)

  store().edit()
  store().addNode('root', row)
  store().editNode(row.id, { values: ['sekundar'] })
  store().apply()
  const query = resultQuery(currentAnalysis(store()))
  assertValidQuery(query)
  expect(query?.where).toEqual({ op: 'in', attr: 'typ', values: ['sekundar'] })
})

test('changing the result layer drops attribute conditions, keeps spatial ones (B13)', () => {
  store().addLayer('schulen')
  store().addLayer('kitas')
  store().edit()
  store().addNode('root', { ...newAttributeRow('typ'), values: ['primar'], operator: 'in' })
  store().addNode('root', { ...newSpatialRow('strassen'), operator: 'near', distance_m: 500 })
  store().apply()

  const { dropped } = store().setResult('kitas')
  expect(dropped.map((r) => r.attr)).toEqual(['typ'])
  expect(store().tree.children.map((n) => n.kind)).toEqual(['spatial'])
  expect(resultQuery(currentAnalysis(store()))?.source).toBe('kitas')
})

test('removing the result layer leaves no result', () => {
  store().addLayer('schulen')
  store().removeLayer('schulen')
  expect(store().result).toBeNull()
  expect(resultQuery(currentAnalysis(store()))).toBeNull()
})

test('loading a saved analysis is not a change', () => {
  store().addLayer('schulen')
  const saved = currentAnalysis(store())
  store().reset()
  store().load(saved)
  expect(store().dirty).toBe(false)
  expect(store().layers).toHaveLength(1)
})

test('changing the result layer inside the editor keeps the other draft edits', () => {
  store().addLayer('schulen')
  store().addLayer('kitas')
  store().edit()
  store().addNode('root', { ...newSpatialRow('strassen'), operator: 'near', distance_m: 500 })
  store().setResult('kitas')
  expect(store().draft?.children).toHaveLength(1)
  expect(store().tree.children).toHaveLength(0) // nothing applied yet
})

test('sorting cycles ↓ / ↑ / aus; Shift sets the second key (design B8)', () => {
  const desc = (attr: string) => ({ attr, dir: 'desc' as const })
  const asc = (attr: string) => ({ attr, dir: 'asc' as const })
  expect(nextSort([], 'n', false)).toEqual([desc('n')])
  expect(nextSort([desc('n')], 'n', false)).toEqual([asc('n')])
  expect(nextSort([asc('n')], 'n', false)).toEqual([])
  expect(nextSort([desc('n'), asc('a')], 'b', false)).toEqual([desc('b')])
  expect(nextSort([desc('n')], 'a', true)).toEqual([desc('n'), desc('a')])
  expect(nextSort([desc('n'), desc('a')], 'b', true)).toEqual([desc('n'), desc('b')])
  expect(nextSort([desc('n'), desc('a')], 'a', true)).toEqual([desc('n'), asc('a')])
  expect(nextSort([desc('n'), asc('a')], 'a', true)).toEqual([desc('n')])
})

test('columns and sort mark the analysis unsaved; tab and mode do not (design C7)', () => {
  store().addLayer('schulen')
  store().load(currentAnalysis(store()))
  store().setTableTab('schulen')
  store().setTableMode('all')
  store().setOnlyView(true)
  expect(store().dirty).toBe(false)
  store().toggleSort('schulen', 'schueler', false)
  expect(store().dirty).toBe(true)
  store().load(currentAnalysis(store()))
  store().setColumns('schulen', { order: ['name'], hidden: ['typ'] })
  expect(store().dirty).toBe(true)
})

test('removing a layer drops its tab, columns and sort', () => {
  store().addLayer('schulen')
  store().addLayer('strassen')
  store().setTableTab('strassen')
  store().toggleSort('strassen', 'name', false)
  store().setColumns('strassen', { order: [], hidden: ['klasse'] })
  store().removeLayer('strassen')
  expect(store().table).toEqual({ tab: null, mode: 'hits', onlyView: false, columns: {}, sort: {} })
})
