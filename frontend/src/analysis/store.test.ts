import { beforeEach, expect, test } from 'vitest'
import { assertValidQuery } from '../test/schema'
import { resultQuery } from './query'
import { currentAnalysis, useAnalysis } from './store'
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
