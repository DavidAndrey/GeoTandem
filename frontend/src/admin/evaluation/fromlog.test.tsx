// A case from the model log (plan WP92, F-3.14, design M16.2 → V2): the
// entry offers "Als Prüffall übernehmen" only for a direct query that was
// accepted or applied unasked, not undone and not changed by hand; it opens
// the case editor prefilled from the server's draft, and saving creates the
// case with the id, tags and split the administrator gives.
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Link, Route, Routes } from 'react-router'
import { useAnalysis } from '../../analysis/store'
import type { CaseDraft, CaseView, EvalCase, ModelActionView } from '../../api/client'
import { casePage } from '../../test/eval-mocks'
import { attribute, layer, signedIn } from '../../test/fixtures'
import { actionView } from '../../test/model-mocks'
import { fakeApi, renderAt } from '../../test/render'
import { ModelActionPage } from '../ModelActionPage'
import { CaseDetailPage, CaseFromLogPage } from './CaseDetailPage'
import { fromLog, referenceOf } from './words'

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => useAnalysis.getState().reset())

const ID = 103
const STAMP = { count: 10, ids_hash: 'a'.repeat(64), query_hash: 'b'.repeat(64), data_versions: {} }

/** The fixture's reference query, accepted and applied. */
function accepted(patch: Partial<ModelActionView> = {}): ModelActionView {
  const base = actionView('reference', { id: ID })
  return {
    ...base,
    status: 'applied',
    decision: 'accepted',
    decided_at: '2026-10-10T14:05:06',
    stamp: STAMP,
    ...patch,
  }
}

/** The draft the server builds from ``view`` (``evaluation/cases.py`` ``draft_of``). */
function draftOf(view: ModelActionView): CaseDraft {
  const query = view.query as Record<string, unknown>
  return {
    prompt: view.prompt,
    data_state: 'live',
    origin: 'log',
    origin_action: view.id,
    schema_version: '2',
    split: 'confirm',
    gold: referenceOf(query),
    also: [],
    forbid: [],
    note: '',
    layers: [{ name: 'gemeinden_steuern' }, { name: 'schulen' }, { name: 'strassen' }],
  }
}

const LAYERS = [
  layer({
    name: 'schulen',
    title: 'Schulen',
    geometry_type: 'Point',
    attributes: [attribute({ name: 'typ', label: 'Schulstufe', data_type: 'text' })],
  }),
]

function server(view: ModelActionView, patch: Record<string, unknown> = {}) {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': LAYERS,
    [`GET /api/admin/model-actions/${view.id}`]: view,
    [`GET /api/admin/evaluation/cases/draft-from-action/${view.id}`]: draftOf(view),
    'GET /api/admin/evaluation/cases': casePage(),
    'POST /api/admin/evaluation/cases': (init: RequestInit | undefined): CaseView => ({
      case: JSON.parse(String(init?.body)) as EvalCase,
      status: 'ok',
      status_layers: [],
      read_only: false,
      reference_hits: [7],
      created_at: '2026-10-25T10:00:00',
      updated_at: '2026-10-25T10:00:00',
    }),
    'POST /api/query/count': (init: RequestInit | undefined) => {
      const queries = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries
      return { counts: queries.map(() => 7) }
    },
    ...patch,
  })
}

function renderEntry(id = ID) {
  return renderAt(
    `/admin/modellprotokoll/${id}`,
    <Routes>
      <Route path="/admin/bewertung/faelle" element={<p>Liste der Prüffälle</p>} />
      <Route path="/admin/modellprotokoll/:id" element={<ModelActionPage />} />
      <Route path="/admin/bewertung/faelle/:id" element={<CaseDetailPage />} />
      <Route path="/admin/bewertung/faelle/aus-protokoll/:action" element={<CaseFromLogPage />} />
    </Routes>,
  )
}

const OFFER = 'Als Prüffall übernehmen'

