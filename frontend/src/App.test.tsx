import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from './App'
import { account, layer, signedIn } from './test/fixtures'
import { fakeApi, renderAt } from './test/render'

afterEach(() => vi.unstubAllGlobals())

const health = {
  status: 'ok',
  version: '0.1.0',
  backend: 'spatialite',
  internal_crs: 2056,
  schema_version: '0',
  sample_dataset_version: 'tandemtal-1',
  capabilities: { supported: [], missing: {} },
}
const unauthorized = () =>
  new Response('{"code":"not_authenticated","message":"Please sign in."}', { status: 401 })

test('start page shows the backend status', async () => {
  fakeApi({ ...signedIn(), 'GET /api/health': health, 'GET /api/layers': [layer()] })
  renderAt('/', <App />)
  expect(await screen.findByText('Bereit')).toBeInTheDocument()
  expect(screen.getByText('EPSG:2056')).toBeInTheDocument()
  const layers = screen.getByRole('region', { name: 'Verfügbare Layer' })
  expect(await within(layers).findByText('Gemeinden')).toBeInTheDocument()
})

test('unreachable backend is reported, not swallowed', async () => {
  fakeApi({ ...signedIn(), 'GET /api/health': () => new Response('{}', { status: 502 }) })
  renderAt('/', <App />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Backend nicht erreichbar')
})

test('administrators reach the administration area', async () => {
  fakeApi({ ...signedIn(), 'GET /api/admin/layers': [] })
  renderAt('/admin', <App />)
  expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument()
})

test('users see neither the link nor the area', async () => {
  fakeApi({ ...signedIn({ role: 'user', username: 'm.keller' }), 'GET /api/health': health })
  renderAt('/admin/daten', <App />)
  expect(await screen.findByRole('alert')).toHaveTextContent('nur Administratoren')
  expect(screen.queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument()
})

test('without a session the guard sends to sign-in, keeping the target', async () => {
  fakeApi({
    'GET /api/auth/me': unauthorized,
    'GET /api/auth/setup': { needs_setup: false, sample_loaded: true },
  })
  renderAt('/admin/protokoll', <App />)
  expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeInTheDocument()
})

test('a fresh instance sends to the setup', async () => {
  fakeApi({
    'GET /api/auth/me': unauthorized,
    'GET /api/auth/setup': { needs_setup: true, sample_loaded: false },
  })
  renderAt('/', <App />)
  expect(await screen.findByRole('heading', { name: 'Ersteinrichtung' })).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: /Beispieldatensatz/ })).toBeChecked()
})

test('signing in with a start password leads to the mandatory password page', async () => {
  let signedInYet = false
  const calls = fakeApi({
    'GET /api/auth/me': () =>
      signedInYet
        ? new Response(JSON.stringify(account({ role: 'user', must_change_password: true })))
        : unauthorized(),
    'GET /api/auth/setup': { needs_setup: false, sample_loaded: true },
    'POST /api/auth/login': () => {
      signedInYet = true
      return account({ role: 'user', must_change_password: true })
    },
  })
  renderAt('/anmelden', <App />)
  await userEvent.type(await screen.findByLabelText('Benutzername'), 'm.keller')
  await userEvent.type(screen.getByLabelText('Passwort'), 'start-passwort')
  await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }))

  expect(await screen.findByRole('heading', { name: 'Passwort festlegen' })).toBeInTheDocument()
  expect(calls.find((c) => c.key === 'POST /api/auth/login')?.body).toEqual({
    username: 'm.keller',
    password: 'start-passwort',
  })
  expect(screen.queryByRole('button', { name: 'Abbrechen' })).not.toBeInTheDocument()
})

test('a failed sign-in shows the server message', async () => {
  fakeApi({
    'GET /api/auth/me': unauthorized,
    'GET /api/auth/setup': { needs_setup: false, sample_loaded: true },
    'POST /api/auth/login': () =>
      new Response(
        '{"code":"not_authenticated","message":"Username or password is wrong, or the account is locked."}',
        { status: 401 },
      ),
  })
  renderAt('/anmelden', <App />)
  await userEvent.type(await screen.findByLabelText('Benutzername'), 'x')
  await userEvent.type(screen.getByLabelText('Passwort'), 'y')
  await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Username or password is wrong')
})
