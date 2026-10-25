import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import type { ProfilePreview, ProfileSummary } from '../api/client'
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

test('the completeness shows shares per layer and the gaps in the order of care (V8.1)', async () => {
  const urls: string[] = []
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account(), account({ id: 2, username: 'm.keller', role: 'user' })],
    'GET /api/admin/llm/profile': profile,
    'GET /api/admin/evaluation/profile-summary': (_init: unknown, input: string) => {
      urls.push(input)
      return withGaps
    },
  })
  renderAt('/admin/steckbrief', <App />)

  await screen.findByRole('option', { name: 'm.keller' })
  await userEvent.selectOptions(screen.getByLabelText('Konto'), 'm.keller')
  const summary = await screen.findByRole('region', { name: 'Vollständigkeit' })
  expect(urls).toEqual(['/api/admin/evaluation/profile-summary?data_state=live&account=m.keller'])
  expect(within(summary).getByText('Vollständigkeit · Betriebsdaten')).toBeInTheDocument()
  const total = within(summary).getByRole('row', { name: /Gesamt/ })
  // Bar and number: 10/34 labelled, 3/9 code lists, 13/37 described.
  expect(
    within(total)
      .getAllByText(/%/)
      .map((c) => c.textContent),
  ).toEqual(['29 %', '33 %', '35 %'])
  const layer = within(summary).getByRole('row', { name: /Schulanlagen/ })
  expect(
    within(layer)
      .getAllByText(/%/)
      .map((c) => c.textContent),
  ).toEqual(['0 %', '0 %', '4 %'])
  expect(within(summary).getByText('2 weitere Layer sind vollständig.')).toBeInTheDocument()

  const gaps = within(summary).getByRole('region', {
    name: 'Lücken in Schulanlagen (Import 21.10.)',
  })
  const items = within(gaps).getAllByRole('listitem')
  expect(items.map((i) => i.querySelector('strong')?.textContent)).toEqual([
    'Codelisten bestätigen',
    'Beschriftungen',
    'Beschreibungen, die die Bedeutung nennen',
  ])
  expect(items[0]).toHaveTextContent('0 von 6 Textattributen (schulstufe, sprache, traeger, …)')
  expect(items[1]).toHaveTextContent('0 von 24 Attributen (z. B. hat_turnhalle, sw_dist_m, f0, …)')
  expect(items[2]).toHaveTextContent('1 von 25 (fehlt: Layerbeschreibung, f0, f1, …)')
  for (const item of items)
    expect(within(item).getByRole('link', { name: 'Felder ›' })).toHaveAttribute(
      'href',
      '/admin/daten/schulanlagen?reiter=felder',
    )
  expect(within(summary).queryByText('vollständig')).not.toBeInTheDocument()
})

test('a complete profile is one row and a short confirmation (V8.2), the sample without an account', async () => {
  const urls: string[] = []
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account()],
    'GET /api/admin/evaluation/profile-summary': (_init: unknown, input: string) => {
      urls.push(input)
      return complete
    },
  })
  renderAt('/admin/steckbrief', <App />)

  await screen.findByRole('option', { name: 'admin' })
  expect(screen.queryByRole('region', { name: 'Vollständigkeit' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: 'Beispieldaten' }))
  const summary = await screen.findByRole('region', { name: 'Vollständigkeit' })
  expect(urls).toEqual(['/api/admin/evaluation/profile-summary?data_state=sample'])
  expect(within(summary).getByText('Vollständigkeit · Beispieldaten')).toBeInTheDocument()
  expect(within(summary).getAllByRole('row')).toHaveLength(2)
  expect(within(summary).getAllByText('100 %')).toHaveLength(3)
  expect(within(summary).getByText('vollständig')).toBeInTheDocument()
  expect(
    within(summary).getByText(
      'Alle Attribute beschriftet, alle Codelisten bestätigt, alle Beschreibungen vorhanden.',
    ),
  ).toBeInTheDocument()
  expect(within(summary).queryByRole('link')).not.toBeInTheDocument()
})

test('a share is never rounded up to 100 while something is missing', () => {
  expect(percent(199, 200)).toBe(99)
  expect(percent(0, 0)).toBeNull()
  expect(percent(3, 3)).toBe(100)
})
