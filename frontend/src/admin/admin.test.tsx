import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { account, attribute, csvPreview, layer, signedIn } from '../test/fixtures'
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
  fakeApi({
    ...signedIn(),
    'GET /api/admin/layers': [gemeinden, { ...complete, last_import: null }],
  })
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
    ...signedIn(),
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
  await userEvent.upload(await screen.findByLabelText('Importdatei'), file)
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
    ...signedIn(),
    'GET /api/admin/layers': [gemeinden],
    'POST /api/admin/imports': { import_id: 'abc', preview: csvPreview() },
    'POST /api/admin/imports/abc/commit': {
      id: 8,
      status: 'failed',
      layer_name: null,
      errors: [
        {
          code: 'layer_exists',
          message: "A layer 'messstellen' already exists.",
          details: { layer: 'messstellen' },
        },
      ],
      warnings: [],
    },
  })
  renderAt('/admin/daten/import', <App />)
  await userEvent.upload(
    await screen.findByLabelText('Importdatei'),
    new File(['x'], 'messstellen.csv', { type: 'text/csv' }),
  )
  await screen.findByText('messstellen.csv')
  for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Import fehlgeschlagen')
  expect(alert).toHaveTextContent('Einen Layer „messstellen" gibt es schon.')
  expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeEnabled()
})

test('a new account shows its start password once', async () => {
  const calls = fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account()],
    'POST /api/admin/users': {
      account: account({ id: 2, username: 's.brun', role: 'user', must_change_password: true }),
      start_password: 'k7-Tm4-q9xYz',
    },
  })
  renderAt('/admin/benutzer', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Konto' }))
  const form = screen.getByRole('form', { name: 'Neues Konto' })
  await userEvent.type(within(form).getByLabelText('Benutzer'), 's.brun')
  await userEvent.click(within(form).getByRole('button', { name: 'Anlegen' }))

  expect(await screen.findByLabelText('Startpasswort')).toHaveTextContent('k7-Tm4-q9xYz')
  expect(calls.find((c) => c.key === 'POST /api/admin/users')?.body).toEqual({
    username: 's.brun',
    display_name: '',
    role: 'user',
  })
})

test('the visibility matrix releases a layer for users', async () => {
  const row = (visible: boolean) => [
    { layer: 'kitas', title: 'Kitas', roles: { admin: true, user: visible } },
  ]
  const calls = fakeApi({
    ...signedIn(),
    'GET /api/admin/visibility': row(false),
    'PUT /api/admin/visibility': row(true),
  })
  renderAt('/admin/sichtbarkeit', <App />)
  const box = await screen.findByRole('checkbox', { name: 'Kitas für Anwender' })
  expect(box).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Kitas für Administrator' })).toBeDisabled()
  await userEvent.click(box)
  await vi.waitFor(() => expect(box).toBeChecked())
  expect(calls.find((c) => c.key === 'PUT /api/admin/visibility')?.body).toEqual({
    layer: 'kitas',
    role: 'user',
    visible: true,
  })
})

test('new layers follow the visibility setting (design D10)', async () => {
  const calls = fakeApi({
    ...signedIn(),
    'GET /api/admin/visibility': [],
    'GET /api/admin/visibility/default': { new_layers_visible: false },
    'PUT /api/admin/visibility/default': (init) => JSON.parse(String(init?.body)),
  })
  renderAt('/admin/sichtbarkeit', <App />)
  const later = await screen.findByRole('radio', { name: 'erst nach Freigabe' })
  expect(later).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: 'sofort sichtbar' }))
  expect(await screen.findByRole('radio', { name: 'sofort sichtbar' })).toBeChecked()
  expect(calls.find((c) => c.key === 'PUT /api/admin/visibility/default')?.body).toEqual({
    new_layers_visible: true,
  })
})

test('a layer is duplicated from the catalog and opened (design D2)', async () => {
  const calls = fakeApi({
    ...signedIn(),
    'GET /api/admin/layers': [gemeinden],
    'POST /api/admin/layers/gemeinden/duplicate': layer({
      name: 'gemeinden_kopie',
      title: 'Gemeinden (Kopie)',
    }),
    'GET /api/layers/gemeinden_kopie': layer({
      name: 'gemeinden_kopie',
      title: 'Gemeinden (Kopie)',
    }),
    'GET /api/admin/layers/gemeinden_kopie/profile': () => null,
  })
  renderAt('/admin/daten', <App />)
  const table = await screen.findByRole('table')
  await userEvent.click(within(table).getByRole('button', { name: 'Aktionen für Gemeinden' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplizieren' }))
  const dialog = await screen.findByRole('dialog', { name: '„Gemeinden" duplizieren' })
  expect(within(dialog).getByLabelText('Titel')).toHaveValue('Gemeinden (Kopie)')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Duplizieren' }))
  expect(calls.find((c) => c.key === 'POST /api/admin/layers/gemeinden/duplicate')?.body).toEqual({
    title: 'Gemeinden (Kopie)',
  })
  // The copy opens on its layer page.
  expect(await screen.findByDisplayValue('Gemeinden (Kopie)')).toBeInTheDocument()
})
