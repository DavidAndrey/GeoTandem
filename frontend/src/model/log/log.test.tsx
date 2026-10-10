// The model log (plan WP73, design M16): the administrators' list with its key
// figures and filters (M16.1), one entry as it was (M16.2), and the user's own
// entries as a dialog with a focus trap (M16.3). The fake routes answer as the
// server does: naive UTC times, compact queries, filters and pages from the
// query string, own entries only under /api/model/my-actions, 404 not_found
// for an id that is not there.
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import fixture from '../../../../schema/model-cases/v1.json'
import { App } from '../../App'
import type { KeyFigures, ModelActionSummary, ModelActionView } from '../../api/client'
import { UserMenu } from '../../auth/UserMenu'
import { activate } from '../../i18n/i18n'
import { formatNumber, parseTimestamp } from '../../i18n/locale'
import { messages as pseudo } from '../../locales/pseudo.po'
import { account, attribute, layer, signedIn } from '../../test/fixtures'
import { actionView } from '../../test/model-mocks'
import { strays } from '../../test/pseudo'
import { fakeApi, renderAt } from '../../test/render'
import { compactQuery } from '../readable'
import { useMyActionsDialog } from './dialog'
import { keyFigures, outcomeText, share } from './words'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  activate('de')
  useMyActionsDialog.setState({ open: false })
})

const FIGURES = Object.fromEntries(
  Object.entries(fixture.key_figures.expect).filter(([k]) => !k.startsWith('_')),
) as unknown as KeyFigures

const STAMP = { count: 10, ids_hash: 'a'.repeat(64), query_hash: 'b'.repeat(64), data_versions: {} }

