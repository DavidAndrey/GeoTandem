// The model log (plan WP73, design M16): the administrators' list with its key
// figures and filters (M16.1), one entry as it was (M16.2), and the user's own
// entries as a dialog with a focus trap (M16.3). The fake routes answer as the
// server does: naive UTC times, compact queries, filters and pages from the
// query string, key figures over the filtered records as section 2 counts them
// (``figuresOf``, held to the contract fixture below), own entries only under
// /api/model/my-actions, 404 not_found for an id that is not there, times with
// microseconds.
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import fixture from '../../../../schema/model-cases/v1.json'
import { App } from '../../App'
import type {
  KeyFigures,
  ModelActionSummary,
  ModelActionView,
  PromptProfile,
} from '../../api/client'
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

/** A naive UTC time ``minutes`` ago with microseconds, as the server writes it. */
const ago = (minutes: number) =>
  `${new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 23)}456`

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
  reject_reason: v.reject_reason ?? null,
  refusal_code: v.refusal?.code ?? null,
  hits: v.stamp?.count ?? null,
  is_check: v.is_check,
})

/** Plan section 2 over the records, as ``ModelActionStore.key_figures`` counts. */
function figuresOf(found: ModelActionView[]): KeyFigures {
  const n = (decision: string, undone?: boolean) =>
    found.filter(
      (v) => v.decision === decision && (undone === undefined || Boolean(v.undone_at) === undone),
    ).length
  const accepted = n('accepted')
  const adjusted = n('adjusted')
  const rejected = n('rejected')
  const superseded = n('superseded')
  const auto = n('auto')
  const proposalOnly = n('proposal_only')
  const decided = accepted + adjusted + rejected + superseded
  return {
    proposals: decided + auto + proposalOnly,
    accepted,
    adjusted,
    rejected,
    superseded,
    proposal_only: proposalOnly,
    auto,
    undone: n('auto', true),
    undone_after_approval: n('accepted', true),
    acceptance_rate: decided
      ? Math.round(((accepted + adjusted) / decided) * 10_000) / 10_000
      : null,
    not_counted: {
      refused: found.filter((v) => v.status === 'refused').length,
      aborted: n('aborted'),
      failed: n('failed'),
    },
  }
}

