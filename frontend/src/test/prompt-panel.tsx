// Shared setup of the prompt-panel tests: the workplace on the fake API with
// the contract's layers and one connection, the stores reset.
import { act, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { useAnalysis } from '../analysis/store'
import type { LLMOptions, ModelActionView } from '../api/client'
import { useMapView } from '../map/view'
import { attribute, layer, signedIn } from './fixtures'
import { actionView } from './model-mocks'
import { fakeApi, renderAt } from './render'
import { Workplace } from '../workplace/Workplace'
import { useModel } from '../model/store'
import { useHandover } from '../model/panel/handover'
import { POLL_MS } from '../model/panel/poll'
import { PROMPT_INPUT, resetPanel } from '../model/panel/state'

export const LAYERS = [
  layer({
    name: 'schulen',
    title: 'Schulen',
    geometry_type: 'Point',
    feature_count: 137,
    attributes: [
      attribute({ name: 'typ', label: 'Schulstufe', data_type: 'text' }),
      attribute({ name: 'standorte', label: 'Standorte', data_type: 'integer' }),
    ],
  }),
  layer({
    name: 'strassen',
    title: 'Strassen',
    geometry_type: 'LineString',
    attributes: [attribute({ name: 'klasse', label: 'Strassenklasse', data_type: 'text' })],
  }),
  layer({
    name: 'gemeinden_steuern',
    title: 'Gemeinden · Steuern',
    attributes: [attribute({ name: 'steueranlage', label: 'Steueranlage', data_type: 'real' })],
  }),
]

export const LOCAL = {
  id: 1,
  name: 'Lokales Modell',
  model: 'qwen3:8b',
  host: 'host.docker.internal',
  locality: 'local' as const,
  is_default: true,
}
export const EXTERNAL = {
  id: 2,
  name: 'Extern',
  model: 'anbieter-large',
  host: 'api.anbieter.example',
  locality: 'external' as const,
  is_default: false,
}

export function llmOptions(active: number | null = 1): LLMOptions {
  return {
    connections: active === null ? [] : [LOCAL, EXTERNAL],
    chosen_connection_id: null,
    active_connection_id: active,
    levels: [
      { id: 1, name: 'Assistenz', description: '', selectable: true },
      { id: 2, name: 'Prüfen', description: '', selectable: true },
    ],
    chosen_level_id: null,
    active_level_id: 2,
  }
}

type Routes = Parameters<typeof fakeApi>[0]

/** The workplace's backend plus ``routes``; returns the recorded calls. */
export function backend(routes: Routes = {}, options: LLMOptions = llmOptions()) {
  return fakeApi({
    ...signedIn({ role: 'admin' }),
    'GET /api/layers': LAYERS,
    'GET /api/config/map': { basemap: null, extent_wgs84: [7.8, 46.8, 8, 47], max_features: 10000 },
    'GET /api/llm/options': options,
    'GET /api/queries': [],
    'GET /api/sessions': [],
    'POST /api/query': { type: 'FeatureCollection', features: [], query: {}, meta: {} },
    'POST /api/query/ids': { ids: [] },
    'POST /api/query/count': (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { queries: unknown[] }
      return { counts: body.queries.map(() => 10) }
    },
    ...routes,
  })
}

/** A fresh workplace with the three layers on the map, schools the result. */
export function resetStores() {
  useAnalysis.getState().reset()
  useModel.getState().reset()
  useHandover.setState({ open: null, failed: null })
  useMapView.getState().setActiveRow(null)
  resetPanel()
  const analysis = useAnalysis.getState()
  analysis.addLayer('gemeinden_steuern')
  analysis.addLayer('strassen')
  analysis.addLayer('schulen', true)
}

/** Timers under test control; the user events advance them. */
export function fakeTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

export const tick = (ms = POLL_MS) => act(() => vi.advanceTimersByTimeAsync(ms))

/** The workplace with the prompt panel open (found by id, so also in pseudo). */
export async function openPanel() {
  useModel.getState().setOpen(true)
  const view = renderAt('/', <Workplace />)
  const panel = await waitFor(() => {
    const found = document.getElementById('prompt-panel')
    if (!found) throw new Error('no prompt panel')
    return found
  })
  return { view, panel }
}

/** Types ``text`` into the prompt field and sends it with Ctrl+Enter. */
export async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  const field = document.getElementById(PROMPT_INPUT) as HTMLTextAreaElement
  await user.click(field)
  await user.paste(text)
  await user.keyboard('{Control>}{Enter}{/Control}')
}

/** Waits for the record to be thinking (P7): the answer card is busy. */
export const thinking = () =>
  waitFor(() => {
    if (!document.querySelector('article[aria-busy="true"]')) throw new Error('not thinking')
  })

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** The POST answers 202 with ``thinking``; the polls bring ``answers`` one by one, the last repeats. */
export function promptFlow(thinking: ModelActionView, ...answers: ModelActionView[]) {
  let polls = 0
  return {
    'POST /api/model/prompt': () => json(thinking, 202),
    [`GET /api/model/actions/${thinking.id}`]: () =>
      answers[Math.min(polls++, answers.length - 1)] as ModelActionView,
  }
}

/**
 * ``decide`` as the backend answers it (WP65, store.py): ``applied_by_hand``
 * belongs to ``proposal_only``; an adjusted query with it is refused with 400.
 */
export function decideRoute(id: number) {
  return {
    [`POST /api/model/actions/${id}/decide`]: (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as {
        decision: 'proposal_only' | 'adjusted'
        applied_by_hand?: boolean
        query?: ModelActionView['applied_query']
      }
      if (body.decision === 'adjusted' && body.applied_by_hand)
        return json({ code: 'bad_request', message: 'adjusted is not by hand', details: {} }, 400)
      return actionView('reference', {
        id,
        status: 'applied',
        decision: body.decision,
        applied_by_hand: body.applied_by_hand ?? false,
        applied_query: body.query ?? null,
        decided_at: '2026-10-10T14:07:00Z',
      })
    },
  }
}

export function done() {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
}
