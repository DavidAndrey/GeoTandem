import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { useAnalysis } from '../analysis/store'
import { account, layer, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { newSession } from './actions'
import { STATE_VERSION } from './format'
import { useSessionUi } from './ui'

const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  feature_count: 3,
})
const stamp = {
  count: 10,
  ids_hash: 'abc',
  query_hash: 'q',
  data_versions: { schulen: 'v1' },
  stamped_at: '2026-10-03T12:02:00',
}

function summary(id: string, name: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    name,
    note: '',
    result_layer: 'schulen',
    stamp,
    data_changed: false,
    created_at: '2026-10-03T12:00:00',
    updated_at: '2026-10-03T12:02:00',
    opened_at: null,
    ...patch,
  }
}

function detail(id: string, name: string) {
  return {
    ...summary(id, name),
    state_version: STATE_VERSION,
    state: {
      layers: [
        {
          id: 'schulen',
          source: { kind: 'catalog', layer: 'schulen' },
          visible: true,
          opacity: 1,
          symbology: null,
        },
      ],
      result: 'schulen',
      tree: { id: 'root', kind: 'group', op: 'and', not: false, children: [] },
      restriction: null,
      table: { tab: null, mode: 'hits', onlyView: false, columns: {}, sort: {} },
      view: null,
    },
    query: { schema_version: '2', source: 'schulen' },
  }
}

const check = {
  identical: true,
  saved: stamp,
  current: stamp,
  changed_layers: [],
  missing_layers: [],
  state_matches: true,
}

function backend(routes: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': [schulen],
    'GET /api/config/map': {
      basemap: null,
      extent_wgs84: [7.3, 46.9, 7.5, 47],
      max_features: 10000,
    },
    'POST /api/query': { type: 'FeatureCollection', features: [], query: {}, meta: {} },
    'POST /api/query/count': { counts: [3, 3] },
    'GET /api/sessions': [],
    'GET /api/sessions/last': () => null,
    ...routes,
  })
}

beforeEach(() => {
  newSession()
  useSessionUi.setState({ landed: false, dialog: null, guard: null, owner: null })
})
afterEach(() => vi.unstubAllGlobals())

const status = () => screen.getByRole('status', { name: 'Speicherstand' })

test('a new analysis is unsaved until saved under a name (design C1, C2)', async () => {
  const calls = backend({
    'POST /api/sessions': (init) => ({ ...detail('s1', JSON.parse(String(init?.body)).name) }),
  })
  renderAt('/', <App />)
  expect(await screen.findByRole('button', { name: 'Sitzungsmenü' })).toHaveTextContent(
    'Neue Sitzung',
  )
  useAnalysis.getState().addLayer('schulen')
  await waitFor(() => expect(status()).toHaveTextContent('ungespeichert'))

  await userEvent.click(screen.getByRole('button', { name: 'Sitzungsmenü' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Speichern unter …' }))
  const dialog = await screen.findByRole('dialog', { name: 'Sitzung speichern' })
  expect(within(dialog).getByText('Abfrage · Ziel Schulen')).toBeInTheDocument()
  expect(await within(dialog).findByText('3 Treffer')).toBeInTheDocument()
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Vorführung')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }))

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Sitzungsmenü' })).toHaveTextContent('Vorführung')
  expect(status()).toHaveTextContent(/^gespeichert/)
  expect(calls.some((c) => c.key === 'POST /api/sessions')).toBe(true)
})

test('a taken name asks before overwriting (plan D10)', async () => {
  const calls = backend({
    'POST /api/sessions': new Response(
      JSON.stringify({ code: 'name_taken', message: 'x', details: { existing: 's7' } }),
      { status: 409 },
    ),
    'PUT /api/sessions/s7': detail('s7', 'Vorführung'),
  })
  renderAt('/', <App />)
  await screen.findByRole('button', { name: 'Sitzungsmenü' })
  useAnalysis.getState().addLayer('schulen')
  useSessionUi.getState().openDialog('saveAs')
  const dialog = await screen.findByRole('dialog', { name: 'Sitzung speichern' })
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Vorführung')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('gibt es schon')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Überschreiben' }))
  await waitFor(() => expect(calls.some((c) => c.key === 'PUT /api/sessions/s7')).toBe(true))
})

