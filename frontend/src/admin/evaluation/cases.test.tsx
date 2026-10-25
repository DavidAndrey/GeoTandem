// The case pages (design V1, plan WP88): list, filters, status marks, import
// and export, the empty state; against the fake API with the eval mocks.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../../App'
import type { CasePage } from '../../api/client'
import { casePage, START_CASES } from '../../test/eval-mocks'
import { layer, signedIn } from '../../test/fixtures'
import { fakeApi, renderAt } from '../../test/render'

/** The element a test relies on; a clear failure instead of ``!``. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected an element')
  return value
}

afterEach(() => vi.unstubAllGlobals())

const schulanlagen = layer({ name: 'schulanlagen', title: 'Schulanlagen (Import)' })

function backend(page: CasePage = casePage(), patch: Record<string, unknown> = {}) {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': [schulanlagen],
    'GET /api/admin/evaluation/cases': page,
    ...patch,
  })
}

const onlyStart = (): CasePage => {
  const items = casePage().items.filter((v) => v.read_only)
  return { items, total: items.length }
}

/** The ids of the table's rows, in order. */
const rowIds = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).queryByRole('link')?.textContent)
    .filter(Boolean)

beforeEach(() => vi.stubGlobal('scrollTo', () => undefined))

test('Bewertung is active in the navigation and enters on the Prüffälle tab', async () => {
  backend()
  renderAt('/admin/daten', <App />)
  const nav = await screen.findByRole('navigation', { name: 'Administration' })
  const entry = within(nav).getByRole('link', { name: 'Bewertung' })
  expect(entry).toHaveAttribute('href', '/admin/bewertung/faelle')
  expect(within(nav).queryByText(/ab E3/)).toBeNull()
})

test('the Läufe tab holds a placeholder until WP93', async () => {
  backend()
  renderAt('/admin/bewertung', <App />)
  expect(await screen.findByText(/Bewertungsläufe folgen/)).toBeInTheDocument()
  const tabs = screen.getByRole('navigation', { name: 'Bewertung' })
  expect(within(tabs).getByRole('link', { name: 'Läufe' })).toHaveAttribute('aria-current', 'page')
  // The group entry stays marked on every tab of Bewertung.
  const nav = screen.getByRole('navigation', { name: 'Administration' })
  const entry = within(nav).getByRole('link', { name: 'Bewertung' })
  expect(entry.className).toMatch(/border-accent/)
  expect(entry).toHaveAttribute('aria-current', 'page')
})

test('V1.1: start cases first, five of them until expanded, own cases below', async () => {
  backend()
  renderAt('/admin/bewertung/faelle', <App />)
  await screen.findByText('doc1-primar-koeniz')
  expect(screen.getByText(/71 Startfälle \(nur lesbar\) · 3 eigene/)).toBeInTheDocument()
  const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
  expect(headers.slice(0, 7)).toEqual([
    'Kennung',
    'Frage',
    'Art',
    'Teil',
    'Stichwörter',
    'Herkunft',
    'Datenstand',
  ])
  expect(rowIds()).toEqual([
    ...START_CASES.slice(0, 5).map((c) => c.id),
    'e-turnhalle-ostermundigen',
    'e-kitas-bahnhof',
    'e-schulweg-import',
  ])
  const first = must(screen.getAllByRole('row')[1])
  expect(within(first).getByText('Welche Primarschulen gibt es in Köniz?')).toBeInTheDocument()
  expect(within(first).getByText('Abstimmung')).toBeInTheDocument()
  expect(within(first).getByText('Beispieldaten')).toBeInTheDocument()
  expect(
    within(first).getByText('räumlich · liegt in · Kombination · mehrdeutig'),
  ).toBeInTheDocument()
  // The id is a code: monospace, and the way into the case.
  expect(within(first).getByRole('link').closest('td')?.className).toMatch(/font-mono/)
  expect(within(first).getByRole('link')).toHaveAttribute(
    'href',
    '/admin/bewertung/faelle/doc1-primar-koeniz',
  )
  const more = screen.getByRole('button', { name: '… 66 weitere Startfälle' })
  expect(more).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(more)
  expect(rowIds()).toHaveLength(74)
  // A real toggle: the same button folds them again.
  expect(more).toHaveAttribute('aria-expanded', 'true')
  expect(more).toHaveFocus()
  await userEvent.click(more)
  expect(rowIds()).toHaveLength(8)
})

