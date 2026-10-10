// The readable query of an answer (design M2, M5): the reference question in
// plain language, JSON only under "Technisch", and what has no row form.
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Group } from '../analysis/model'
import { activate } from '../i18n/i18n'
import { messages as pseudo } from '../locales/pseudo.po'
import { attribute, layer } from '../test/fixtures'
import { actionView, type CaseId } from '../test/model-mocks'
import { strays } from '../test/pseudo'
import { fakeApi, renderAt } from '../test/render'
import { stamp } from './origin'
import { readCondition, readQuery } from './readable'
import { ConditionTree, QueryTree } from './tree'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const LAYERS = [
  layer({
    name: 'schulen',
    title: 'Schulen',
    geometry_type: 'Point',
    attributes: [attribute({ name: 'typ', label: 'Schulstufe', data_type: 'text' })],
  }),
  layer({
    name: 'strassen',
    title: 'Strassen',
    geometry_type: 'LineString',
    attributes: [attribute({ name: 'klasse', label: 'Strassenklasse', data_type: 'text' })],
  }),
  layer({
    name: 'gemeinden_steuern',
    title: 'Gemeinden · Steuern',
    attributes: [attribute({ name: 'steueranlage', label: 'Steueranlage', data_type: 'real' })],
  }),
]

const reference = () => actionView('reference').query

/** The query as the model wrote it, also when the record refused it (M3). */
function rawQuery(id: CaseId): unknown {
  const answer = actionView(id).answer
  return answer?.kind === 'query' ? answer.query : null
}

/** Renders and checks in pseudo throughout: data arrives after the first render. */
async function inPseudoLocale(check: () => Promise<void>) {
  activate('pseudo', pseudo)
  try {
    await check()
  } finally {
    // The provider re-renders on the switch back: unmount first.
    cleanup()
    activate('de')
  }
}

describe('readQuery', () => {
  test('the reference question reads as three rows', () => {
    const read = readQuery(reference())
    expect(read.source).toBe('schulen')
    expect(read.extra).toEqual([])
    expect(read.tree.op).toBe('and')
    expect(read.tree.children.map((n) => n.kind)).toEqual(['attribute', 'spatial', 'spatial'])
    expect(read.tree.children[1]).toMatchObject({
      operator: 'near',
      layer: 'strassen',
      distance_m: 500,
      filter: { attr: 'klasse', operator: 'eq', value: 'kantonsstrasse_b' },
    })
    expect(read.tree.children[2]).toMatchObject({
      operator: 'in',
      layer: 'gemeinden_steuern',
      filter: { attr: 'steueranlage', operator: 'gt', value: 1.6 },
    })
  })

  test('negations read as the editor names them (schema v1)', () => {
    const related = { op: 'related', layer: 'strassen', predicate: 'within' }
    const near = { op: 'related', layer: 'strassen', predicate: 'dwithin', distance_m: 20 }
    expect(readCondition({ op: 'not', arg: related }, 'x')).toMatchObject({ operator: 'outside' })
    expect(readCondition({ op: 'not', arg: near }, 'x')).toMatchObject({ operator: 'far' })
    expect(readCondition({ op: 'not', arg: { op: 'is_null', attr: 'a' } }, 'x')).toMatchObject({
      operator: 'is_empty',
      not: true,
    })
    expect(
      readCondition({ op: 'not', arg: { op: 'or', args: [{ op: 'is_null', attr: 'a' }] } }, 'x'),
    ).toMatchObject({ kind: 'group', op: 'or', not: true })
  })

  test('what has no row form stays JSON, never guessed', () => {
    // A refused answer's query is kept as the model wrote it (M3).
    const read = readQuery(rawQuery('model_query_invalid'))
    expect(read.tree.children).toEqual([
      { id: 'q0', kind: 'opaque', json: '{"op":"near","layer":"gewaesser","name":"Aare"}' },
    ])
    expect(readCondition({ op: 'related', layer: 'x', predicate: 'dwithin' }, 'y').kind).toBe(
      'opaque',
    )
    expect(readCondition('nonsense', 'z').kind).toBe('opaque')
    expect(readQuery(null).tree.children).toEqual([])
  })

  test('parts beyond the conditions are named for "Technisch" (M3.3)', () => {
    const read = readQuery(rawQuery('not_representable'))
    expect(read.extra).toEqual(['order_by', 'limit'])
    expect(read.tree.children).toEqual([])
  })
})

