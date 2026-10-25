import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import type { CheckResult, ConnectionInfo } from '../api/client'
import { runPage } from '../test/eval-mocks'
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
  request_limit_enabled: false,
  request_limit_per_day: null,
  prompt_profile: { examples: 'standard', placement: 'P0', output: 'constrained' },
  price_input_per_mtok: null,
  price_output_per_mtok: null,
  price_currency: null,
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
      details: { model: 'qwen9' },
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

// P5: the request limit per connection. The fields arrive with WP65 (TODO there).
test('the request limit: a switch, and a number enabled and required only while it is on', async () => {
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

  const limit = within(form).getByRole('switch', { name: 'Anfragen pro Tag begrenzen' })
  const perDay = within(form).getByLabelText('Anfragen pro Tag')
  expect(limit).not.toBeChecked()
  expect(perDay).toBeDisabled()
  expect(perDay).not.toBeRequired()

  await userEvent.click(limit)
  expect(perDay).toBeEnabled()
  expect(perDay).toBeRequired()
  // On without a number: not sent.
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))
  expect(bodiesOf(calls, `POST ${URL}`)).toEqual([])

  await userEvent.type(perDay, '50')
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))
  await vi.waitFor(() => expect(bodiesOf(calls, `POST ${URL}`)).toHaveLength(1))
  expect(bodiesOf(calls, `POST ${URL}`)[0]).toMatchObject({
    request_limit_enabled: true,
    request_limit_per_day: 50,
  })
})

test('switching the limit off sends the switch alone: the backend keeps the threshold', async () => {
  const limited = { ...cloud, request_limit_enabled: true, request_limit_per_day: 50 }
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [limited],
    [`PATCH ${URL}/2`]: cloud,
  })
  renderAt('/admin/modelle', <App />)
  await openMenu('Cloud')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  const form = screen.getByRole('form', { name: 'Anbindung bearbeiten' })
  const perDay = within(form).getByLabelText('Anfragen pro Tag')
  expect(within(form).getByRole('switch', { name: 'Anfragen pro Tag begrenzen' })).toBeChecked()
  expect(perDay).toHaveValue(50)

  await userEvent.click(within(form).getByRole('switch', { name: 'Anfragen pro Tag begrenzen' }))
  expect(perDay).toBeDisabled()
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))
  await vi.waitFor(() => expect(bodiesOf(calls, `PATCH ${URL}/2`)).toHaveLength(1))
  expect(bodiesOf(calls, `PATCH ${URL}/2`)[0]).toEqual({ request_limit_enabled: false })
})

// Plan E3, D9 and O4: the prompt profile from measured presets, optional prices.
test('a new connection leaves out today’s prompt and an empty price', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [],
    [`POST ${URL}`]: connection(),
  })
  renderAt('/admin/modelle', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Anbindung' }))
  const form = screen.getByRole('form', { name: 'Neue Anbindung' })
  expect(within(form).getByLabelText('Beispiele')).toHaveDisplayValue('Standard')
  expect(within(form).getByLabelText('Platzierung')).toHaveDisplayValue('P0 (wie bisher)')
  expect(within(form).getByLabelText('Ausgabeformat')).toHaveDisplayValue('erzwungen')
  await userEvent.type(within(form).getByLabelText('Name'), 'Ollama')
  await userEvent.type(within(form).getByLabelText('Modell'), 'qwen3:8b')
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(bodiesOf(calls, `POST ${URL}`)).toHaveLength(1))
  // The back end's defaults: only what was set is sent, so the audit lists it.
  const [body] = bodiesOf(calls, `POST ${URL}`) as Record<string, unknown>[]
  for (const key of [
    'prompt_profile',
    'price_input_per_mtok',
    'price_output_per_mtok',
    'price_currency',
  ])
    expect(body).not.toHaveProperty(key)
})

