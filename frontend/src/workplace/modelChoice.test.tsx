import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import type { LLMOptions } from '../api/client'
import { signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { ModelChoice } from './ModelChoice'

afterEach(() => vi.unstubAllGlobals())

const options: LLMOptions = {
  connections: [
    {
      id: 1,
      name: 'Ollama',
      model: 'qwen3:8b',
      host: 'host.docker.internal',
      locality: 'local',
      is_default: true,
    },
    {
      id: 2,
      name: 'Cloud',
      model: 'gpt-5-mini',
      host: 'api.openai.com',
      locality: 'external',
      is_default: false,
    },
  ],
  chosen_connection_id: 2,
  active_connection_id: 2,
  levels: [
    { id: 1, name: 'Assistenz', description: 'Erklärt nur.', selectable: true },
    { id: 2, name: 'Prüfen', description: 'Mit Freigabe.', selectable: true },
  ],
  chosen_level_id: null,
  active_level_id: 2,
}

test('the header shows the active connection, naming an external host, and the level', async () => {
  fakeApi({ ...signedIn({ role: 'user' }), 'GET /api/llm/options': options })
  renderAt('/', <ModelChoice />)

  const trigger = await screen.findByRole('button', { name: 'Modellunterstützung wählen' })
  expect(within(trigger).getByText('Cloud')).toBeInTheDocument()
  expect(within(trigger).getByText('extern · api.openai.com')).toBeInTheDocument()
  expect(within(trigger).getByText('Stufe: Prüfen')).toBeInTheDocument()
})

test('choosing a level sends only the level', async () => {
  const calls = fakeApi({
    ...signedIn({ role: 'user' }),
    'GET /api/llm/options': options,
    'PUT /api/llm/options': { ...options, chosen_level_id: 1, active_level_id: 1 },
  })
  renderAt('/', <ModelChoice />)

  await userEvent.click(await screen.findByRole('button', { name: 'Modellunterstützung wählen' }))
  expect(screen.getByRole('menuitemradio', { name: /Prüfen/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await userEvent.click(screen.getByRole('menuitemradio', { name: /Assistenz/ }))

  await vi.waitFor(() =>
    expect(calls.filter((c) => c.key === 'PUT /api/llm/options').map((c) => c.body)).toEqual([
      { level_id: 1 },
    ]),
  )
  expect(await screen.findByText('Stufe: Assistenz')).toBeInTheDocument()
})

test('without a connection the header says so; an administrator gets a link', async () => {
  const none = {
    ...options,
    connections: [],
    chosen_connection_id: null,
    active_connection_id: null,
  }
  fakeApi({ ...signedIn(), 'GET /api/llm/options': none })
  renderAt('/', <ModelChoice />)

  expect(await screen.findByText(/^Keine Modellanbindung eingerichtet/)).toBeInTheDocument()
  expect(await screen.findByRole('link', { name: 'einrichten' })).toHaveAttribute(
    'href',
    '/admin/modelle',
  )
})