test('V1.1: filters by origin, split, kind and question, kept in the address', async () => {
  backend()
  renderAt('/admin/bewertung/faelle', <App />)
  await screen.findByText('doc1-primar-koeniz')
  await userEvent.selectOptions(screen.getByLabelText('Herkunft'), 'import')
  expect(rowIds()).toEqual(['e-schulweg-import'])
  await userEvent.selectOptions(screen.getByLabelText('Herkunft'), '')
  await userEvent.selectOptions(screen.getByLabelText('Datenstand'), 'live')
  await userEvent.selectOptions(screen.getByLabelText('Teil'), 'confirm')
  expect(rowIds()).toEqual(['e-turnhalle-ostermundigen', 'e-kitas-bahnhof', 'e-schulweg-import'])
  await userEvent.selectOptions(screen.getByLabelText('Datenstand'), '')
  await userEvent.selectOptions(screen.getByLabelText('Teil'), '')
  await userEvent.selectOptions(screen.getByLabelText('Art'), 'behaviour')
  expect(rowIds()).toContain('n15-je-gemeinde')
  expect(rowIds()).not.toContain('doc1-primar-koeniz')
  await userEvent.selectOptions(screen.getByLabelText('Art'), '')
  await userEvent.type(screen.getByRole('searchbox', { name: 'Frage suchen' }), 'Turnhalle')
  expect(rowIds()).toEqual(['e-turnhalle-ostermundigen'])
  await userEvent.selectOptions(screen.getByLabelText('Stichwort'), 'near')
  expect(screen.getByText('Kein Prüffall passt zu diesen Filtern.')).toBeInTheDocument()
})

test('V1.2: stale grey with a struck-through label, a changed data state as a message', async () => {
  backend()
  renderAt('/admin/bewertung/faelle', <App />)
  const stale = must((await screen.findByText('e-kitas-bahnhof')).closest('tr'))
  const label = must(within(stale).getByText('veraltet').closest('[data-status]'))
  expect(label).toHaveAttribute('data-line', 'void')
  expect(label.className).toMatch(/line-through/)
  expect(stale.className).toMatch(/text-muted/)
  const changed = must(screen.getByText('e-schulweg-import').closest('tr'))
  const message = must(within(changed).getByText('Datenstand geändert').closest('[data-status]'))
  expect(message).toHaveAttribute('data-line', 'message')
  expect(message.className).not.toMatch(/line-through/)
  // Both explained below the list, in words.
  expect(screen.getByText(/ist gelöscht oder für admin nicht mehr sichtbar/)).toHaveTextContent(
    'e-kitas-bahnhof',
  )
  expect(screen.getByText(/wurde seit dem Anlegen des Falls neu importiert/)).toHaveTextContent(
    '„schulwege"',
  )
  // An ok case has no label.
  const ok = must(screen.getByText('e-turnhalle-ostermundigen').closest('tr'))
  expect(within(ok).queryByText('veraltet')).toBeNull()
})

test('V1.4: without own cases the start set stays and the three ways stand below it', async () => {
  backend(onlyStart())
  renderAt('/admin/bewertung/faelle', <App />)
  const hint = must((await screen.findByText('Noch keine eigenen Prüffälle')).parentElement)
  const ways = within(hint).getAllByRole('listitem')
  expect(ways).toHaveLength(3)
  expect(ways[0]).toHaveTextContent('Im Arbeitsplatz eine Analyse bauen und Als Prüffall speichern')
  expect(ways[1]).toHaveTextContent('Im Modellprotokoll einen Eintrag Als Prüffall übernehmen')
  expect(ways[2]).toHaveTextContent('Eine Datei importieren (Format wie Export)')
  expect(within(must(ways[1])).getByRole('link')).toHaveAttribute('href', '/admin/modellprotokoll')
  expect(screen.getByText('doc1-primar-koeniz')).toBeInTheDocument()
})

test('export downloads the own cases as a JSON file', async () => {
  backend()
  renderAt('/admin/bewertung/faelle', <App />)
  const link = await screen.findByRole('link', { name: 'Exportieren' })
  expect(link).toHaveAttribute('href', '/api/admin/evaluation/cases/export')
  expect(link).toHaveAttribute('download', 'pruefaelle.json')
})