test('unsaved changes ask before a new session; discarding empties it (design C5)', async () => {
  backend()
  renderAt('/', <App />)
  await screen.findByRole('button', { name: 'Sitzungsmenü' })
  useAnalysis.getState().addLayer('schulen')
  await userEvent.click(screen.getByRole('button', { name: 'Sitzungsmenü' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Neue Sitzung' }))
  const ask = await screen.findByRole('alertdialog', { name: 'Ungespeicherte Änderungen' })
  expect(
    within(ask).getByRole('button', { name: 'Speichern und neu beginnen' }),
  ).toBeInTheDocument()
  await userEvent.click(within(ask).getByRole('button', { name: 'Abbrechen' }))
  expect(useAnalysis.getState().layers).toHaveLength(1)

  await userEvent.click(screen.getByRole('button', { name: 'Sitzungsmenü' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Neue Sitzung' }))
  await userEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Verwerfen' }),
  )
  expect(useAnalysis.getState().layers).toHaveLength(0)
})

test('after sign-in the workplace lands in the last session and checks it (design A2, C4)', async () => {
  const calls = backend({
    'GET /api/sessions/last': detail('s1', 'Vorführung'),
    'GET /api/sessions/s1': detail('s1', 'Vorführung'),
    'POST /api/sessions/s1/check': check,
  })
  renderAt('/', <App />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Sitzungsmenü' })).toHaveTextContent('Vorführung'),
  )
  expect(useAnalysis.getState().layers.map((l) => l.id)).toEqual(['schulen'])
  await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/sessions/s1/check')).toBe(true))
  expect(status()).toHaveTextContent(/^gespeichert/)
  expect(await screen.findByRole('status', { name: 'Ergebnisprüfung' })).toHaveTextContent(
    'Wiederhergestellt · 10 Treffer, identisch mit dem Speicherstand',
  )
})

/** Signed out until the login form is sent, then account 1. */
function signingIn() {
  let signedInYet = false
  return {
    'GET /api/auth/me': () =>
      signedInYet
        ? new Response(JSON.stringify(account()))
        : new Response('{"code":"not_authenticated","message":"Please sign in."}', {
            status: 401,
          }),
    'POST /api/auth/login': () => {
      signedInYet = true
      return account()
    },
  }
}

async function signIn() {
  renderAt('/anmelden', <App />)
  await userEvent.type(await screen.findByLabelText('Benutzername'), 'admin')
  await userEvent.type(screen.getByLabelText('Passwort'), 'passwort')
  await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }))
}

test('another account signing in starts empty and lands in its own session (design A2)', async () => {
  // Account 7 worked here until its session ran out; account 1 signs in.
  useAnalysis.getState().addLayer('schulen')
  useSessionUi.setState({ landed: true, owner: 7 })
  backend({
    ...signingIn(),
    'GET /api/sessions/last': detail('s1', 'Vorführung'),
    'GET /api/sessions/s1': detail('s1', 'Vorführung'),
    'POST /api/sessions/s1/check': check,
  })
  await signIn()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Sitzungsmenü' })).toHaveTextContent('Vorführung'),
  )
  expect(useSessionUi.getState().owner).toBe(1)
})

test('the same account signing in again keeps its unsaved work', async () => {
  useAnalysis.getState().addLayer('schulen')
  useSessionUi.setState({ landed: true, owner: 1 })
  backend(signingIn())
  await signIn()
  await screen.findByRole('button', { name: 'Sitzungsmenü' })
  expect(useAnalysis.getState().dirty).toBe(true)
  expect(useAnalysis.getState().layers).toHaveLength(1)
})

test('the list opens, renames and flags new data (design C3)', async () => {
  const calls = backend({
    'GET /api/sessions': [
      summary('s1', 'Vorführung'),
      summary('s2', 'Kitas je Gemeinde', { data_changed: true, stamp: { ...stamp, count: 12 } }),
    ],
    'PATCH /api/sessions/s2': summary('s2', 'Kitas'),
    'GET /api/sessions/s1': detail('s1', 'Vorführung'),
    'POST /api/sessions/s1/check': check,
  })
  renderAt('/', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Sitzungsmenü' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: /Alle öffnen/ }))
  const list = await screen.findByRole('table', { name: 'Sitzungen' })
  const kitas = within(list).getByText('Kitas je Gemeinde').closest('tr') as HTMLElement
  expect(within(kitas).getByText('Daten neu')).toBeInTheDocument()
  expect(within(kitas).getByText('12')).toBeInTheDocument()

  await userEvent.click(
    within(kitas).getByRole('button', { name: 'Aktionen für Kitas je Gemeinde' }),
  )
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Umbenennen' }))
  const input = within(list).getByLabelText('Neuer Name')
  await userEvent.clear(input)
  await userEvent.type(input, 'Kitas{Enter}')
  await waitFor(() => expect(calls.some((c) => c.key === 'PATCH /api/sessions/s2')).toBe(true))

  await userEvent.click(within(list).getByRole('button', { name: 'Vorführung' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Sitzungsmenü' })).toHaveTextContent('Vorführung'),
  )
})
