// "Als Prüffall speichern" in the workplace (design V3, plan WP88): admins
// only; the analysis as the reference; a refusal before and after the server.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Node } from '../../analysis/model'
import { useAnalysis } from '../../analysis/store'
import { newAttributeRow, newSpatialRow } from '../../analysis/tree'
import type { CaseView, EvalCase } from '../../api/client'
import { casePage } from '../../test/eval-mocks'
import { attribute, layer, signedIn } from '../../test/fixtures'
import { fakeApi, renderAt } from '../../test/render'
import { assertValidQuery } from '../../test/schema'
import { QueryPanel } from '../../workplace/QueryPanel'

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => useAnalysis.getState().reset())

const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  attributes: [attribute({ name: 'schulart', data_type: 'text', label: 'Schulart' })],
})
const gemeinden = layer({
  attributes: [attribute({ name: 'name', data_type: 'text', label: 'Name' })],
})

function backend(patch: Record<string, unknown> = {}, role: 'admin' | 'user' = 'admin') {
  return fakeApi({
    ...signedIn({ role }),
    'GET /api/layers': [schulen, gemeinden],
    'GET /api/admin/evaluation/cases': casePage(),
    'POST /api/query/count': (init: RequestInit | undefined) => {
      const queries = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries
      return { counts: queries.map((_, i) => [14, 412, 30, 22][i] ?? 0) }
    },
    ...patch,
  })
}

const primary = { ...newAttributeRow('schulart'), value: 'Primarschule' }
const inKoeniz: Node = {
  ...newSpatialRow('gemeinden'),
  operator: 'in',
  filter: { ...newAttributeRow('name'), value: 'Köniz' },
}

/** The workplace's analysis: Schulen with the given conditions, applied. */
function analysis(rows: Node[]) {
  const s = useAnalysis.getState()
  s.addLayer('schulen')
  s.edit()
  for (const row of rows) s.addNode('root', row)
  s.apply()
}

const open = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Als Prüffall speichern' }))
  return screen.findByRole('dialog', { name: 'Als Prüffall speichern' })
}

test('only an administrator sees "Als Prüffall speichern"', async () => {
  backend({}, 'user')
  analysis([primary])
  renderAt('/', <QueryPanel />)
  await screen.findByText('Bearbeiten ›')
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Als Prüffall speichern' })).toBeNull(),
  )
})

test('V3.1: the analysis becomes the reference of a live case, split Bestätigung by default', async () => {
  const calls = backend({
    'POST /api/admin/evaluation/cases': (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as EvalCase
      const view: CaseView = { case: body, status: 'ok', status_layers: [], read_only: false }
      return new Response(JSON.stringify(view), { status: 201 })
    },
  })
  analysis([primary, inKoeniz])
  renderAt('/', <QueryPanel />)
  const dialog = await open()
  // The reference as the readable tree, with the hits on the live data.
  const tree = within(dialog).getByRole('group', { name: 'Bedingungen' })
  expect(tree).toHaveTextContent('Schulart = Primarschule')
  expect(await within(dialog).findByText(/14 Treffer · Datenstand/)).toHaveTextContent(
    '14 Treffer · Datenstand Betriebsdaten',
  )
  expect(within(dialog).getByText(/Schreiben Sie die Frage so/)).toBeInTheDocument()
  const question = within(dialog).getByRole('textbox', { name: 'Frage' })
  expect(question).toHaveFocus()
  expect(within(dialog).getByRole('button', { name: 'Bestätigung' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await userEvent.type(question, 'Welche Primarschulen gibt es in Köniz?')
  // The id follows the question until it is edited.
  expect(within(dialog).getByRole('textbox', { name: 'Kennung' })).toHaveValue(
    'e-welche-primarschulen-gibt-es-in-koeniz',
  )
  // At least one tag before it can be saved.
  expect(within(dialog).getByRole('button', { name: 'Speichern' })).toBeDisabled()
  await userEvent.click(within(dialog).getByRole('button', { name: '+ Stichwort' }))
  await userEvent.type(
    within(dialog).getByRole('combobox', { name: 'Neues Stichwort' }),
    'spatial{Enter}',
  )
  expect(within(dialog).getByText('räumlich')).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }))
  expect(await within(dialog).findByRole('status')).toHaveTextContent(
    'Prüffall „e-welche-primarschulen-gibt-es-in-koeniz" gespeichert.',
  )
  expect(within(dialog).getByRole('link', { name: 'Ansehen ›' })).toHaveAttribute(
    'href',
    '/admin/bewertung/faelle/e-welche-primarschulen-gibt-es-in-koeniz',
  )
  const body = calls.find((c) => c.key === 'POST /api/admin/evaluation/cases')?.body as EvalCase
  expect(body).toMatchObject({
    id: 'e-welche-primarschulen-gibt-es-in-koeniz',
    prompt: 'Welche Primarschulen gibt es in Köniz?',
    tags: ['spatial'],
    split: 'confirm',
    origin: 'authored',
    data_state: 'live',
    layers: [{ name: 'gemeinden' }, { name: 'schulen' }],
  })
  // Stored as the harness writes it: no schema_version or output in the reference.
  expect(Object.keys(body.gold ?? {})).toEqual(['source', 'where'])
  assertValidQuery({ schema_version: '2', output: 'map', ...body.gold })
  // Empty defaults are not sent, so the case exports as written.
  expect(body).not.toHaveProperty('also')
  expect(body).not.toHaveProperty('note')
  // The analysis is unchanged.
  expect(useAnalysis.getState().tree.children).toHaveLength(2)
})

