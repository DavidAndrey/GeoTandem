// The list of runs (design V5) and the new run (V4, plan WP93): against the
// fake API with the eval mocks.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../../App'
import type { RunPage, RunRequest } from '../../api/client'
import { CONNECTIONS, COST_ESTIMATE, runPage, runView } from '../../test/eval-mocks'
import { formatNumber } from '../../i18n/locale'
import { renderAt } from '../../test/render'
import { refused, runBackend, RUNS_URL } from '../../test/run-api'
import { poll } from './runs'

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined)
  poll.ms = 20
})
afterEach(() => vi.unstubAllGlobals())

/** The runs without the running #14: nothing blocks a start. */
const idle = (): RunPage => {
  const items = runPage().items.filter((r) => r.status !== 'running')
  return { items, total: items.length }
}

/** "Lauf starten" at the top (design) and again after the confirmation; both act alike. */
const startButtons = () => {
  const [top, bottom] = screen.getAllByRole('button', { name: 'Lauf starten' })
  expect(bottom.hasAttribute('disabled')).toBe(top.hasAttribute('disabled'))
  return top
}

const estimates = (calls: { key: string; body: unknown }[]) =>
  calls.filter((c) => c.key === `POST ${RUNS_URL}/estimate`).map((c) => c.body as RunRequest)

// --- V5 -------------------------------------------------------------------------------

test('V5.1: the runs with status, the reference rate and the cost', async () => {
  runBackend()
  renderAt('/admin/bewertung', <App />)
  const row13 = (await screen.findByRole('link', { name: '#13' })).closest('tr')
  if (!row13) throw new Error('no row')
  expect(within(row13).getByText('fertig').closest('[data-line]')).toHaveAttribute(
    'data-line',
    'applied',
  )
  expect(within(row13).getByText('84.8 %')).toBeInTheDocument()
  expect(within(row13).getByText('2.08 USD')).toBeInTheDocument()
  expect(
    within(row13).getByText('4 Messpunkte · 71 Fälle · Beispieldaten · Vollständig'),
  ).toBeInTheDocument()
  const row14 = screen.getByRole('link', { name: '#14' }).closest('tr')
  if (!row14) throw new Error('no row')
  // The running run's label follows its progress (1164 of 2840).
  expect(await within(row14).findByText('· 41 %')).toBeInTheDocument()
  expect(within(row14).getByText('0.84 USD bisher')).toBeInTheDocument()
  const row12 = screen.getByRole('link', { name: '#12' }).closest('tr')
  expect(within(row12 as HTMLElement).getByText('· Schnelltest')).toBeInTheDocument()
  const row10 = screen.getByRole('link', { name: '#10' }).closest('tr')
  expect(
    within(row10 as HTMLElement)
      .getByText('unterbrochen')
      .closest('[data-line]'),
  ).toHaveAttribute('data-line', 'void')
})

test('V5.1: two complete runs over the same cases are put side by side, others not', async () => {
  runBackend()
  const user = userEvent.setup()
  renderAt('/admin/bewertung', <App />)
  const compare = await screen.findByRole('button', { name: 'Gegenüberstellen' })
  expect(compare).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: 'Lauf #13 markieren' }))
  await user.click(screen.getByRole('checkbox', { name: 'Lauf #10 markieren' }))
  expect(compare).toBeDisabled()
  expect(screen.getByText(/#10 ist nicht vollständig/)).toBeInTheDocument()
  // A third mark replaces the older one: #10 out, #12 in.
  await user.click(screen.getByRole('checkbox', { name: 'Lauf #12 markieren' }))
  expect(screen.getByRole('checkbox', { name: 'Lauf #13 markieren' })).not.toBeChecked()
  await user.click(screen.getByRole('checkbox', { name: 'Lauf #13 markieren' }))
  expect(compare).toBeEnabled()
})

