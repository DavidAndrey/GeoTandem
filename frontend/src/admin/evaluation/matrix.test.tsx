// The matrix of a run (design V6, plan WP93): running, polled until done,
// abort, the column heads, still falsch, the label, the prompt profile dialog,
// the quick test, a failed run, the keyboard, two runs side by side.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../../App'
import type { RunView } from '../../api/client'
import { RUN_COMPARISON, runView } from '../../test/eval-mocks'
import { renderAt } from '../../test/render'
import { refused, runBackend, RUNS_URL } from '../../test/run-api'
import { poll } from './runs'

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined)
  poll.ms = 20
})
afterEach(() => vi.unstubAllGlobals())

const matrix = () => screen.findByRole('table', { name: 'Matrix: Prüffälle × Messpunkte' })

/** The column heads after the row head "Prüffall". */
const heads = async () => (await within(await matrix()).findAllByRole('columnheader')).slice(1)

test('V6.1: while running, progress as status, cells fill, no column figures yet', async () => {
  runBackend()
  renderAt('/admin/bewertung/lauf/14', <App />)
  const status = await screen.findByText(/von .* Antworten/)
  expect(status.closest('[role="status"]')).not.toBeNull()
  expect(status.closest('[role="status"]')).toHaveTextContent(/41 % · seit .* · bisher 0.84 USD/)
  const columns = await heads()
  expect(columns).toHaveLength(4)
  for (const head of columns) {
    expect(head).toHaveTextContent('läuft …')
    expect(head).not.toHaveTextContent('%')
  }
  expect(screen.queryByText('Vergleichsbasis')).toBeNull()
  // The first cells are in, the rest wait.
  expect(
    screen.getAllByRole('link', { name: /Welche Primarschulen gibt es in Köniz\? bei/ }),
  ).toHaveLength(4)
})

test('V6.1 → V6.2: the run is polled until it is done; then the heads appear', async () => {
  let asked = 0
  runBackend({
    [`GET ${RUNS_URL}/14`]: () => {
      asked += 1
      return asked < 3 ? runView('running') : { ...runView('done'), id: 14 }
    },
  })
  renderAt('/admin/bewertung/lauf/14', <App />)
  expect(await screen.findByText('Vergleichsbasis', {}, { timeout: 3000 })).toBeInTheDocument()
  expect(asked).toBeGreaterThanOrEqual(3)
  expect(screen.queryByRole('button', { name: 'Abbrechen' })).toBeNull()
})

