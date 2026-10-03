import { expect, test } from 'vitest'
import { csvPreview, vectorPreview } from '../test/fixtures'
import {
  checks,
  fieldChanges,
  firstBlockedStep,
  initialState,
  isIdentifier,
  problems,
  toDecisions,
  withPreview,
  type FieldDraft,
  type WizardState,
} from './wizard'

/** Change one field in place, as the field step does. */
function edit(state: WizardState, index: number, patch: Partial<FieldDraft>) {
  state.fields = state.fields.map((f, i) => (i === index ? { ...f, ...patch } : f))
}

test('a vector file starts from its own geometry and detected CRS', () => {
  const state = initialState('id', vectorPreview())
  expect(state.geo).toEqual({ mode: 'geometry', crs: 2056 })
  expect(firstBlockedStep(state)).toBeNull()
})

test('a table starts from proposed X/Y columns, else from a proposed key', () => {
  expect(initialState('id', csvPreview()).geo).toEqual({ mode: 'xy', x: 'E', y: 'N', crs: 2056 })
  const keyed = csvPreview({
    xy: null,
    keys: [{ column: 'Gem-Nr', layer: 'gemeinden', attribute: 'gem_nr', matched: 12, total: 14 }],
  })
  expect(initialState('id', keyed).geo).toEqual({
    mode: 'key',
    column: 'Gem-Nr',
    layer: 'gemeinden',
    attribute: 'gem_nr',
  })
})

test('a missing CRS blocks step 2 until one is chosen', () => {
  const state = initialState('id', vectorPreview({ crs: null }))
  expect(problems(state, 2)).toHaveLength(1)
  expect(problems({ ...state, geo: { mode: 'geometry', crs: 2056 } }, 2)).toEqual([])
})

test.each([
  ['messstellen', true],
  ['mess_stellen_2', true],
  ['Messstellen', false],
  ['2025_daten', false],
  ['a__b', false],
  ['ende_', false],
])('identifier %s → %s', (name, valid) => {
  expect(isIdentifier(name)).toBe(valid)
})

test('field names must be valid, unique and not reserved', () => {
  const state = initialState('id', csvPreview())
  const renamed = (name: string) => ({
    ...state,
    fields: state.fields.map((f, i) => (i === 0 ? { ...f, name } : f)),
  })
  expect(problems(renamed('geom'), 3)).toEqual(['„geom" ist reserviert.'])
  expect(problems(renamed('e'), 3)).toEqual(['„e" kommt mehrfach vor.'])
  expect(problems(renamed('Nr'), 3)).toEqual(['„Nr" ist kein gültiger Feldname.'])
  // An excluded field does not count.
  const excluded = renamed('e')
  edit(excluded, 0, { include: false })
  expect(problems(excluded, 3)).toEqual([])
})

test('decisions carry geo-reference, names and metadata', () => {
  const state = initialState('id', csvPreview())
  edit(state, 1, { unit: ' m ü. M. ', label: 'Höhe' })
  const decisions = toDecisions({ ...state, title: ' Messstellen ' })
  expect(decisions).toMatchObject({
    geo: { mode: 'xy', x: 'E', y: 'N', crs: 2056 },
    layer_name: 'messstellen',
    replace: null,
    title: 'Messstellen',
    options: { delimiter: ';', encoding: 'cp1252' },
  })
  expect(decisions.fields?.[1]).toMatchObject({
    source_name: 'Höhe ü. M.',
    name: 'hoehe_ue_m',
    label: 'Höhe',
    unit: 'm ü. M.',
  })
})

test('a replace sends the target instead of a new layer name', () => {
  const decisions = toDecisions(initialState('id', vectorPreview(), 'gemeinden'))
  expect(decisions).toMatchObject({ replace: 'gemeinden', layer_name: null })
})

test('reading again keeps the decisions for columns that still exist', () => {
  const state = initialState('id', csvPreview())
  edit(state, 0, { label: 'Nummer' })
  const next = withPreview({ ...state, title: 'Messstellen' }, csvPreview({ record_count: 20 }))
  expect(next.title).toBe('Messstellen')
  expect(next.fields[0]?.label).toBe('Nummer')
  expect(next.preview.record_count).toBe(20)
})

test('the check list shows CRS, warnings and open points', () => {
  const state = initialState('id', csvPreview())
  edit(state, 0, { label: '' })
  expect(checks(state).map((c) => [c.kind, c.step])).toEqual([
    ['ok', 2],
    ['warning', undefined],
    ['todo', 3],
  ])
})

test('field changes of a replace', () => {
  expect(fieldChanges(['a', 'b'], ['a', 'c'])).toBe('+ c · − b')
  expect(fieldChanges(['a'], ['a'])).toBe('unverändert')
})
