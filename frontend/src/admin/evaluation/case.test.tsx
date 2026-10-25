// One case (design V2, plan WP88): an own query case edited, saved, deleted
// and opened in the workplace; a behaviour case; a start case read only and
// copied into an own case.
import { act, screen, waitFor, within } from '@testing-library/react'
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

/** An error body as the backend writes it (api/errors.py). */
const refusal = (status: number, code: string, details: Record<string, unknown>) =>
  new Response(JSON.stringify({ code, message: 'English text.', details }), { status })

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
      refusal(400, 'case_invalid', {
        case_id: OWN,
        reason: 'unknown_attribute',
        reading: 0,
        layer: 'schulanlagen',
        attribute: 'turnhalle',
        available: ['name'],
      }),
  })
  renderCase(OWN)
  const question = await screen.findByRole('textbox', { name: 'Frage' })
  await userEvent.type(question, '?')
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Das Feld „turnhalle" gibt es im Layer „schulanlagen" nicht, oder das Modell kennt es nicht.',
  )
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
  const keys = calls.map((c) => c.key)
  const deleted = keys.indexOf(`DELETE /api/admin/evaluation/cases/${OWN}`)
  expect(deleted).toBeGreaterThan(-1)
  // The deleted case is not asked for again (no 404 flash).
  expect(keys.slice(deleted + 1)).not.toContain(`GET /api/admin/evaluation/cases/${OWN}`)
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

test('V2.1: unsaved edits of the case are not dropped by leaving without a question', async () => {
  backend(caseView(OWN))
  renderCase(OWN)
  const question = await screen.findByRole('textbox', { name: 'Frage' })
  await userEvent.type(question, '!')
  await userEvent.click(screen.getByRole('button', { name: 'Im Arbeitsplatz öffnen' }))
  const ask = await screen.findByRole('alertdialog', {
    name: 'Ungespeicherte Änderungen am Prüffall verwerfen?',
  })
  await userEvent.click(within(ask).getByRole('button', { name: 'Abbrechen' }))
  expect(question).toHaveValue('Schulanlagen mit Turnhalle in Ostermundigen!')
  expect(screen.queryByText('Arbeitsplatz')).toBeNull()
  // The breadcrumb asks too; confirming leaves.
  await userEvent.click(screen.getByRole('link', { name: 'Bewertung › Prüffälle' }))
  const again = await screen.findByRole('alertdialog')
  await userEvent.click(within(again).getByRole('button', { name: 'Verwerfen' }))
  expect(await screen.findByText('Liste der Prüffälle')).toBeInTheDocument()
})

test('V2.1: a further reading is the applied analysis, never an open draft', async () => {
  const calls = backend(caseView(OWN))
  const s = useAnalysis.getState()
  s.addLayer('schulanlagen')
  s.edit()
  s.addNode('root', { ...newAttributeRow('turnhalle'), operator: 'is_empty' })
  s.apply()
  // A draft in the editor that was not applied.
  s.edit()
  s.addNode('root', { ...newAttributeRow('turnhalle'), value: false })
  renderCase(OWN)
  await userEvent.click(await screen.findByRole('button', { name: 'Weitere Lesart hinzufügen' }))
  // The hits of the readings come with the save.
  expect(screen.getByRole('group', { name: 'Lesart A' })).toHaveTextContent(
    'Treffer neu nach dem Speichern',
  )
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await screen.findByRole('status')
  const body = calls.find((c) => c.key.startsWith('PUT'))?.body as Record<string, unknown>
  expect((body.gold_any as unknown[])[1]).toEqual({
    source: 'schulanlagen',
    where: { op: 'is_null', attr: 'turnhalle' },
  })
})

