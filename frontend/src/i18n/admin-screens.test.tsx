// The administration and the access pages in pseudo show no text that
// bypassed the catalog (plan E1.9, WP50). Data from the fake backend may.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { messages } from '../locales/pseudo.po'
import { account, attribute, csvPreview, layer, signedIn } from '../test/fixtures'
import { strays } from '../test/pseudo'
import { fakeApi, renderAt } from '../test/render'
import { activate } from './i18n'

beforeEach(() => activate('pseudo', messages))
afterEach(() => {
  activate('de')
  vi.unstubAllGlobals()
})

const gemeinden = {
  ...layer({
    attributes: [
      attribute({ name: 'einwohner', label: 'Einwohner', unit: 'Pers.', references: 'x.y' }),
      attribute({ name: 'name', data_type: 'text', label: 'name' }),
    ],
  }),
  last_import: null,
}
const run = {
  id: 7,
  status: 'warning',
  started_at: '2026-10-03T08:00:00',
  finished_at: '2026-10-03T08:00:02',
  actor: 'admin',
  source_name: 'messstellen.csv',
  source_format: 'csv',
  layer_name: 'messstellen',
  mode: 'create',
  read_count: 21,
  imported_count: 20,
  rejected_count: 1,
  warnings: [],
  errors: [],
  steps: [{ step: 'read', ms: 120 }],
  decisions: {},
  rejected_sample: [],
}
const DATA = [
  'MCP',
  'E2',
  'E3',
  'E4',
  's.brun',
  'kitas',
  'v2',
  'cp1252',
  ';',
  'GeoTandem',
  'Systemverwaltung',
  'admin',
  'Gemeinden',
  'gemeinden',
  'Einwohner',
  'einwohner',
  'Pers.',
  'name',
  'x.y',
  'messstellen.csv',
  'messstellen',
  'csv',
  'CSV',
  'Kitas',
  'spatialite',
  'tandemtal-1',
  'sample:tandemtal',
  'Nr',
  'Höhe ü. M.',
  'E',
  'N',
  'UTF-8',
  'Windows-1252',
  'ISO-8859-1',
  'EPSG',
  'CH1903+ / LV95',
  'CH1903 / LV03',
  'WGS 84',
  'ETRS89 / UTM 32N',
  'Web Mercator',
  'GEOTANDEM_SETUP_TOKEN',
  'docker logs',
  'fid',
]

function backend(patch: Record<string, unknown> = {}) {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': [gemeinden],
    'GET /api/layers/gemeinden': gemeinden,
    'GET /api/admin/layers': [gemeinden],
    'GET /api/admin/layers/gemeinden/profile': () => null,
    'GET /api/admin/import-log': [run],
    'GET /api/admin/import-log/7': run,
    'GET /api/admin/users': [account(), account({ id: 2, username: 's.brun', role: 'user' })],
    'GET /api/admin/visibility': [
      { layer: 'kitas', title: 'Kitas', roles: { admin: true, user: false } },
    ],
    'GET /api/admin/visibility/default': { new_layers_visible: false },
    'GET /api/admin/system': {
      status: 'ok',
      version: '0.1',
      backend: 'spatialite',
      internal_crs: 2056,
      schema_version: '2',
      sample_dataset_version: 'tandemtal-1',
      capabilities: {},
    },
    'POST /api/query': { type: 'FeatureCollection', features: [], query: {}, meta: {} },
    'POST /api/admin/imports': { import_id: 'abc', preview: csvPreview() },
    ...patch,
  })
}

test.each([
  '/admin/daten',
  '/admin/daten/gemeinden',
  '/admin/daten/gemeinden?reiter=felder',
  '/admin/daten/gemeinden?reiter=vorschau',
  '/admin/protokoll',
  '/admin/protokoll/7',
  '/admin/benutzer',
  '/admin/sichtbarkeit',
  '/admin/system',
  '/admin/daten/import',
])('%s', async (path) => {
  backend()
  renderAt(path, <App />)
  await screen.findAllByRole('heading')
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})

test('the import wizard, step by step', async () => {
  backend()
  renderAt('/admin/daten/import', <App />)
  const file = new File(['Nr;E;N\n'], 'messstellen.csv', { type: 'text/csv' })
  const input = await waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('input[type="file"]')
    if (!found) throw new Error('no file input')
    return found
  })
  await userEvent.upload(input, file)
  await screen.findByText('messstellen.csv')
  for (let step = 1; step <= 4; step++) {
    await waitFor(() => expect(strays(DATA)).toEqual([]))
    const next = document.querySelector<HTMLButtonElement>('button.btn-primary:not([disabled])')
    if (step < 4 && next) await userEvent.click(next)
  }
})

test.each(['/anmelden', '/passwort'])('%s', async (path) => {
  backend()
  renderAt(path, <App />)
  await screen.findAllByRole('heading')
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})

test('/einrichtung', async () => {
  backend({ 'GET /api/auth/setup': { needs_setup: true, sample_loaded: false } })
  renderAt('/einrichtung', <App />)
  await screen.findAllByRole('heading')
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})
