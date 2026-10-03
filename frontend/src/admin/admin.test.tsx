import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { attribute, csvPreview, layer } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { AttributeRows } from './LayerPage'

afterEach(() => vi.unstubAllGlobals())

const gemeinden = { ...layer(), last_import: null }

test('the catalog lists layers and filters incomplete ones', async () => {
  const complete = layer({
    name: 'strassen',
    title: 'Strassen',
    description: 'Haupt- und Nebenstrassen',
    geometry_type: 'LineString',
    attributes: [attribute({ name: 'name', data_type: 'text', label: 'Name', description: 'x' })],
  })
  fakeApi({ 'GET /api/admin/layers': [gemeinden, { ...complete, last_import: null }] })
  renderAt('/admin/daten', <App />)

  const table = await screen.findByRole('table')
  expect(within(table).getByRole('link', { name: 'Gemeinden' })).toBeInTheDocument()
  expect(within(table).getByText('Linie')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Unvollständig' }))
  expect(within(table).queryByRole('link', { name: 'Strassen' })).not.toBeInTheDocument()
  expect(within(table).getByRole('link', { name: 'Gemeinden' })).toBeInTheDocument()
})

test('the field editor saves label, unit and range', async () => {
  const calls = fakeApi({
    'PATCH /api/admin/layers/gemeinden/attributes/einwohner': attribute({ label: 'Einwohner' }),
  })
  renderAt(
    '/',
    <table>
      <AttributeRows layer="gemeinden" attribute={attribute()} />
    </table>,
  )
  const label = screen.getByLabelText('Bezeichnung einwohner')
  await userEvent.clear(label)
  await userEvent.type(label, 'Einwohner')
  await userEvent.type(screen.getByLabelText('Einheit einwohner'), 'Personen')
  await userEvent.click(screen.getByRole('button', { name: 'Details zu einwohner' }))
  await userEvent.type(screen.getByLabelText('Minimum einwohner'), '0')
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(calls).toHaveLength(1))
  expect(calls[0]?.body).toEqual({
    label: 'Einwohner',
    unit: 'Personen',
    for_model: true,
    description: '',
    value_domain: { min: 0, max: null },
  })
})

test('the wizard walks a CSV with coordinates to a committed import', async () => {
  const calls = fakeApi({
    'GET /api/admin/layers': [gemeinden],
    'POST /api/admin/imports': { import_id: 'abc', preview: csvPreview() },
    'POST /api/admin/imports/abc/commit': {
      id: 7,
      status: 'warning',
      layer_name: 'messstellen',
      read_count: 21,
      imported_count: 20,
      rejected_count: 1,
      warnings: [{ code: 'rejected_rows', message: '1 records were not imported.' }],
      errors: [],
    },
  })
  renderAt('/admin/daten/import', <App />)

  const file = new File(['Nr;E;N\n'], 'messstellen.csv', { type: 'text/csv' })
  await userEvent.upload(screen.getByLabelText('Importdatei'), file)
  expect(await screen.findByText('messstellen.csv')).toBeInTheDocument()
  const title = screen.getByLabelText('Bezeichnung')
  await userEvent.clear(title)
  await userEvent.type(title, 'Messstellen')

  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(screen.getByRole('radio', { name: 'Koordinatenspalten (X / Y)' })).toBeChecked()
  expect(screen.getByLabelText('EPSG-Code')).toHaveValue('2056')
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'Nr übernehmen' }))
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(screen.getByText('Koordinatensystem EPSG:2056')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))

  expect(await screen.findByText('Import abgeschlossen')).toBeInTheDocument()
  const commit = calls.find((c) => c.key === 'POST /api/admin/imports/abc/commit')
  expect(commit?.body).toMatchObject({
    title: 'Messstellen',
    layer_name: 'messstellen',
    geo: { mode: 'xy', x: 'E', y: 'N', crs: 2056 },
    fields: [{ source_name: 'Nr', include: false }, {}, {}, {}],
  })
})

test('a failed commit is shown and the wizard stays open', async () => {
  fakeApi({
    'GET /api/admin/layers': [gemeinden],
    'POST /api/admin/imports': { import_id: 'abc', preview: csvPreview() },
    'POST /api/admin/imports/abc/commit': {
      id: 8,
      status: 'failed',
      layer_name: null,
      errors: [{ code: 'layer_exists', message: "A layer 'messstellen' already exists." }],
      warnings: [],
    },
  })
  renderAt('/admin/daten/import', <App />)
  await userEvent.upload(
    screen.getByLabelText('Importdatei'),
    new File(['x'], 'messstellen.csv', { type: 'text/csv' }),
  )
  await screen.findByText('messstellen.csv')
  for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Import fehlgeschlagen')
  expect(alert).toHaveTextContent("A layer 'messstellen' already exists.")
  expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeEnabled()
})
