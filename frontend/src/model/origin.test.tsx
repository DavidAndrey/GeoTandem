// Origin mark "Modell" (plan P3, design M15): stamped when a model query is
// applied, gone after a hand edit of that row only, never saved.
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AttributeRow, Group, Node, Row, SpatialRow } from '../analysis/model'
import { useAnalysis } from '../analysis/store'
import { newAttributeRow, rows } from '../analysis/tree'
import { saveQueryAs } from '../queries/actions'
import { saveSessionAs } from '../session/actions'
import { attribute, layer } from '../test/fixtures'
import { actionView } from '../test/model-mocks'
import { fakeApi, renderAt } from '../test/render'
import { applied, discarded, isMarked, NO_ORIGIN, stamp, touch } from './origin'
import { readQuery, type ReadNode } from './readable'
import { AnalysisConditions } from './tree'

const store = () => useAnalysis.getState()

/** The reference answer's conditions as editor rows (all three have a row form). */
function referenceTree(): Group {
  const asNode = (node: ReadNode): Node => {
    if (node.kind === 'opaque' || node.kind === 'within') throw new Error(`no row: ${node.id}`)
    return node.kind === 'group' ? { ...node, children: node.children.map(asNode) } : node
  }
  return asNode(readQuery(actionView('reference').query).tree) as Group
}

/** What applying the model's query does (WP67/WP80 call these two). */
function applyModelQuery() {
  store().applyQuery({ result: 'schulen', tree: referenceTree(), restriction: null }, null)
  store().markOrigin()
}

const current = () => rows(store().draft ?? store().tree)
const marked = () => current().filter((row) => isMarked(store().origin, row))
function near(): SpatialRow {
  const found = current().find(
    (r): r is SpatialRow => r.kind === 'spatial' && r.operator === 'near',
  )
  if (!found) throw new Error('no "near" row')
  return found
}

beforeEach(() => store().reset())
afterEach(() => vi.unstubAllGlobals())

describe('pure', () => {
  test('stamp, touch, apply, discard', () => {
    const tree = referenceTree()
    const [first, second] = rows(tree) as [Row, Row]
    const origin = stamp(NO_ORIGIN, tree)
    expect(rows(tree).every((row) => isMarked(origin, row))).toBe(true)

    const touched = touch(origin, tree, second.id, { not: true })
    expect(isMarked(touched, second)).toBe(false)
    expect(isMarked(touched, first)).toBe(true)
    // A patch that changes nothing, or an edit of a group, touches nothing.
    expect(touch(origin, tree, second.id, { not: false })).toBe(origin)
    expect(touch(origin, tree, tree.id, { op: 'or' })).toBe(origin)

    expect(applied(touched, tree).marks).toEqual({
      [first.id]: true,
      [(rows(tree)[2] as Row).id]: true,
    })
    expect(discarded(touched, tree)).toEqual(origin)
    expect(discarded(origin, { ...tree, children: [first] }).marks).toEqual({ [first.id]: true })
  })

  test('only the named rows are stamped; stamping again clears a touch', () => {
    const tree = referenceTree()
    const [first] = rows(tree) as [Row]
    expect(Object.keys(stamp(NO_ORIGIN, tree, [first.id]).marks)).toEqual([first.id])
    const touched = touch(stamp(NO_ORIGIN, tree), tree, first.id, { values: ['x'] })
    expect(isMarked(stamp(touched, tree, [first.id]), first)).toBe(true)
  })
})