const LAYERS = [
  layer({
    name: 'schulen',
    title: 'Schulen',
    geometry_type: 'Point',
    attributes: [attribute({ name: 'typ', label: 'Schulstufe', data_type: 'text' })],
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

/** A naive UTC time ``minutes`` ago, as the server writes it. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19)

/** Records as the server returns them: naive UTC, compact query, newest first. */
function records(): ModelActionView[] {
  return [
    actionView('reference', {
      id: 101,
      created_at: ago(25),
      status: 'applied',
      decision: 'accepted',
      decided_at: ago(24),
      stamp: STAMP,
      prompt_hash: 'c'.repeat(64),
      profile_hash: 'd'.repeat(64),
    }),
    actionView('reference', {
      id: 102,
      created_at: ago(10),
      status: 'undone',
      decision: 'auto',
      decided_at: ago(10),
      undone_at: ago(9),
      stamp: STAMP,
      prompt: 'Grundschulen nahe Hauptstrasse',
    }),
    actionView('reference', {
      id: 103,
      account: 'm.keller',
      created_at: ago(32),
      status: 'rejected',
      decision: 'rejected',
      decided_at: ago(31),
      reject_reason: 'wrong_value',
      prompt: 'Kinderreiche Stadtteile',
    }),
    actionView('unknown_layer', { id: 104, account: 'm.keller', created_at: ago(50) }),
    actionView('reference', {
      id: 105,
      account: 'm.keller',
      approach: 'chain',
      created_at: ago(70),
      status: 'superseded',
      decision: 'superseded',
      decided_at: ago(59),
      prompt: 'Schulen im Norden',
    }),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
}

const summary = (v: ModelActionView): ModelActionSummary => ({
  id: v.id,
  account: v.account,
  created_at: v.created_at,
  prompt: v.prompt,
  approach: v.approach,
  level_name: v.level.name,
  connection_name: v.connection.name,
  locality: v.connection.locality,
  status: v.status,
  decision: v.decision,
  hits: v.stamp?.count ?? null,
})

/** The server's filters (``api/model_log.py``): from inclusive, to exclusive, naive UTC. */
function matches(v: ModelActionView, params: URLSearchParams): boolean {
  const at = parseTimestamp(v.created_at).getTime()
  const from = params.get('from')
  const to = params.get('to')
  return (
    (!from || at >= parseTimestamp(from).getTime()) &&
    (!to || at < parseTimestamp(to).getTime()) &&
    (!params.get('level_id') || v.level.id === Number(params.get('level_id'))) &&
    (!params.get('connection_id') || v.connection.id === Number(params.get('connection_id'))) &&
    (!params.get('approach') || v.approach === params.get('approach')) &&
    (!params.get('account') || v.account === params.get('account'))
  )
}

function page(found: ModelActionView[], params: URLSearchParams) {
  const offset = Number(params.get('offset') ?? 0)
  const limit = Number(params.get('limit') ?? 50)
  if (offset < 0 || limit < 1 || limit > 200)
    return new Response('{"code":"schema_violation","message":"?"}', { status: 422 })
  return { items: found.slice(offset, offset + limit).map(summary), total: found.length }
}

const query = (url: string) => new URL(url, 'http://test').searchParams

/** The fake server of the log, signed in as ``me``. */
function logServer(all: ModelActionView[], me = account()) {
  const admin = me.role === 'admin'
  const forbidden = () => new Response('{"code":"forbidden","message":"?"}', { status: 403 })
  return fakeApi({
    ...signedIn(me),
    'GET /api/layers': LAYERS,
    'GET /api/admin/levels': {
      levels: fixture.levels.map((l, i) => ({
        id: i + 1,
        name: l.name,
        description: '',
        system_prompt: '',
        selectable: l.selectable,
        is_default: Boolean('is_default' in l && l.is_default),
        matrix: l.matrix,
      })),
    },
    'GET /api/admin/llm/connections': [],
    'GET /api/admin/model-actions': (_init: unknown, url: string) =>
      admin
        ? page(
            all.filter((v) => matches(v, query(url))),
            query(url),
          )
        : forbidden(),
    'GET /api/admin/model-actions/key-figures': () => (admin ? FIGURES : forbidden()),
    ...Object.fromEntries(
      all.map((v) => [`GET /api/admin/model-actions/${v.id}`, () => (admin ? v : forbidden())]),
    ),
    'GET /api/model/my-actions': (_init: unknown, url: string) =>
      page(
        all.filter((v) => v.account === me.username),
        query(url),
      ),
  })
}

const LOG_PATH = '/admin/modellprotokoll'
const shareOf = (n: number, of: number) =>
  formatNumber(n / of, { style: 'percent', maximumFractionDigits: 0 })

describe('words', () => {
  test('a decision in one phrase, the undone ones and the open ones too', () => {
    expect(outcomeText({ status: 'applied', decision: 'accepted' })).toBe('angenommen')
    expect(outcomeText({ status: 'undone', decision: 'auto' })).toBe(
      'auto angewendet · zurückgenommen',
    )
    expect(outcomeText({ status: 'refused', decision: null })).toBe('abgewiesen')
    expect(outcomeText({ status: 'proposed', decision: null })).toBe('offen')
  })

  test('key figures: counts with their share of the proposals, undone of auto', () => {
    const figures = Object.fromEntries(keyFigures(FIGURES).map((f) => [f.key, f]))
    expect(figures.proposals?.count).toBe('24')
    expect(figures.proposals?.share).toBeUndefined()
    expect(figures.accepted).toMatchObject({ count: '13', share: shareOf(13, 24) })
    expect(figures.rejected?.share).toBe(shareOf(3, 24))
    expect(figures.undone).toMatchObject({ count: '1', share: shareOf(1, 2) })
    // Shown only when there are any (design M16.1 lists neither).
    expect(figures.proposal_only).toBeUndefined()
    expect(figures.undone_after_approval).toBeUndefined()
    expect(share(0, 0)).toBe('–')
  })
})

describe('M16.1 the list', () => {
  test('every account, newest first, with the key figures as numbers and shares', async () => {
    const all = records()
    const calls = logServer(all)
    renderAt(LOG_PATH, <App />)
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[2]?.textContent)).toEqual([
      'Grundschulen nahe Hauptstrasse',
      fixture.cases[0]?.prompt,
      'Kinderreiche Stadtteile',
      actionView('unknown_layer').prompt,
      'Schulen im Norden',
    ])
    const cells = (i: number) => within(rows[i] as HTMLElement).getAllByRole('cell')
    expect(cells(0).map((c) => c.textContent)).toEqual([
      // Naive UTC from the server, shown in local time.
      new Intl.DateTimeFormat('de-CH', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(`${all[0]?.created_at}Z`)),
      'admin',
      'Grundschulen nahe Hauptstrasse',
      'Prüfen',
      'Direkt',
      'auto angewendet · zurückgenommen',
      '10',
    ])
    expect(cells(2)[5]).toHaveTextContent('abgelehnt')
    expect(cells(3)[5]).toHaveTextContent('abgewiesen')
    expect(cells(3)[6]).toHaveTextContent('–')
    expect(cells(4)[4]).toHaveTextContent('Kette')
    expect(within(cells(1)[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '/admin/modellprotokoll/101',
    )

    const figures = await screen.findByRole('region', { name: 'Kennzahlen' })
    const figure = (key: string) => figures.querySelector(`[data-figure="${key}"]`)?.textContent
    expect(figure('proposals')).toBe('Vorschläge24')
    expect(figure('accepted')).toBe(`angenommen unverändert13${shareOf(13, 24)}`)
    expect(figure('adjusted')).toBe(`angepasst4${shareOf(4, 24)}`)
    expect(figure('superseded')).toBe(`übergangen2${shareOf(2, 24)}`)
    expect(figure('auto')).toBe(`auto angewendet2${shareOf(2, 24)}`)
    expect(figure('undone')).toBe(`davon zurückgenommen1${shareOf(1, 2)}`)
    expect(figure('acceptance_rate')).toBe(`Annahmequote${shareOf(0.7727, 1)}`)
    expect(figures).toHaveTextContent(
      'Nicht als Vorschlag gezählt: abgewiesen 3 · abgebrochen 1 · Fehler 2.',
    )
    expect(figures.querySelector('svg, canvas')).toBeNull()

    // The default period is the last 30 days, the same for list and figures.
    const list = calls.find((c) => c.key === 'GET /api/admin/model-actions')
    const figuresCall = calls.find((c) => c.key === 'GET /api/admin/model-actions/key-figures')
    expect(list && figuresCall).toBeTruthy()
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    const from = query(requests.find((u) => u.includes('/key-figures')) ?? '').get('from')
    expect(Date.now() - parseTimestamp(from ?? '').getTime()).toBeGreaterThan(29.9 * 86_400_000)
    expect(Date.now() - parseTimestamp(from ?? '').getTime()).toBeLessThan(30.1 * 86_400_000)
  })

  test('list, key figures and CSV follow the same filters', async () => {
    logServer(records())
    renderAt(LOG_PATH, <App />)
    await screen.findByRole('table')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Arbeitsweise' }), 'chain')
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    expect(screen.getByRole('cell', { name: 'Schulen im Norden' })).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Arbeitsweise' }), '')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Zeitraum' }), 'alle')
    await userEvent.click(
      (await screen.findAllByRole('button', { name: 'm.keller' }))[0] as HTMLElement,
    )
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4))
    expect(
      screen.getByRole('button', { name: 'Filter Konto m.keller entfernen' }),
    ).toBeInTheDocument()

    const last = (part: string) =>
      query(
        vi
          .mocked(fetch)
          .mock.calls.map(([url]) => String(url))
          .filter((u) => u.includes(part))
          .at(-1) ?? '',
      )
    expect(last('/model-actions?').get('account')).toBe('m.keller')
    expect(last('/model-actions?').get('from')).toBeNull()
    expect(last('/key-figures').get('account')).toBe('m.keller')
    const csv = screen.getByRole('link', { name: 'CSV' })
    expect(csv).toHaveAttribute('download')
    expect(query(csv.getAttribute('href') ?? '').get('account')).toBe('m.keller')
    expect(csv.getAttribute('href')).toMatch(/^\/api\/admin\/model-actions\/export\.csv\?/)

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Stufe' }), '3')
    await waitFor(() =>
      expect(screen.getByText('Keine Modellaktionen in diesem Ausschnitt.')).toBeInTheDocument(),
    )
    expect(last('/model-actions?').get('level_id')).toBe('3')
  })

  test('a page at a time, as the server pages', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      actionView('reference', {
        id: 1000 + i,
        created_at: `2026-10-10T12:${String(59 - Math.floor(i / 2)).padStart(2, '0')}:0${i % 2}`,
        prompt: `Frage ${i}`,
      }),
    ).sort((a, b) => b.created_at.localeCompare(a.created_at))
    logServer(many)
    renderAt(`${LOG_PATH}?zeitraum=alle`, <App />)
    await screen.findByText('1–50 von 120')
    expect(screen.getByRole('button', { name: 'Neuere' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Ältere' }))
    await screen.findByText('51–100 von 120')
    await userEvent.click(screen.getByRole('button', { name: 'Ältere' }))
    await screen.findByText('101–120 von 120')
    expect(screen.getAllByRole('row')).toHaveLength(21)
    expect(screen.getByRole('button', { name: 'Ältere' })).toBeDisabled()
  })
})

