// Shared setup of the prompt-panel tests: the workplace on the fake API with
// the contract's layers and one connection, the stores reset.
import { act, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { useAnalysis } from '../analysis/store'
import type { LLMOptions, ModelActionView, PlanEdit, RejectReason } from '../api/client'
import { useMapView } from '../map/view'
import { attribute, layer, signedIn } from './fixtures'
import {
  actionView,
  isFakeError,
  levelOption,
  modelServer,
  REPEAT_ID,
  type CaseId,
  type LevelName,
  type ModelServer,
} from './model-mocks'
import { fakeApi, renderAt } from './render'
import { Workplace } from '../workplace/Workplace'
import { resetModelState } from '../model/reset'
import { useModel } from '../model/store'
import { POLL_MS } from '../model/panel/poll'
import { PROMPT_INPUT } from '../model/panel/state'

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

/**
 * The account's options; the levels carry their matrix as WP72 assumes the
 * server will send it (``levelOption``). ``level``: the active one's id
 * (1 Assistenz, 2 Prüfen, 3 Teilautonom, 4 Automatisch).
 */
export function llmOptions(active: number | null = 1, level = 2): LLMOptions {
  return {
    connections: active === null ? [] : [LOCAL, EXTERNAL],
    chosen_connection_id: null,
    active_connection_id: active,
    levels: [levelOption('Assistenz'), levelOption('Prüfen'), levelOption('Teilautonom')],
    chosen_level_id: null,
    active_level_id: level,
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
    // 10 hits under any condition, all 137 without (the reference question's numbers).
    'POST /api/query/count': (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { queries: { where?: unknown }[] }
      return { counts: body.queries.map((q) => (q.where ? 10 : 137)) }
    },
    ...routes,
  })
}

/**
 * The enforcement routes of ``server`` for the records ``ids`` (WP70 as the
 * fake answers it, ``modelServer``); a ``FakeError`` becomes its error body.
 */
export function enforcement(server: ModelServer, ...ids: number[]): Routes {
  const answer = (value: unknown) =>
    isFakeError(value) ? json(value.body, value.status) : json(value)
  const body = (init: RequestInit | undefined) =>
    (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>
  return Object.fromEntries(
    ids.flatMap((id) => {
      const base = `/api/model/actions/${id}`
      return [
        [`POST ${base}/preview`, () => answer(server.preview(id))],
        [`POST ${base}/approve`, () => answer(server.approve(id))],
        [
          `POST ${base}/reject`,
          (init: RequestInit | undefined) =>
            answer(server.reject(id, (body(init).reason ?? null) as RejectReason | null)),
        ],
        [`POST ${base}/execute`, () => answer(server.execute(id))],
        [`POST ${base}/undo`, () => answer(server.undo(id))],
        [`POST ${base}/touched`, () => answer(server.touched(id))],
        [
          `POST ${base}/decide`,
          (init: RequestInit | undefined) =>
            answer(server.decide(id, body(init) as Parameters<ModelServer['decide']>[1])),
        ],
      ]
    }),
  )
}

/**
 * The tool-chain routes of ``server`` for the record ``id`` (WP75 as the fake
 * answers it, ``modelServer``: the rules and what they assume are listed
 * there), with the approval routes of ``enforcement``. The poll ``GET`` is the
 * server's: a running chain moves on one step per poll. ``POST /api/model/prompt``
 * answers 202 with ``thinking`` (P7); the first poll brings the plan.
 */
export function chainRoutes(server: ModelServer, thinking: ModelActionView): Routes {
  const id = thinking.id
  const base = `/api/model/actions/${id}`
  const answer = (value: unknown, status = 200) =>
    isFakeError(value) ? json(value.body, value.status) : json(value, status)
  return {
    ...enforcement(server, id),
    'POST /api/model/prompt': () => json(thinking, 202),
    [`GET ${base}`]: () => answer(server.poll(id)),
    [`POST ${base}/run`]: () => answer(server.run(id), 202),
    [`POST ${base}/abort`]: () => answer(server.abort(id)),
    [`POST ${base}/adopt`]: () => answer(server.adopt(id)),
    [`PATCH ${base}/plan`]: (init: RequestInit | undefined) =>
      answer(server.plan(id, JSON.parse(String(init?.body)) as PlanEdit)),
  }
}

/**
 * The comparison's routes of ``server`` (WP76 as the fake answers it,
 * ``modelServer``): ``compare`` of the records ``ids``, whose repeat brings
 * case ``answer``'s answer under ``level`` (the account's level now); each
 * repeat's poll, approval and chain routes (ids from ``REPEAT_ID`` on);
 * ``comparison`` named by any of them.
 */
export function compareRoutes(
  server: ModelServer,
  ids: number[],
  answer: CaseId,
  level: LevelName = 'Prüfen',
  repeats = 2,
): Routes {
  const result = (value: unknown, status = 200) =>
    isFakeError(value) ? json(value.body, value.status) : json(value, status)
  const repeatIds = Array.from({ length: repeats }, (_, i) => REPEAT_ID + i)
  return {
    ...enforcement(server, ...repeatIds),
    ...Object.fromEntries(
      ids.map((id) => [
        `POST /api/model/actions/${id}/compare`,
        () => result(server.compare(id, answer, level), 202),
      ]),
    ),
    ...Object.fromEntries(
      [...ids, ...repeatIds].map((id) => [
        `GET /api/model/actions/${id}/comparison`,
        () => result(server.comparison(id)),
      ]),
    ),
    ...Object.fromEntries(
      repeatIds.flatMap((id) => {
        const base = `/api/model/actions/${id}`
        return [
          [`GET ${base}`, () => result(server.poll(id))],
          [`POST ${base}/run`, () => result(server.run(id), 202)],
          [`POST ${base}/abort`, () => result(server.abort(id))],
          [`POST ${base}/adopt`, () => result(server.adopt(id))],
        ]
      }),
    ),
  }
}

/** A fresh workplace with the three layers on the map, schools the result. */
export function resetStores() {
  useAnalysis.getState().reset()
  resetModelState()
  useMapView.getState().setActiveRow(null)
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

/** The decision a record in a final status carries (store.py ``DECIDED``). */
const DECIDED_AS: Partial<Record<ModelActionView['status'], ModelActionView['decision']>> = {
  applied: 'accepted',
  rejected: 'rejected',
  superseded: 'superseded',
  undone: 'accepted',
  aborted: 'aborted',
  failed: 'failed',
}

/**
 * ``decide`` as the server answers it (WP65, store.py; ``modelServer``): only a
 * record still ``proposed`` is decided, once; ``not_approved`` for a record
 * not there yet (``thinking``, ``approved``), ``already_decided`` for a
 * decided or final one; ``applied_by_hand`` belongs to ``proposal_only``, and
 * ``adjusted`` names its query (else 400). Under *Assistenz* by default: ``proposal_only``
 * belongs to a level with ``off`` parts (WP71), any other answers ``not_approved``.
 */
export function decideRoute(
  id: number,
  status: ModelActionView['status'] = 'proposed',
  levelName: LevelName = 'Assistenz',
) {
  const server = modelServer([
    actionView('reference', { id, status, decision: DECIDED_AS[status] ?? null }, levelName),
  ])
  return {
    [`POST /api/model/actions/${id}/decide`]: (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as Parameters<ModelServer['decide']>[1]
      const answer = server.decide(id, body)
      return isFakeError(answer) ? json(answer.body, answer.status) : json(answer)
    },
  }
}

export function done() {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
}