describe('QueryTree', () => {
  test('the reference question in plain language, JSON under "Technisch"', async () => {
    fakeApi({ 'GET /api/layers': LAYERS })
    renderAt('/', <QueryTree query={reference()} line="dashed" />)
    expect(await screen.findByText('Abfrage · Ergebnis Schulen')).toBeVisible()
    const tree = screen.getByRole('group', { name: 'Bedingungen' })
    expect(tree.className).toMatch(/border-dashed/)
    expect(within(tree).getByText('UND')).toBeVisible()
    const lines = within(tree)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(lines).toEqual([
      'Schulstufe ist eins von primar',
      '≤ 500 m zu Strassen (Strassenklasse = kantonsstrasse_b)',
      expect.stringMatching(/^liegt in Gemeinden · Steuern \(Steueranlage > 1[.,]6\)$/),
    ])
    // The answer shows no origin marks: those belong to the applied analysis.
    expect(within(tree).queryByText('Modell')).toBeNull()

    // Closed until asked for.
    const technical = screen.getByText('Technisch (Abfrageobjekt JSON)').closest('details')
    expect(technical).not.toHaveAttribute('open')
    expect(JSON.parse(technical?.querySelector('pre')?.textContent ?? '')).toEqual(reference())
  })

  test('without the catalog it falls back to the names', () => {
    fakeApi({})
    renderAt('/', <QueryTree query={reference()} />)
    expect(screen.getByText('Abfrage · Ergebnis schulen')).toBeVisible()
    expect(screen.getByText('typ ist eins von primar')).toBeVisible()
  })

  test('a query beyond the controls says so', () => {
    fakeApi({ 'GET /api/layers': LAYERS })
    renderAt('/', <QueryTree query={rawQuery('not_representable')} />)
    expect(screen.getByText('Keine Bedingung: alle Objekte sind Treffer.')).toBeVisible()
    expect(screen.getByText('Ausserdem, nur unter „Technisch“: order_by, limit')).toBeVisible()
  })

  test('in pseudo, every word comes from the catalog', async () => {
    fakeApi({ 'GET /api/layers': LAYERS })
    const query = reference()
    const data = [
      'Schulen',
      'Schulstufe',
      'primar',
      'Strassen',
      'Strassenklasse',
      'kantonsstrasse_b',
      'Gemeinden · Steuern',
      'Steueranlage',
      JSON.stringify(query, null, 2),
    ]
    await inPseudoLocale(async () => {
      renderAt('/', <QueryTree query={query} />)
      await waitFor(() => expect(screen.getAllByText(/Strassenklasse/)).toHaveLength(1))
      expect(strays(data)).toEqual([])
    })
  })
})

describe('ConditionTree with marks', () => {
  test('the mark shows on the rows it holds (M15.1)', async () => {
    fakeApi({ 'GET /api/layers': LAYERS })
    const tree = readQuery(reference()).tree
    const [first] = tree.children
    const marks = stamp({}, { ...tree, children: first ? [first] : [] } as Group)
    renderAt('/', <ConditionTree source="schulen" tree={tree} marks={marks} />)
    await screen.findByText('Schulstufe ist eins von primar')
    const marked = screen.getAllByText('Modell')
    expect(marked).toHaveLength(1)
    expect(marked[0]?.parentElement).toHaveTextContent('ModellSchulstufe ist eins von primar')
  })

  test('in pseudo, the mark comes from the catalog', async () => {
    fakeApi({ 'GET /api/layers': LAYERS })
    const tree = readQuery(reference()).tree
    const marks = stamp({}, tree as Group)
    const data = ['Schulstufe', 'primar', 'Strassen', 'Strassenklasse', 'kantonsstrasse_b']
    await inPseudoLocale(async () => {
      renderAt('/', <ConditionTree source="schulen" tree={tree} marks={marks} />)
      await waitFor(() => expect(screen.getAllByText(/Strassenklasse/)).toHaveLength(1))
      expect(strays([...data, 'Gemeinden · Steuern', 'Steueranlage'])).toEqual([])
    })
  })
})
