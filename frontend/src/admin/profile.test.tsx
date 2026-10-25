import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import type { LayerGaps, ProfilePreview, ProfileSummary } from '../api/client'
import { runPage, runView } from '../test/eval-mocks'
import { account, attribute, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { AttributeRows } from './LayerPage'
import { percent } from './format'

afterEach(() => vi.unstubAllGlobals())

const profile: ProfilePreview = {
  profile_version: 1,
  hash: 'ab'.repeat(32),
  size_chars: 2663,
  tokens_estimate: 888,
  budget: { connection: 'Ollama', context_length: 8192 },
  over_budget: false,
  layers: [
    {
      name: 'gewaesser',
      title: 'Gewässer',
      description: 'Fliessgewässer',
      kind: 'vector',
      geometry_type: 'LineString',
      attributes: [
        { name: 'typ', type: 'text', label: 'Typ', codes: { B: 'Bach', F: 'Fluss' } },
        { name: 'laenge_km', type: 'real', label: 'Länge', unit: 'km', range: [0, 120] },
      ],
    },
  ],
}

const complete: ProfileSummary = {
  profile_hash: 'ab'.repeat(32),
  layers: 2,
  attributes: 10,
  labelled: 10,
  text_attributes: 3,
  text_with_codes: 3,
  described: 12,
  gaps: [],
}

/** V8.1 of the design: a plain import beside two curated layers. */
const withGaps: ProfileSummary = {
  profile_hash: 'cd'.repeat(32),
  layers: 3,
  attributes: 34,
  labelled: 10,
  text_attributes: 9,
  text_with_codes: 3,
  described: 13,
  gaps: [
    {
      layer: 'schulanlagen',
      title: 'Schulanlagen (Import 21.10.)',
      attributes: 24,
      text_attributes: 6,
      unconfirmed_codes: ['schulstufe', 'sprache', 'traeger', 'stufe2', 'art', 'ort'],
      unlabelled: ['hat_turnhalle', 'sw_dist_m'].concat(
        Array.from({ length: 22 }, (_, i) => `f${i}`),
      ),
      undescribed: [''].concat(Array.from({ length: 23 }, (_, i) => `f${i}`)),
    },
  ],
}

test('the profile for an account shows layers, domains, hash and size', async () => {
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account(), account({ id: 2, username: 'm.keller', role: 'user' })],
    'GET /api/admin/llm/profile': profile,
    'GET /api/admin/evaluation/profile-summary': complete,
  })
  renderAt('/admin/steckbrief', <App />)

  await screen.findByRole('option', { name: 'm.keller' })
  await userEvent.selectOptions(screen.getByLabelText('Konto'), 'm.keller')
  const layer = await screen.findByRole('region', { name: 'Gewässer' })
  expect(within(layer).getByText('Codeliste (2)')).toBeInTheDocument()
  expect(within(layer).getByText('0 bis 120')).toBeInTheDocument()
  expect(screen.getByText("2'663 Zeichen, geschätzt 888 Token")).toBeInTheDocument()
  expect(screen.getByText("8'192 Token (Ollama)")).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('ab'.repeat(32))).toBeInTheDocument()
})

test('a profile over the context length is a warning, not cut', async () => {
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account()],
    'GET /api/admin/llm/profile': {
      ...profile,
      budget: { connection: 'Ollama', context_length: 512 },
      over_budget: true,
    },
    'GET /api/admin/evaluation/profile-summary': complete,
  })
  renderAt('/admin/steckbrief', <App />)

  await screen.findByRole('option', { name: 'admin' })
  await userEvent.selectOptions(screen.getByLabelText('Konto'), 'admin')
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'grösser als die Kontextlänge von „Ollama“',
  )
  expect(screen.getByRole('region', { name: 'Gewässer' })).toBeInTheDocument()
})

const proposed = attribute({
  name: 'kategorie',
  data_type: 'text',
  label: 'Kategorie',
  value_domain: { codes: { A: 'A', B: 'B' } },
  value_domain_confirmed: false,
})

