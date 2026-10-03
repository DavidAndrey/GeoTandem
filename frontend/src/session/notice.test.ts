import { expect, test } from 'vitest'
import type { DisplayLayer, SpatialRow } from '../analysis/model'
import type { SessionCheck } from '../api/client'
import { noticeOf } from './notice'
import type { OpenReport } from './store'

const stamp = (count: number, versions: Record<string, string>) => ({
  count,
  ids_hash: String(count),
  query_hash: 'q',
  data_versions: versions,
  stamped_at: '2026-10-03T12:02:00',
})
const check = (patch: Partial<SessionCheck> = {}): SessionCheck => ({
  identical: true,
  saved: stamp(10, { schulen: 'v1', strassen: 'v1' }),
  current: stamp(10, { schulen: 'v1', strassen: 'v1' }),
  changed_layers: [],
  missing_layers: [],
  error: null,
  state_matches: true,
  ...patch,
})
const report = (patch: Partial<OpenReport> = {}): OpenReport => ({
  name: 'Vorführung',
  check: check(),
  removed: { layers: [], rows: [], result: false },
  error: null,
  ...patch,
})
const titles: Record<string, string> = { schulen: 'Schulen', strassen: 'Strassen' }
const title = (name: string) => titles[name] ?? name
const road: SpatialRow = {
  id: 's1',
  kind: 'spatial',
  not: false,
  operator: 'near',
  layer: 'strassen',
  distance_m: 500,
  filter: null,
}
const roads: DisplayLayer = {
  id: 'strassen',
  source: { kind: 'catalog', layer: 'strassen' },
  visible: true,
  opacity: 1,
  symbology: null,
}

test('identical: a short notice that closes by itself (design C4)', () => {
  expect(noticeOf(report(), title)).toMatchObject({
    tone: 'ok',
    headline: 'Wiederhergestellt · 10 Treffer, identisch mit dem Speicherstand',
    autoClose: true,
    adopt: false,
  })
})

test('a new layer version with the same hits is identical but says so, and stays', () => {
  const notice = noticeOf(
    report({
      check: check({
        changed_layers: ['strassen'],
        current: stamp(10, { schulen: 'v1', strassen: 'v2' }),
      }),
    }),
    title,
  )
  expect(notice.tone).toBe('ok')
  expect(notice.autoClose).toBe(false)
  expect(notice.lines).toEqual([
    'Layer „Strassen" hat eine neue Fassung (v1 → v2).',
    'Die Treffer sind dieselben.',
  ])
})

test('a deviation names old and new count and the cause, and offers to adopt (design C4)', () => {
  const notice = noticeOf(
    report({
      check: check({
        identical: false,
        changed_layers: ['schulen'],
        current: stamp(12, { schulen: 'import-7', strassen: 'v1' }),
      }),
    }),
    title,
  )
  expect(notice).toMatchObject({
    tone: 'warn',
    headline: 'Ergebnis weicht ab: 10 → 12 Treffer',
    lines: ['Layer „Schulen" hat eine neue Fassung (v1 → import-7).'],
    adopt: true,
    autoClose: false,
  })
})

test('a removed condition is listed and the result counts as deviating (design C8, plan D5)', () => {
  const notice = noticeOf(
    report({
      removed: { layers: [roads], rows: [road], result: false },
      check: check({ identical: false, current: null, missing_layers: ['strassen'] }),
    }),
    title,
  )
  expect(notice.tone).toBe('warn')
  expect(notice.headline).toBe('Ergebnis weicht ab')
  expect(notice.lines).toEqual([
    'Layer „Strassen" ist nicht mehr verfügbar und wurde aus der Analyse genommen.',
    'Bedingung „≤ 500 m zu Strassen" entfernt: ihr Layer fehlt.',
  ])
})

test('without the result layer: no result, choose another (design C8)', () => {
  const notice = noticeOf(
    report({ removed: { layers: [], rows: [], result: true }, check: null }),
    title,
  )
  expect(notice).toMatchObject({
    tone: 'warn',
    headline: 'Der Ergebnis-Layer fehlt',
    chooseResult: true,
    adopt: false,
  })
})

test('state and query drifting apart is a deviation', () => {
  const notice = noticeOf(report({ check: check({ state_matches: false }) }), title)
  expect(notice.tone).toBe('warn')
  expect(notice.lines).toEqual([
    'Der gespeicherte Zustand ergibt nicht mehr genau die gespeicherte Abfrage.',
  ])
})

test('while checking, and when opening failed', () => {
  expect(noticeOf(report({ check: null }), title).tone).toBe('pending')
  expect(noticeOf(report({ error: 'Format 9' }), title)).toMatchObject({
    tone: 'error',
    lines: ['Format 9'],
  })
})
