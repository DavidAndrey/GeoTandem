// Every sentence builder speaks only through the catalog (plan E1.9, WP48).
import { describe as group, expect, test } from 'vitest'
import { newAttributeRow, newGroup, newReferenceRow, newSpatialRow } from '../analysis/tree'
import { checks, fieldChanges, initialState, problems } from '../admin/wizard'
import { describe, operatorLabel, spatialLabel } from '../editor/describe'
import { noticeOf } from '../session/notice'
import type { OpenReport } from '../session/store'
import { formatWhen } from '../session/ui'
import { csvPreview, vectorPreview } from '../test/fixtures'
import { inPseudo, unmarked } from '../test/pseudo'

const labels = {
  field: (n: string) => ({ typ: 'Schulstufe', datum: 'Eröffnung' })[n] ?? n,
  layer: (n: string) => ({ strassen: 'Strassen', gemeinden: 'Gemeinden' })[n] ?? n,
  type: (n: string) => (n === 'datum' ? ('date' as const) : undefined),
}
const DATA = ['Schulstufe', 'Eröffnung', 'Strassen', 'Gemeinden', 'primar', 'Talstrasse']

group('describe', () => {
  const rows = [
    { ...newAttributeRow('typ'), operator: 'in' as const, values: ['primar'] },
    { ...newAttributeRow('typ'), operator: 'is_empty' as const, not: true },
    { ...newAttributeRow('datum'), operator: 'between' as const, min: '2020-01-01', max: null },
    { ...newAttributeRow('datum'), operator: 'ge' as const, value: '2020-01-01' },
    { ...newAttributeRow('typ'), operator: 'eq' as const, value: true },
    { ...newSpatialRow('strassen'), operator: 'near' as const, distance_m: 1500 },
    { ...newSpatialRow('strassen'), operator: 'far' as const, distance_m: 20 },
    {
      ...newSpatialRow('gemeinden'),
      not: true,
      filter: { ...newAttributeRow('typ'), operator: 'contains' as const, value: 'primar' },
    },
    { ...newReferenceRow('strassen'), fid: 3, label: 'Talstrasse', distance_m: 200 },
    { ...newReferenceRow('strassen'), fid: 7, label: '', distance_m: 0 },
    { ...newGroup('or'), not: true },
  ]
  test.each(rows.map((row) => [row.kind, row] as const))('%s', (_, row) => {
    expect(
      unmarked(
        inPseudo(() => describe(row, labels)),
        DATA,
      ),
    ).toBe('')
  })

  test('operator labels', () => {
    inPseudo(() => {
      for (const op of ['between', 'contains', 'eq'] as const)
        expect(unmarked(operatorLabel(op, 'date') + operatorLabel(op, 'text'))).toBe('')
      expect(unmarked(spatialLabel('contains'))).toBe('')
    })
  })
})

group('noticeOf', () => {
  const stamp = (count: number) => ({
    count,
    ids_hash: String(count),
    query_hash: 'q',
    data_versions: { strassen: 'v1' },
    stamped_at: '2026-10-03T12:02:00',
  })
  const report = (patch: Partial<OpenReport> = {}): OpenReport => ({
    name: 'Vorführung',
    check: {
      identical: false,
      saved: stamp(1),
      current: stamp(1200),
      changed_layers: ['strassen'],
      missing_layers: ['gemeinden'],
      error: null,
      state_matches: false,
    },
    removed: { layers: [], rows: [{ ...newSpatialRow('strassen'), id: 'r1' }], result: false },
    error: null,
    ...patch,
  })
  const title = labels.layer
  const deviating = report().check as NonNullable<OpenReport['check']>
  test.each([
    ['deviating', report()],
    ['identical', report({ check: { ...deviating, identical: true, missing_layers: [] } })],
    ['pending', report({ check: null })],
    ['result missing', report({ removed: { layers: [], rows: [], result: true } })],
  ])('%s', (_, r) => {
    const notice = inPseudo(() => noticeOf(r, title))
    expect(unmarked([notice.headline, ...notice.lines].join(' '), [...DATA, 'v1'])).toBe('')
  })
})

group('import wizard', () => {
  test('problems and checks', () => {
    const state = initialState('id', csvPreview({ crs: null }))
    state.title = ''
    state.fields = state.fields.map((f) => ({ ...f, label: '', name: 'Nr' }))
    const keyed = initialState(
      'id',
      csvPreview({
        xy: null,
        keys: [{ column: 'Nr', layer: 'gemeinden', attribute: 'gem_nr', matched: 1, total: 2 }],
        warnings: [],
      }),
    )
    const data = ['Nr', 'gemeinden', 'gem_nr', 'messstellen', 'EPSG']
    inPseudo(() => {
      for (const step of [1, 2, 3] as const)
        for (const text of problems(state, step)) expect(unmarked(text, data)).toBe('')
      // Back-end messages are data until WP51 translates them by code.
      const backend = state.preview.warnings.map((w) => w.message)
      for (const s of [state, keyed, initialState('id', vectorPreview())])
        for (const c of checks(s)) expect(unmarked(c.text, [...data, ...backend])).toBe('')
      expect(unmarked(fieldChanges(['a'], ['a']))).toBe('')
    })
  })
})

test('formatWhen', () => {
  const now = new Date(2026, 9, 4, 15, 0)
  inPseudo(() => {
    expect(unmarked(formatWhen(new Date(2026, 9, 4, 14, 2).toISOString(), now))).toBe('')
    expect(unmarked(formatWhen(new Date(2026, 9, 3, 9, 0).toISOString(), now))).toBe('')
  })
})
