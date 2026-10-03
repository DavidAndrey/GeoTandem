import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { useAnalysis } from '../analysis/store'
import { newSession } from '../session/actions'
import { useSessionUi } from '../session/ui'
import { useSelection } from '../table/selection'
import { attribute, layer, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { assertValidQuery } from '../test/schema'
import { searchQuery } from './search'
import { useMapView } from './view'

const gewaesser = layer({
  name: 'gewaesser',
  title: 'Gewässer',
  geometry_type: 'LineString',
  attributes: [attribute({ name: 'name', data_type: 'text', label: 'Name' })],
})
const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  attributes: [attribute({ name: 'name', data_type: 'text', label: 'Name' })],
})
const tabelle = layer({
  name: 'daten',
  title: 'Daten',
  kind: 'table',
  geometry_type: null,
  attributes: [attribute({ name: 'name', data_type: 'text' })],
})

const line = (id: number, name: string) => ({
  type: 'Feature',
  id,
  properties: { name },
  geometry: {
    type: 'LineString',
    coordinates: [
      [7.4, 46.9],
      [7.5, 47.0],
    ],
  },
})
const point = (id: number, name: string) => ({
  type: 'Feature',
  id,
  properties: { name },
  geometry: { type: 'Point', coordinates: [7.45, 46.95] },
})

function backend() {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': [gewaesser, schulen, tabelle],
    'GET /api/config/map': {
      basemap: null,
      extent_wgs84: [7.3, 46.9, 7.5, 47],
      max_features: 10000,
    },
    'GET /api/sessions': [],
    'GET /api/sessions/last': () => null,
    'GET /api/queries': [],
    'POST /api/query/count': { counts: [1, 1] },
    'POST /api/query': (init) => {
      const query = JSON.parse(String(init?.body))
      assertValidQuery(query)
      const text = query.where?.text
      const features =
        query.source === 'gewaesser' && text === 'änggi'
          ? [line(7, 'Änggisteibach')]
          : query.source === 'schulen' && text === 'bümpliz'
            ? [point(3, 'Bern Bümpliz/Höhe')]
            : []
      return { type: 'FeatureCollection', features, query, meta: {} }
    },
  })
}

beforeEach(() => {
  newSession()
  useSessionUi.setState({ landed: true })
  useMapView.setState({ found: null, featureRequest: null })
  useSelection.getState().clear()
})
afterEach(() => vi.unstubAllGlobals())

test('the search query is a case-insensitive text condition with a limit', () => {
  const query = searchQuery('gewaesser', 'name', 'änggi')
  assertValidQuery(query)
  expect(query.where).toEqual({
    op: 'text_match',
    attr: 'name',
    text: 'änggi',
    mode: 'contains',
    case_sensitive: false,
  })
  expect(query.limit).toBe(11)
})

test('a hit in a layer not on the map is zoomed to and marked (plan E1.8, G1)', async () => {
  const calls = backend()
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Suchen' }))
  const search = await screen.findByRole('search', { name: 'Kartensuche' })
  await userEvent.type(within(search).getByLabelText('Suchbegriff'), 'änggi')
  const group = await within(search).findByRole('region', { name: 'Gewässer' })
  await userEvent.click(within(group).getByRole('button', { name: 'Änggisteibach' }))

  expect(useMapView.getState().featureRequest).toMatchObject({
    bbox: [7.4, 46.9, 7.5, 47.0],
    mode: 'zoom',
  })
  expect(useMapView.getState().found?.label).toBe('Änggisteibach')
  // Only layers with geometry and a name are searched; the table layer is not.
  const searched = calls
    .filter((c) => c.key === 'POST /api/query')
    .map((c) => (c.body as { source: string }).source)
  expect(new Set(searched)).toEqual(new Set(['gewaesser', 'schulen']))

  await userEvent.click(within(search).getByRole('button', { name: 'Suche schliessen' }))
  expect(useMapView.getState().found).toBeNull()
})

test('a hit in a shown layer is selected like a table row (B9)', async () => {
  backend()
  useAnalysis.getState().addLayer('schulen')
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Suchen' }))
  const search = await screen.findByRole('search', { name: 'Kartensuche' })
  await userEvent.type(within(search).getByLabelText('Suchbegriff'), 'bümpliz')
  await within(search).findByRole('button', { name: 'Bern Bümpliz/Höhe' })
  // Enter takes the first hit.
  await userEvent.type(within(search).getByLabelText('Suchbegriff'), '{Enter}')
  await waitFor(() =>
    expect(useSelection.getState()).toMatchObject({ layer: 'schulen', fids: [3] }),
  )
  expect(useMapView.getState().found).toBeNull()
})