test('V3.2: more than 8 conditions cannot be saved; "Zur Abfrage" opens the editor', async () => {
  backend()
  analysis(Array.from({ length: 10 }, () => ({ ...primary, id: crypto.randomUUID() })))
  renderAt('/', <QueryPanel />)
  const dialog = await open()
  const refusal = within(dialog).getByRole('alert')
  expect(refusal).toHaveTextContent('Nicht speicherbar')
  expect(refusal).toHaveTextContent(
    'Die Analyse hat 10 Bedingungen. Ein Prüffall darf höchstens 8 haben, wie jede Modellantwort.',
  )
  expect(within(dialog).queryByRole('textbox', { name: 'Frage' })).toBeNull()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Zur Abfrage' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(useAnalysis.getState().draft).not.toBeNull()
})

test('V3.2: a restriction "Nur in" cannot be part of a case', async () => {
  backend()
  analysis([primary])
  useAnalysis.getState().setRestriction({ kind: 'view', bbox: [7.4, 46.9, 7.5, 47] })
  renderAt('/', <QueryPanel />)
  const dialog = await open()
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Die Einschränkung „Nur in"')
})

test('V3.2: the refusal of the server in words, the form stays', async () => {
  backend({
    'POST /api/admin/evaluation/cases': () =>
      new Response(
        JSON.stringify({
          code: 'case_invalid',
          message: "Reading 0 of the case 'e-x' fails the checks.",
          details: { case_id: 'e-x', reason: 'unknown_layer', layer: 'schulen', reading: 0 },
        }),
        { status: 400 },
      ),
  })
  analysis([primary])
  renderAt('/', <QueryPanel />)
  const dialog = await open()
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Frage' }), 'Primarschulen')
  await userEvent.click(within(dialog).getByRole('button', { name: '+ Stichwort' }))
  await userEvent.type(
    within(dialog).getByRole('combobox', { name: 'Neues Stichwort' }),
    'attribute{Enter}',
  )
  await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }))
  const refusal = await within(dialog).findByRole('alert')
  expect(refusal).toHaveTextContent('Nicht speicherbar')
  expect(refusal).toHaveTextContent('Den Layer „schulen" gibt es nicht oder er ist nicht sichtbar.')
  expect(within(dialog).getByRole('textbox', { name: 'Frage' })).toHaveValue('Primarschulen')
})

test('keyboard: the dialog keeps the focus inside, Esc closes it', async () => {
  backend()
  analysis([primary])
  renderAt('/', <QueryPanel />)
  const dialog = await open()
  const order: string[] = []
  for (let i = 0; i < 6; i++) {
    await userEvent.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
    const el = document.activeElement as HTMLElement
    order.push(el.getAttribute('aria-label') ?? el.textContent ?? '')
  }
  // Frage → Kennung → Teil → Stichwort → Abbrechen (Speichern waits), then around again.
  expect(order.slice(0, 5)).toEqual(['', 'Abstimmung', 'Bestätigung', '+ Stichwort', 'Abbrechen'])
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
