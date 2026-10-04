import { i18n } from '@lingui/core'
import { afterEach, describe, expect, it } from 'vitest'
import { activate } from './i18n'
import { collator, formatIsoDate, formatNumber, lowerText, parseNumber } from './locale'

afterEach(() => activate('de'))

// French has no catalog yet; formatting only needs the locale (plan E1.9, L4).
const french = () => i18n.loadAndActivate({ locale: 'fr', messages: {} })

describe('formatting locale', () => {
  it('writes numbers and dates as in German-speaking Switzerland', () => {
    // ICU writes the Swiss group mark as ' (older versions: ’); both read back.
    expect(formatNumber(1234567.5)).toBe("1'234'567.5")
    expect(formatIsoDate('2024-03-01')).toBe('01.03.2024')
    expect(formatIsoDate('März')).toBe('März')
  })

  it('follows the active language', () => {
    french()
    expect(formatNumber(1234.5)).toBe('1\u202f234,5')
    expect(formatIsoDate('2024-03-01')).toBe('01.03.2024')
  })

  it('sorts and folds text by the language', () => {
    const sorted = ['Zollikofen', 'Ägerten', 'Bus 10', 'Bus 9'].sort(
      collator({ numeric: true }).compare,
    )
    expect(sorted).toEqual(['Ägerten', 'Bus 9', 'Bus 10', 'Zollikofen'])
    expect(lowerText('ÄNGGISTEIBACH')).toBe('änggisteibach')
  })
})

describe('parseNumber (L5)', () => {
  it('reads back what every Swiss form shows', () => {
    for (const locale of ['de', 'fr'] as const) {
      if (locale === 'fr') french()
      for (const n of [0.5, -12.25, 1234567.75]) expect(parseNumber(formatNumber(n))).toBe(n)
    }
  })

  it('takes either decimal separator', () => {
    expect(parseNumber('3,5')).toBe(3.5)
    expect(parseNumber(' 3.5 ')).toBe(3.5)
    expect(parseNumber('−2')).toBe(-2)
    expect(parseNumber(',5')).toBe(0.5)
  })

  it('refuses what is not one number', () => {
    for (const text of ['', 'abc', '1,234.5', '1.2.3', '12 m', '-'])
      expect(parseNumber(text)).toBeNull()
  })
})
