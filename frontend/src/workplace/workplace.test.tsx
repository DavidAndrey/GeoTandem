import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { useAnalysis } from '../analysis/store'
import { layer, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { assertValidQuery } from '../test/schema'

beforeEach(() => useAnalysis.getState().reset())
afterEach(() => vi.unstubAllGlobals())

const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  feature_count: 120,
})
const gemeinden = layer()
const bevoelkerung = layer({
  name: 'bevoelkerung',
  title: 'Bevölkerung',
  kind: 'table',
  geometry_type: null,
})
const feature = (id: number) => ({
  type: 'Feature',
  id,
  properties: { name: `Schule ${id}` },
  geometry: { type: 'Point', coordinates: [7.9, 46.9] },
})

function backend() {
  return fakeApi({
    ...signedIn({ role: 'user', username: 'm.keller' }),
    'GET /api/layers': [schulen, gemeinden, bevoelkerung],
    'GET /api/config/map': { basemap: null, extent_wgs84: [7.8, 46.8, 8, 47], max_features: 10000 },
    'POST /api/query': {
      type: 'FeatureCollection',
      features: [feature(1), feature(2)],
      query: {},
      meta: {},
    },
    'POST /api/query/count': { counts: [120, 120] },
  })
}

test('layers come from the picker; the first becomes the result layer', async () => {
  const calls = backend()
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Layer' }))
  const picker = await screen.findByRole('dialog', { name: 'Layer hinzufügen' })
  // Table layers are listed for the attribute table, never drawn nor the result (B11).
  await userEvent.click(within(picker).getByRole('checkbox', { name: /Bevölkerung/ }))
  await userEvent.click(within(picker).getByRole('checkbox', { name: /Schulen/ }))
  await userEvent.click(within(picker).getByRole('checkbox', { name: /Gemeinden/ }))
  await userEvent.click(within(picker).getByRole('button', { name: 'Hinzufügen' }))

  const panel = screen.getByRole('region', { name: 'Layer' })
  const rows = within(panel)
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('aria-expanded') && b.textContent !== ' Layer')
  expect(rows.map((b) => b.textContent)).toEqual(['Bevölkerung', 'SchulenErgebnis', 'Gemeinden'])
  expect(within(panel).queryByRole('button', { name: 'Bevölkerung ausblenden' })).toBeNull()
  expect(useAnalysis.getState().result).toBe('schulen')

  // The table layer has its tab in the attribute table.
  await userEvent.click(screen.getByRole('button', { name: 'Attributtabelle' }))
  expect(await screen.findByRole('tab', { name: 'Bevölkerung' })).toBeInTheDocument()
  expect(await screen.findByLabelText('Trefferzahl')).toHaveTextContent('120 von 120')

  // Every query the interface sent is a valid query object (etappen E1.5).
  const sent = calls.filter((c) => c.key === 'POST /api/query' || c.key === 'POST /api/query/count')
  expect(sent.length).toBeGreaterThan(0)
  for (const call of sent) {
    const body = call.body as { queries?: unknown[] }
    for (const query of body.queries ?? [body]) assertValidQuery(query)
  }
})

test('visibility and opacity are display state, not query state', async () => {
  backend()
  useAnalysis.getState().addLayer('schulen')
  renderAt('/', <App />)
  const panel = await screen.findByRole('region', { name: 'Layer' })
  await userEvent.click(await within(panel).findByRole('button', { name: 'Schulen ausblenden' }))
  expect(useAnalysis.getState().layers[0]?.visible).toBe(false)
  await userEvent.click(within(panel).getByRole('button', { name: /Schulen/, expanded: false }))
  const slider = within(panel).getByRole('slider', { name: 'Deckkraft Schulen' })
  expect(slider).toHaveValue('100')
})