test('saving a label does not confirm a proposed code list', async () => {
  const calls = fakeApi({
    'PATCH /api/admin/layers/x/attributes/kategorie': proposed,
  })
  renderAt(
    '/',
    <table>
      <AttributeRows layer="x" attribute={proposed} />
    </table>,
  )

  const label = screen.getByLabelText('Bezeichnung kategorie')
  await userEvent.type(label, ' neu')
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  expect(calls[0]?.body).not.toHaveProperty('value_domain')
})

test('a proposed code list is confirmed explicitly', async () => {
  const calls = fakeApi({
    'PATCH /api/admin/layers/x/attributes/kategorie': proposed,
  })
  renderAt(
    '/',
    <table>
      <AttributeRows layer="x" attribute={proposed} />
    </table>,
  )

  await userEvent.click(screen.getByRole('button', { name: 'Details zu kategorie' }))
  expect(screen.getByText(/stammen aus den Daten des Imports/)).toBeInTheDocument()
  await userEvent.click(screen.getByLabelText('Vorschlag für kategorie bestätigen'))
  await userEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  expect(calls[0]?.body).toMatchObject({ value_domain: { codes: { A: 'A', B: 'B' } } })
})

const summaryRoute = (urls: string[], answer: ProfileSummary) => ({
  'GET /api/admin/evaluation/profile-summary': (_init: unknown, input: string) => {
    urls.push(input)
    return answer
  },
})

const SUMMARY = '/api/admin/evaluation/profile-summary'

const percents = (row: HTMLElement) =>
  within(row)
    .getAllByText(/%/)
    .map((c) => c.textContent)

test('the completeness shows shares per layer and the gaps in the order of care (V8.1)', async () => {
  const urls: string[] = []
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account(), account({ id: 2, username: 'm.keller', role: 'user' })],
    'GET /api/admin/llm/profile': profile,
    ...summaryRoute(urls, withGaps),
  })
  renderAt('/admin/steckbrief', <App />)

  await screen.findByRole('option', { name: 'm.keller' })
  await userEvent.selectOptions(screen.getByLabelText('Konto'), 'm.keller')
  await vi.waitFor(() => expect(urls).toContain(`${SUMMARY}?data_state=live&account=m.keller`))
  const summary = screen.getByRole('region', { name: 'Vollständigkeit' })
  expect(within(summary).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent(
    'Vollständigkeit · Betriebsdaten',
  )
  // Bar and number: 10/34 labelled, 3/9 code lists, 13/37 described.
  expect(percents(within(summary).getByRole('row', { name: /Gesamt/ }))).toEqual([
    '29 %',
    '33 %',
    '35 %',
  ])
  expect(percents(within(summary).getByRole('row', { name: /Schulanlagen/ }))).toEqual([
    '0 %',
    '0 %',
    '4 %',
  ])
  expect(within(summary).getByText('2 weitere Layer sind vollständig.').tagName).toBe('TD')
  expect(
    within(summary).getByRole('columnheader', { name: /Textattribute mit bestätigter Codeliste/ }),
  ).toHaveTextContent('von denen mit Codeliste (bestätigt oder vorgeschlagen)')

  const gaps = within(summary).getByRole('region', {
    name: 'Lücken in Schulanlagen (Import 21.10.)',
  })
  expect(within(gaps).getByRole('heading', { level: 4 })).toBeInTheDocument()
  const items = within(gaps).getAllByRole('listitem')
  expect(items.map((i) => i.querySelector('strong')?.textContent)).toEqual([
    'Codelisten bestätigen',
    'Beschriftungen',
    'Beschreibungen, die die Bedeutung nennen',
  ])
  expect(items[0]).toHaveTextContent(
    '0 von 6 Textattributen mit Codeliste (bestätigt oder vorgeschlagen): schulstufe, sprache, traeger, …',
  )
  expect(items[1]).toHaveTextContent('0 von 24 Attributen (z. B. hat_turnhalle, sw_dist_m, f0, …)')
  expect(items[2]).toHaveTextContent('1 von 25 (fehlt: Layerbeschreibung, f0, f1, …)')
  expect(items[2]).toHaveTextContent('zuletzt: im Mittel ohne messbare Wirkung')
  for (const item of items)
    expect(
      within(item).getByRole('link', { name: 'Felder von Schulanlagen (Import 21.10.)' }),
    ).toHaveAttribute('href', '/admin/daten/schulanlagen?reiter=felder')
  expect(within(summary).queryByText('vollständig')).not.toBeInTheDocument()
})

