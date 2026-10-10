// Times the panel shows: the clock time of a prompt ("Prompt · 14:05") and the
// running time of a request ("0:14 / max. 2:00").
import { dateTimeFormat } from '../../i18n/locale'

export const clockTime = (iso: string | null | undefined): string =>
  iso ? dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : ''

/** Seconds as m:ss. */
export function minutes(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
