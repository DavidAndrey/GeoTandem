import { expect, test } from 'vitest'
import type { Analysis, DisplayLayer, Group, SpatialRow } from '../analysis/model'
import { emptyTree } from '../analysis/query'
import {
  conditionLabel,
  fitQuery,
  isChanged,
  partFrom,
  queryPart,
  snapshotOf,
  wouldLose,
} from './part'

const schulen: DisplayLayer = {
  id: 'schulen',
  source: { kind: 'catalog', layer: 'schulen' },
  visible: true,
  opacity: 1,
  symbology: null,
}
const buffer: DisplayLayer = {
  id: 'd1',
  source: {
    kind: 'derived',
    name: 'Puffer',
    recipe: { op: 'buffer', layer: 'strassen', distance_m: 100, onlyFiltered: false },
  },
  visible: true,
  opacity: 1,
  symbology: null,
}
const road: SpatialRow = {
  id: 's1',
  kind: 'spatial',
  not: false,
  operator: 'near',
  layer: 'strassen',
  distance_m: 500,
  filter: null,
}
const tree: Group = { ...emptyTree(), children: [road] }
const analysis = (patch: Partial<Analysis> = {}): Analysis => ({
  layers: [schulen, buffer],
  result: 'schulen',
  tree,
  restriction: null,
  ...patch,
})

test('only a query on a catalog layer can be saved (plan E1.7b, Q2)', () => {
  expect(queryPart(analysis())).toEqual({ result: 'schulen', tree, restriction: null })
  expect(queryPart(analysis({ result: 'd1' }))).toBeNull()
  expect(queryPart(analysis({ result: null }))).toBeNull()
})

test('"geändert" compares with the saved part', () => {
  const ref = {
    id: 'q',
    name: 'Q',
    mine: true,
    shared: false,
    snapshot: snapshotOf(queryPart(analysis())),
  }
  expect(isChanged(analysis(), ref)).toBe(false)
  expect(isChanged(analysis({ tree: emptyTree() }), ref)).toBe(true)
  expect(isChanged(analysis(), null)).toBe(false)
})

test('choosing another query asks only when work would be lost (design B1)', () => {
  const ref = {
    id: 'q',
    name: 'Q',
    mine: true,
    shared: false,
    snapshot: snapshotOf(queryPart(analysis())),
  }
  expect(wouldLose(analysis(), ref)).toBe(false)
  expect(wouldLose(analysis({ tree: emptyTree() }), ref)).toBe(true)
  expect(wouldLose(analysis(), null)).toBe(true)
  expect(wouldLose(analysis({ tree: emptyTree() }), null)).toBe(false)
})

test('a saved query fits today: missing layers drop their conditions, a missing result fails', () => {
  const part = { result: 'schulen', tree, restriction: null }
  expect(fitQuery(part, new Set(['schulen', 'strassen']))).toEqual({ part, removed: [] })
  const fitted = fitQuery(part, new Set(['schulen']))
  expect(fitted?.removed).toEqual([road])
  expect(fitted?.part.tree.children).toEqual([])
  expect(fitQuery(part, new Set(['strassen']))).toBeNull()
})

test('reading a state refuses what it does not know', () => {
  const state = { result: 'schulen', tree, restriction: null }
  expect(partFrom(1, state)).toEqual(state)
  expect(partFrom(2, state)).toBeNull()
  expect(partFrom(1, { result: 'schulen' })).toBeNull()
})

test('conditions read as in design C6', () => {
  expect(conditionLabel({ attribute: 1, spatial: 2, restriction: false })).toBe('1 A · 2 R')
  expect(conditionLabel({ attribute: 0, spatial: 0, restriction: true })).toBe('Fläche')
  expect(conditionLabel({ attribute: 0, spatial: 0, restriction: false })).toBe('keine')
})
