// Times the panel shows: the clock time of a prompt ("Prompt · 14:05") and the
// running time of a request ("0:14 / max. 2:00"). The server's times are naive
// UTC (``parseTimestamp``).
import { t } from '@lingui/core/macro'
import { dateTimeFormat, formatNumber, parseTimestamp } from '../../i18n/locale'

export const clockTime = (iso: string | null | undefined): string =>
  iso ? dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(parseTimestamp(iso)) : ''

/**
 * Milliseconds as seconds: "6 s" (an answer's time, M2), "0.4 s" with
 * ``digits`` (a chain step's, M9.1); ``null`` for no time.
 */
export function seconds(ms: number | null | undefined, digits = 0): string | null {
  if (ms === null || ms === undefined) return null
  const s = formatNumber(ms / 1000, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return t`${s} s`
}

/** Seconds as m:ss. */
export function minutes(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