const gap = (layer: string, extra: Partial<LayerGaps>): LayerGaps => ({
  layer,
  title: layer,
  attributes: 1,
  text_attributes: 1,
  unconfirmed_codes: [],
  unlabelled: [],
  undescribed: [],
  ...extra,
})

/** In the catalog's order: one layer lacks a description, one a label, one a code list. */
const threeLayers: ProfileSummary = {
  ...withGaps,
  layers: 4,
  attributes: 3,
  gaps: [
    gap('anlagen', { undescribed: ['x'] }),
    gap('bahnen', { unlabelled: ['x'] }),
    gap('zonen', { unconfirmed_codes: ['x'] }),
  ],
}

test('layers and their gaps come in one order, by care; one complete layer in the singular', async () => {
  fakeApi({ ...signedIn(), 'GET /api/admin/users': [account()], ...summaryRoute([], threeLayers) })
  renderAt('/admin/steckbrief', <App />)

  const summary = await screen.findByRole('region', { name: 'Vollständigkeit' })
  const rows = within(summary).getAllByRole('row').slice(2, 5)
  expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual([
    'zonen',
    'bahnen',
    'anlagen',
  ])
  const cards = within(summary).getAllByRole('region')
  expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
    'Lücken in zonen',
    'Lücken in bahnen',
    'Lücken in anlagen',
  ])
  expect(within(summary).getByText('Ein weiterer Layer ist vollständig.')).toBeInTheDocument()
  expect(cards[0]).toHaveTextContent(
    '0 von 1 Textattribut mit Codeliste (bestätigt oder vorgeschlagen): x',
  )
  expect(cards[1]).toHaveTextContent('0 von 1 Attribut (z. B. x)')
})

test("the import wizard's layer comes first, marked", async () => {
  fakeApi({ ...signedIn(), 'GET /api/admin/users': [account()], ...summaryRoute([], threeLayers) })
  renderAt('/admin/steckbrief?layer=anlagen', <App />)

  const summary = await screen.findByRole('region', { name: 'Vollständigkeit' })
  const [first] = within(summary).getAllByRole('region')
  expect(first).toHaveAccessibleName('Lücken in anlagen')
  expect(first).toHaveTextContent('gerade importiert')
  expect(within(summary).getAllByText('gerade importiert')).toHaveLength(1)
})

test("live without an account is the caller's at once; complete is one row (V8.2); sample and back", async () => {
  const urls: string[] = []
  fakeApi({ ...signedIn(), 'GET /api/admin/users': [account()], ...summaryRoute(urls, complete) })
  renderAt('/admin/steckbrief', <App />)

  let summary = await screen.findByRole('region', { name: 'Vollständigkeit' })
  expect(urls).toEqual([`${SUMMARY}?data_state=live`])
  expect(within(summary).getByText('Vollständigkeit · Betriebsdaten')).toBeInTheDocument()
  expect(within(summary).getAllByRole('row')).toHaveLength(2)
  expect(within(summary).getAllByText('100 %')).toHaveLength(3)
  expect(within(summary).getByText('vollständig')).toBeInTheDocument()
  expect(
    within(summary).getByText(
      'Alle Attribute beschriftet, alle Codelisten bestätigt, alle Beschreibungen vorhanden.',
    ),
  ).toBeInTheDocument()
  expect(within(summary).queryByRole('link')).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole('radio', { name: 'Beispieldaten' }))
  await screen.findByText('Vollständigkeit · Beispieldaten')
  expect(urls).toEqual([`${SUMMARY}?data_state=live`, `${SUMMARY}?data_state=sample`])
  await userEvent.click(screen.getByRole('radio', { name: 'Betriebsdaten' }))
  summary = await screen.findByRole('region', { name: 'Vollständigkeit' })
  expect(within(summary).getByText('Vollständigkeit · Betriebsdaten')).toBeInTheDocument()
})