test('V5.2: no runs yet proposes the smallest first run', async () => {
  runBackend({ [`GET ${RUNS_URL}`]: { items: [], total: 0 } })
  renderAt('/admin/bewertung', <App />)
  expect(await screen.findByText('Noch keine Bewertung')).toBeInTheDocument()
  expect(screen.getByText(/Startbestand, eine Anbindung, Schnelltest/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Neuer Lauf' })).toHaveAttribute(
    'href',
    '/admin/bewertung/lauf/neu?umfang=schnell',
  )
})

// --- V4 -------------------------------------------------------------------------------

test('V4.1: the estimate follows every change at once', async () => {
  const calls = runBackend({ [`GET ${RUNS_URL}`]: idle() })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/neu?umfang=schnell', <App />)
  expect(await screen.findByRole('heading', { name: 'Neuer Lauf' })).toBeInTheDocument()
  // The smallest first run: the default connection, the start set, a quick test.
  await waitFor(() => expect(estimates(calls)).toHaveLength(1))
  expect(estimates(calls)[0]).toMatchObject({
    points: [{ connection_id: 1, prompt_profile: null, level_id: 2, system_prompt: null }],
    cases: { origins: ['start'], split: null, tags: [] },
    data_state: 'sample',
    scope: 'quick',
  })
  const table = await screen.findByRole('table', { name: 'Abschätzung' })
  expect(within(table).getByText('Zusammen')).toBeInTheDocument()
  expect(screen.getByText(formatNumber(2840))).toBeInTheDocument()
  expect(screen.getByText('8.5 Mio')).toBeInTheDocument()
  expect(screen.getByText('≈ 2.08 USD')).toBeInTheDocument()
  expect(screen.getByText('lokal · kein Preis')).toBeInTheDocument()
  expect(screen.getByText('(parallel je Anbindung)')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Vollständig · 2 × 5' }))
  await waitFor(() => expect(estimates(calls).at(-1)?.scope).toBe('full'))
  await user.click(screen.getByRole('button', { name: 'Bestätigung' }))
  await waitFor(() => expect(estimates(calls).at(-1)?.cases?.split).toBe('confirm'))
  await user.click(screen.getByRole('button', { name: '+ Messpunkt' }))
  await waitFor(() => expect(estimates(calls).at(-1)?.points).toHaveLength(2))
  await user.click(screen.getAllByRole('radio')[1])
  await waitFor(() => expect(estimates(calls).at(-1)?.reference).toBe(1))
})

test('V4.1: an external host needs the confirmation; it is sent as confirm_external', async () => {
  const calls = runBackend({
    [`GET ${RUNS_URL}`]: idle(),
    [`POST ${RUNS_URL}`]: { ...runView('running'), id: 15 },
    [`GET ${RUNS_URL}/15`]: { ...runView('running'), id: 15 },
  })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  await screen.findByText(/Steckbrief und Fragen gehen an/)
  expect(screen.getByText('api.anthropic.com und api.openai.com')).toBeInTheDocument()
  const start = startButtons()
  expect(start).toBeDisabled()
  expect(screen.getByText('Ohne Haken bleibt „Lauf starten“ gesperrt.')).toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: 'Verstanden, extern senden' }))
  await waitFor(() => expect(start).toBeEnabled())
  await user.click(start)
  const sent = calls.find((c) => c.key === `POST ${RUNS_URL}`)?.body as RunRequest
  expect(sent.confirm_external).toEqual([2, 3])
  expect(await screen.findByRole('heading', { name: 'Lauf #15' })).toBeInTheDocument()
})

test('V4.2: while a run runs, starting is locked with a link to it', async () => {
  runBackend()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  expect(await screen.findByText('Ein Lauf läuft schon')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Lauf #14 ansehen ›' })).toHaveAttribute(
    'href',
    '/admin/bewertung/lauf/14',
  )
  expect(await screen.findByText(/admin, seit .*, 41 %/)).toBeInTheDocument()
  await user().click(screen.getByRole('checkbox', { name: 'Verstanden, extern senden' }))
  expect(startButtons()).toBeDisabled()
})

const user = () => userEvent.setup()

test('run_busy at the start says which run holds the instance', async () => {
  runBackend({
    [`GET ${RUNS_URL}`]: idle(),
    [`POST ${RUNS_URL}`]: () => refused(409, 'run_busy', { run: 14, reason: 'finishing' }),
  })
  const u = user()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  await u.click(await screen.findByRole('checkbox', { name: 'Verstanden, extern senden' }))
  const start = startButtons()
  await waitFor(() => expect(start).toBeEnabled())
  await u.click(start)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Lauf #14 ist abgebrochen und wartet noch auf die letzte Antwort',
  )
})

