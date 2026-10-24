// One case (design V2, plan WP88): an own query case edited, saved, deleted
// and opened in the workplace; a behaviour case; a start case read only and
// copied into an own case.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Route, Routes } from 'react-router'
import { useAnalysis } from '../../analysis/store'
import { newAttributeRow } from '../../analysis/tree'
import type { CaseView } from '../../api/client'
import { casePage, caseView } from '../../test/eval-mocks'
import { attribute, layer, signedIn } from '../../test/fixtures'
import { fakeApi, renderAt } from '../../test/render'
import { CaseDetailPage } from './CaseDetailPage'

/** The element a test relies on; a clear failure instead of ``!``. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected an element')
  return value
}

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => useAnalysis.getState().reset())

const schulanlagen = layer({
  name: 'schulanlagen',
  title: 'Schulanlagen (Import)',
  geometry_type: 'Point',
  attributes: [attribute({ name: 'turnhalle', data_type: 'boolean', label: 'Turnhalle' })],
})

const OWN = 'e-turnhalle-ostermundigen'

/** The server keeps what a PUT saved, as the store does. */
function backend(view: CaseView, patch: Record<string, unknown> = {}) {
  let current = view
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': [schulanlagen],
    'GET /api/admin/evaluation/cases': casePage(),
    [`GET /api/admin/evaluation/cases/${view.case.id}`]: () => current,
    [`PUT /api/admin/evaluation/cases/${view.case.id}`]: (init: RequestInit | undefined) => {
      current = {
        ...current,
        case: JSON.parse(String(init?.body)) as CaseView['case'],
        updated_at: '2026-10-24T10:00:00',
      }
      return current
    },
    // Hits of the reference, of the layer and of each condition alone (B2).
    'POST /api/query/count': (init: RequestInit | undefined) => {
      const queries = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries
      return { counts: queries.map((_, i) => [9, 248, 31][i] ?? 0) }
    },
    ...patch,
  })
}

function renderCase(id: string) {
  return renderAt(
    `/admin/bewertung/faelle/${id}`,
    <Routes>
      <Route path="/admin/bewertung/faelle/:id" element={<CaseDetailPage />} />
      <Route path="/admin/bewertung/faelle" element={<p>Liste der Prüffälle</p>} />
      <Route path="/" element={<p>Arbeitsplatz</p>} />
    </Routes>,
  )
}

const row = (label: string) => {
  const term = must(screen.getAllByText(label).find((el) => el.closest('dt')))
  return must(must(term.closest('div')).querySelector('dd'))
}