test('a chosen profile and a price are sent with a new connection', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [],
    [`POST ${URL}`]: connection(),
  })
  renderAt('/admin/modelle', <App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Anbindung' }))
  const form = screen.getByRole('form', { name: 'Neue Anbindung' })
  await userEvent.type(within(form).getByLabelText('Name'), 'Luna')
  await userEvent.type(within(form).getByLabelText('Modell'), 'gpt-6-luna')
  await userEvent.selectOptions(
    within(form).getByLabelText('Platzierung'),
    'P5 (Beispiele vor dem Steckbrief)',
  )
  await userEvent.type(within(form).getByLabelText('Eingabe je Mio. Tokens'), '0.5')
  await userEvent.type(within(form).getByLabelText('Ausgabe je Mio. Tokens'), '2')
  await userEvent.type(within(form).getByLabelText('Währung'), 'eur')
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(bodiesOf(calls, `POST ${URL}`)).toHaveLength(1))
  expect(bodiesOf(calls, `POST ${URL}`)[0]).toMatchObject({
    prompt_profile: { examples: 'standard', placement: 'P5', output: 'constrained' },
    price_input_per_mtok: 0.5,
    price_output_per_mtok: 2,
    price_currency: 'EUR',
  })
})

test('an invalid currency or a negative price is not sent', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [cloud],
    [`PATCH ${URL}/2`]: cloud,
  })
  renderAt('/admin/modelle', <App />)
  await openMenu('Cloud')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  const form = screen.getByRole('form', { name: 'Anbindung bearbeiten' })
  const input = within(form).getByLabelText('Eingabe je Mio. Tokens')
  const currency = within(form).getByLabelText('Währung')
  await userEvent.type(input, '1')
  await userEvent.type(within(form).getByLabelText('Ausgabe je Mio. Tokens'), '2')
  await userEvent.type(currency, 'u5')
  expect(currency).toBeInvalid()
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))
  expect(bodiesOf(calls, `PATCH ${URL}/2`)).toEqual([])

  await userEvent.clear(currency)
  await userEvent.type(currency, 'chf')
  expect(currency).toBeValid()
  await userEvent.clear(input)
  await userEvent.type(input, '-1')
  expect(input).toBeInvalid()
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))
  expect(bodiesOf(calls, `PATCH ${URL}/2`)).toEqual([])
})

test('the three selects and the prices send only what changed', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [cloud],
    [`PATCH ${URL}/2`]: cloud,
  })
  renderAt('/admin/modelle', <App />)
  await openMenu('Cloud')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  const form = screen.getByRole('form', { name: 'Anbindung bearbeiten' })
  // Only the measured presets are offered (D9).
  const placement = within(form).getByLabelText('Platzierung')
  expect(
    within(placement)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual([
    'P0 (wie bisher)',
    'P5 (Beispiele vor dem Steckbrief)',
    'P9 (Hinweis „erste Frage" als eigene Systemnachricht)',
  ])
  await userEvent.selectOptions(within(form).getByLabelText('Beispiele'), '12 Beispiele')
  await userEvent.selectOptions(placement, 'P9 (Hinweis „erste Frage" als eigene Systemnachricht)')
  await userEvent.selectOptions(within(form).getByLabelText('Ausgabeformat'), 'nur Text')
  await userEvent.type(within(form).getByLabelText('Eingabe je Mio. Tokens'), '0.8')
  await userEvent.type(within(form).getByLabelText('Ausgabe je Mio. Tokens'), '4')
  await userEvent.type(within(form).getByLabelText('Währung'), 'usd')
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(bodiesOf(calls, `PATCH ${URL}/2`)).toHaveLength(1))
  expect(bodiesOf(calls, `PATCH ${URL}/2`)[0]).toEqual({
    prompt_profile: { examples: '12', placement: 'P9', output: 'text' },
    price_input_per_mtok: 0.8,
    price_output_per_mtok: 4,
    price_currency: 'USD',
  })
})

