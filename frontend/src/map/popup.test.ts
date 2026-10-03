import { expect, test } from 'vitest'
import { attribute, layer } from '../test/fixtures'
import { featureName, formatValue, popupContent } from './popup'

const info = layer({
  attributes: [
    attribute({ name: 'name', data_type: 'text', label: 'Gemeindename' }),
    attribute({ name: 'flaeche', data_type: 'real', label: 'Fläche', unit: 'km²' }),
  ],
})

test('the popup shows the feature name, labels and units', () => {
  const root = popupContent('Gemeinden', { name: 'Brunnwil', flaeche: 8.095 }, info)
  expect(root.textContent).toBe('BrunnwilGemeindenGemeindenameBrunnwilFläche8.1 km²')
})

test('values from imported files are text, never markup', () => {
  const root = popupContent('X', { name: '<img src=x onerror=alert(1)>' }, info)
  expect(root.querySelector('img')).toBeNull()
  expect(root.textContent).toContain('<img src=x onerror=alert(1)>')
})

test('formatting and name choice', () => {
  expect(formatValue(null, 'm')).toBe('–')
  expect(formatValue(true, null)).toBe('ja')
  expect(formatValue(1234.5, 'm')).toBe("1'234.5 m") // Swiss format (de-CH)
  expect(featureName({ flaeche: 3 }, info)).toBeNull()
})
