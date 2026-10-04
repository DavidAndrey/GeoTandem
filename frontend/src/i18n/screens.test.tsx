// The user area in pseudo shows no text that bypassed the catalog (plan E1.9,
// L8): every text node and every label is bracketed ⟦…⟧ or is data.
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { useAnalysis } from '../analysis/store'
import { newAttributeRow, newReferenceRow, newSpatialRow } from '../analysis/tree'
import { useDock } from '../table/dock'
import { useMapView } from '../map/view'
import { OperationDialog } from '../operations/OperationDialog'
import { useQueryUi } from '../queries/ui'
import { useSessionUi } from '../session/ui'
import { layer, signedIn } from '../test/fixtures'
import { activate } from './i18n'
import { messages } from '../locales/pseudo.po'
import { fakeApi, renderAt } from '../test/render'
import { unmarked } from '../test/pseudo'

beforeEach(() => {
  useAnalysis.getState().reset()
  useSessionUi.getState().close()
  useQueryUi.getState().close()
  useMapView.getState().setMeasuring(null)
  activate('pseudo', messages)
})
afterEach(() => {
  activate('de')
  vi.unstubAllGlobals()
})

const schulen = layer({ name: 'schulen', title: 'Schulen', geometry_type: 'Point' })
// Data from the fake backend: names, titles, values.
const DATA = [
  'GeoTandem',
  'Systemverwaltung',
  'Schulen',
  'Gemeinden',
  'schulen',
  'gemeinden',
  'einwohner',
  'name',
  'Schule 1',
  'Schule 2',
  'm.keller',
  'C3',
]
// Leaflet draws its own controls (scale bar, credits); they are not ours.
const SKIP = 'script, style, .leaflet-control-container'
// Unit symbols are the same in every language.
const UNIT = /^\s*(m|km|m²|ha|km²|%)\s*$/

/** Every visible text and label of the page outside the catalog and the data. */
function strays(): string[] {
  const found = new Set<string>()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement
    if (!element || element.closest(SKIP) || UNIT.test(node.textContent ?? '')) continue
    // React may split one message into several text nodes; judge the element's text.
    const text = element.textContent ?? ''
    if (unmarked(text, DATA)) found.add(text.trim())
  }
  for (const element of Array.from(
    document.body.querySelectorAll('[aria-label], [title], [placeholder]'),
  )) {
    if (element.closest(SKIP)) continue
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name)
      if (value && unmarked(value, DATA)) found.add(`${name}="${value}"`)
    }
  }
  return [...found]
}

function backend() {
  return fakeApi({
    ...signedIn({ role: 'user', username: 'm.keller' }),
    'GET /api/layers': [schulen, layer()],
    'GET /api/config/map': { basemap: null, extent_wgs84: [7.8, 46.8, 8, 47], max_features: 10000 },
    'POST /api/query': {
      type: 'FeatureCollection',
      features: [1, 2].map((id) => ({
        type: 'Feature',
        id,
        properties: { name: `Schule ${id}`, einwohner: 1200 },
        geometry: { type: 'Point', coordinates: [7.9, 46.9] },
      })),
      query: {},
      meta: {},
    },
    'POST /api/query/count': { counts: [2, 2, 2, 2, 2] },
    'GET /api/sessions': [],
    'GET /api/queries': [],
  })
}

function analysis() {
  const analysis = useAnalysis.getState()
  analysis.addLayer('schulen', true)
  analysis.addLayer('gemeinden')
  analysis.edit()
  const root = useAnalysis.getState().draft?.id ?? 'root'
  analysis.addNode(root, { ...newAttributeRow('einwohner'), operator: 'between', min: 1, max: 9 })
  analysis.addNode(root, { ...newSpatialRow('gemeinden'), operator: 'near', distance_m: 500 })
  analysis.addNode(root, { ...newReferenceRow('gemeinden'), fid: 1, label: 'Schule 1' })
}

test('the workplace speaks only through the catalog', async () => {
  backend()
  analysis()
  act(() => useDock.getState().setOpen(true))
  renderAt('/', <App />)
  await screen.findAllByText(/Schule 1/)
  expect(strays()).toEqual([])
})

test.each([
  ['save session', () => useSessionUi.getState().openDialog('saveAs')],
  ['sessions', () => useSessionUi.getState().openDialog('list')],
  ['save query', () => useQueryUi.getState().open('saveAs')],
  ['saved queries', () => useQueryUi.getState().open('manage')],
  ['measuring', () => useMapView.getState().setMeasuring('area')],
])('%s', async (_, open) => {
  backend()
  analysis()
  renderAt('/', <App />)
  await screen.findAllByText(/Schule 1/)
  const before = document.body.querySelectorAll('[role="dialog"], [role="status"]').length
  act(open)
  // Wait for the dialog (or the measuring panel's status) to be there before judging.
  await waitFor(() =>
    expect(
      document.body.querySelectorAll('[role="dialog"], [role="status"]').length,
    ).toBeGreaterThan(before),
  )
  await waitFor(() => expect(strays()).toEqual([]))
})

test.each(['buffer', 'join', 'aggregate', 'symbology'] as const)('operation %s', async (op) => {
  backend()
  analysis()
  const [layer] = useAnalysis.getState().layers
  if (!layer) throw new Error('no layer')
  renderAt('/', <OperationDialog layer={layer} operation={op} onClose={() => {}} />)
  await screen.findByRole('dialog')
  await waitFor(() => expect(strays()).toEqual([]))
})
