import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { layerQuery } from '../analysis/query'
import { useAnalysis } from '../analysis/store'
import { attribute, layer } from '../test/fixtures'
import { fakeApi, renderAt } from '../test/render'
import { assertValidQuery } from '../test/schema'
import { OperationDialog } from './OperationDialog'

const catalog = [
  layer({
    name: 'schulen',
    title: 'Schulen',
    geometry_type: 'Point',
    attributes: [
      attribute({ name: 'typ', data_type: 'text', label: 'Schulstufe' }),
      attribute({ name: 'schueler', data_type: 'integer', label: 'Schülerzahl' }),
    ],
  }),
  layer({
    name: 'gemeinden',
    title: 'Gemeinden',
    geometry_type: 'Polygon',
    attributes: [
      attribute({ name: 'gem_nr', data_type: 'integer', label: 'Gemeindenummer' }),
      attribute({ name: 'name', data_type: 'text', label: 'Gemeindename' }),
    ],
  }),
  layer({
    name: 'bevoelkerung',
    title: 'Bevölkerung',
    kind: 'table',
    geometry_type: null,
    attributes: [
      attribute({ name: 'gem_nr', data_type: 'integer' }),
      attribute({ name: 'einwohner', data_type: 'integer', label: 'Einwohner' }),
    ],
  }),
]

beforeEach(() => {
  useAnalysis.getState().reset()
  useAnalysis.getState().addLayer('gemeinden')
  useAnalysis.getState().addLayer('schulen', true)
})
afterEach(() => vi.unstubAllGlobals())

const derived = () => useAnalysis.getState().layers.filter((l) => l.source.kind === 'derived')
const open = (id: string, operation: 'buffer' | 'join' | 'aggregate' | 'symbology') => {
  const target = useAnalysis.getState().layers.find((l) => l.id === id)
  if (!target) throw new Error(id)
  renderAt('/', <OperationDialog layer={target} operation={operation} onClose={() => {}} />)
}

test('a buffer is a derived layer with the accent as default (B4, B7)', async () => {
  fakeApi({ 'GET /api/layers': catalog })
  open('schulen', 'buffer')
  const dialog = await screen.findByRole('dialog', { name: /Puffer · Schulen/ })
  await userEvent.clear(within(dialog).getByLabelText('Distanz'))
  await userEvent.type(within(dialog).getByLabelText('Distanz'), '1')
  await userEvent.selectOptions(within(dialog).getByLabelText('Einheit'), 'km')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Puffer anlegen' }))
  const [buffer] = derived()
  expect(buffer?.source).toMatchObject({
    name: 'Puffer 1 km · Schulen',
    recipe: { op: 'buffer', distance_m: 1000 },
  })
  expect(buffer?.symbology).toEqual({ kind: 'single', color: '#b68235' })
  assertValidQuery(buffer && layerQuery(buffer))
})

test('a join shows its match rate (B5)', async () => {
  const calls = fakeApi({
    'GET /api/layers': catalog,
    'POST /api/query/count': { counts: [11, 12] },
  })
  open('gemeinden', 'join')
  const dialog = await screen.findByRole('dialog', { name: /Join · Gemeinden/ })
  expect(within(dialog).getByLabelText('Tabelle')).toHaveValue('bevoelkerung')
  expect(within(dialog).getByLabelText('Schlüssel in der Tabelle')).toHaveValue('gem_nr')
  await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Einwohner' }))
  expect(await within(dialog).findByLabelText('Trefferquote')).toHaveTextContent('11 / 12')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Join anlegen' }))
  const [join] = derived()
  assertValidQuery(join && layerQuery(join))
  expect(join?.source).toMatchObject({
    recipe: {
      op: 'join',
      join: {
        layer: 'bevoelkerung',
        left_key: 'gem_nr',
        right_key: 'gem_nr',
        fields: ['einwohner'],
      },
    },
  })
  for (const call of calls.filter((c) => c.key === 'POST /api/query/count'))
    for (const q of (call.body as { queries: unknown[] }).queries) assertValidQuery(q)
})

test('an aggregation is classified by its first metric (B6, B7)', async () => {
  fakeApi({ 'GET /api/layers': catalog })
  open('schulen', 'aggregate')
  const dialog = await screen.findByRole('dialog', { name: /Aggregieren · Schulen/ })
  expect(within(dialog).getByLabelText('Gebietslayer')).toHaveValue('gemeinden')
  await userEvent.click(within(dialog).getByRole('button', { name: '+ Kennzahl' }))
  const fields = within(dialog).getAllByLabelText('Feld')
  await userEvent.selectOptions(fields[fields.length - 1] as HTMLElement, 'Schülerzahl')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Aggregieren' }))
  const [aggregation] = derived()
  assertValidQuery(aggregation && layerQuery(aggregation))
  expect(aggregation?.symbology).toEqual({
    kind: 'classified',
    attr: 'anzahl',
    method: 'quantile',
    classes: 5,
  })
  expect(aggregation?.source).toMatchObject({
    recipe: {
      aggregate: {
        metrics: [
          { fn: 'count', as: 'anzahl' },
          { fn: 'sum', attr: 'schueler', as: 'sum_schueler' },
        ],
      },
    },
  })
})

test('symbology: classes over a numeric field (F-4.8)', async () => {
  fakeApi({ 'GET /api/layers': catalog })
  open('schulen', 'symbology')
  const dialog = await screen.findByRole('dialog', { name: /Darstellung · Schulen/ })
  await userEvent.selectOptions(within(dialog).getByLabelText('Art der Darstellung'), 'Klassen')
  expect(within(dialog).getByLabelText('Feld der Darstellung')).toHaveValue('schueler') // numbers only
  await userEvent.selectOptions(within(dialog).getByLabelText('Methode'), 'gleiche Intervalle')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Übernehmen' }))
  const schulen = useAnalysis.getState().layers.find((l) => l.id === 'schulen')
  expect(schulen?.symbology).toEqual({
    kind: 'classified',
    attr: 'schueler',
    method: 'equal_interval',
    classes: 5,
  })
  assertValidQuery(schulen && layerQuery(schulen))
})
