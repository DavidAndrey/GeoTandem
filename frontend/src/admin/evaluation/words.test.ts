// The small rules of the case pages: readings, layers, the body sent, ids and
// the refusal words; the reference an analysis gives (V3).
import { expect, test } from 'vitest'
import type { Analysis } from '../../analysis/model'
import { ApiRequestError, type LayerInfo } from '../../api/client'
import { caseView } from '../../test/eval-mocks'
import { attribute, layer } from '../../test/fixtures'
import { referenceFor } from './reference'
import {
  caseBody,
  caseErrorText,
  idFrom,
  idProblem,
  layersOf,
  readings,
  referenceOf,
  tagText,
  withReadings,
} from './words'

test('readings are the reference or the fair readings; one reading is gold again', () => {
  const doc1 = caseView('doc1-primar-koeniz').case
  expect(readings(doc1)).toHaveLength(2)
  const one = withReadings(doc1, readings(doc1).slice(0, 1))
  expect(one.gold).toEqual(doc1.gold_any?.[0])
  expect(one.gold_any).toBeNull()
  expect(readings(caseView('n15-je-gemeinde').case)).toEqual([])
})

test('the layers a query names, without the keys of a symbology', () => {
  expect(
    layersOf({
      source: 'kitas',
      where: { op: 'related', layer: 'haltestellen', where: { op: 'is_null', attr: 'x' } },
      symbology: { field: 'layer', values: { source: 'nope' } },
    }),
  ).toEqual(['haltestellen', 'kitas'])
})

test('a reference keeps source and conditions only', () => {
  expect(
    referenceOf({
      schema_version: '2',
      output: 'map',
      source: 's',
      where: { op: 'x' },
      symbology: {},
    }),
  ).toEqual({ source: 's', where: { op: 'x' } })
})

test('the body of a case has no null fields and no empty defaults', () => {
  const body = caseBody({ ...caseView('e-turnhalle-ostermundigen').case, gold_any: null, note: '' })
  expect(Object.keys(body).sort()).toEqual(
    [
      'data_state',
      'gold',
      'id',
      'layers',
      'origin',
      'prompt',
      'schema_version',
      'split',
      'tags',
    ].sort(),
  )
})

test('an id from a question, and what an id may be', () => {
  expect(idFrom('Schulen über 2 km – in Köniz?')).toBe('e-schulen-ueber-2-km-in-koeniz')
  expect(idFrom('???')).toBe('')
  expect(idProblem('e-ok.1')).toBeNull()
  expect(idProblem('Gross')).not.toBeNull()
  expect(idProblem('export')).not.toBeNull()
})

test('tags of the start set in words, others as written', () => {
  expect(tagText('spatial')).toBe('räumlich')
  expect(tagText('paraphrase:muensingen')).toBe('paraphrase:muensingen')
})

test('a refusal of a case names the reason the check gave', () => {
  const refused = (details: Record<string, unknown>) =>
    caseErrorText(new ApiRequestError(400, { code: 'case_invalid', message: 'x', details }))
  expect(refused({ case_id: 'e', reason: 'unknown_layer', layer: 'kitas' })).toBe(
    'Den Layer „kitas" gibt es nicht oder er ist nicht sichtbar.',
  )
  expect(refused({ case_id: 'e', reason: 'limit_exceeded' })).toMatch(/höchstens 8/)
  expect(refused({ case_id: 'e', reason: 'layer_not_listed' })).toMatch(
    /Der Prüffall „e" passt nicht/,
  )
})

const catalog: LayerInfo[] = [
  layer({
    name: 'schulen',
    geometry_type: 'Point',
    attributes: [attribute({ name: 'typ', data_type: 'text' })],
  }),
]

const on = (tree: Analysis['tree'], patch: Partial<Analysis> = {}): Analysis => ({
  layers: [
    {
      id: 'schulen',
      source: { kind: 'catalog', layer: 'schulen' },
      visible: true,
      opacity: 1,
      symbology: null,
    },
  ],
  result: 'schulen',
  tree,
  restriction: null,
  ...patch,
})

const row = (id: string) => ({
  id,
  kind: 'attribute' as const,
  not: false,
  attr: 'typ',
  operator: 'eq' as const,
  value: 'primar',
  min: null,
  max: null,
  values: [],
})

test('the reference of an analysis, or why it cannot be one (V3.2)', () => {
  const root = (n: number): Analysis['tree'] => ({
    id: 'root',
    kind: 'group',
    op: 'and',
    not: false,
    children: Array.from({ length: n }, (_, i) => row(`r${i}`)),
  })
  expect(referenceFor(on(root(1)), catalog)).toEqual({
    gold: { source: 'schulen', where: { op: 'compare', attr: 'typ', cmp: 'eq', value: 'primar' } },
    problem: null,
  })
  expect(referenceFor(on(root(9)), catalog).problem).toMatch(/9 Bedingungen/)
  expect(referenceFor(on(root(1), { result: null }), catalog).problem).toMatch(/Ergebnis-Layer/)
  expect(
    referenceFor(on(root(1), { restriction: { kind: 'view', bbox: [0, 0, 1, 1] } }), catalog)
      .problem,
  ).toMatch(/Nur in/)
  // A layer the controls do not know: the query cannot be shown, so it cannot be a reference.
  expect(referenceFor(on(root(1)), []).problem).toMatch(/nicht vollständig darstellen/)
})
