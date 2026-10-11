// What went wrong with a request (design M14), from a failed record or from a
// request the server refused before writing one; ``ProblemCard`` shows it.
import { ApiRequestError, type ModelActionView } from '../../api/client'
import type { Details } from '../../i18n/errors'

export interface Problem {
  code: string
  details: Details
  /** The backend's English, for a code this version does not know. */
  message?: string
  /** The connection asked, as the record holds it; ``null`` before any record. */
  connection: ModelActionView['connection'] | null
}

/** A failed record's problem. */
export function recordProblem(view: ModelActionView): Problem {
  const error = view.error ?? {}
  return {
    code: typeof error.code === 'string' ? error.code : 'internal_error',
    details: (error.details as Details | undefined) ?? {},
    connection: view.connection,
  }
}

/** A refused request's problem: an error body, or the transport failing. */
export function requestProblem(error: unknown): Problem {
  if (error instanceof ApiRequestError && error.body?.code)
    return {
      code: error.body.code,
      details: (error.body.details as Details | undefined) ?? {},
      message: error.body.message,
      connection: null,
    }
  return { code: 'internal_error', details: {}, connection: null }
}

/** A code and its details as "key: value" lines (design M3, M14.3 "Details"). */
export function technical(code: string, details: Details): string {
  const lines = Object.entries(details).map(
    ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  )
  return [`code: ${code}`, ...lines].join('\n')
}