const file = (content: unknown, name = 'pruefaelle-ostermundigen.json') =>
  new File([typeof content === 'string' ? content : JSON.stringify(content)], name, {
    type: 'application/json',
  })

const caseFile = {
  format: 'geotandem-eval-cases',
  version: 1,
  cases: [
    { id: 'e-hallenbad', prompt: 'Schulen mit Hallenbad' },
    { id: 'e-kita-2', prompt: 'Kitas' },
    { id: 'e-gut', prompt: 'Gut' },
  ],
}

const chooseFile = () => must(screen.getAllByLabelText('Prüffall-Datei wählen')[0])

test('V1.3: an import with faulty cases takes nothing and names each case with its reason', async () => {
  const calls = backend(casePage(), {
    'POST /api/admin/evaluation/cases/import': {
      imported: 0,
      problems: [
        // As ``cases.import_file`` writes them (WP88 review: with the details).
        {
          case_id: 'e-hallenbad',
          code: 'case_invalid',
          message: "Reading 0 of the case 'e-hallenbad' fails the checks: no attribute becken_m.",
          details: {
            reason: 'unknown_attribute',
            reading: 0,
            layer: 'schulanlagen',
            attribute: 'becken_m',
            available: ['name'],
          },
        },
        {
          case_id: 'e-kita-2',
          code: 'case_id_taken',
          message: "A case 'e-kita-2' exists already.",
          details: {},
        },
      ],
    },
  })
  renderAt('/admin/bewertung/faelle', <App />)
  await screen.findByText('doc1-primar-koeniz')
  await userEvent.upload(chooseFile(), file(caseFile))
  const dialog = await screen.findByRole('dialog', { name: 'Import nicht übernommen' })
  expect(dialog).toHaveTextContent(
    'pruefaelle-ostermundigen.json enthält 3 Fälle, 2 davon sind fehlerhaft. Es wurde nichts übernommen.',
  )
  const rows = within(dialog).getAllByRole('row').slice(1)
  expect(rows.map((r) => r.textContent)).toEqual([
    'e-hallenbadDas Feld „becken_m" gibt es im Layer „schulanlagen" nicht, oder das Modell kennt es nicht.',
    'e-kita-2Kennung doppelt (schon vorhanden)',
  ])
  // The server's own words only under "Technisch".
  expect(within(dialog).getByText('Technisch (Prüfbericht)')).toBeInTheDocument()
  expect(calls.find((c) => c.key === 'POST /api/admin/evaluation/cases/import')?.body).toEqual(
    caseFile,
  )
  // Esc closes the dialog, the focus goes back to Importieren; the list is unchanged.
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(calls.filter((c) => c.key === 'GET /api/admin/evaluation/cases')).toHaveLength(1)
})

test('V1.3: a case the format refuses is named from the file, a file that is no JSON as the file', async () => {
  backend(casePage(), {
    'POST /api/admin/evaluation/cases/import': () =>
      new Response(
        JSON.stringify({
          code: 'schema_violation',
          message: 'cases.1.tags: Field required',
          details: {
            errors: [
              { loc: ['body', 'cases', 1, 'tags'], msg: 'Field required', type: 'missing' },
              { loc: ['body', 'cases', 1, 'split'], msg: 'Field required', type: 'missing' },
            ],
          },
        }),
        { status: 422 },
      ),
  })
  renderAt('/admin/bewertung/faelle', <App />)
  await screen.findByText('doc1-primar-koeniz')
  await userEvent.upload(chooseFile(), file(caseFile))
  const dialog = await screen.findByRole('dialog', { name: 'Import nicht übernommen' })
  expect(dialog).toHaveTextContent('enthält 3 Fälle, 1 davon sind fehlerhaft')
  expect(within(dialog).getByText('Feld „tags" fehlt oder ist ungültig')).toBeInTheDocument()
  expect(within(dialog).getAllByText('e-kita-2')).toHaveLength(2)
  await userEvent.click(within(dialog).getByRole('button', { name: 'Schliessen' }))
  await userEvent.upload(chooseFile(), file('{ kein json', 'kaputt.json'))
  const again = await screen.findByRole('dialog', { name: 'Import nicht übernommen' })
  expect(again).toHaveTextContent('kaputt.json lässt sich nicht übernehmen.')
  expect(within(again).getByText('Die Datei ist kein lesbares JSON.')).toBeInTheDocument()
})