test('the rule mirrors the server: accepted or auto, direct, no follow-up, not undone, not touched, with a query', () => {
  expect(fromLog(accepted())).toBe(true)
  expect(fromLog(accepted({ decision: 'auto' }))).toBe(true)
  expect(fromLog(accepted({ decision: 'adjusted' }))).toBe(false)
  expect(fromLog(accepted({ decision: 'auto', undone_at: '2026-10-10T14:06:00' }))).toBe(false)
  expect(fromLog(accepted({ touched_at: '2026-10-10T14:07:00' }))).toBe(false)
  expect(fromLog(accepted({ approach: 'chain' }))).toBe(false)
  expect(fromLog(accepted({ decision: null, status: 'refused' }))).toBe(false)
  expect(fromLog(accepted({ query: null }))).toBe(false)
  expect(fromLog(accepted({ status: 'undone', undone_at: '2026-10-10T14:06:00' }))).toBe(false)
  expect(fromLog(accepted({ decision: null, status: 'answered' }))).toBe(false)
  expect(fromLog(accepted({ parent_action_id: 101 }))).toBe(false)
})

test.each([
  ['adjusted', { decision: 'adjusted' }],
  ['auto, undone', { decision: 'auto', status: 'undone', undone_at: '2026-10-10T14:06:00' }],
  ['changed by hand afterwards', { touched_at: '2026-10-10T14:07:00' }],
  ['a chain', { approach: 'chain' }],
  ['a follow-up', { parent_action_id: 101 }],
] as const)('M16.2: no offer for an entry %s', async (_, patch) => {
  server(accepted(patch as Partial<ModelActionView>))
  renderEntry()
  await screen.findByText('Stufe damals')
  expect(screen.queryByRole('link', { name: OFFER })).toBeNull()
})

