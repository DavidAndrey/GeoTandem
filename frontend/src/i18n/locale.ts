// Numbers, dates and text order in the regional form of the active language
// (plan E1.9, L4): "de" is written as in Switzerland, so are the later ones.
import { i18n } from '@lingui/core'

const REGIONAL: Record<string, string> = {
  de: 'de-CH',
  fr: 'fr-CH',
  it: 'it-CH',
  pseudo: 'de-CH',
}

export const formattingLocale = () => REGIONAL[i18n.locale] ?? 'de-CH'

// Intl objects are costly to build; one per locale and options.
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.Collator>()
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.Collator>(
  kind: string,
  options: object,
  make: (locale: string) => T,
): T {
  const locale = formattingLocale()
  const key = `${kind} ${locale} ${JSON.stringify(options)}`
  let value = cache.get(key) as T | undefined
  if (!value) cache.set(key, (value = make(locale)))
  return value
}

export const numberFormat = (options: Intl.NumberFormatOptions = {}) =>
  cached('number', options, (locale) => new Intl.NumberFormat(locale, options))

export const dateTimeFormat = (options: Intl.DateTimeFormatOptions) =>
  cached('date', options, (locale) => new Intl.DateTimeFormat(locale, options))

/** Text order of the language: "Ägerten" with A, "Bus 10" after "Bus 9". */
export const collator = (options: Intl.CollatorOptions = {}) =>
  cached('collator', options, (locale) => new Intl.Collator(locale, options))

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  numberFormat(options).format(value)

const DAY = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' } as const

/** "2024-03-01" → "01.03.2024" (de-CH); anything else unchanged. */
export function formatIsoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return dateTimeFormat(DAY).format(date)
}

export const lowerText = (text: string) => text.toLocaleLowerCase(formattingLocale())

/**
 * A number typed as text (L5): "." or "," as decimal separator, "'", "’" and
 * spaces between digit groups, so what any of the Swiss forms shows reads
 * back. ``null`` for anything else, "1,234.5" included.
 */
export function parseNumber(text: string): number | null {
  const compact = text
    .trim()
    .replace(/[\s'’]/g, '')
    .replace('−', '-')
  if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)$/.test(compact)) return null
  return Number(compact.replace(',', '.'))
}
