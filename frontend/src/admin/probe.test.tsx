import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import type { LLMOptions, ProbeResult } from '../api/client'
import { attribute, layer } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { ProbeTab } from './ProbeTab'

afterEach(() => vi.unstubAllGlobals())

const gemeinden = layer({
  description: 'Politische Gemeinden.',
  attributes: [
    attribute({ label: 'Einwohner', unit: 'Personen' }),
    attribute({ name: 'gem_nr', label: 'Gemeindenummer' }),
  ],
})

function options(patch: Partial<LLMOptions> = {}): LLMOptions {
  return {
    connections: [
      {
        id: 1,
        name: 'Lokal',
        model: 'qwen3:14b',
        host: '127.0.0.1',
        locality: 'local',
        is_default: true,
      },
      {
        id: 2,
        name: 'Haiku',
        model: 'claude-haiku-5-5',
        host: 'api.anthropic.com',
        locality: 'external',
        is_default: false,
      },
    ],
    chosen_connection_id: null,
    active_connection_id: 1,
    levels: [],
    chosen_level_id: null,
    active_level_id: 1,
    ...patch,
  }
}

const result: ProbeResult = {
  layer: 'gemeinden',
  meaning: 'Eine Gemeinde mit Grenze.',
  attributes: [
    {
      name: 'einwohner',
      answered: true,
      meaning: 'Zahl der Einwohner.',
      unit: 'Personen',
      values: '100 bis 140 000',
      identifier: false,
    },
    { name: 'gem_nr', answered: false, meaning: '', unit: '', values: '', identifier: false },
  ],
  unknown: ['flaeche'],
  connection: {
    id: 2,
    name: 'Haiku',
    model: 'claude-haiku-5-5',
    host: 'api.anthropic.com',
    locality: 'external',
  },
  probed_at: '2026-11-07T16:00:00',
  latency_ms: 2400,
  prompt_tokens: 900,
  completion_tokens: 150,
}

test('the probe asks the chosen connection and shows the readings beside the curated', async () => {
  const calls = fakeApi({
    'GET /api/llm/options': options(),
    'POST /api/admin/layers/gemeinden/probe': result,
  })
  renderAt('/', <ProbeTab layer={gemeinden} />)

  const select = await screen.findByLabelText('Verbindung')
  expect(select).toHaveValue('1')
  await userEvent.selectOptions(select, '2')
  expect(screen.getByText(/nur der Steckbrief hinaus/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Verständnis prüfen' }))

  const readings = await screen.findByRole('region', { name: 'Was das Modell versteht' })
  expect(calls.find((c) => c.key === 'POST /api/admin/layers/gemeinden/probe')?.body).toEqual({
    connection_id: 2,
  })
  expect(within(readings).getByText('Politische Gemeinden.')).toBeInTheDocument()
  expect(within(readings).getByText('Eine Gemeinde mit Grenze.')).toBeInTheDocument()
  const rows = within(readings).getAllByRole('row')
  expect(within(rows[1] as HTMLElement).getByText('Zahl der Einwohner.')).toBeInTheDocument()
  expect(within(rows[1] as HTMLElement).getByText('100 bis 140 000')).toBeInTheDocument()
  expect(
    within(rows[2] as HTMLElement).getByText('Das Modell hat zu diesem Feld nichts gesagt.'),
  ).toBeInTheDocument()
  expect(within(readings).getByText('flaeche')).toBeInTheDocument()
  expect(within(readings).getByText(/900 \+ 150 Tokens/)).toBeInTheDocument()
})

test('the default connection is asked when none is chosen', async () => {
  const calls = fakeApi({
    'GET /api/llm/options': options(),
    'POST /api/admin/layers/gemeinden/probe': result,
  })
  renderAt('/', <ProbeTab layer={gemeinden} />)

  await userEvent.click(await screen.findByRole('button', { name: 'Verständnis prüfen' }))

  await screen.findByRole('region', { name: 'Was das Modell versteht' })
  expect(calls.find((c) => c.key === 'POST /api/admin/layers/gemeinden/probe')?.body).toEqual({
    connection_id: 1,
  })
})

test('a failed probe says why', async () => {
  fakeApi({
    'GET /api/llm/options': options(),
    'POST /api/admin/layers/gemeinden/probe': () =>
      new Response(
        JSON.stringify({ code: 'quota_exceeded', message: '?', details: { limit: 5 } }),
        { status: 429 },
      ),
  })
  renderAt('/', <ProbeTab layer={gemeinden} />)

  await userEvent.click(await screen.findByRole('button', { name: 'Verständnis prüfen' }))

  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Was das Modell versteht' })).toBeNull()
})

test('a layer hidden from the model has nothing to probe', () => {
  fakeApi({ 'GET /api/llm/options': options() })
  renderAt('/', <ProbeTab layer={{ ...gemeinden, for_model: false }} />)

  expect(screen.getByText(/es gibt keinen Steckbrief zu prüfen/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Verständnis prüfen' })).toBeNull()
})