/** Records whose decisions are the fixture's (``key_figures.decisions``). */
function fixtureRecords(): ModelActionView[] {
  const counts: Record<string, number> = { ...fixture.key_figures.decisions }
  // The fixture counts undone ones inside their decision; build them apart.
  counts.auto = (counts.auto ?? 0) - (counts.auto_undone ?? 0)
  counts.accepted = (counts.accepted ?? 0) - (counts.accepted_undone ?? 0)
  const ends: Record<string, Partial<ModelActionView>> = {
    accepted: { status: 'applied', decision: 'accepted' },
    accepted_undone: { status: 'undone', decision: 'accepted', undone_at: ago(1) },
    adjusted: { status: 'applied', decision: 'adjusted' },
    rejected: { status: 'rejected', decision: 'rejected' },
    superseded: { status: 'superseded', decision: 'superseded' },
    auto: { status: 'applied', decision: 'auto' },
    auto_undone: { status: 'undone', decision: 'auto', undone_at: ago(1) },
    proposal_only: { status: 'applied', decision: 'proposal_only' },
    aborted: { status: 'aborted', decision: 'aborted' },
    failed: { status: 'failed', decision: 'failed' },
  }
  let id = 500
  return Object.entries(counts)
    .flatMap(([end, count]) =>
      Array.from({ length: count }, () => {
        id += 1
        return end === 'refused'
          ? actionView('unknown_layer', { id, created_at: ago(id - 490) })
          : actionView('reference', { id, created_at: ago(id - 490), ...ends[end] })
      }),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

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
function logServer(all: ModelActionView[], me = account(), patch: Record<string, object> = {}) {
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
    'GET /api/admin/model-actions/key-figures': (_init: unknown, url: string) =>
      admin ? figuresOf(all.filter((v) => matches(v, query(url)))) : forbidden(),
    ...Object.fromEntries(
      all.map((v) => [`GET /api/admin/model-actions/${v.id}`, () => (admin ? v : forbidden())]),
    ),
    'GET /api/model/my-actions': (_init: unknown, url: string) =>
      page(
        all.filter((v) => v.account === me.username),
        query(url),
      ),
    ...patch,
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
    expect(
      outcomeText({ status: 'rejected', decision: 'rejected', reject_reason: 'wrong_value' }),
    ).toBe('abgelehnt · falscher Wert')
    expect(outcomeText({ status: 'refused', decision: null, refusal_code: 'unknown_layer' })).toBe(
      'abgewiesen · Layer nicht vorhanden',
    )
  })

  test('the fake counts key figures as the server does: the fixture from its records', () => {
    expect(figuresOf(fixtureRecords())).toEqual(FIGURES)
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
  test('every account, newest first, over one fixed period', async () => {
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
    expect(cells(2)[5]).toHaveTextContent('abgelehnt · falscher Wert')
    expect(cells(3)[5]).toHaveTextContent('abgewiesen · Layer nicht vorhanden')
    expect(cells(3)[6]).toHaveTextContent('–')
    expect(cells(4)[4]).toHaveTextContent('Kette')
    expect(within(cells(1)[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '/admin/modellprotokoll/101',
    )

    // The default period is the last 30 days up to the opening of the page,
    // the same for list and figures.
    const list = calls.find((c) => c.key === 'GET /api/admin/model-actions')
    const figuresCall = calls.find((c) => c.key === 'GET /api/admin/model-actions/key-figures')
    expect(list && figuresCall).toBeTruthy()
    const requests = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    const asked = query(requests.find((u) => u.includes('/key-figures')) ?? '')
    const listed = query(requests.find((u) => u.includes('/model-actions?')) ?? '')
    const from = parseTimestamp(asked.get('from') ?? '').getTime()
    const to = parseTimestamp(asked.get('to') ?? '').getTime()
    expect(to - from).toBe(30 * 86_400_000)
    expect(Math.abs(Date.now() - to)).toBeLessThan(60_000)
    expect([listed.get('from'), listed.get('to')]).toEqual([asked.get('from'), asked.get('to')])
  })

  test('the key figures of the fixture, as numbers with shares and no chart', async () => {
    logServer(fixtureRecords())
    renderAt(LOG_PATH, <App />)
    const figures = await screen.findByRole('region', { name: 'Kennzahlen' })
    /** What is shown, without the words for assistive technology. */
    const figure = (key: string) => {
      const shown = figures.querySelector(`[data-figure="${key}"]`)?.cloneNode(true)
      if (!(shown instanceof HTMLElement)) return undefined
      shown.querySelectorAll('.sr-only').forEach((n) => n.remove())
      return shown.textContent
    }
    await waitFor(() => expect(figure('proposals')).toBe('Vorschläge24'))
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
    // The share says what it is of, for assistive technology too.
    expect(figures.querySelector('[data-figure="accepted"] .sr-only')).toHaveTextContent(
      'der Vorschläge',
    )
  })

  test('list, key figures and CSV follow the same filters', async () => {
    logServer(records())
    renderAt(LOG_PATH, <App />)
    await screen.findByRole('table')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Arbeitsweise' }), 'chain')
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    expect(screen.getByRole('cell', { name: 'Schulen im Norden' })).toBeInTheDocument()
    // The figures count the same records: one proposal, superseded.
    const figures = screen.getByRole('region', { name: 'Kennzahlen' })
    await waitFor(() =>
      expect(figures.querySelector('[data-figure="proposals"]')).toHaveTextContent('1'),
    )
    expect(figures.querySelector('[data-figure="superseded"]')).toHaveTextContent('1')

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
    // List, figures and CSV end at the same moment.
    const end = last('/model-actions?').get('to')
    expect(end).toBeTruthy()
    expect(last('/key-figures').get('to')).toBe(end)
    expect(query(csv.getAttribute('href') ?? '').get('to')).toBe(end)
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
        created_at: ago(i + 1),
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

  test('beyond the export cap the CSV is not offered, and the page says why', async () => {
    logServer(records(), account(), {
      'GET /api/admin/model-actions': { items: [], total: 60_000 },
    })
    renderAt(LOG_PATH, <App />)
    await screen.findByText(/Bitte den Zeitraum oder die Filter enger wählen/)
    expect(screen.queryByRole('link', { name: 'CSV' })).toBeNull()
    expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled()
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

  test('the prompt profile it was written with, in one line when not today’s', async () => {
    const withProfile = (prompt_profile: PromptProfile) =>
      records().map((v) =>
        v.id === 101 ? { ...v, connection: { ...v.connection, prompt_profile } } : v,
      )
    logServer(withProfile({ examples: '12', placement: 'P9', output: 'text' }))
    renderAt(`${LOG_PATH}/101`, <App />)
    expect(
      await screen.findByText(
        'Promptprofil: 12 Beispiele · P9 (Hinweis „erste Frage" als eigene Systemnachricht) · nur Text',
      ),
    ).toBeInTheDocument()
    cleanup()
    logServer(withProfile({ examples: 'standard', placement: 'P0', output: 'constrained' }))
    renderAt(`${LOG_PATH}/101`, <App />)
    await screen.findByRole('heading', { name: /· admin$/ })
    expect(screen.queryByText(/^Promptprofil:/)).toBeNull()
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

  test("a chain's steps in the dialogue's words, numbered by their place in the plan", async () => {
    const [first, second, third, ...rest] = actionView('chain_reference').steps
    const chain = actionView('chain_reference', {
      id: 106,
      created_at: ago(5),
      status: 'limited',
      stop_reason: 'replan_limit',
      steps: [
        {
          ...(first as NonNullable<typeof first>),
          status: 'ok',
          hits: 62,
          duration_ms: 400,
          model_view: { outcome: 'ok', code: null, part: null, empty: false, count: 62 },
        },
        // Removed by hand before the run (M8.3): it has no place.
        { ...(second as NonNullable<typeof second>), status: 'removed' },
        {
          ...(third as NonNullable<typeof third>),
          status: 'error',
          duration_ms: 300,
          model_view: {
            outcome: 'error',
            code: 'unknown_attribute',
            part: null,
            empty: null,
            count: null,
          },
        },
        ...rest.map((s) => ({ ...s, status: 'skipped' as const })),
      ],
    })
    logServer([...records(), chain])
    renderAt(`${LOG_PATH}/106`, <App />)
    const term = await screen.findByText('Schritte')
    const items = within(term.nextElementSibling as HTMLElement).getAllByRole('listitem')
    expect(items.map((li) => li.firstElementChild?.textContent)).toEqual([
      '1.',
      '–',
      '2.',
      '3.',
      '4.',
    ])
    // The state in words after the tool, never the raw status.
    expect(items.map((li) => li.querySelector('code')?.nextElementSibling?.textContent)).toEqual([
      'erledigt',
      'entfernt',
      'Fehler',
      'nicht ausgeführt',
      'nicht ausgeführt',
    ])
    expect(items[0]).toHaveTextContent('Modell sieht: ok · nicht leer · 62')
    expect(items[2]).toHaveTextContent('Modell sieht: Fehler · unknown_attribute')
  })

  test('an entry that is not there', async () => {
    logServer(records())
    renderAt(`${LOG_PATH}/999`, <App />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  test('an address that names no entry asks for none', async () => {
    logServer(records())
    renderAt(`${LOG_PATH}/abc`, <App />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls.some((u) => u.startsWith('/api/admin/model-actions/'))).toBe(false)
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

  test("an administrator sees their own entries here too, not everyone's", async () => {
    logServer(records())
    renderAt('/', <UserMenu account={account()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Benutzermenü' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Meine Modellaktionen' }))
    const dialog = await screen.findByRole('dialog', { name: 'Meine Modellaktionen' })
    await within(dialog).findByText('Grundschulen nahe Hauptstrasse')
    expect(within(dialog).getAllByRole('row').slice(1)).toHaveLength(2)
    expect(within(dialog).queryByText('Kinderreiche Stadtteile')).toBeNull()
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
