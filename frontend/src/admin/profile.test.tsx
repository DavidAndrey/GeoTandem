import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import type { ModelProfile } from '../api/client'
import { account, attribute, signedIn } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { AttributeRows } from './LayerPage'

afterEach(() => vi.unstubAllGlobals())

const profile: ModelProfile = {
  profile_version: 1,
  hash: 'ab'.repeat(32),
  size_chars: 2663,
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

test('the profile for an account shows layers, domains, hash and size', async () => {
  fakeApi({
    ...signedIn(),
    'GET /api/admin/users': [account(), account({ id: 2, username: 'm.keller', role: 'user' })],
    'GET /api/admin/llm/profile': profile,
  })
  renderAt('/admin/steckbrief', <App />)

  await screen.findByRole('option', { name: 'm.keller' })
  await userEvent.selectOptions(screen.getByLabelText('Konto'), 'm.keller')
  const layer = await screen.findByRole('region', { name: 'Gewässer' })
  expect(within(layer).getByText('Codeliste (2)')).toBeInTheDocument()
  expect(within(layer).getByText('0 bis 120')).toBeInTheDocument()
  expect(screen.getByText("2'663 Zeichen")).toBeInTheDocument()
  expect(screen.getByText('ab'.repeat(32))).toBeInTheDocument()
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