test('V2.1: an own query case with its reference as a tree, hits per condition and per reading', async () => {
  backend(caseView(OWN, { reference_hits: [9] }))
  renderCase(OWN)
  expect(await screen.findByRole('heading', { name: OWN })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Frage' })).toHaveValue(
    'Schulanlagen mit Turnhalle in Ostermundigen',
  )
  expect(
    screen.getByText(
      'So formulieren, wie ein Anwender fragen würde, nicht wie die Abfrage aussieht.',
    ),
  ).toBeInTheDocument()
  const reference = row('Referenz')
  // The readable tree, not JSON: the condition in words, the JSON only under "Technisch".
  const tree = within(reference).getByRole('group', { name: 'Bedingungen' })
  expect(tree).toHaveTextContent('turnhalle = ja')
  expect(
    within(reference).getByText('Technisch (Abfrageobjekt JSON)').closest('details'),
  ).not.toHaveAttribute('open')
  await waitFor(() => expect(tree).toHaveTextContent('31'))
  expect(within(reference).getByText('9 von 248 · Datenstand Betriebsdaten')).toBeInTheDocument()
  expect(row('Teil')).toHaveTextContent('AbstimmungBestätigung')
  expect(within(row('Teil')).getByRole('button', { name: 'Bestätigung' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(row('Herkunft')).toHaveTextContent('Arbeitsplatz · 20.10.2026')
  expect(row('Datenstand')).toHaveTextContent('Betriebsdaten · schulanlagen imp-2026-10-20')
  expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Verwerfen' })).toBeDisabled()
})

test('V2.1: question, split, tags and note are saved with PUT, without null fields', async () => {
  const view = caseView(OWN, { reference_hits: [9] })
  const calls = backend(view)
  renderCase(OWN)
  const question = await screen.findByRole('textbox', { name: 'Frage' })
  await userEvent.clear(question)
  await userEvent.type(question, 'Welche Schulanlagen in Ostermundigen haben eine Turnhalle?')
  await userEvent.click(screen.getByRole('button', { name: 'Abstimmung' }))
  // ``in`` in words is "liegt in"; the tag keeps its key.
  await userEvent.click(screen.getByRole('button', { name: 'Stichwort liegt in entfernen' }))
  await userEvent.click(screen.getByRole('button', { name: '+ Stichwort' }))
  await userEvent.type(
    screen.getByRole('combobox', { name: 'Neues Stichwort' }),
    'turnhalle{Enter}',
  )
  await userEvent.type(screen.getByRole('textbox', { name: 'Anmerkung' }), 'Ja/Nein-Feld')
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Gespeichert.')
  expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
  const put = calls.find((c) => c.key === `PUT /api/admin/evaluation/cases/${OWN}`)
  expect(put?.body).toEqual({
    id: OWN,
    prompt: 'Welche Schulanlagen in Ostermundigen haben eine Turnhalle?',
    tags: ['attribute', 'turnhalle'],
    split: 'tuning',
    data_state: 'live',
    origin: 'authored',
    schema_version: '2',
    gold: view.case.gold,
    note: 'Ja/Nein-Feld',
    layers: view.case.layers,
  })
})

test('V2.1: a refusal of the check is shown in words; Verwerfen restores the case', async () => {
  backend(caseView(OWN), {
    [`PUT /api/admin/evaluation/cases/${OWN}`]: () =>
      new Response(
        JSON.stringify({
          code: 'case_invalid',
          message: 'Reading 0 fails the checks.',
          details: {
            case_id: OWN,
            reason: 'unknown_attribute',
            attribute: 'turnhalle',
            reading: 0,
          },
        }),
        { status: 400 },
      ),
  })
  renderCase(OWN)
  const question = await screen.findByRole('textbox', { name: 'Frage' })
  await userEvent.type(question, '?')
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Das Feld „turnhalle" gibt es nicht.')
  await userEvent.click(screen.getByRole('button', { name: 'Verwerfen' }))
  expect(question).toHaveValue('Schulanlagen mit Turnhalle in Ostermundigen')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('V2.1: deleting asks first, then goes back to the list', async () => {
  const calls = backend(caseView(OWN), {
    [`DELETE /api/admin/evaluation/cases/${OWN}`]: () => new Response(null, { status: 204 }),
  })
  renderCase(OWN)
  await userEvent.click(await screen.findByRole('button', { name: 'Löschen' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Prüffall löschen?' })
  await userEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }))
  expect(await screen.findByText('Liste der Prüffälle')).toBeInTheDocument()
  expect(calls.some((c) => c.key === `DELETE /api/admin/evaluation/cases/${OWN}`)).toBe(true)
})

test('V2.1: "Im Arbeitsplatz öffnen" makes the reference the analysis', async () => {
  backend(caseView(OWN))
  renderCase(OWN)
  await userEvent.click(await screen.findByRole('button', { name: 'Im Arbeitsplatz öffnen' }))
  expect(await screen.findByText('Arbeitsplatz')).toBeInTheDocument()
  const s = useAnalysis.getState()
  expect(s.result).toBe('schulanlagen')
  expect(s.tree.children).toEqual([
    expect.objectContaining({ kind: 'attribute', attr: 'turnhalle', operator: 'eq', value: true }),
  ])
})

test('V2.1: unsaved conditions in the workplace are not replaced without a question', async () => {
  useAnalysis.getState().addLayer('schulanlagen')
  useAnalysis.getState().edit()
  useAnalysis.getState().addNode('root', newAttributeRow('turnhalle'))
  useAnalysis.getState().apply()
  backend(caseView(OWN))
  renderCase(OWN)
  await userEvent.click(await screen.findByRole('button', { name: 'Im Arbeitsplatz öffnen' }))
  const dialog = await screen.findByRole('alertdialog', {
    name: 'Abfrage im Arbeitsplatz ersetzen?',
  })
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(screen.queryByText('Arbeitsplatz')).toBeNull()
})

test('V2.1: "Weitere Lesart hinzufügen" takes the workplace analysis as reading B', async () => {
  const view = caseView(OWN)
  const calls = backend(view)
  useAnalysis.getState().addLayer('schulanlagen')
  useAnalysis.getState().edit()
  useAnalysis.getState().addNode('root', { ...newAttributeRow('turnhalle'), operator: 'is_empty' })
  useAnalysis.getState().apply()
  renderCase(OWN)
  await userEvent.click(await screen.findByRole('button', { name: 'Weitere Lesart hinzufügen' }))
  expect(screen.getByRole('group', { name: 'Lesart B' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await screen.findByRole('status')
  const body = calls.find((c) => c.key.startsWith('PUT'))?.body as Record<string, unknown>
  expect(body.gold).toBeUndefined()
  expect(body.gold_any).toEqual([
    view.case.gold,
    { source: 'schulanlagen', where: { op: 'is_null', attr: 'turnhalle' } },
  ])
})

test('V2.2: a behaviour case names the expected answer and what else passes', async () => {
  backend(caseView('n15-je-gemeinde'))
  renderCase('n15-je-gemeinde')
  await screen.findByRole('heading', { name: 'n15-je-gemeinde' })
  expect(row('Art')).toHaveTextContent('Verhaltensfall')
  const expected = within(row('Erwartet')).getByText('Nicht beantwortbar')
  expect(expected.className).toMatch(/border-ink/)
  const also = within(row('Auch zulässig')).getAllByRole('checkbox')
  expect(also).toHaveLength(2)
  for (const box of also) expect(box).toBeDisabled()
  // The start set says "none": the answer must not offer the tool chain.
  expect(row('Arbeitsweise')).toHaveTextContent('Keine andere Arbeitsweise vorschlagen')
  expect(row('Nicht zulässig')).toHaveTextContent('Abfrage, Rückfrage')
  expect(screen.queryByRole('group', { name: 'Bedingungen' })).toBeNull()
})

test('V2.3: a start case is read only, its two readings weigh the same', async () => {
  backend(caseView('doc1-primar-koeniz', { reference_hits: [14, 17] }))
  renderCase('doc1-primar-koeniz')
  await screen.findByRole('heading', { name: 'doc1-primar-koeniz' })
  expect(screen.getByText('Startfall · nur lesbar')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Löschen' })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(row('Art')).toHaveTextContent('Abfragefall · 2 Lesarten, jede gilt')
  expect(
    within(screen.getByRole('group', { name: 'Lesart A' })).getByText(
      '14 Treffer · Datenstand Beispieldaten',
    ),
  ).toBeInTheDocument()
  expect(
    within(screen.getByRole('group', { name: 'Lesart B' })).getByText(
      '17 Treffer · Datenstand Beispieldaten',
    ),
  ).toBeInTheDocument()
  expect(row('Datenstand')).toHaveTextContent('Beispieldaten · fest')
  expect(row('Teil')).toHaveTextContent('Abstimmung')
})

test('V2.3: "Als eigenen Fall kopieren" makes an own case under a new id, split Bestätigung', async () => {
  const start = caseView('doc1-primar-koeniz')
  const calls = backend(start, {
    'POST /api/admin/evaluation/cases': (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as CaseView['case']
      return new Response(JSON.stringify({ ...start, case: body, read_only: false }), {
        status: 201,
      })
    },
    'GET /api/admin/evaluation/cases/doc1-koeniz-eigen': { ...start, read_only: false },
  })
  renderCase('doc1-primar-koeniz')
  await userEvent.click(await screen.findByRole('button', { name: 'Als eigenen Fall kopieren' }))
  const dialog = await screen.findByRole('dialog', { name: 'Als eigenen Fall kopieren' })
  const id = within(dialog).getByRole('textbox', { name: 'Kennung' })
  expect(id).toHaveValue('doc1-primar-koeniz-kopie')
  expect(id).toHaveFocus()
  expect(within(dialog).getByRole('button', { name: 'Bestätigung' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await userEvent.clear(id)
  await userEvent.type(id, 'Doc1')
  expect(within(dialog).getByRole('button', { name: 'Kopieren' })).toBeDisabled()
  await userEvent.clear(id)
  await userEvent.type(id, 'doc1-koeniz-eigen{Enter}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const post = calls.find((c) => c.key === 'POST /api/admin/evaluation/cases')?.body as Record<
    string,
    unknown
  >
  expect(post).toMatchObject({
    id: 'doc1-koeniz-eigen',
    origin: 'authored',
    split: 'confirm',
    data_state: 'sample',
    prompt: start.case.prompt,
    gold_any: start.case.gold_any,
  })
  expect(post).not.toHaveProperty('origin_action')
  expect(await screen.findByRole('heading', { name: 'doc1-primar-koeniz' })).toBeInTheDocument()
})

test('keyboard: the copy dialog traps the focus and Esc closes it', async () => {
  backend(caseView('doc1-primar-koeniz'))
  renderCase('doc1-primar-koeniz')
  const open = await screen.findByRole('button', { name: 'Als eigenen Fall kopieren' })
  await userEvent.click(open)
  const dialog = await screen.findByRole('dialog')
  for (let i = 0; i < 8; i++) {
    await userEvent.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
  }
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
