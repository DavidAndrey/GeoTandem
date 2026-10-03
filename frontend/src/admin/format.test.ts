import { expect, test } from 'vitest'
import { attribute, layer } from '../test/fixtures'
import { formatCodes, parseCodes } from './codes'
import { completeness, formatDate, layerType, sourceLabel } from './format'

test('completeness counts the four metadata steps', () => {
  expect(completeness(layer())).toBe(0)
  const curated = layer({
    description: 'Politische Gemeinden.',
    attributes: [
      attribute({ label: 'Einwohner', description: 'Wohnbevölkerung', unit: 'Personen' }),
      attribute({ name: 'typ', data_type: 'text', label: 'Typ', description: 'Gemeindetyp' }),
    ],
  })
  expect(completeness(curated)).toBe(4)
  expect(completeness({ ...curated, description: '' })).toBe(3)
})

test('labels for type, source and date', () => {
  expect(layerType({ kind: 'vector', geometry_type: 'MultiPolygon' })).toBe('Fläche')
  expect(layerType({ kind: 'table', geometry_type: null })).toBe('Tabelle')
  expect(sourceLabel('file:gemeinden.zip')).toBe('gemeinden.zip')
  expect(sourceLabel('sample:tandemtal')).toBe('Beispieldaten')
  // Naive timestamps from the backend are UTC.
  expect(formatDate('2026-10-03T23:30:00')).toMatch(/0[34]\.10\.2026/)
})

test('code lists round-trip through their text form', () => {
  const codes = { fluss: 'Fluss', bach: 'Bach', see: 'see' }
  expect(formatCodes(codes)).toBe('fluss = Fluss\nbach = Bach\nsee')
  expect(parseCodes(formatCodes(codes))).toEqual(codes)
  expect(parseCodes('  \n')).toBeNull()
  expect(parseCodes('a = \n = b')).toEqual({ a: 'a' })
})
