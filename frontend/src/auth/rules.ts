// Pure rules of the access screens, shared and unit-tested.
import { ApiRequestError, type Account } from '../api/client'

export const ROLE_LABELS: Record<Account['role'], string> = {
  admin: 'Administrator',
  user: 'Anwender',
}

export const MIN_PASSWORD_LENGTH = 12

/** Under every new-password field: length over complexity (security review #12). */
export const PASSWORD_HINT = `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen, Sonderzeichen sind nicht nötig. Ein Satz aus mehreren Wörtern ist sicher und gut zu merken.`

/** The server's password rules, told in German; it alone knows the lists of common passwords. */
const PASSWORD_RULES: Record<string, string> = {
  password_too_short: `Das Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`,
  password_too_long: 'Das Passwort ist zu lang.',
  password_common:
    'Dieses Passwort ist zu verbreitet: Es gehört zu den ersten, die ausprobiert werden, auch mit angehängten Zahlen oder Zeichen.',
  password_pattern:
    'Das Passwort ist eine Tastaturreihe, eine Folge oder eine Wiederholung und leicht zu erraten.',
  password_contains_name:
    'Das Passwort darf weder den Benutzernamen noch den Anzeigenamen noch «GeoTandem» enthalten.',
  password_unchanged: 'Das neue Passwort muss sich vom alten unterscheiden.',
}

/** ``error`` with a German message if it is a password rule the server refused. */
export function passwordError(error: unknown): unknown {
  const code = error instanceof ApiRequestError ? error.body?.code : undefined
  const message = code ? PASSWORD_RULES[code] : undefined
  return message ? new Error(message) : error
}

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
