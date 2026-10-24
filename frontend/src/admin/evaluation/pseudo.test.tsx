// The case pages in pseudo show no text that bypassed the catalog (plan E1.9,
// L7). Case ids, questions, notes, layer and attribute names are data.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../../App'
import { useAnalysis } from '../../analysis/store'
import { newAttributeRow } from '../../analysis/tree'
import { activate } from '../../i18n/i18n'
import { messages } from '../../locales/pseudo.po'
import { casePage, caseView, OWN_CASES, START_CASES } from '../../test/eval-mocks'
import { attribute, layer, signedIn } from '../../test/fixtures'
import { strays } from '../../test/pseudo'
import { fakeApi, renderAt } from '../../test/render'
import { compactQuery } from '../../model/readable'
import { QueryPanel } from '../../workplace/QueryPanel'

beforeEach(() => {
  activate('pseudo', messages)
  useAnalysis.getState().reset()
})
afterEach(() => {
  activate('de')
  vi.unstubAllGlobals()
})

const schulen = layer({
  name: 'schulen',
  title: 'Schulen',
  geometry_type: 'Point',
  attributes: [attribute({ name: 'typ', data_type: 'text', label: 'typ' })],
})

const CASES = [...START_CASES, ...OWN_CASES.map((o) => o.case)]

/** Every string and number a case holds: ids, questions, layer, attribute and value names. */
function leaves(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(leaves)
  if (value && typeof value === 'object') return Object.values(value).flatMap(leaves)
  return []
}

const DATA = [
  ...CASES.flatMap(leaves),
  // The reference as JSON under "Technisch" is data.
  ...CASES.flatMap((c) =>
    [...(c.gold_any ?? []), ...(c.gold ? [c.gold] : [])].map((g) =>
      JSON.stringify(compactQuery(g), null, 2),
    ),
  ),
  // "Lesart A": the letter is a placeholder.
  'A',
  'B',
  'GeoTandem',
  'Systemverwaltung',
  'admin',
  'MCP',
  'E4',
  'Schulen',
  'schulen',
  'gemeinden',
  'Köniz',
  'typ',
  'primar',
  'name',
  'primarstufe',
  '20.10.2026',
  '09:12',
  '14',
  '17',
  '71',
  '3',
  '33',
  '41',
  '66',
  '1',
  '0',
  '{',
  '}',
].filter(Boolean)

function backend() {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': [schulen],
    'GET /api/admin/evaluation/cases': casePage(),
    'GET /api/admin/evaluation/cases/doc1-primar-koeniz': caseView('doc1-primar-koeniz', {
      reference_hits: [14, 17],
    }),
    'GET /api/admin/evaluation/cases/e-schulweg-import': caseView('e-schulweg-import'),
    'GET /api/admin/evaluation/cases/n15-je-gemeinde': caseView('n15-je-gemeinde'),
    'POST /api/query/count': { counts: [14, 30, 14] },
  })
}

test.each([
  '/admin/bewertung',
  '/admin/bewertung/faelle',
  '/admin/bewertung/faelle/doc1-primar-koeniz',
  '/admin/bewertung/faelle/e-schulweg-import',
  '/admin/bewertung/faelle/n15-je-gemeinde',
])('%s', async (path) => {
  backend()
  renderAt(path, <App />)
  await screen.findAllByRole('heading', { level: 2 })
  await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull())
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})

test('the save dialog', async () => {
  backend()
  const s = useAnalysis.getState()
  s.addLayer('schulen')
  s.edit()
  s.addNode('root', { ...newAttributeRow('typ'), value: 'primar' })
  s.apply()
  renderAt('/', <QueryPanel />)
  // The entry's words are pseudo here: found by its place under the query.
  const entry = await waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>('section > div.mt-1\\.5 > button')
    if (!found) throw new Error('no entry')
    return found
  })
  await userEvent.click(entry)
  await screen.findByRole('dialog')
  await waitFor(() => expect(strays(DATA)).toEqual([]))
})
