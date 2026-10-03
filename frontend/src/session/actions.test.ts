import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resultQuery } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { newAttributeRow } from '../analysis/tree'
import { fakeApi } from '../test/render'
import { assertValidQuery } from '../test/schema'
import { NameTaken, newSession, openSession, saveSession, saveSessionAs } from './actions'
import { STATE_VERSION } from './format'
import { useSession } from './store'

interface Sent {
  name: string
  state_version: number
  state: { tree: { children: unknown[] } }
  query: unknown
}

const stamp = {
  count: 3,
  ids_hash: 'h',
  query_hash: 'q',
  data_versions: { schulen: 'v1' },
  stamped_at: '2026-10-03T14:02:00',
}

function detail(patch: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'Vorführung',
    note: '',
    result_layer: 'schulen',
    stamp,
    data_changed: false,
    created_at: '2026-10-03T14:00:00',
    updated_at: '2026-10-03T14:02:00',
    opened_at: null,
    state_version: STATE_VERSION,
    state: {},
    query: null,
    ...patch,
  }
}

function build() {
  const s = useAnalysis.getState()
  s.addLayer('schulen')
  s.addLayer('strassen')
  s.edit()
  s.addNode('root', { ...newAttributeRow('typ'), operator: 'in', values: ['primar'] })
  s.apply()
}

beforeEach(() => {
  newSession()
})
afterEach(() => vi.unstubAllGlobals())

test('"Speichern unter" sends the state and the result query; then nothing is unsaved', async () => {
  build()
  const calls = fakeApi({ 'POST /api/sessions': (init) => detail(JSON.parse(String(init?.body))) })
  await saveSessionAs('Vorführung', 'Notiz')
  const sent = calls.find((c) => c.key === 'POST /api/sessions')?.body as Sent
  expect(sent.name).toBe('Vorführung')
  expect(sent.state_version).toBe(STATE_VERSION)
  expect(sent.query).toEqual(resultQuery(currentAnalysis(useAnalysis.getState())))
  assertValidQuery(sent.query)
  expect(sent.state.tree.children).toHaveLength(1)
  expect(useAnalysis.getState().dirty).toBe(false)
  expect(useSession.getState().current).toMatchObject({ id: 's1', name: 'Vorführung' })
})

test('an open editor draft is not saved (plan D8)', async () => {
  build()
  useAnalysis.getState().edit()
  useAnalysis.getState().addNode('root', newAttributeRow('name'))
  const calls = fakeApi({ 'POST /api/sessions': () => detail() })
  await saveSessionAs('Vorführung', '')
  const sent = calls[0]?.body as Sent
  expect(sent.state.tree.children).toHaveLength(1)
  expect(useAnalysis.getState().draft?.children).toHaveLength(2)
})

test('a taken name is reported with the session to overwrite', async () => {
  build()
  fakeApi({
    'POST /api/sessions': new Response(
      JSON.stringify({ code: 'name_taken', message: 'x', details: { existing: 's9' } }),
      { status: 409 },
    ),
  })
  await expect(saveSessionAs('Vorführung', '')).rejects.toEqual(new NameTaken('s9'))
  expect(useAnalysis.getState().dirty).toBe(true)
})

test('"Speichern" overwrites the current session', async () => {
  build()
  useSession
    .getState()
    .setCurrent({ id: 's1', name: 'Vorführung', note: '', savedAt: '', stamp: null })
  const calls = fakeApi({ 'PUT /api/sessions/s1': () => detail() })
  await saveSession()
  expect(calls.map((c) => c.key)).toEqual(['PUT /api/sessions/s1'])
  expect(useAnalysis.getState().dirty).toBe(false)
})

test('opening loads the state, fits it to today and checks it (design C4, C8)', async () => {
  build()
  const saved = useAnalysis.getState()
  const state = {
    layers: saved.layers,
    result: saved.result,
    tree: saved.tree,
    restriction: null,
    table: saved.table,
    view: [7.3, 46.9, 7.5, 47],
  }
  newSession()
  const check = {
    identical: true,
    saved: stamp,
    current: stamp,
    changed_layers: [],
    missing_layers: [],
    state_matches: true,
  }
  const calls = fakeApi({ 'POST /api/sessions/s1/check': check })
  await openSession(detail({ state }), new Set(['schulen']))
  const loaded = useAnalysis.getState()
  expect(loaded.layers.map((l) => l.id)).toEqual(['schulen'])
  expect(loaded.dirty).toBe(false)
  const sent = calls[0]?.body as { rebuilt: unknown; has_result: boolean }
  expect(sent.rebuilt).toEqual(resultQuery(currentAnalysis(loaded)))
  expect(useSession.getState().report).toMatchObject({
    check,
    removed: { layers: [{ id: 'strassen' }], rows: [], result: false },
  })
})

test('an unknown format opens nothing and says so', async () => {
  build()
  fakeApi({})
  await openSession(detail({ state_version: 99 }), new Set(['schulen']))
  expect(useAnalysis.getState().layers).toEqual([])
  expect(useSession.getState().current).toBeNull()
  expect(useSession.getState().report?.error).toMatch(/Format 99/)
})
