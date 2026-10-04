import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { useAnalysis } from '../analysis/store'
import { newAttributeRow } from '../analysis/tree'
import { attribute, layer, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { assertValidQuery } from '../test/schema'
import { useDock } from './dock'
import { useSelection } from './selection'

const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  feature_count: 3,
  attributes: [
    attribute({ name: 'name', data_type: 'text', label: 'Name' }),
    attribute({ name: 'typ', data_type: 'text', label: 'Schulart' }),
    attribute({ name: 'schueler', data_type: 'integer', label: 'Schüler' }),
  ],
})

const school = (id: number, name: string, typ: string, schueler: number) => ({
  type: 'Feature',
  id,
  properties: { name, typ, schueler },
  geometry: { type: 'Point', coordinates: [7.9 + id / 100, 46.9] },
})
const features = [
  school(1, 'GS Hafen', 'primar', 412),
  school(2, 'Sek Nord', 'sekundar', 500),
  school(3, 'GS Altstadt', 'primar', 301),
]

function backend() {
  return fakeApi({
    ...signedIn({ role: 'user', username: 'm.keller' }),
    'GET /api/layers': [schulen],
    'GET /api/config/map': { basemap: null, extent_wgs84: [7.8, 46.8, 8, 47], max_features: 10000 },
    'POST /api/query': (init) => {
      const query = JSON.parse(String(init?.body))
      assertValidQuery(query)
      return { type: 'FeatureCollection', features, query, meta: {} }
    },
    // The hits: the primary schools.
    'POST /api/query/ids': (init) => {
      assertValidQuery(JSON.parse(String(init?.body)))
      return { ids: features.filter((f) => f.properties.typ === 'primar').map((f) => f.id) }
    },
    'POST /api/query/count': { counts: [2, 3] },
  })
}

beforeEach(() => {
  useAnalysis.getState().reset()
  useSelection.getState().clear()
  useDock.setState({ open: false, height: 260 })
  const s = useAnalysis.getState()
  s.addLayer('schulen')
  s.edit()
  s.addNode('root', { ...newAttributeRow('typ'), operator: 'in', values: ['primar'] })
  s.apply()
  const { layers, result, tree } = useAnalysis.getState()
  s.load({ layers, result, tree, restriction: null })
})
afterEach(() => vi.unstubAllGlobals())

const bodyRows = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .filter((r) => r.getAttribute('aria-hidden') !== 'true')
    .map((r) =>
      within(r)
        .getAllByRole('cell')
        .slice(1, -1)
        .map((c) => c.textContent),
    )

async function openTable() {
  backend()
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Attributtabelle' }))
  return screen.findByRole('table', { name: 'Attribute von Schulen' })
}

test('the table lists hits or all, with catalog labels (F-8.2)', async () => {
  const table = await openTable()
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['', 'Name', 'Schulart', 'Schüler', 'Zoomen'])
  expect(await screen.findByRole('button', { name: 'Treffer (2)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(bodyRows(table)).toEqual([
    ['GS Hafen', 'primar', '412'],
    ['GS Altstadt', 'primar', '301'],
  ])
  await userEvent.click(screen.getByRole('button', { name: 'Alle (3)' }))
  expect(bodyRows(table)).toHaveLength(3)
  // Tab and mode are saved, but are no change to the analysis (design C7).
  expect(useAnalysis.getState().dirty).toBe(false)
})

test('headers sort ↓ / ↑ / aus, Shift adds a second key (design B8)', async () => {
  const table = await openTable()
  await userEvent.click(await screen.findByRole('button', { name: 'Alle (3)' }))
  const header = () => within(table).getByRole('columnheader', { name: /Schüler/ })
  await userEvent.click(within(header()).getByRole('button'))
  expect(header()).toHaveAttribute('aria-sort', 'descending')
  expect(bodyRows(table).map((r) => r[2])).toEqual(['500', '412', '301'])
  await userEvent.click(within(header()).getByRole('button'))
  expect(bodyRows(table).map((r) => r[2])).toEqual(['301', '412', '500'])
  await userEvent.click(within(header()).getByRole('button'))
  expect(header()).toHaveAttribute('aria-sort', 'none')

  const typ = within(table).getByRole('columnheader', { name: /Schulart/ })
  await userEvent.click(within(typ).getByRole('button'))
  const user = userEvent.setup()
  await user.keyboard('{Shift>}')
  await user.click(within(header()).getByRole('button'))
  await user.keyboard('{/Shift}')
  expect(useAnalysis.getState().table.sort.schulen).toEqual([
    { attr: 'typ', dir: 'desc' },
    { attr: 'schueler', dir: 'desc' },
  ])
  expect(bodyRows(table).map((r) => r[0])).toEqual(['Sek Nord', 'GS Hafen', 'GS Altstadt'])
  expect(useAnalysis.getState().dirty).toBe(true)
})

test('columns can be hidden and reordered; the choice marks the session unsaved', async () => {
  const table = await openTable()
  await userEvent.click(screen.getByRole('button', { name: /Spalten/ }))
  const menu = await screen.findByRole('dialog', { name: 'Spalten' })
  await userEvent.click(within(menu).getByRole('checkbox', { name: 'Schulart' }))
  await userEvent.click(within(menu).getByRole('button', { name: 'Schüler nach oben' }))
  await userEvent.click(within(menu).getByRole('button', { name: 'Schüler nach oben' }))
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['', 'Schüler', 'Name', 'Zoomen'])
  expect(useAnalysis.getState().dirty).toBe(true)
})

test('rows are selected by click and checkbox; the selection is not saved', async () => {
  const table = await openTable()
  await within(table).findByText('GS Hafen')
  await userEvent.click(within(table).getByText('GS Hafen'))
  expect(useSelection.getState()).toMatchObject({ layer: 'schulen', fids: [1] })
  await userEvent.click(within(table).getByRole('checkbox', { name: 'Zeile 3 auswählen' }))
  expect(screen.getByText('2 ausgewählt')).toBeInTheDocument()
  expect(useAnalysis.getState().dirty).toBe(false)
  await userEvent.click(screen.getByRole('button', { name: 'Tabelle einklappen' }))
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})

test('columns are reordered by dragging (design B8)', async () => {
  const table = await openTable()
  await userEvent.click(screen.getByRole('button', { name: /Spalten/ }))
  const menu = await screen.findByRole('dialog', { name: 'Spalten' })
  const items = within(menu).getAllByRole('listitem')
  const transfer = { setData: () => {}, effectAllowed: '' }
  // "Schüler" (third) dragged onto "Name" (first).
  fireEvent.dragStart(items[2] as HTMLElement, { dataTransfer: transfer })
  fireEvent.dragOver(items[0] as HTMLElement, { dataTransfer: transfer })
  fireEvent.drop(items[0] as HTMLElement, { dataTransfer: transfer })
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['', 'Schüler', 'Name', 'Schulart', 'Zoomen'])
  expect(useAnalysis.getState().table.columns.schulen?.order).toEqual(['schueler', 'name', 'typ'])
})