test('a half price is refused by the back end and worded by its code', async () => {
  const priced = connection({
    price_input_per_mtok: 1,
    price_output_per_mtok: 2,
    price_currency: 'CHF',
  })
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [priced],
    [`PATCH ${URL}/1`]: () =>
      new Response(
        JSON.stringify({
          code: 'price_incomplete',
          message: 'A price needs input, output and currency, or none of them.',
          details: { name: 'Ollama', missing: ['price_currency'] },
        }),
        { status: 400 },
      ),
  })
  renderAt('/admin/modelle', <App />)
  await openMenu('Ollama')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  const form = screen.getByRole('form', { name: 'Anbindung bearbeiten' })
  expect(within(form).getByLabelText('Eingabe je Mio. Tokens')).toHaveValue(1)
  await userEvent.clear(within(form).getByLabelText('Währung'))
  await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }))

  expect(
    await within(form).findByText(
      'Ein Preis braucht beide Beträge (Eingabe und Ausgabe) und die Währung, oder keinen davon.',
    ),
  ).toBeInTheDocument()
  expect(bodiesOf(calls, `PATCH ${URL}/1`)[0]).toEqual({ price_currency: null })
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

test('a local connection moved to a new address asks for confirmation naming it', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [connection()],
    [`PATCH ${URL}/1`]: connection(),
  })
  renderAt('/admin/modelle', <App />)

  await openMenu('Ollama')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  const address = screen.getByLabelText('Adresse')
  await userEvent.clear(address)
  await userEvent.type(address, 'https://llm.example.org/v1')
  await userEvent.click(
    screen.getByLabelText('Ich bestätige: Dateninhalte dürfen an llm.example.org gehen.'),
  )
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))

  await vi.waitFor(() => expect(bodiesOf(calls, `PATCH ${URL}/1`)).toHaveLength(1))
  expect(bodiesOf(calls, `PATCH ${URL}/1`)[0]).toEqual({
    base_url: 'https://llm.example.org/v1',
    confirm_data_release: true,
  })
})

test('a new address needs the key again: the stored one stays with the old', async () => {
  fakeApi({ ...signedIn(), [`GET ${URL}`]: [cloud] })
  renderAt('/admin/modelle', <App />)

  await openMenu('Cloud')
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }))
  const form = screen.getByRole('form', { name: 'Anbindung bearbeiten' })
  expect(within(form).getByLabelText('API-Schlüssel')).not.toBeRequired()
  const address = within(form).getByLabelText('Adresse')
  await userEvent.clear(address)
  await userEvent.type(address, 'https://llm.example.org/v1')
  expect(within(form).getByText(/Neue Adresse: den Schlüssel neu eintragen/)).toBeInTheDocument()
  expect(within(form).getByLabelText('API-Schlüssel')).toBeRequired()
  await userEvent.click(within(form).getByLabelText('Schlüssel entfernen'))
  expect(within(form).getByLabelText('API-Schlüssel')).not.toBeRequired()
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
    within(result).getByText('Das Modell „qwen9" wird dort nicht angeboten.'),
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

test('"zuletzt bewertet": the newest run that measured a connection, with a link (O7)', async () => {
  const calls = fakeApi({
    ...signedIn(),
    [`GET ${URL}`]: [connection(), cloud],
    'GET /api/admin/evaluation/runs': (_init: RequestInit | undefined, url: string) => {
      const id = new URLSearchParams(url.split('?')[1]).get('connection_id')
      const page = runPage()
      return id === '1' ? { items: [page.items[1]], total: 1 } : { items: [], total: 0 }
    },
  })
  renderAt('/admin/modelle', <App />)
  const row = (await screen.findByText('Ollama')).closest('tr')
  if (!row) throw new Error('no row')
  expect(await within(row).findByRole('link', { name: 'Lauf #13' })).toHaveAttribute(
    'href',
    '/admin/bewertung/lauf/13',
  )
  const other = screen.getByText('Cloud').closest('tr')
  expect(await within(other as HTMLElement).findByText('noch nie')).toBeInTheDocument()
  const asked = calls.filter((c) => c.key === 'GET /api/admin/evaluation/runs')
  expect(asked).toHaveLength(2)
})
