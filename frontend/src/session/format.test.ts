import { expect, test } from 'vitest'
import type { Analysis, DisplayLayer, Group, TableState } from '../analysis/model'
import { emptyTree, layerQuery, resultQuery } from '../analysis/query'
import { emptyTable } from '../analysis/store'
import { random, randomNode } from '../test/random'
import { fromSaved, reconcile, SessionFormatError, STATE_VERSION, toSaved } from './format'

const catalog = (id: string): DisplayLayer => ({
  id,
  source: { kind: 'catalog', layer: id },
  visible: true,
  opacity: 1,
  symbology: null,
})
const buffer: DisplayLayer = {
  id: 'd1',
  source: {
    kind: 'derived',
    name: 'Puffer 500 m',
    recipe: { op: 'buffer', layer: 'strassen', distance_m: 500, onlyFiltered: false },
  },
  visible: true,
  opacity: 0.8,
  symbology: { kind: 'single', color: '#4a6fa5' },
}

function analysis(tree: Group, patch: Partial<Analysis> = {}): Analysis {
  return {
    layers: [catalog('schulen'), catalog('strassen'), catalog('gemeinden'), buffer],
    result: 'schulen',
    tree,
    restriction: null,
    ...patch,
  }
}

const roundTrip = (a: Analysis, table: TableState = emptyTable()) => {
  const { state_version, state } = toSaved({ analysis: a, table, view: [7.3, 46.9, 7.5, 47] })
  return fromSaved(state_version, JSON.parse(JSON.stringify(state)))
}

test('every random analysis survives saving with the same queries (F-4.10, F-8.9)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed)
    const id = { n: 0 }
    const tree: Group = {
      ...emptyTree(),
      op: next() < 0.5 ? 'and' : 'or',
      not: next() < 0.2,
      children: Array.from({ length: 1 + Math.floor(next() * 5) }, () => randomNode(next, 1, id)),
    }
    const restriction: Analysis['restriction'] =
      next() < 0.3 ? { kind: 'view', bbox: [7.3, 46.9, 7.5, 47] } : null
    const before = analysis(tree, { restriction })
    const after = roundTrip(before).analysis
    expect(resultQuery(after)).toEqual(resultQuery(before))
    for (const layer of before.layers) {
      const restored = after.layers.find((l) => l.id === layer.id)
      expect(restored && layerQuery(restored, after)).toEqual(layerQuery(layer, before))
    }
  }
})

test('table and view are saved with it', () => {
  const table: TableState = {
    tab: 'schulen',
    mode: 'all',
    onlyView: true,
    columns: { schulen: { order: ['name'], hidden: ['typ'] } },
    sort: { schulen: [{ attr: 'standorte', dir: 'desc' }] },
  }
  const restored = roundTrip(analysis(emptyTree()), table)
  expect(restored.table).toEqual(table)
  expect(restored.view).toEqual([7.3, 46.9, 7.5, 47])
})

test('an unknown format or an incomplete state is refused, not guessed', () => {
  expect(() => fromSaved(STATE_VERSION + 1, {})).toThrow(SessionFormatError)
  expect(() => fromSaved(STATE_VERSION, { layers: [] })).toThrow(SessionFormatError)
  expect(() => fromSaved(STATE_VERSION, null)).toThrow(SessionFormatError)
})

test('layers that are gone leave the analysis and are listed (design C8, plan D5)', () => {
  const tree: Group = {
    ...emptyTree(),
    children: [
      {
        id: 'a',
        kind: 'attribute',
        not: false,
        attr: 'typ',
        operator: 'in',
        value: null,
        min: null,
        max: null,
        values: ['primar'],
      },
      {
        id: 's1',
        kind: 'spatial',
        not: false,
        operator: 'near',
        layer: 'strassen',
        distance_m: 500,
        filter: null,
      },
      {
        id: 'g',
        kind: 'group',
        op: 'or',
        not: false,
        children: [
          {
            id: 's2',
            kind: 'spatial',
            not: false,
            operator: 'in',
            layer: 'gemeinden',
            distance_m: null,
            filter: null,
          },
        ],
      },
    ],
  }
  const table: TableState = {
    ...emptyTable(),
    tab: 'd1',
    sort: { d1: [{ attr: 'name', dir: 'asc' }], schulen: [] },
  }
  const { saved, removed } = reconcile(
    { analysis: analysis(tree), table, view: null },
    new Set(['schulen', 'gemeinden']),
  )
  // The road layer is gone, and with it the buffer derived from it.
  expect(removed.layers.map((l) => l.id)).toEqual(['strassen', 'd1'])
  expect(removed.rows.map((r) => r.id)).toEqual(['s1'])
  expect(removed.result).toBe(false)
  expect(saved.analysis.layers.map((l) => l.id)).toEqual(['schulen', 'gemeinden'])
  expect(saved.analysis.tree.children.map((n) => n.id)).toEqual(['a', 'g'])
  expect(saved.table).toEqual({ ...emptyTable(), tab: null, sort: { schulen: [] } })
})

test('without the result layer the session opens without a result', () => {
  const { saved, removed } = reconcile(
    { analysis: analysis(emptyTree()), table: emptyTable(), view: null },
    new Set(['strassen', 'gemeinden']),
  )
  expect(removed.result).toBe(true)
  expect(saved.analysis.result).toBeNull()
})
