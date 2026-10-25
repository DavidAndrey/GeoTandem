// The run pages in pseudo show no text that bypassed the catalog (plan E1.9,
// L7). Case ids and questions, connection, model, host and level names,
// hashes, codes and currencies are data.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../../App'
import { activate } from '../../i18n/i18n'
import { messages } from '../../locales/pseudo.po'
import {
  answerViews,
  behaviourAnswer,
  CONNECTIONS,
  LEVELS,
  refusedAnswers,
  RUN_COMPARISON,
  START_CASES,
} from '../../test/eval-mocks'
import { compactQuery } from '../../model/readable'
import { strays } from '../../test/pseudo'
import { renderAt } from '../../test/render'
import { LAYERS, runBackend, RUNS_URL } from '../../test/run-api'
import { poll } from './runs'
import { readings } from './words'

beforeEach(() => {
  activate('pseudo', messages)
  vi.stubGlobal('scrollTo', () => undefined)
  poll.ms = 50
})
afterEach(() => {
  activate('de')
  vi.unstubAllGlobals()
})

const ANSWERS = [...answerViews(), ...refusedAnswers(), behaviourAnswer()]

/** What "Technisch" shows: the JSON of references and answers, the raw text. */
const technical = [
  ...START_CASES.flatMap((c) => readings(c).map((g) => JSON.stringify(compactQuery(g), null, 2))),
  ...ANSWERS.flatMap((a) => [
    a.answer ? JSON.stringify(compactQuery(a.answer), null, 2) : '',
    a.raw ?? '',
  ]),
]

const DATA = [
  ...technical,
  ...START_CASES.flatMap((c) => [c.id, c.prompt, ...c.tags]),
  ...CONNECTIONS.flatMap((c) => [c.name, c.host, c.model]),
  ...LEVELS.levels.flatMap((l) => [l.name, l.system_prompt]),
  ...LAYERS.flatMap((l) => [l.name, l.title, ...l.attributes.map((a) => a.label ?? a.name)]),
  ...answerViews().flatMap((a) =>
    a.answer?.kind === 'query'
      ? [a.answer.explanation, ...(a.answer.assumptions ?? []).map((x) => x.text)]
      : [],
  ),
  ...[...refusedAnswers(), behaviourAnswer()].map((a) =>
    a.answer?.kind === 'query' ? a.answer.explanation : '',
  ),
  'bern-mittelland-2026-10-03',
  'model_unreadable',
  'USD',
  'admin',
  'GeoTandem',
  'Systemverwaltung',
  'MCP',
  'E4',
  'b20a',
  'c71a',
  '41d9',
  'none',
  'Bern',
  'bahnhof_name',
  'code',
  'query',
  'Nur Vorschlag',
].filter((x): x is string => Boolean(x))

const settle = async () => {
  await screen.findAllByRole('heading', { level: 2 })
  await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull())
}

test.each([
  ['V5.1', '/admin/bewertung'],
  ['V4.2', '/admin/bewertung/lauf/neu'],
  ['V6.1', '/admin/bewertung/lauf/14'],
  ['V6.2', '/admin/bewertung/lauf/13'],
  ['V6.5', '/admin/bewertung/lauf/12'],
  ['V6.6', '/admin/bewertung/lauf/13/gegen/12'],
])('%s %s', async (_state, path) => {
  runBackend({ 'POST /api/admin/evaluation/comparison': RUN_COMPARISON })
  renderAt(path, <App />)
  await settle()
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})

test('V5.2 the empty list', async () => {
  runBackend({ [`GET ${RUNS_URL}`]: { items: [], total: 0 } })
  renderAt('/admin/bewertung', <App />)
  await settle()
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})

test('V6.3 the label and V6.4 the prompt profile dialog', async () => {
  runBackend()
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13', <App />)
  await settle()
  for (const details of Array.from(document.querySelectorAll('summary'))) await user.click(details)
  await waitFor(() => expect(strays(DATA)).toEqual([]))
  // The first button of "Je Spalte": "Promptprofil übernehmen ▾" in pseudo.
  const menus = document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')
  await user.click(menus[menus.length - 2])
  const items = await screen.findAllByRole('menuitem')
  await user.click(items[3])
  await screen.findByRole('dialog')
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})

test.each([
  ['V7.2', 'n13-bahnhof-bern', 3, answerViews(), 1],
  ['V7.4', 'n13-bahnhof-bern', 1, refusedAnswers(), 0],
  ['V7.5', 'n15-je-gemeinde', 2, [behaviourAnswer()], 0],
])('%s a case in a run, an answer opened', async (_state, id, point, answers, open) => {
  runBackend({ [`GET ${RUNS_URL}/13/answers`]: answers })
  const user = userEvent.setup()
  renderAt(`/admin/bewertung/lauf/13/fall/${id}?punkt=${point}`, <App />)
  await settle()
  const toggles = await screen.findAllByRole('button', { expanded: false })
  const answerToggles = toggles.filter((b) => b.closest('tbody'))
  await user.click(answerToggles[open])
  for (const details of Array.from(document.querySelectorAll('summary'))) await user.click(details)
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})
