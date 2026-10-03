import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { useAnalysis } from '../analysis/store'
import { newAttributeRow } from '../analysis/tree'
import { newSession } from '../session/actions'
import { useSessionUi } from '../session/ui'
import { layer, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { assertValidQuery } from '../test/schema'
import { useQueryUi } from './ui'

const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  feature_count: 3,
})
const kitas = layer({ name: 'kitas', title: 'Kitas', geometry_type: 'Point', feature_count: 5 })
const primary = {
  id: 'a1',
  kind: 'attribute',
  not: false,
  attr: 'typ',
  operator: 'in',
  value: null,
  min: null,
  max: null,
  values: ['primar'],
}

function summary(id: string, name: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    name,
    owner: 'admin',
    mine: true,
    shared: false,
    result_layer: 'schulen',
    conditions: { attribute: 1, spatial: 2, restriction: false },
    query: { schema_version: '2', source: 'schulen' },
    created_at: '2026-10-03T12:00:00',
    updated_at: '2026-10-03T12:00:00',
    ...patch,
  }
}

function detail(id: string, name: string, patch: Record<string, unknown> = {}) {
  return {
    ...summary(id, name, patch),
    state_version: 1,
    state: {
      result: 'schulen',
      tree: { id: 'root', kind: 'group', op: 'and', not: false, children: [primary] },
      restriction: null,
    },
  }
}

function backend(routes: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': [schulen, kitas],
    'GET /api/config/map': {
      basemap: null,
      extent_wgs84: [7.3, 46.9, 7.5, 47],
      max_features: 10000,
    },
    'POST /api/query': { type: 'FeatureCollection', features: [], query: {}, meta: {} },
    'POST /api/query/count': (init) => ({
      counts: JSON.parse(String(init?.body)).queries.map(() => 2),
    }),
    'GET /api/sessions': [],
    'GET /api/sessions/last': () => null,
    'GET /api/queries': [],
    ...routes,
  })
}

beforeEach(() => {
  newSession()
  useSessionUi.setState({ landed: true, dialog: null, guard: null })
  useQueryUi.setState({ dialog: null, pending: null, message: null })
  useAnalysis.getState().addLayer('schulen')
})
afterEach(() => vi.unstubAllGlobals())

const menu = () => screen.getByRole('button', { name: 'Gespeicherte Abfragen' })

test('a query is saved under a name, shared if wanted (design B1)', async () => {
  const s = useAnalysis.getState()
  s.edit()
  s.addNode('root', { ...newAttributeRow('typ'), operator: 'in', values: ['primar'] })
  s.apply()
  const calls = backend({
    'POST /api/queries': (init) => {
      const body = JSON.parse(String(init?.body))
      return detail('q1', body.name, { shared: body.shared })
    },
  })
  renderAt('/', <App />)
  expect(await screen.findByRole('button', { name: 'Gespeicherte Abfragen' })).toHaveTextContent(
    'Nicht gespeichert',
  )
  await userEvent.click(menu())
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Speichern' }))
  const dialog = await screen.findByRole('dialog', { name: 'Abfrage speichern' })
  expect(within(dialog).getByText(/Ziel Schulen · 1 Bedingungen/)).toBeInTheDocument()
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Primarschulen')
  await userEvent.click(within(dialog).getByRole('checkbox', { name: /Geteilt/ }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }))
  await waitFor(() => expect(menu()).toHaveTextContent('Primarschulen'))

  const sent = calls.find((c) => c.key === 'POST /api/queries')?.body as {
    shared: boolean
    state: { result: string; tree: { children: unknown[] } }
    query: unknown
  }
  expect(sent.shared).toBe(true)
  expect(sent.state.result).toBe('schulen')
  expect(sent.state.tree.children).toHaveLength(1)
  assertValidQuery(sent.query)
  // Changing it afterwards shows; saving again overwrites the own query.
  useAnalysis.getState().setRestriction({ kind: 'view', bbox: [7.3, 46.9, 7.5, 47] })
  await waitFor(() => expect(menu()).toHaveTextContent('geändert'))
})