describe('M16.2 one entry', () => {
  test('the level as it was, the query readable and as JSON, decision and hashes', async () => {
    logServer(records())
    renderAt(`${LOG_PATH}/101`, <App />)
    const heading = await screen.findByRole('heading', { name: /· admin$/ })
    expect(heading).toBeInTheDocument()
    const term = (name: string) =>
      screen.getAllByRole('term').find((t) => t.textContent === name)?.nextElementSibling
    expect(term('Prompt')).toHaveTextContent(fixture.cases[0]?.prompt ?? '')
    expect(term('Stufe damals')).toHaveTextContent(
      'Prüfen · catalog Freigabe · query Freigabe · spatial Freigabe · derive Freigabe · display Freigabe · sha256:level-2',
    )
    expect(term('Anbindung')).toHaveTextContent('Lokales Modell · qwen3:8b')
    expect(term('Arbeitsweise')).toHaveTextContent('Direktabfrage · 6 s')
    expect(term('Annahmen')?.querySelectorAll('li')).toHaveLength(3)
    const first = actionView('reference').answer
    expect(term('Annahmen')).toHaveTextContent(
      `≈${first?.kind === 'query' ? first.assumptions[0]?.text : '?'}`,
    )
    const tree = within(term('Abfrage') as HTMLElement)
    expect(tree.getByRole('group', { name: 'Bedingungen' })).toBeInTheDocument()
    expect(tree.getByText('Technisch (Abfrageobjekt JSON)')).toBeInTheDocument()
    expect(term('Abfrage')?.querySelector('pre')?.textContent).toContain('"source": "schulen"')
    expect(term('Entscheidung')).toHaveTextContent(/^angenommen \d\d\.\d\d\.2026/)
    expect(term('Ergebnis')).toHaveTextContent('10 Treffer')
    expect(term('Layer-Steckbrief')).toHaveTextContent('d'.repeat(64))
    expect(term('Prompt-Hash')).toHaveTextContent('c'.repeat(64))
    expect(document.querySelector('[data-status]')).toHaveAttribute('data-status', 'applied')
    expect(screen.queryByText('Schritte')).toBeNull()
  })

  test('a refusal with its code and the query it refused; a chain with its steps', async () => {
    logServer(records())
    renderAt(`${LOG_PATH}/104`, <App />)
    const refused = await screen.findByText('Abgewiesen')
    expect(refused.nextElementSibling).toHaveTextContent('unknown_layer')
    expect(document.querySelector('[data-status]')).toHaveAttribute('data-status', 'refused')
    cleanup()
    logServer(records())
    renderAt(`${LOG_PATH}/105`, <App />)
    const steps = await screen.findByText('Schritte')
    expect(steps.nextElementSibling).toHaveTextContent('keine Schritte')
  })

  test('an entry that is not there', async () => {
    logServer(records())
    renderAt(`${LOG_PATH}/999`, <App />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

describe('M16.3 my model actions', () => {
  const keller = account({ id: 2, username: 'm.keller', display_name: '', role: 'user' })

  async function open() {
    logServer(records(), keller)
    renderAt('/', <UserMenu account={keller} />)
    await userEvent.click(screen.getByRole('button', { name: 'Benutzermenü' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Meine Modellaktionen' }))
    return screen.findByRole('dialog', { name: 'Meine Modellaktionen' })
  }

  test('own entries only, without the account column', async () => {
    const dialog = await open()
    await within(dialog).findByText('Kinderreiche Stadtteile')
    const rows = within(dialog).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(within(dialog).queryByText('Grundschulen nahe Hauptstrasse')).toBeNull()
    expect(within(dialog).queryByRole('columnheader', { name: 'Konto' })).toBeNull()
    expect(rows[0]).toHaveTextContent('abgelehnt')
    expect(
      within(dialog).getByText(/Administratoren sehen alle Einträge samt Prompt/),
    ).toBeVisible()
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls.some((u) => u.includes('/api/admin/'))).toBe(false)
  })

  test('focus stays in the dialog until Esc closes it', async () => {
    const dialog = await open()
    await within(dialog).findByText('Kinderreiche Stadtteile')
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
    for (let i = 0; i < 6; i++) {
      await userEvent.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
    for (let i = 0; i < 6; i++) {
      await userEvent.tab({ shift: true })
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('pseudo locale', () => {
  const DATA = [
    'GeoTandem',
    'Systemverwaltung',
    'admin',
    'm.keller',
    'Prüfen',
    'Assistenz',
    'Teilautonom',
    'Automatisch',
    'Lokales Modell',
    'qwen3:8b',
    'host.docker.internal',
    'MCP',
    'E2',
    'E3',
    'E4',
    'CSV',
    'Schulen',
    'Schulstufe',
    'catalog',
    'query',
    'spatial',
    'derive',
    'display',
    'sha256',
    'unknown_layer',
    'schulen',
    'strassen',
    'gemeinden_steuern',
    'primar',
    'kantonsstrasse_b',
    'klasse',
    'steueranlage',
    ...records().flatMap((v) => [v.prompt, v.level.prompt_hash, v.prompt_hash, v.profile_hash]),
    'kitas',
    'Strassen',
    'Strassenklasse',
    'Gemeinden · Steuern',
    'Steueranlage',
    ...records().flatMap((v) => {
      const answer = v.answer?.kind === 'query' ? v.answer : null
      return [
        answer?.explanation ?? '',
        ...(answer?.assumptions ?? []).map((a) => a.text),
        JSON.stringify(compactQuery(v.query ?? answer?.query), null, 2),
      ]
    }),
  ]

  test.each([LOG_PATH, `${LOG_PATH}/101`, `${LOG_PATH}/104`])('%s', async (path) => {
    activate('pseudo', pseudo)
    logServer(records())
    renderAt(path, <App />)
    await screen.findAllByRole('heading')
    await waitFor(() => expect(document.querySelector('table, dl')).not.toBeNull())
    await waitFor(() => expect(strays(DATA)).toEqual([]))
  })

  test('the dialog', async () => {
    activate('pseudo', pseudo)
    const keller = account({ id: 2, username: 'm.keller', display_name: '', role: 'user' })
    logServer(records(), keller)
    renderAt('/', <UserMenu account={keller} />)
    act(() => useMyActionsDialog.setState({ open: true }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Kinderreiche Stadtteile')
    await waitFor(() => expect(strays(DATA)).toEqual([]))
  })
})