test('V2.1: a further reading passes the checks of V3 and is not taken twice', async () => {
  backend(caseView(OWN))
  const s = useAnalysis.getState()
  s.addLayer('schulanlagen')
  s.edit()
  s.addNode('root', { ...newAttributeRow('turnhalle'), value: true })
  s.apply()
  renderCase(OWN)
  const add = await screen.findByRole('button', { name: 'Weitere Lesart hinzufügen' })
  // The workplace holds the case's own reference.
  expect(add).toBeDisabled()
  await waitFor(() => expect(add).toHaveAccessibleDescription('Diese Lesart hat der Fall schon.'))
  act(() => s.setRestriction({ kind: 'view', bbox: [7.4, 46.9, 7.5, 47] }))
  expect(add).toBeDisabled()
  expect(add).toHaveAccessibleDescription(/Die Einschränkung „Nur in"/)
  act(() => {
    s.setRestriction(null)
    s.edit()
    for (let i = 0; i < 9; i++) s.addNode('root', { ...newAttributeRow('turnhalle'), value: false })
    s.apply()
  })
  expect(add).toBeDisabled()
  expect(add).toHaveAccessibleDescription(/Die Analyse hat 10 Bedingungen/)
})

test('V2.1: editing only the question keeps the hits', async () => {
  backend(caseView(OWN, { reference_hits: [9] }))
  renderCase(OWN)
  await userEvent.type(await screen.findByRole('textbox', { name: 'Frage' }), '?')
  expect(await screen.findByText('9 von 248 · Datenstand Betriebsdaten')).toBeInTheDocument()
})

test('V2.1: a stale case that is saved unchanged is refused in words', async () => {
  backend(caseView('e-kitas-bahnhof'), {
    'PUT /api/admin/evaluation/cases/e-kitas-bahnhof': () =>
      refusal(409, 'case_stale', {
        case_id: 'e-kitas-bahnhof',
        layer: 'kitas',
        layers: ['kitas'],
      }),
  })
  renderCase('e-kitas-bahnhof')
  expect(await screen.findByText(/Veraltet: Der Layer „kitas" ist gelöscht/)).toBeInTheDocument()
  await userEvent.type(screen.getByRole('textbox', { name: 'Frage' }), '?')
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Der Prüffall nutzt den Layer „kitas", den es nicht mehr gibt oder den Sie nicht sehen.',
  )
})

test('V2.2: an own behaviour case saves its expected kind and what else passes', async () => {
  const start = caseView('n15-je-gemeinde')
  const own = {
    ...start,
    read_only: false,
    case: { ...start.case, id: 'e-je-gemeinde', origin: 'import' as const },
  }
  const calls = backend(own)
  renderCase('e-je-gemeinde')
  await userEvent.selectOptions(
    await screen.findByRole('combobox', { name: 'Erwartet' }),
    'clarification',
  )
  const also = screen.getByRole('group', { name: 'Auch zulässig' })
  await userEvent.click(within(also).getByRole('checkbox', { name: 'Nicht beantwortbar' }))
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await screen.findByRole('status')
  expect(calls.find((c) => c.key.startsWith('PUT'))?.body).toMatchObject({
    expect: 'clarification',
    also: ['cannot_answer'],
    other_approach: 'none',
  })
})

test('a case on the sample data counts nothing on the live catalog', async () => {
  const calls = backend(caseView('doc1-primar-koeniz', { reference_hits: [14, 17] }))
  renderCase('doc1-primar-koeniz')
  await screen.findAllByText(/Treffer · Datenstand Beispieldaten/)
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(calls.some((c) => c.key === 'POST /api/query/count')).toBe(false)
})

test('V2.3: a copy under an id in use is refused in words; the copy notes its source', async () => {
  const calls = backend(caseView('doc1-primar-koeniz'), {
    'POST /api/admin/evaluation/cases': () =>
      refusal(409, 'case_id_taken', { case_id: 'doc1-primar-koeniz-kopie' }),
  })
  renderCase('doc1-primar-koeniz')
  const open = await screen.findByRole('button', { name: 'Als eigenen Fall kopieren' })
  await userEvent.click(open)
  const dialog = await screen.findByRole('dialog')
  const id = within(dialog).getByRole('textbox', { name: 'Kennung' })
  await userEvent.clear(id)
  await userEvent.type(id, 'X')
  expect(id).toHaveAccessibleDescription(/Kennung: Kleinbuchstaben/)
  await userEvent.clear(id)
  await userEvent.type(id, 'doc1-primar-koeniz-kopie{Enter}')
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Einen Prüffall „doc1-primar-koeniz-kopie" gibt es schon.',
  )
  const post = calls.find((c) => c.key === 'POST /api/admin/evaluation/cases')?.body
  expect(post).toMatchObject({ note: 'Kopie von doc1-primar-koeniz.' })
  // Esc closes the dialog and the focus goes back to the button that opened it.
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(open).toHaveFocus()
})

test('V2.3: a copy over the limit of own cases is refused in words', async () => {
  backend(caseView('doc1-primar-koeniz'), {
    'POST /api/admin/evaluation/cases': () =>
      refusal(400, 'case_invalid', { case_id: null, reason: 'too_many', max: 429 }),
  })
  renderCase('doc1-primar-koeniz')
  await userEvent.click(await screen.findByRole('button', { name: 'Als eigenen Fall kopieren' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Kopieren' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Neben dem Startbestand sind höchstens 429 eigene Prüffälle möglich',
  )
})
