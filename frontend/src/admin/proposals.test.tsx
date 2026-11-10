import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import type { LLMOptions, LayerInfo, ProposalResult } from '../api/client'
import { attribute, layer } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { LayerPage } from './LayerPage'

afterEach(() => vi.unstubAllGlobals())

const gemeinden = layer({
  description: '',
  attributes: [
    attribute({ label: '', description: '' }),
    attribute({ name: 'gem_nr', label: 'Gemeindenummer', description: '' }),
    attribute({ name: 'name', data_type: 'text', label: 'Name', description: 'Amtlicher Name.' }),
  ],
})

const options: LLMOptions = {
  connections: [
    {
      id: 1,
      name: 'Lokal',
      model: 'qwen3:14b',
      host: '127.0.0.1',
      locality: 'local',
      is_default: true,
    },
  ],
  chosen_connection_id: null,
  active_connection_id: 1,
  levels: [],
  chosen_level_id: null,
  active_level_id: 1,
}

const result: ProposalResult = {
  layer: 'gemeinden',
  layer_description: 'Politische Gemeinden des Kantons.',
  attributes: [
    {
      name: 'einwohner',
      label: 'Einwohner',
      description: 'Zahl der Einwohnerinnen und Einwohner.',
    },
    // A label the catalog has: never put over it, even if the server sent one.
    { name: 'gem_nr', label: 'Anders', description: 'Amtliche Nummer der Gemeinde.' },
  ],
  connection: { id: 1, name: 'Lokal', model: 'qwen3:14b', host: '127.0.0.1', locality: 'local' },
  proposed_at: '2026-11-08T09:00:00',
  latency_ms: 3100,
  prompt_tokens: 800,
  completion_tokens: 120,
}

function page(info: LayerInfo, tab = 'felder') {
  renderAt(
    `/admin/daten/gemeinden?reiter=${tab}`,
    <Routes>
      <Route path="/admin/daten/:layer" element={<LayerPage />} />
    </Routes>,
  )
  return info
}

test('proposals fill empty fields as drafts, and only saving takes them', async () => {
  const calls = fakeApi({
    'GET /api/layers/gemeinden': gemeinden,
    'GET /api/llm/options': options,
    'GET /api/admin/visibility': [],
    'POST /api/admin/layers/gemeinden/proposals': result,
    'PATCH /api/admin/layers/gemeinden/attributes/einwohner': attribute({ label: 'Einwohner' }),
  })
  page(gemeinden)

  await userEvent.click(await screen.findByRole('button', { name: 'Vorschläge erzeugen' }))

  expect(await screen.findByText('2 Felder mit Vorschlag')).toBeInTheDocument()
  expect(calls.find((c) => c.key.endsWith('/proposals'))?.body).toEqual({ connection_id: 1 })
  expect(screen.getByLabelText('Bezeichnung einwohner')).toHaveValue('Einwohner')
  expect(screen.getByLabelText('Bezeichnung gem_nr')).toHaveValue('Gemeindenummer')
  expect(screen.getByDisplayValue('Amtliche Nummer der Gemeinde.')).toBeInTheDocument()
  expect(screen.getAllByText('Vorschlag des Modells, noch nicht gespeichert')).toHaveLength(3)
  expect(calls.some((c) => c.key.startsWith('PATCH'))).toBe(false)

  await userEvent.click(screen.getAllByRole('button', { name: 'Speichern' })[0] as HTMLElement)

  const saved = calls.find((c) => c.key.endsWith('/attributes/einwohner'))
  expect(saved?.body).toMatchObject({
    label: 'Einwohner',
    description: 'Zahl der Einwohnerinnen und Einwohner.',
  })
})

test('a proposed layer description waits on «Beschreibung»', async () => {
  fakeApi({
    'GET /api/layers/gemeinden': gemeinden,
    'GET /api/llm/options': options,
    'GET /api/admin/visibility': [],
    'POST /api/admin/layers/gemeinden/proposals': result,
  })
  page(gemeinden)

  await userEvent.click(await screen.findByRole('button', { name: 'Vorschläge erzeugen' }))
  await screen.findByText(/Layer-Beschreibung/)
  await userEvent.click(screen.getByRole('tab', { name: 'Beschreibung' }))

  expect(screen.getByLabelText('Beschreibung für Mensch und Modell')).toHaveValue(
    'Politische Gemeinden des Kantons.',
  )
  expect(screen.getByText('Vorschlag des Modells, noch nicht gespeichert')).toBeInTheDocument()
})

test('a complete layer offers no proposals', async () => {
  const complete = layer({
    description: 'Gemeinden.',
    attributes: [attribute({ label: 'Einwohner', description: 'Zahl der Einwohner.' })],
  })
  fakeApi({
    'GET /api/layers/gemeinden': complete,
    'GET /api/llm/options': options,
  })
  page(complete)

  expect(await screen.findByLabelText('Bezeichnung einwohner')).toHaveValue('Einwohner')
  expect(screen.queryByRole('button', { name: 'Vorschläge erzeugen' })).toBeNull()
})
