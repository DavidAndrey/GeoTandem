// Pure rules of the access screens, shared and unit-tested.
import type { Account } from '../api/client'

export const ROLE_LABELS: Record<Account['role'], string> = {
  admin: 'Administrator',
  user: 'Anwender',
}

export const MIN_PASSWORD_LENGTH = 10

/** Problems the form can tell before asking the server; the server checks again. */
export function passwordProblems(current: string, next: string, repeat: string): string[] {
  const problems = []
  if (next.length < MIN_PASSWORD_LENGTH)
    problems.push(`Das neue Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`)
  if (next && next === current)
    problems.push('Das neue Passwort muss sich vom alten unterscheiden.')
  if (repeat && next !== repeat) problems.push('Die Wiederholung stimmt nicht überein.')
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