test('a share is never rounded up to 100 while something is missing', () => {
  expect(percent(199, 200)).toBe(99)
  expect(percent(0, 0)).toBeNull()
  expect(percent(3, 3)).toBe(100)
})

test('V8.1: a gap names what the newest complete run measured on the layer', async () => {
  const haltestellen = { ...withGaps.gaps[0], layer: 'haltestellen', title: 'Haltestellen' }
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account()],
    ...summaryRoute([], { ...withGaps, gaps: [haltestellen] }),
    'GET /api/admin/evaluation/runs': runPage(),
    'GET /api/admin/evaluation/runs/13': runView('done'),
  })
  renderAt('/admin/steckbrief', <App />)
  await userEvent.click(await screen.findByRole('radio', { name: 'Beispieldaten' }))
  const gaps = await screen.findByRole('region', { name: 'Lücken in Haltestellen' })
  expect(
    await within(gaps).findByText(
      /^Gemessen: gpt-6-luna P0 hatte auf diesem Layer .* \(Lauf #13, .*\)\. Steckbrief damals #b20a, heute anders\.$/,
    ),
  ).toBeInTheDocument()
  // The sample data is mended nowhere: its gaps carry no links to fields.
  expect(within(gaps).queryByRole('link', { name: /^Felder von / })).toBeNull()
})

test("V8.1 live: a full run (never a quick test) that saw the chosen account's view", async () => {
  const haltestellen = { ...withGaps.gaps[0], layer: 'haltestellen', title: 'Haltestellen' }
  const done = runView('done')
  const live = (id: number, account: string, scope: 'full' | 'quick' = 'full') => ({
    ...done,
    id,
    label: { ...done.label, data_state: 'live' as const, account, scope },
  })
  const summary = (id: number, scope: 'full' | 'quick' = 'full') => ({
    ...runPage().items[1],
    id,
    scope,
    data_state: 'live' as const,
  })
  const asked: string[] = []
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account(), account({ id: 2, username: 'm.keller', role: 'user' })],
    'GET /api/admin/llm/profile': profile,
    ...summaryRoute([], {
      ...withGaps,
      profile_hash: done.label.profile.profile_hash,
      gaps: [haltestellen],
    }),
    'GET /api/admin/evaluation/runs': {
      items: [summary(31, 'quick'), summary(30), summary(29)],
      total: 3,
    },
    'GET /api/admin/evaluation/runs/31': () => (asked.push('31'), live(31, 'm.keller', 'quick')),
    'GET /api/admin/evaluation/runs/30': () => (asked.push('30'), live(30, 'admin')),
    'GET /api/admin/evaluation/runs/29': () => (asked.push('29'), live(29, 'm.keller')),
  })
  renderAt('/admin/steckbrief', <App />)
  await screen.findByRole('option', { name: 'm.keller' })
  await userEvent.selectOptions(screen.getByLabelText('Konto'), 'm.keller')
  const gaps = await screen.findByRole('region', { name: 'Lücken in Haltestellen' })
  // #31 is a quick test, #30 saw admin's view: #29. The same profile: no note.
  expect(await within(gaps).findByText(/^Gemessen: .* \(Lauf #29, [^)]*\)\.$/)).toBeInTheDocument()
  expect(asked).not.toContain('31')
})
