// Pure rules of the access screens, shared and unit-tested.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import type { Account } from '../api/client'

const ROLE_LABELS: Record<Account['role'], MessageDescriptor> = {
  admin: msg`Administrator`,
  user: msg`Anwender`,
}

export const roleLabel = (role: Account['role']) => i18n._(ROLE_LABELS[role])

export const MIN_PASSWORD_LENGTH = 12

/** Under every new-password field: length over complexity (security review #12). */
export const passwordHint = () =>
  t`Mindestens ${MIN_PASSWORD_LENGTH} Zeichen, Sonderzeichen sind nicht nötig. Ein Satz aus mehreren Wörtern ist sicher und gut zu merken.`

/** Problems the form can tell before asking the server; the server checks again. */
export function passwordProblems(current: string, next: string, repeat: string): string[] {
  const problems = []
  if (next.length < MIN_PASSWORD_LENGTH)
    problems.push(t`Das neue Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`)
  if (next && next === current)
    problems.push(t`Das neue Passwort muss sich vom alten unterscheiden.`)
  if (repeat && next !== repeat) problems.push(t`Die Wiederholung stimmt nicht überein.`)
  return problems
}

/**
 * Only paths inside the application: an open redirect would be a phishing aid.
 * Parsed as the browser would, which also reads "/\evil.example" or "/\t/evil.example"
 * as another host.
 */
export function safeTarget(target: string | null): string {
  if (!target?.startsWith('/')) return '/'
  const base = 'http://geotandem.invalid'
  const url = new URL(target, base)
  return url.origin === base ? url.pathname + url.search + url.hash : '/'
}