test('a shared query of someone else opens and is saved as an own copy (design C6)', async () => {
  const theirs = detail('q9', 'Primarschulen', { mine: false, shared: true, owner: 'm.keller' })
  const calls = backend({
    'GET /api/queries': [
      summary('q9', 'Primarschulen', { mine: false, shared: true, owner: 'm.keller' }),
    ],
    'GET /api/queries/q9': theirs,
    'POST /api/queries': (init) => detail('q10', JSON.parse(String(init?.body)).name),
  })
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Gespeicherte Abfragen' }))
  const item = await screen.findByRole('menuitem', { name: /Primarschulen/ })
  expect(item).toHaveTextContent('geteilt von m.keller')
  expect(item).toHaveTextContent('2') // its hit count
  await userEvent.click(item)
  await waitFor(() => expect(menu()).toHaveTextContent('Primarschulen'))
  expect(useAnalysis.getState().tree.children).toHaveLength(1)

  await userEvent.click(menu())
  const save = await screen.findByRole('menuitem', { name: /^Speichern\s*als Kopie/ })
  await userEvent.click(save)
  const dialog = await screen.findByRole('dialog', { name: 'Abfrage speichern' })
  expect(dialog).toHaveTextContent('gehört jemand anderem')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }))
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/queries')).toBe(true))
  expect(calls.some((c) => c.key === 'PUT /api/queries/q9')).toBe(false)
})

test('choosing a query asks before replacing unsaved conditions (design B1)', async () => {
  const s = useAnalysis.getState()
  s.edit()
  s.addNode('root', newAttributeRow('name'))
  s.apply()
  backend({
    'GET /api/queries': [summary('q1', 'Primarschulen')],
    'GET /api/queries/q1': detail('q1', 'Primarschulen'),
  })
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Gespeicherte Abfragen' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: /Primarschulen/ }))
  const ask = await screen.findByRole('alertdialog', { name: 'Aktuelle Abfrage ersetzen?' })
  await userEvent.click(within(ask).getByRole('button', { name: 'Ersetzen' }))
  await waitFor(() => expect(menu()).toHaveTextContent('Primarschulen'))
  expect(useAnalysis.getState().tree.children.map((n) => n.id)).toEqual(['a1'])
})

test('the list shares own queries and asks before deleting a used one (design C6)', async () => {
  const calls = backend({
    'GET /api/queries': [
      summary('q1', 'Primarschulen'),
      summary('q2', 'Kitas nah', {
        mine: false,
        shared: true,
        owner: 'm.keller',
        result_layer: 'kitas',
        conditions: { attribute: 0, spatial: 1, restriction: false },
      }),
    ],
    'PATCH /api/queries/q1': summary('q1', 'Primarschulen', { shared: true }),
    'GET /api/queries/q1/usage': { sessions: 2 },
    'DELETE /api/queries/q1': () => new Response(null, { status: 204 }),
  })
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Gespeicherte Abfragen' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Verwalten …' }))
  const table = await screen.findByRole('table', { name: 'Gespeicherte Abfragen' })
  const theirs = within(table).getByText('Kitas nah').closest('tr') as HTMLElement
  expect(within(theirs).getByText('1 R')).toBeInTheDocument()
  expect(within(theirs).getByText('von m.keller')).toBeInTheDocument()
  expect(within(theirs).getByRole('checkbox', { name: 'Kitas nah teilen' })).toBeDisabled()

  await userEvent.click(within(table).getByRole('checkbox', { name: 'Primarschulen teilen' }))
  await waitFor(() => expect(calls.some((c) => c.key === 'PATCH /api/queries/q1')).toBe(true))

  const mine = within(table).getByText('Primarschulen').closest('tr') as HTMLElement
  await userEvent.click(within(mine).getByRole('button', { name: 'Aktionen für Primarschulen' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Löschen' }))
  const ask = await screen.findByRole('alertdialog')
  expect(await within(ask).findByText(/in 2 Sitzungen verwendet/)).toBeInTheDocument()
  await userEvent.click(within(ask).getByRole('button', { name: 'Löschen' }))
  await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /api/queries/q1')).toBe(true))
})