test('a clean import takes every case and refreshes the list', async () => {
  const calls = backend(casePage(), {
    'POST /api/admin/evaluation/cases/import': { imported: 3, problems: [] },
  })
  renderAt('/admin/bewertung/faelle', <App />)
  await screen.findByText('doc1-primar-koeniz')
  await userEvent.upload(chooseFile(), file(caseFile))
  expect(await screen.findByRole('status')).toHaveTextContent('3 Prüffälle übernommen.')
  await waitFor(() =>
    expect(calls.filter((c) => c.key === 'GET /api/admin/evaluation/cases')).toHaveLength(2),
  )
})

test('the list reads every page of a long list', async () => {
  const all = casePage().items
  const pages = [all.slice(0, 50), all.slice(50)]
  let call = 0
  backend(casePage(), {
    'GET /api/admin/evaluation/cases': () => ({ items: pages[call++] ?? [], total: all.length }),
  })
  renderAt('/admin/bewertung/faelle', <App />)
  expect(await screen.findByText('e-schulweg-import')).toBeInTheDocument()
  expect(call).toBe(2)
})

test('keyboard: the filters, import and export are reached in reading order', async () => {
  backend()
  renderAt('/admin/bewertung/faelle', <App />)
  const search = await screen.findByRole('searchbox', { name: 'Frage suchen' })
  await screen.findByText('doc1-primar-koeniz')
  search.focus()
  const order: string[] = []
  for (let i = 0; i < 8; i++) {
    await userEvent.tab()
    const el = document.activeElement as HTMLElement
    order.push(
      el.getAttribute('aria-label') ??
        el.closest('label')?.firstChild?.textContent ??
        el.textContent ??
        '',
    )
  }
  expect(order).toEqual([
    'Art',
    'Teil',
    'Stichwort',
    'Herkunft',
    'Datenstand',
    'Importieren',
    'Exportieren',
    'doc1-primar-koeniz',
  ])
})

test('V1.3: an import over the limit of own cases says so', async () => {
  backend(casePage(), {
    'POST /api/admin/evaluation/cases/import': {
      imported: 0,
      problems: [
        {
          case_id: null,
          code: 'case_invalid',
          message: 'An instance keeps at most 429 own cases beside the start set; it has 3.',
          details: { reason: 'too_many', max: 429 },
        },
      ],
    },
  })
  renderAt('/admin/bewertung/faelle', <App />)
  await screen.findByText('doc1-primar-koeniz')
  const button = screen.getByRole('button', { name: 'Importieren' })
  await userEvent.click(button)
  await userEvent.upload(chooseFile(), file(caseFile))
  const dialog = await screen.findByRole('dialog', { name: 'Import nicht übernommen' })
  expect(within(dialog).getByText(/höchstens 429 eigene Prüffälle/)).toBeInTheDocument()
  expect(within(dialog).getByText('Datei')).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Schliessen' }))
  await waitFor(() => expect(button).toHaveFocus())
})

test('V1.4: an import from the hint keeps its message when the hint goes away', async () => {
  let imported = false
  backend(onlyStart(), {
    'GET /api/admin/evaluation/cases': () => (imported ? casePage() : onlyStart()),
    'POST /api/admin/evaluation/cases/import': () => {
      imported = true
      return { imported: 3, problems: [] }
    },
  })
  renderAt('/admin/bewertung/faelle', <App />)
  const hint = must((await screen.findByText('Noch keine eigenen Prüffälle')).parentElement)
  await userEvent.click(within(hint).getByRole('button', { name: 'importieren' }))
  await userEvent.upload(chooseFile(), file(caseFile))
  expect(await screen.findByRole('status')).toHaveTextContent('3 Prüffälle übernommen.')
  await waitFor(() => expect(screen.queryByText('Noch keine eigenen Prüffälle')).toBeNull())
  expect(screen.getByRole('status')).toHaveTextContent('3 Prüffälle übernommen.')
  expect(screen.getByText('e-schulweg-import')).toBeInTheDocument()
})
