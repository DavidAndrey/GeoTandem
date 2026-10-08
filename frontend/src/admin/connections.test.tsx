import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import type { CheckResult, ConnectionInfo } from '../api/client'
import { signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'

afterEach(() => vi.unstubAllGlobals())

const URL = '/api/admin/llm/connections'

const connection = (patch: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  id: 1,
  name: 'Ollama',
  base_url: 'http://host.docker.internal:11434/v1',
  host: 'host.docker.internal',
  locality: 'local',
  model: 'qwen3:8b',
  has_api_key: false,
  credentials_unreadable: false,
  temperature: 0,
  seed: 42,
  timeout_s: 120,
  reasoning_effort: 'none',
  context_length: null,
  enabled: true,
  is_default: true,
  may_receive_data: true,
  marked_external: false,
  last_test: null,
  created_at: '2026-10-08T10:00:00',
  updated_at: '2026-10-08T10:00:00',
  ...patch,
})

const cloud = connection({
  id: 2,
  name: 'Cloud',
  base_url: 'https://api.openai.com/v1',
  host: 'api.openai.com',
  locality: 'external',
  model: 'gpt-5-mini',
  has_api_key: true,
  is_default: false,
  may_receive_data: false,
  reasoning_effort: 'default',
})

const failedCheck: CheckResult = {
  ok: false,
  tested_at: '2026-10-08T10:05:00Z',
  steps: [
    { name: 'url', status: 'ok', details: { host: '127.0.0.1' } },
    { name: 'reachable', status: 'ok', details: { models: 2 } },
    { name: 'authorised', status: 'ok', details: {} },
    {
      name: 'model',
      status: 'failed',
      code: 'llm_model_missing',
      details: { model: 'qwen9', offered: ['qwen3:8b', 'gemma3:4b'] },
    },
    { name: 'server', status: 'skipped', details: {} },
    { name: 'json_schema', status: 'skipped', details: {} },
    { name: 'tool_call', status: 'skipped', details: {} },
  ],
}

const bodiesOf = (calls: { key: string; body: unknown }[], key: string) =>
  calls.filter((c) => c.key === key).map((c) => c.body)

const openMenu = async (name: string) =>
  userEvent.click(await screen.findByRole('button', { name: `Aktionen für ${name}` }))

test('the list shows kind, default and the last test; an external one names its host', async () => {
  fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [cloud, connection({ last_test: { ...failedCheck, ok: true } })],
  })
  renderAt('/admin/modelle', <App />)

  const table = await screen.findByRole('table')
  const row = (name: string) => within(table).getByRole('row', { name: new RegExp(`^${name}`) })
  expect(within(row('Cloud')).getByText('extern · api.openai.com')).toBeInTheDocument()
  expect(within(row('Cloud')).getByText('nur Metadaten')).toBeInTheDocument()
  expect(within(row('Ollama')).getByText('lokal')).toBeInTheDocument()
  expect(within(row('Ollama')).getByText('voreingestellt')).toBeInTheDocument()
  expect(within(row('Ollama')).getByText('bestanden')).toBeInTheDocument()
})

test('without connections the page says Modus A still works', async () => {
  fakeApi({ ...signedIn(), [`GET ${URL}`]: [] })
  renderAt('/admin/modelle', <App />)
  expect(await screen.findByText(/Noch keine Anbindung/)).toBeInTheDocument()
})

test('a new connection is created; an empty key and automatic defaults are not sent', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [],
    [`POST ${URL}`]: connection(),
  })
  renderAt('/admin/modelle', <App />)

  await userEvent.click(await screen.findByRole('button', { name: 'Anbindung' }))
  const form = screen.getByRole('form', { name: 'Neue Anbindung' })
  await userEvent.type(within(form).getByLabelText('Name'), 'Ollama')
  await userEvent.type(within(form).getByLabelText('Modell'), 'qwen3:8b')
  await userEvent.click(within(form).getByLabelText('Für Anwender freigegeben'))
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(bodiesOf(calls, `POST ${URL}`)).toHaveLength(1))
  const [body] = bodiesOf(calls, `POST ${URL}`) as Record<string, unknown>[]
  expect(body).toMatchObject({
    name: 'Ollama',
    base_url: 'http://host.docker.internal:11434/v1',
    model: 'qwen3:8b',
    enabled: true,
    temperature: 0,
    seed: 42,
  })
  expect(body).not.toHaveProperty('api_key')
  expect(body).not.toHaveProperty('reasoning_effort')
  expect(body).not.toHaveProperty('may_receive_data')
})

test('an edit sends only what changed; the stored key stays unless replaced', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [cloud],
    [`PATCH ${URL}/2`]: cloud,
  })
  renderAt('/admin/modelle', <App />)

  await openMenu('Cloud')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  const form = screen.getByRole('form', { name: 'Anbindung bearbeiten' })
  expect(within(form).getByText(/Ein Schlüssel ist gespeichert/)).toBeInTheDocument()
  const model = within(form).getByLabelText('Modell')
  await userEvent.clear(model)
  await userEvent.type(model, 'gpt-5')
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(bodiesOf(calls, `PATCH ${URL}/2`)).toHaveLength(1))
  expect(bodiesOf(calls, `PATCH ${URL}/2`)[0]).toEqual({ model: 'gpt-5' })
})

test('data release to an external connection asks for confirmation naming the host', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [cloud],
    [`PATCH ${URL}/2`]: cloud,
  })
  renderAt('/admin/modelle', <App />)

  await openMenu('Cloud')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  await userEvent.click(screen.getByLabelText('Darf Dateninhalte erhalten (sonst nur Metadaten)'))
  await userEvent.click(
    screen.getByLabelText('Ich bestätige: Dateninhalte dürfen an api.openai.com gehen.'),
  )
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(bodiesOf(calls, `PATCH ${URL}/2`)).toHaveLength(1))
  expect(bodiesOf(calls, `PATCH ${URL}/2`)[0]).toEqual({
    may_receive_data: true,
    confirm_data_release: true,
  })
})

test('a draft is tested with the stored key and its steps are worded by code', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [cloud],
    [`POST ${URL}/test`]: failedCheck,
  })
  renderAt('/admin/modelle', <App />)

  await openMenu('Cloud')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  await userEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }))

  const result = await screen.findByRole('region', { name: 'Ergebnis des Verbindungstests' })
  expect(within(result).getByText('Verbindungstest nicht bestanden')).toBeInTheDocument()
  expect(
    within(result).getByText(
      'Das Modell „qwen9" wird dort nicht angeboten. Angeboten: „qwen3:8b", „gemma3:4b".',
    ),
  ).toBeInTheDocument()
  expect(within(result).getByText('2 Modelle angeboten')).toBeInTheDocument()
  expect(bodiesOf(calls, `POST ${URL}/test`)[0]).toMatchObject({ connection_id: 2 })
})

test('a saved connection is tested from its menu', async () => {
  fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [connection()],
    [`POST ${URL}/1/test`]: { ...failedCheck, ok: true, steps: failedCheck.steps.slice(0, 3) },
  })
  renderAt('/admin/modelle', <App />)

  await openMenu('Ollama')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Verbindung testen' }))
  const result = await screen.findByRole('region', { name: 'Verbindungstest „Ollama"' })
  expect(within(result).getByText('Verbindungstest bestanden')).toBeInTheDocument()
})
