import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { resultQuery } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { attribute, layer, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { assertValidQuery } from '../test/schema'

const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  attributes: [
    attribute({
      name: 'typ',
      data_type: 'text',
      label: 'Schulstufe',
      value_domain: { codes: { primar: 'primar', sekundar: 'sekundar' } },
    }),
    attribute({ name: 'schueler', data_type: 'integer', label: 'Schülerzahl' }),
  ],
})
const strassen = layer({
  name: 'strassen',
  title: 'Strassen',
  geometry_type: 'LineString',
  attributes: [attribute({ name: 'klasse', data_type: 'text', label: 'Klasse' })],
})
const kitas = layer({ name: 'kitas', title: 'Kitas', geometry_type: 'Point', attributes: [] })

beforeEach(() => {
  useAnalysis.getState().reset()
  useAnalysis.getState().addLayer('schulen')
  useAnalysis.getState().addLayer('kitas', false)
})
afterEach(() => vi.unstubAllGlobals())

function backend() {
  return fakeApi({
    ...signedIn({ role: 'user', username: 'm.keller' }),
    'GET /api/layers': [schulen, strassen, kitas],
    'GET /api/config/map': { basemap: null, extent_wgs84: [7.8, 46.8, 8, 47], max_features: 10000 },
    'POST /api/query': { type: 'FeatureCollection', features: [], query: {}, meta: {} },
    'POST /api/query/count': (init) => {
      const { queries } = JSON.parse(String(init?.body)) as { queries: unknown[] }
      return { counts: queries.map((_, i) => (i === 1 ? 120 : 24)) }
    },
  })
}

test('an attribute and a spatial condition become one valid query (B2)', async () => {
  const calls = backend()
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: '+ Bedingung' }))
  const editor = await screen.findByRole('region', { name: 'Abfrage-Editor' })

  const row = within(editor).getByRole('group', { name: 'Bedingung Attribut' })
  await userEvent.selectOptions(within(row).getByLabelText('Feld'), 'Schulstufe')
  await userEvent.selectOptions(within(row).getByLabelText('Operator'), 'ist eins von')
  await userEvent.type(within(row).getByLabelText('Wert hinzufügen'), 'primar{Enter}')
  await waitFor(() =>
    expect(within(row).getByLabelText('Treffer dieser Bedingung')).toHaveTextContent('24'),
  )

  await userEvent.click(
    within(editor).getAllByRole('button', { name: 'Bedingung' })[0] as HTMLElement,
  )
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Raum' }))
  const spatial = within(editor).getByRole('group', { name: 'Bedingung Raum' })
  await userEvent.selectOptions(within(spatial).getByLabelText('Beziehung'), '≤ Distanz zu')
  await userEvent.type(within(spatial).getByLabelText('Distanz in Metern'), '500')
  await userEvent.selectOptions(within(spatial).getByLabelText('Bezugslayer'), 'Strassen')
  await userEvent.click(within(spatial).getByRole('button', { name: '+ Filter' }))
  await userEvent.type(within(spatial).getByLabelText('Wert'), 'haupt')

  await userEvent.click(within(editor).getByRole('button', { name: 'Übernehmen' }))
  expect(screen.queryByRole('region', { name: 'Abfrage-Editor' })).not.toBeInTheDocument()

  const query = resultQuery(currentAnalysis(useAnalysis.getState()))
  assertValidQuery(query)
  expect(query?.where).toEqual({
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
    ],
  })
  const summary = screen.getByLabelText('Bedingungen (Übersicht)')
  expect(summary).toHaveTextContent('Schulstufe ist eins von primar')
  expect(summary).toHaveTextContent('≤ 500 m zu Strassen (Klasse = haupt)')

  // Every query the interface sent on the way is valid.
  for (const call of calls.filter((c) => c.key.startsWith('POST /api/query'))) {
    const body = call.body as { queries?: unknown[] }
    for (const q of body.queries ?? [body]) assertValidQuery(q)
  }
})

test('Verwerfen restores the previous state', async () => {
  backend()
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: '+ Bedingung' }))
  const editor = await screen.findByRole('region', { name: 'Abfrage-Editor' })
  await userEvent.click(within(editor).getByRole('button', { name: 'Verwerfen' }))
  expect(useAnalysis.getState().tree.children).toEqual([])
  expect(screen.getByText(/Keine Bedingung/)).toBeInTheDocument()
})

test('switching the result layer asks when attribute conditions drop out (B13)', async () => {
  backend()
  useAnalysis.getState().edit()
  useAnalysis.getState().addNode('root', {
    id: 'a1',
    kind: 'attribute',
    not: false,
    attr: 'typ',
    operator: 'eq',
    value: 'primar',
    min: null,
    max: null,
    values: [],
  })
  useAnalysis.getState().apply()
  renderAt('/', <App />)
  await screen.findByRole('option', { name: 'Kitas' })
  await userEvent.selectOptions(screen.getByLabelText('Ergebnis-Layer'), 'Kitas')
  const dialog = await screen.findByRole('alertdialog', { name: 'Ergebnis-Layer wechseln?' })
  expect(dialog).toHaveTextContent('Eine Attribut-Bedingung bezieht sich')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Wechseln' }))
  expect(useAnalysis.getState().result).toBe('kitas')
  expect(useAnalysis.getState().tree.children).toEqual([])
})