test('V6.1: abort asks first, then stops the run', async () => {
  const calls = runBackend({
    [`POST ${RUNS_URL}/14/abort`]: { ...runView('running'), status: 'aborted' } satisfies RunView,
  })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/14', <App />)
  await user.click(await screen.findByRole('button', { name: 'Abbrechen' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('Der Lauf hält vor der nächsten Frage an.')
  await user.click(within(dialog).getByRole('button', { name: 'Lauf abbrechen' }))
  await waitFor(() => expect(calls.some((c) => c.key === `POST ${RUNS_URL}/14/abort`)).toBe(true))
  expect(await screen.findByText(/^Abgebrochen\./)).toBeInTheDocument()
  expect(screen.getByText('abgebrochen').closest('[data-line]')).toHaveAttribute(
    'data-line',
    'void',
  )
})

test('V6.2: column heads with the rate on Abstimmung and the comparison on Bestätigung', async () => {
  runBackend()
  renderAt('/admin/bewertung/lauf/13', <App />)
  const [gemma, haiku, luna, lunaP9] = await heads()
  expect(gemma).toHaveTextContent('82.4 %')
  expect(gemma).toHaveTextContent('272 von 330')
  expect(gemma).toHaveTextContent('still falsch 14 · nicht lesbar 6')
  expect(gemma).toHaveTextContent('Verhalten 44 von 50')
  expect(gemma).toHaveTextContent('1.4 s · 3.1 s · lokal')
  expect(gemma).toHaveTextContent('nicht belegt · -3.7 Punkte (-15.8 … +7.6)')
  expect(haiku).toHaveTextContent('besser · +13.7 Punkte (+6.1 … +21.0)')
  expect(haiku).toHaveTextContent('0.92 USD')
  // The reference column: marked by a line on top and the word.
  expect(luna).toHaveAttribute('data-reference', 'true')
  expect(luna).toHaveTextContent('Vergleichsbasis')
  expect(lunaP9).toHaveTextContent('besser')
  expect(screen.getByRole('link', { name: 'Exportieren' })).toHaveAttribute(
    'href',
    '/api/admin/evaluation/runs/13/export',
  )
})

test('V6.2: rows grouped by tag with sums; still falsch as dashed frame, "!" and text', async () => {
  runBackend()
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13', <App />)
  const table = await matrix()
  const groups = within(table)
    .getAllByRole('rowheader')
    .filter((h) => h.getAttribute('scope') === 'rowgroup')
  expect(groups.map((g) => g.textContent)).toContain('räumlich · 14 Fälle')
  const spatial = groups.find((g) => g.textContent === 'räumlich · 14 Fälle')?.closest('tbody')
  if (!spatial) throw new Error('no group')
  await user.click(within(spatial).getByRole('button', { name: '▸ 12 weitere' }))
  const cell = within(spatial).getByRole('link', {
    name: 'Schulen im Umkreis von 1 km um den Bahnhof Bern bei gpt-6-luna P9: 4 von 10',
  })
  expect(cell).toHaveTextContent('4 von 10 · 6 f')
  const mark = within(cell).getByText('6 still falsch').closest('[data-mark]')
  expect(mark).toHaveAttribute('data-mark', 'silently-wrong')
  expect(mark).toHaveClass('border-dashed')
  expect(mark).toHaveTextContent('!')
  // The Bestätigung part shows its own rows.
  await user.click(screen.getByRole('button', { name: 'Bestätigung' }))
  expect(within(await matrix()).queryByText('n13-bahnhof-bern')).toBeNull()
})

test("V6.3: the run's label with the state of the profile and every point", async () => {
  runBackend()
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13', <App />)
  await user.click(await screen.findByText('Beschriftung des Laufs'))
  expect(screen.getByText('Abfrageschema v2 · Bewertungsregeln v1')).toBeInTheDocument()
  expect(screen.getByText('bern-mittelland-2026-10-03')).toBeInTheDocument()
  expect(
    screen.getByText(/Beschriftungen 100 % · Codelisten 66 % · Beschreibungen 100 %/),
  ).toBeInTheDocument()
  expect(screen.getByText('#b20a')).toBeInTheDocument()
  expect(screen.getByText(/Seeds 1–10/)).toBeInTheDocument()
  const p9 = screen.getAllByText('gpt-6-luna P9').find((e) => e.tagName === 'DT')
  expect(p9?.nextElementSibling).toHaveTextContent(/Temperatur 0.3 .* Standard · P9 · erzwungen/)
  // V8.1 in the label: the completeness table of the run's profile.
  await user.click(screen.getByText('Vollständigkeit im Einzelnen'))
  expect(screen.getByText('Vollständigkeit beim Lauf')).toBeInTheDocument()
})

test('V6.4: "Promptprofil übernehmen" lists the change and the drawback; disabled until stored', async () => {
  runBackend()
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13', <App />)
  await user.click(await screen.findByRole('button', { name: 'Promptprofil übernehmen ▾' }))
  // The default profile is the connection's already.
  expect(
    screen.getByRole('menuitem', { name: 'gemma4:12b P0 · schon im Betrieb' }),
  ).toHaveAttribute('aria-disabled', 'true')
  await user.click(screen.getByRole('menuitem', { name: 'gpt-6-luna P9' }))
  const dialog = await screen.findByRole('dialog', { name: 'Promptprofil übernehmen?' })
  expect(within(dialog).getByRole('list', { name: 'Änderungen' })).toHaveTextContent(
    '~ Platzierung: P0 → P9',
  )
  expect(dialog).toHaveTextContent('Beispiele: Standard (unverändert)')
  expect(dialog).toHaveTextContent(
    'Gemessen in Lauf #13: besser als gpt-6-luna P0, +6.6 Punkte (+1.3 … +13.2) auf Bestätigung.',
  )
  expect(dialog).toHaveTextContent('Aber: 17 still falsch gegenüber 9 bei gpt-6-luna P0.')
  expect(dialog).toHaveTextContent('speichert die Anbindung noch kein Promptprofil')
  expect(within(dialog).getByRole('button', { name: 'Übernehmen' })).toBeDisabled()
  await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('V6.2: "Zur Anbindung" leads to the connections page', async () => {
  runBackend()
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13', <App />)
  await user.click(await screen.findByRole('button', { name: 'Zur Anbindung ▾' }))
  expect(screen.getByRole('menuitem', { name: 'Claude Haiku 5.5' })).toHaveAttribute(
    'href',
    '/admin/modelle#anbindung-2',
  )
  // Three connections, the two Luna points under one.
  expect(screen.getAllByRole('menuitem')).toHaveLength(3)
})

test('V6.5: a quick test shows rates without comparison, and offers the full run', async () => {
  runBackend()
  renderAt('/admin/bewertung/lauf/12', <App />)
  expect(await screen.findByText(/Ein Block: für einen ersten Eindruck/)).toBeInTheDocument()
  const [gemma] = await heads()
  expect(gemma).toHaveTextContent('Vergleich: –')
  expect(screen.queryByText('besser')).toBeNull()
  expect(screen.queryByText(/nicht belegt/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Promptprofil übernehmen ▾' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Als vollständigen Lauf wiederholen' })).toHaveAttribute(
    'href',
    '/admin/bewertung/lauf/neu?von=12',
  )
  expect(screen.getByText('fertig').closest('[data-status]')).toHaveTextContent(
    'fertig· Schnelltest',
  )
})

test.each([
  [
    'llm_unauthorized',
    /Der Zugangsschlüssel wurde abgelehnt\. Die Messpunkte dieser Anbindung wurden angehalten\./,
  ],
  ['no_cases', /Keiner der Prüffälle liess sich beim Lauf lesen/],
  ['internal_error', /Der Vorgang wurde unerwartet abgebrochen\./],
])('a failed run says why in words (%s)', async (code, words) => {
  runBackend({
    [`GET ${RUNS_URL}/13`]: { ...runView('running'), id: 13, status: 'failed', error: code },
  })
  renderAt('/admin/bewertung/lauf/13', <App />)
  const alert = (await screen.findAllByRole('alert')).find((a) => words.test(a.textContent ?? ''))
  expect(alert).toBeDefined()
})

test('keyboard: the matrix is a table with row and column heads; Enter on a cell opens V7', async () => {
  runBackend({ [`GET ${RUNS_URL}/13/answers`]: [] })
  const user = userEvent.setup()
  renderAt('/admin/bewertung/lauf/13', <App />)
  const table = await matrix()
  expect(within(table).getAllByRole('columnheader')[0]).toHaveTextContent('Prüffall')
  expect(within(table).getAllByRole('rowheader').length).toBeGreaterThan(4)
  const cell = within(table).getByRole('link', {
    name: 'Welche Primarschulen gibt es in Köniz? bei gemma4:12b P0: 9 von 10',
  })
  // Reached with the keyboard: Tab until the cell has the focus.
  for (let i = 0; i < 60 && document.activeElement !== cell; i++) await user.tab()
  expect(cell).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(
    await screen.findByRole('heading', { name: /Lauf #13 › doc1-primar-koeniz › gemma4:12b P0/ }),
  ).toBeInTheDocument()
})

test('V6.6: two runs side by side', async () => {
  const calls = runBackend({ 'POST /api/admin/evaluation/comparison': RUN_COMPARISON })
  const user = userEvent.setup()
  renderAt('/admin/bewertung', <App />)
  await user.click(await screen.findByRole('checkbox', { name: 'Lauf #13 markieren' }))
  await user.click(screen.getByRole('checkbox', { name: 'Lauf #12 markieren' }))
  await user.click(screen.getByRole('button', { name: 'Gegenüberstellen' }))
  expect(
    await screen.findByRole('heading', { name: 'Lauf #13 gegen Lauf #12' }),
  ).toBeInTheDocument()
  expect(calls.find((c) => c.key === 'POST /api/admin/evaluation/comparison')?.body).toEqual({
    run: 13,
    against: 12,
  })
  const row = (await screen.findByRole('rowheader', { name: 'gpt-6-luna P0' })).closest('tr')
  if (!row) throw new Error('no row')
  expect(row).toHaveTextContent('84.8 %')
  expect(row).toHaveTextContent('78.2 %')
  expect(row).toHaveTextContent('+6.6 Punkte (+0.9 … +12.4)')
  expect(within(row).getByText('besser').tagName).toBe('STRONG')
  await user.click(screen.getByRole('button', { name: 'Tauschen' }))
  expect(
    await screen.findByRole('heading', { name: 'Lauf #12 gegen Lauf #13' }),
  ).toBeInTheDocument()
})

test('V6.6: runs that are not comparable are refused in words', async () => {
  runBackend({
    'POST /api/admin/evaluation/comparison': () => refused(409, 'runs_not_comparable'),
  })
  renderAt('/admin/bewertung/lauf/13/gegen/10', <App />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Diese Läufe lassen sich nicht gegenüberstellen',
  )
})