describe('lifecycle in the analysis store', () => {
  test('stamped on apply, for every condition of the model query', () => {
    applyModelQuery()
    expect(marked()).toHaveLength(3)
  })

  test('a mark is no change of the analysis of its own', () => {
    store().applyQuery({ result: 'schulen', tree: referenceTree(), restriction: null }, null)
    store().markSaved()
    store().markOrigin()
    expect(marked()).toHaveLength(3)
    expect(store().dirty).toBe(false)
  })

  test('a hand edit of one row drops its mark only; the others keep theirs (M15.2)', () => {
    applyModelQuery()
    store().edit()
    store().editNode<SpatialRow>(near().id, { distance_m: 300 })
    expect(marked()).toHaveLength(2)
    expect(isMarked(store().origin, near())).toBe(false)
    store().apply()
    expect(marked()).toHaveLength(2)

    // Back to the model's value by hand: still the user's row.
    store().edit()
    store().editNode<SpatialRow>(near().id, { distance_m: 500 })
    store().apply()
    expect(marked()).toHaveLength(2)
  })

  test('changed and changed back within one draft is still a hand edit (P3)', () => {
    applyModelQuery()
    store().edit()
    store().editNode<SpatialRow>(near().id, { distance_m: 300 })
    store().editNode<SpatialRow>(near().id, { distance_m: 500 })
    expect(isMarked(store().origin, near())).toBe(false)
    store().apply()
    expect(marked()).toHaveLength(2)
  })

  const PATCHES: [string, Partial<AttributeRow>][] = [
    ['field', { attr: 'name' }],
    ['operator', { operator: 'eq', value: 'primar', values: [] }],
    ['value', { values: ['sekundar'] }],
    ['negation', { not: true }],
  ]
  test.each(PATCHES)('editing the %s of a condition is a hand edit', (_, patch) => {
    applyModelQuery()
    const typ = current().find((r) => r.kind === 'attribute')
    if (!typ) throw new Error('no attribute row')
    store().edit()
    store().editNode<AttributeRow>(typ.id, patch)
    store().apply()
    expect(marked().map((r) => r.id)).not.toContain(typ.id)
    expect(marked()).toHaveLength(2)
  })

  test('"Verwerfen" restores the mark with the row', () => {
    applyModelQuery()
    store().edit()
    store().editNode<SpatialRow>(near().id, { distance_m: 300 })
    store().discard()
    expect(marked()).toHaveLength(3)
  })

  test('group edits, new and removed rows leave the other marks alone', () => {
    applyModelQuery()
    const [first] = current() as [Row]
    store().edit()
    store().editNode<Group>('root', { op: 'or' })
    store().addNode('root', newAttributeRow('name'))
    store().removeNode(first.id)
    store().apply()
    expect(current()).toHaveLength(3)
    expect(marked()).toHaveLength(2)
    expect(Object.keys(store().origin.marks)).toHaveLength(2)
  })

  test('a saved query, a session opened or a new session bring no marks', () => {
    applyModelQuery()
    store().applyQuery({ result: 'schulen', tree: referenceTree(), restriction: null }, null)
    expect(store().origin).toEqual(NO_ORIGIN)

    applyModelQuery()
    const { layers, result, tree, restriction } = store()
    store().load({ layers, result, tree, restriction })
    expect(marked()).toHaveLength(0)

    applyModelQuery()
    store().reset()
    expect(store().origin).toEqual(NO_ORIGIN)
  })
})

describe('never saved: the real save paths send no mark', () => {
  /** The request bodies of two saves, with marks and after the marks are gone. */
  async function bodies(save: () => Promise<unknown>, calls: { body: unknown }[]) {
    applyModelQuery()
    expect(marked()).toHaveLength(3)
    await save()
    useAnalysis.setState({ origin: NO_ORIGIN })
    await save()
    return calls.map((c) => JSON.stringify(c.body))
  }
  const echo = (patch: object) => (init: RequestInit | undefined) => ({
    ...(JSON.parse(String(init?.body)) as object),
    ...patch,
  })

  test('saving a session (design C2)', async () => {
    const calls = fakeApi({
      'POST /api/sessions': echo({ id: 's1', updated_at: '2026-10-10T14:06:00Z', stamp: null }),
    })
    const [withMarks, without] = await bodies(() => saveSessionAs('Schulen', ''), calls)
    expect(calls.map((c) => c.key)).toEqual(['POST /api/sessions', 'POST /api/sessions'])
    expect(withMarks).toBe(without)
    expect(withMarks).not.toMatch(/origin|marks|touched|Modell/)
  })

  test('saving a query (design B1)', async () => {
    const calls = fakeApi({ 'POST /api/queries': echo({ id: 'q1', mine: true, owner: 'admin' }) })
    const [withMarks, without] = await bodies(() => saveQueryAs('Primarschulen', false), calls)
    expect(calls.map((c) => c.key)).toEqual(['POST /api/queries', 'POST /api/queries'])
    expect(withMarks).toBe(without)
    expect(withMarks).not.toMatch(/origin|marks|touched|Modell/)
  })
})

describe('shown in the tree', () => {
  const layers = [
    layer({
      name: 'schulen',
      title: 'Schulen',
      geometry_type: 'Point',
      attributes: [attribute({ name: 'typ', label: 'Schulstufe', data_type: 'text' })],
    }),
    layer({ name: 'strassen', title: 'Strassen', geometry_type: 'LineString' }),
    layer({ name: 'gemeinden_steuern', title: 'Gemeinden · Steuern' }),
  ]

  test('"Modell" per condition until that row is edited by hand', async () => {
    fakeApi({ 'GET /api/layers': layers })
    applyModelQuery()
    renderAt('/', <AnalysisConditions />)
    const tree = screen.getByRole('group', { name: 'Bedingungen' })
    await waitFor(() =>
      expect(within(tree).getByText(/Schulstufe ist eins von primar/)).toBeVisible(),
    )
    expect(within(tree).getAllByText('Modell')).toHaveLength(3)

    act(() => {
      store().edit()
      store().editNode<SpatialRow>(near().id, { distance_m: 300 })
    })
    expect(within(tree).getAllByText('Modell')).toHaveLength(2)
    const edited = within(tree).getByText(/≤ 300 m zu Strassen/)
    expect(within(edited.parentElement as HTMLElement).queryByText('Modell')).toBeNull()
  })
})