test('no_cases: a selection without a runnable case cannot start', async () => {
  runBackend({
    [`GET ${RUNS_URL}`]: idle(),
    [`POST ${RUNS_URL}/estimate`]: () => refused(400, 'no_cases'),
  })
  renderAt('/admin/bewertung/lauf/neu', <App />)
  expect(await screen.findByText(/Keiner der gewählten Prüffälle kann laufen/)).toHaveAttribute(
    'role',
    'alert',
  )
  expect(startButtons()).toBeDisabled()
})

test('V4.1: own cases run on live data, apart from the start set', async () => {
  const calls = runBackend({ [`GET ${RUNS_URL}`]: idle() })
  const u = user()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  const own = await screen.findByRole('checkbox', { name: /Eigene/ })
  // With the start set checked, own live cases are greyed out with the reason.
  expect(own).toBeDisabled()
  expect(
    screen.getByText(/ein Lauf hat einen Datenstand, der Startbestand die Beispieldaten/),
  ).toBeInTheDocument()
  await u.click(screen.getByRole('checkbox', { name: 'Startbestand (71)' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Wählen Sie Startbestand oder eigene Fälle.',
  )
  await u.click(screen.getByRole('checkbox', { name: /Eigene/ }))
  await waitFor(() =>
    expect(estimates(calls).at(-1)).toMatchObject({
      cases: { origins: ['authored', 'import', 'log'] },
      data_state: 'live',
    }),
  )
  // Two own live cases run (the stale one is left out); the start set is now the greyed one.
  expect(screen.getByRole('checkbox', { name: 'Startbestand (71)' })).toBeDisabled()
})

test("a point starts on the connection's own prompt profile; another one is sent explicitly", async () => {
  const p9 = { examples: 'standard', placement: 'P9', output: 'constrained' } as const
  const connections = CONNECTIONS.map((c) => (c.id === 1 ? { ...c, prompt_profile: p9 } : c))
  const calls = runBackend({
    [`GET ${RUNS_URL}`]: idle(),
    'GET /api/admin/llm/connections': connections,
  })
  const u = user()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  const placement = await screen.findByRole('combobox', { name: 'Platzierung von Messpunkt 1' })
  // The connection's own profile is shown and sent as null ("as in operation").
  expect(placement).toHaveValue('P9')
  await waitFor(() => expect(estimates(calls).at(-1)?.points[0].prompt_profile).toBeNull())
  await u.selectOptions(placement, 'P0')
  await waitFor(() =>
    expect(estimates(calls).at(-1)?.points[0].prompt_profile).toEqual({ ...p9, placement: 'P0' }),
  )
  await u.selectOptions(placement, 'P9')
  await waitFor(() => expect(estimates(calls).at(-1)?.points[0].prompt_profile).toBeNull())
})

test('V4.1: a system prompt copy for this run only', async () => {
  const calls = runBackend({ [`GET ${RUNS_URL}`]: idle() })
  const u = user()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  await u.click(await screen.findByRole('button', { name: 'System-Prompt ändern' }))
  const box = screen.getByRole('textbox', { name: /System-Prompt für diesen Lauf/ })
  expect(box).toHaveValue('Du übersetzt Fragen in Abfragen für GeoTandem. Nenne jede Annahme.')
  expect(screen.getByText('Noch wie im Betrieb (Stufe Prüfen).')).toBeInTheDocument()
  await u.type(box, ' Antworte knapp.')
  await waitFor(() =>
    expect(estimates(calls).at(-1)?.points[0].system_prompt).toBe(
      'Du übersetzt Fragen in Abfragen für GeoTandem. Nenne jede Annahme. Antworte knapp.',
    ),
  )
  await u.click(screen.getByRole('button', { name: 'auf Betrieb zurücksetzen' }))
  await waitFor(() => expect(estimates(calls).at(-1)?.points[0].system_prompt).toBeNull())
})

test('"Als vollständigen Lauf wiederholen" opens V4 with the quick test\'s request, full', async () => {
  const calls = runBackend({ [`GET ${RUNS_URL}`]: idle() })
  const u = user()
  renderAt('/admin/bewertung/lauf/12', <App />)
  await u.click(await screen.findByRole('link', { name: 'Als vollständigen Lauf wiederholen' }))
  expect(await screen.findByRole('heading', { name: 'Neuer Lauf' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Vollständig · 2 × 5' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await waitFor(() => expect(estimates(calls).length).toBeGreaterThan(0))
  const asked = estimates(calls).at(-1)
  const request = runView('done', 'quick').request
  expect(asked).toMatchObject({ scope: 'full', reference: request.reference })
  // The quick test's points; the default profiles stay the connections' own (null).
  expect(asked?.points.map((p) => p.connection_id)).toEqual([1, 2, 3, 3])
  expect(asked?.points[3].prompt_profile).toEqual({
    examples: 'standard',
    placement: 'P9',
    output: 'constrained',
  })
  expect(asked?.points[1].prompt_profile).toEqual({
    examples: 'standard',
    placement: 'P0',
    output: 'text',
  })
})

test('repeating sends the profile each point measured, even if the connection changed since', async () => {
  const p9 = { examples: 'standard', placement: 'P9', output: 'constrained' } as const
  const connections = CONNECTIONS.map((c) => (c.id === 3 ? { ...c, prompt_profile: p9 } : c))
  const calls = runBackend({
    [`GET ${RUNS_URL}`]: idle(),
    'GET /api/admin/llm/connections': connections,
  })
  renderAt('/admin/bewertung/lauf/neu?von=12', <App />)
  await waitFor(() => expect(estimates(calls).length).toBeGreaterThan(0))
  const points = estimates(calls).at(-1)?.points ?? []
  // Luna P0 was measured; the connection is on P9 now: P0 is sent, not null.
  expect(points[2].prompt_profile).toEqual({ ...p9, placement: 'P0' })
  // Luna P9 is the connection's own now: null.
  expect(points[3].prompt_profile).toBeNull()
})

test('the estimate waits for the changes to settle: several changes, one request', async () => {
  const calls = runBackend({ [`GET ${RUNS_URL}`]: idle() })
  const u = user()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  await waitFor(() => expect(estimates(calls)).toHaveLength(1))
  await u.click(screen.getByRole('button', { name: 'Schnelltest · 1 × 5' }))
  await u.click(screen.getByRole('button', { name: 'Abstimmung' }))
  await u.click(screen.getByRole('button', { name: 'Bestätigung' }))
  await waitFor(() => expect(estimates(calls)).toHaveLength(2))
  expect(estimates(calls)[1]).toMatchObject({ scope: 'quick', cases: { split: 'confirm' } })
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(estimates(calls)).toHaveLength(2)
})

test('another set of external hosts asks for the confirmation again', async () => {
  runBackend({
    [`GET ${RUNS_URL}`]: idle(),
    [`POST ${RUNS_URL}/estimate`]: (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as RunRequest
      return body.points.length > 1
        ? { ...COST_ESTIMATE, external_hosts: ['api.anthropic.com', 'api.openai.com', 'x.ai'] }
        : COST_ESTIMATE
    },
  })
  const u = user()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  const box = await screen.findByRole('checkbox', { name: 'Verstanden, extern senden' })
  await u.click(box)
  await waitFor(() => expect(startButtons()).toBeEnabled())
  await u.click(screen.getByRole('button', { name: '+ Messpunkt' }))
  expect(await screen.findByText(/x\.ai/)).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Verstanden, extern senden' })).not.toBeChecked()
  expect(startButtons()).toBeDisabled()
})

test('without a case origin no stale estimate is shown', async () => {
  runBackend({ [`GET ${RUNS_URL}`]: idle() })
  const u = user()
  renderAt('/admin/bewertung/lauf/neu', <App />)
  await screen.findByRole('table', { name: 'Abschätzung' })
  await u.click(screen.getByRole('checkbox', { name: 'Startbestand (71)' }))
  expect(screen.queryByRole('table', { name: 'Abschätzung' })).toBeNull()
  expect(screen.queryByText(/Steckbrief und Fragen gehen an/)).toBeNull()
})
