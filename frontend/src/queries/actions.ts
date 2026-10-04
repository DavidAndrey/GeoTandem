// Saving, opening and starting queries (design B1, C6; plan E1.7b).
import { t } from '@lingui/core/macro'
import type { QueryRef } from '../analysis/model'
import { emptyTree, resultQuery } from '../analysis/query'
import { useAnalysis } from '../analysis/store'
import { api, ApiRequestError, type SavedQueryDetail } from '../api/client'
import { describe } from '../editor/describe'
import { fitQuery, partFrom, queryPart, QUERY_STATE_VERSION, snapshotOf } from './part'

function applied() {
  const s = useAnalysis.getState()
  return { layers: s.layers, result: s.result, tree: s.tree, restriction: s.restriction }
}

function refOf(detail: SavedQueryDetail): QueryRef {
  const part = partFrom(detail.state_version, detail.state)
  return {
    id: detail.id,
    name: detail.name,
    mine: detail.mine,
    shared: detail.shared,
    snapshot: snapshotOf(part),
  }
}

export class CannotSave extends Error {}

function body(name: string, shared: boolean) {
  const analysis = applied()
  const part = queryPart(analysis)
  const query = resultQuery(analysis)
  if (!part || !query)
    throw new CannotSave(
      t`Gespeichert werden Abfragen auf Katalog-Layern; dieser Ergebnis-Layer ist abgeleitet.`,
    )
  return { name, shared, state_version: QUERY_STATE_VERSION, state: { ...part }, query }
}

/** The name is taken by one of the account's own queries: ``existing`` to overwrite. */
export class QueryNameTaken extends Error {
  readonly existing: string
  constructor(existing: string) {
    super('name_taken')
    this.existing = existing
  }
}

/** "Speichern unter"; with ``overwrite``, replaces that own query of the same name. */
export async function saveQueryAs(name: string, shared: boolean, overwrite?: string) {
  try {
    const detail = overwrite
      ? await api.queries.save(overwrite, body(name, shared))
      : await api.queries.create(body(name, shared))
    useAnalysis.getState().setQueryRef(refOf(detail))
    return detail
  } catch (error) {
    if (error instanceof ApiRequestError && error.body?.code === 'name_taken')
      throw new QueryNameTaken(String(error.body.details?.existing ?? ''))
    throw error
  }
}

/** "Speichern": over the own saved query; ``false`` when a name is needed first (Q3). */
export async function saveQuery(): Promise<boolean> {
  const ref = useAnalysis.getState().queryRef
  if (!ref?.mine) return false
  const detail = await api.queries.save(ref.id, body(ref.name, ref.shared))
  useAnalysis.getState().setQueryRef(refOf(detail))
  return true
}

/**
 * Opens a saved query in the analysis (design B1): result layer, conditions and
 * restriction are replaced. Returns what had to be left out on today's layers.
 */
export async function openQuery(id: string, available: Set<string>): Promise<string[]> {
  const detail = await api.queries.get(id)
  const part = partFrom(detail.state_version, detail.state)
  if (!part) throw new Error(t`Diese Abfrage wurde mit einem unbekannten Format gespeichert.`)
  const fitted = fitQuery(part, available)
  const result = part.result
  if (!fitted) throw new Error(t`Der Ergebnis-Layer „${result}" ist nicht verfügbar.`)
  // Rows left out make it differ from the saved part, so it shows as "geändert".
  useAnalysis.getState().applyQuery(fitted.part, refOf(detail))
  const labels = { field: (n: string) => n, layer: (n: string) => n }
  return fitted.removed.map((row) => describe(row, labels))
}

/** "Neue Abfrage (leer)": the same result layer, no conditions. */
export function newQuery() {
  const s = useAnalysis.getState()
  const part = queryPart(applied())
  if (part) s.applyQuery({ ...part, tree: emptyTree(), restriction: null }, null)
  else s.setQueryRef(null)
}
