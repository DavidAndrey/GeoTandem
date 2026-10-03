import { expect, test } from 'vitest'
import { newAttributeRow, newReferenceRow, newSpatialRow } from '../analysis/tree'
import { describe, operatorsFor } from './describe'

const labels = {
  field: (n: string) => ({ typ: 'Schulstufe', anteil_u20: 'Anteil unter 20' })[n] ?? n,
  layer: (n: string) => ({ strassen: 'Strassen', gemeinden: 'Gemeinden' })[n] ?? n,
}

test('rows read like the design (B1, B2)', () => {
  expect(describe({ ...newAttributeRow('typ'), operator: 'in', values: ['primar'] }, labels)).toBe(
    'Schulstufe ist eins von primar',
  )
  expect(
    describe(
      {
        ...newSpatialRow('gemeinden'),
        filter: { ...newAttributeRow('anteil_u20'), operator: 'gt', value: 20 },
      },
      labels,
    ),
  ).toBe('liegt in Gemeinden (Anteil unter 20 > 20)')
  expect(
    describe({ ...newSpatialRow('strassen'), operator: 'near', distance_m: 1500 }, labels),
  ).toBe('≤ 1.5 km zu Strassen')
  expect(
    describe({ ...newSpatialRow('strassen'), operator: 'far', distance_m: 2000 }, labels),
  ).toBe('> 2 km zu Strassen')
  expect(
    describe(
      { ...newReferenceRow('strassen'), fid: 3, label: 'Talstrasse', distance_m: 200 },
      labels,
    ),
  ).toBe('≤ 200 m um Talstrasse (Strassen)')
  expect(describe({ ...newAttributeRow(''), not: true }, labels)).toBe('nicht … = …')
})

test('operators follow the field type', () => {
  expect(operatorsFor('boolean')).toEqual(['eq', 'is_empty'])
  expect(operatorsFor('text')).toContain('contains')
  expect(operatorsFor('real')).toContain('between')
  expect(operatorsFor('real')).not.toContain('contains')
})