test('M16.2 → V2: an accepted direct query opens the case editor prefilled, and saving creates it', async () => {
  const view = accepted()
  const calls = server(view)
  renderEntry()
  const offer = await screen.findByRole('link', { name: OFFER })
  expect(offer).toHaveAttribute('href', `/admin/bewertung/faelle/aus-protokoll/${ID}`)
  await userEvent.click(offer)

  expect(await screen.findByRole('heading', { name: 'Neuer Prüffall' })).toBeInTheDocument()
  const question = screen.getByRole('textbox', { name: 'Frage' })
  expect(question).toHaveValue(view.prompt)
  const id = screen.getByRole('textbox', { name: 'Kennung' })
  expect((id as HTMLInputElement).value).toMatch(/^e-/)
  // The reference is the action's query, readable; hits come with the save.
  expect(screen.getByText(/Treffer neu nach dem Speichern/)).toBeInTheDocument()
  expect(screen.getByText(/Protokoll/, { selector: 'dd span' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: `Eintrag ${ID}` })).toHaveAttribute(
    'href',
    `/admin/modellprotokoll/${ID}`,
  )
  // Split defaults to Bestätigung; nothing is stored before Speichern, which needs a tag.
  expect(screen.getByRole('button', { name: 'Bestätigung' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const save = screen.getByRole('button', { name: 'Speichern' })
  expect(save).toBeDisabled()
  expect(calls.some((c) => c.key === 'POST /api/admin/evaluation/cases')).toBe(false)

  await userEvent.clear(id)
  await userEvent.type(id, 'aus-protokoll-103')
  await userEvent.click(screen.getByRole('button', { name: '+ Stichwort' }))
  await userEvent.type(screen.getByRole('combobox', { name: 'Neues Stichwort' }), 'near{Enter}')
  await userEvent.click(screen.getByRole('button', { name: 'Abstimmung' }))
  await userEvent.click(save)

  // The saved case opens as an own case.
  expect(await screen.findByRole('heading', { name: 'aus-protokoll-103' })).toBeInTheDocument()
  const body = calls.find((c) => c.key === 'POST /api/admin/evaluation/cases')?.body as EvalCase
  expect(body).toMatchObject({
    id: 'aus-protokoll-103',
    prompt: view.prompt,
    tags: ['near'],
    split: 'tuning',
    origin: 'log',
    origin_action: ID,
    data_state: 'live',
    layers: [{ name: 'gemeinden_steuern' }, { name: 'schulen' }, { name: 'strassen' }],
  })
  expect(Object.keys(body.gold ?? {})).toEqual(['source', 'where'])
})

test('V2 from the log: a refusal of the save is shown in words', async () => {
  const refusal = new Response(
    JSON.stringify({
      code: 'action_not_eligible',
      message: 'English text.',
      details: { decision: 'accepted', reason: 'touched' },
    }),
    { status: 409 },
  )
  server(accepted(), { 'POST /api/admin/evaluation/cases': refusal })
  renderAt(
    `/admin/bewertung/faelle/aus-protokoll/${ID}`,
    <Routes>
      <Route path="/admin/bewertung/faelle/aus-protokoll/:action" element={<CaseFromLogPage />} />
    </Routes>,
  )
  await screen.findByRole('heading', { name: 'Neuer Prüffall' })
  await userEvent.click(screen.getByRole('button', { name: '+ Stichwort' }))
  await userEvent.type(screen.getByRole('combobox', { name: 'Neues Stichwort' }), 'near{Enter}')
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText(/von Hand korrigiert/)).toBeInTheDocument()
})

test('an id that names no entry is not asked for', async () => {
  const calls = server(accepted())
  renderAt(
    '/admin/bewertung/faelle/aus-protokoll/abc',
    <Routes>
      <Route path="/admin/bewertung/faelle/aus-protokoll/:action" element={<CaseFromLogPage />} />
    </Routes>,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('Das Gesuchte gibt es nicht (mehr).')
  expect(calls.some((c) => c.key.includes('draft-from-action'))).toBe(false)
})

test('a draft the server refuses shows the reason in words and no form', async () => {
  const refusal = new Response(
    JSON.stringify({
      code: 'action_not_eligible',
      message: 'English text.',
      details: { decision: 'auto', reason: 'undone' },
    }),
    { status: 409 },
  )
  server(accepted(), { [`GET /api/admin/evaluation/cases/draft-from-action/${ID}`]: refusal })
  renderAt(
    `/admin/bewertung/faelle/aus-protokoll/${ID}`,
    <Routes>
      <Route path="/admin/bewertung/faelle/aus-protokoll/:action" element={<CaseFromLogPage />} />
    </Routes>,
  )
  expect(
    await screen.findByText(/Nur eine angenommene oder automatisch angewendete/),
  ).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Frage' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull()
})

test('the new case takes the focus, and Speichern says why it waits', async () => {
  server(accepted())
  renderAt(
    `/admin/bewertung/faelle/aus-protokoll/${ID}`,
    <Routes>
      <Route path="/admin/bewertung/faelle/aus-protokoll/:action" element={<CaseFromLogPage />} />
    </Routes>,
  )
  const heading = await screen.findByRole('heading', { name: 'Neuer Prüffall' })
  expect(heading).toHaveFocus()
  const save = screen.getByRole('button', { name: 'Speichern' })
  expect(save).toBeDisabled()
  expect(save).toHaveAccessibleDescription('Mindestens ein Stichwort.')
})

test('leaving the new case with unsaved input asks, by its links and by any other', async () => {
  server(accepted())
  renderAt(
    `/admin/bewertung/faelle/aus-protokoll/${ID}`,
    <>
      <nav>
        <Link to="/admin/bewertung/faelle">Prüffälle</Link>
      </nav>
      <Routes>
        <Route path="/admin/bewertung/faelle/aus-protokoll/:action" element={<CaseFromLogPage />} />
        <Route path="/admin/modellprotokoll/:id" element={<p>Eintrag im Protokoll</p>} />
        <Route path="/admin/bewertung/faelle" element={<p>Liste der Prüffälle</p>} />
      </Routes>
    </>,
  )
  const question = await screen.findByRole('textbox', { name: 'Frage' })
  await userEvent.type(question, ' heute')

  // The origin's link asks; Abbrechen in the question stays on the page.
  await userEvent.click(screen.getByRole('link', { name: `Eintrag ${ID}` }))
  const ask = await screen.findByRole('alertdialog', {
    name: 'Ungespeicherte Änderungen am Prüffall verwerfen?',
  })
  await userEvent.click(within(ask).getByRole('button', { name: 'Abbrechen' }))
  expect(screen.getByRole('textbox', { name: 'Frage' })).toHaveValue(`${accepted().prompt} heute`)

  // A link outside the form asks too, and goes once the edits are dropped.
  await userEvent.click(screen.getByRole('link', { name: 'Prüffälle' }))
  const again = await screen.findByRole('alertdialog', {
    name: 'Ungespeicherte Änderungen am Prüffall verwerfen?',
  })
  await userEvent.click(within(again).getByRole('button', { name: 'Verwerfen' }))
  expect(await screen.findByText('Liste der Prüffälle')).toBeInTheDocument()
})
