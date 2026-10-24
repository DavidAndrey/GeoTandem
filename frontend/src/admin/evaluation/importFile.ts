// Import of a case file (design V1.3, F-3.13): all or nothing. Whatever stops
// it, a file that is no JSON, a case the format refuses or one the checks
// refuse, comes back as one list of problems, each naming its case.
import { t } from '@lingui/core/macro'
import { api, ApiRequestError, type ImportResult } from '../../api/client'
import { importProblemText } from './words'

export interface Problem {
  /** The case's id, or ``null`` for the file as a whole. */
  caseId: string | null
  /** In words. */
  reason: string
  /** The server's own text, for "Technisch (Prüfbericht)". */
  technical: string
}

export type Outcome =
  | { kind: 'imported'; count: number }
  | { kind: 'refused'; file: string; cases: number | null; problems: Problem[] }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The cases of a parsed file, if it has a list of them. */
function casesOf(file: unknown): unknown[] | null {
  return isObject(file) && Array.isArray(file.cases) ? file.cases : null
}

interface SchemaError {
  loc: (string | number)[]
  msg: string
}

const isSchemaError = (value: unknown): value is SchemaError =>
  isObject(value) && Array.isArray(value.loc) && typeof value.msg === 'string'

/** A refusal of the format (422 ``schema_violation``): one problem per case it names. */
function formatProblems(error: ApiRequestError, cases: unknown[] | null): Problem[] {
  const details = error.body?.details ?? {}
  const errors = Array.isArray(details.errors) ? details.errors.filter(isSchemaError) : []
  const problems: Problem[] = []
  const seen = new Set<string>()
  for (const e of errors) {
    // ``loc``: ["body", "cases", 3, "tags", …] for a case, ["body", "format"] for the file.
    const [, where, index, field] = e.loc
    const technical = `${e.loc.slice(1).join('.')}: ${e.msg}`
    if (where === 'cases' && typeof index === 'number') {
      const found = cases?.[index]
      const caseId = isObject(found) && typeof found.id === 'string' ? found.id : `#${index + 1}`
      const key = `${caseId}\u0000${String(field ?? '')}`
      if (seen.has(key)) continue
      seen.add(key)
      problems.push({
        caseId,
        reason:
          typeof field === 'string'
            ? t`Feld „${field}" fehlt oder ist ungültig`
            : t`Fall unvollständig oder widersprüchlich`,
        technical,
      })
    } else if (!seen.has('file')) {
      seen.add('file')
      problems.push({
        caseId: null,
        reason: t`Die Datei ist keine Prüffall-Datei (Format wie Export).`,
        technical,
      })
    }
  }
  return problems.length
    ? problems
    : [{ caseId: null, reason: error.message, technical: error.body?.message ?? '' }]
}

/** Reads, sends and judges one file; never throws for a refused file. */
export async function importCases(file: File): Promise<Outcome> {
  const name = file.name
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch (error) {
    const technical = error instanceof Error ? error.message : String(error)
    const reason = t`Die Datei ist kein lesbares JSON.`
    return {
      kind: 'refused',
      file: name,
      cases: null,
      problems: [{ caseId: null, reason, technical }],
    }
  }
  const cases = casesOf(parsed)
  let result: ImportResult
  try {
    result = await api.evaluation.importFile(parsed)
  } catch (error) {
    if (!(error instanceof ApiRequestError)) throw error
    const problems =
      error.body?.code === 'schema_violation'
        ? formatProblems(error, cases)
        : [{ caseId: null, reason: error.message, technical: error.body?.message ?? '' }]
    return { kind: 'refused', file: name, cases: cases?.length ?? null, problems }
  }
  if (result.problems?.length)
    return {
      kind: 'refused',
      file: name,
      cases: cases?.length ?? null,
      problems: result.problems.map((p) => ({
        caseId: p.case_id,
        reason: importProblemText(p.code),
        technical: p.message,
      })),
    }
  return { kind: 'imported', count: result.imported }
}
