import { expect, test } from 'vitest'
import { breaks, ramp, symbolizer } from './symbolize'

const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const of = (attr: string) => (attr === 'n' ? values : ['a', 'b', 'a', null])

test('quantile and equal-interval breaks', () => {
  expect(breaks(values, 'quantile', 5)).toEqual([2, 4, 6, 8, 10])
  expect(breaks(values, 'equal_interval', 3)).toEqual([4, 7, 10])
  expect(breaks([5, 5, 5, 9], 'quantile', 4)).toEqual([5, 9]) // no empty classes
  expect(breaks([], 'quantile', 4)).toEqual([])
})

test('classes get a light-to-dark ramp and a legend', () => {
  const s = symbolizer(
    { kind: 'classified', attr: 'n', method: 'equal_interval', classes: 2 },
    of,
    '#000000',
  )
  expect(s.legend.map((e) => e.label)).toEqual(['1 – 5.5', '5.5 – 10'])
  expect(s.of({ n: 1 }).color).toBe(ramp(2)[0])
  expect(s.of({ n: 10 }).color).toBe(ramp(2)[1])
  expect(s.of({ n: null }).color).toBe('#000000')
})

test('categories, single colour and graduated size', () => {
  const cat = symbolizer(
    { kind: 'categorized', attr: 't', colors: { a: '#112233' } },
    of,
    '#000000',
  )
  expect(cat.legend.map((e) => e.label)).toEqual(['(leer)', 'a', 'b'])
  expect(cat.of({ t: 'a' }).color).toBe('#112233')
  expect(symbolizer({ kind: 'single', color: '#abcdef' }, of, '#000000').of({}).color).toBe(
    '#abcdef',
  )
  const size = symbolizer(
    { kind: 'graduated_size', attr: 'n', min_size: 4, max_size: 24 },
    of,
    '#000000',
  )
  expect(size.of({ n: 1 }).radius).toBe(2)
  expect(size.of({ n: 10 }).radius).toBe(12)
})
