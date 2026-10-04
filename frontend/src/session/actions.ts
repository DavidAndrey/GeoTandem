// Saving, opening and starting sessions (design C1–C5). Every query the
// workplace shows still comes from the analysis state (etappen E1.5); a session
// only stores that state, its result query and the server's stamp (plan S5).
import type { Analysis } from '../analysis/model'
import { resultQuery } from '../analysis/query'
import { useAnalysis } from '../analysis/store'
import { api, ApiRequestError, type SessionDetail } from '../api/client'
import { useMapView } from '../map/view'
import { useSelection } from '../table/selection'
import { fromSaved, reconcile, SessionFormatError, toSaved, type Removed } from './format'
import { useSession, type CurrentSession } from './store'

const NONE_REMOVED: Removed = { layers: [], rows: [], result: false }

/** The applied analysis: an open editor's draft is not saved (plan D8). */
function applied(): Analysis {
  const s = useAnalysis.getState()
  return { layers: s.layers, result: s.result, tree: s.tree, restriction: s.restriction }
}

function body(name: string, note: string) {
  const analysis = applied()
  const { table, queryRef } = useAnalysis.getState()
  const view = useMapView.getState().bbox
  return {
    name,
    note,
    ...toSaved({ analysis, table, view, queryRef }),
    query: resultQuery(analysis),
  }
}

function current(detail: SessionDetail): CurrentSession {
  return {
    id: detail.id,
    name: detail.name,
    note: detail.note,
    savedAt: detail.updated_at,
    stamp: detail.stamp,
  }
}

function saved(detail: SessionDetail) {
  useSession.getState().setCurrent(current(detail))
  useAnalysis.getState().markSaved()
  return detail
}

/** "Speichern" (⌘S): overwrites the current session; the stamp is renewed. */
export async function saveSession(): Promise<SessionDetail | null> {
  const session = useSession.getState().current
  if (!session) return null
  return saved(await api.sessions.save(session.id, body(session.name, session.note)))
}

/** The name is taken: ``existing`` is the id to overwrite after asking (plan D10). */
export class NameTaken extends Error {
  readonly existing: string
  constructor(existing: string) {
    super('name_taken')
    this.existing = existing
  }
}

/** "Speichern unter" (design C2). With ``overwrite``, replaces that session of the same name. */
export async function saveSessionAs(
  name: string,
  note: string,
  overwrite?: string,
): Promise<SessionDetail> {
  try {
    const detail = overwrite
      ? await api.sessions.save(overwrite, body(name, note))
      : await api.sessions.create(body(name, note))
    return saved(detail)
  } catch (error) {
    if (error instanceof ApiRequestError && error.body?.code === 'name_taken')
      throw new NameTaken(String(error.body.details?.existing ?? ''))
    throw error
  }
}

/** "Neue Sitzung": an empty analysis, no session. */
/** Counts opens and new sessions: an open overtaken while it loads gives way. */
let latest = 0

export function newSession() {
  latest += 1
  useAnalysis.getState().reset()
  useSelection.getState().clear()
  useSession.getState().setCurrent(null)
  useSession.getState().setReport(null)
}

/**
 * Opens a session with check (design C4, C8): loads the state, fits it to the
 * layers available now, then asks the server to run the saved query again and
 * compare it with the stamp — and with the query rebuilt from the state.
 */
export async function openSession(
  idOrDetail: string | SessionDetail,
  available: Set<string>,
): Promise<void> {
  const ticket = ++latest
  const detail = typeof idOrDetail === 'string' ? await api.sessions.get(idOrDetail) : idOrDetail
  if (ticket !== latest) return
  const { setCurrent, setReport } = useSession.getState()
  let removed = NONE_REMOVED
  try {
    const fitted = reconcile(fromSaved(detail.state_version, detail.state), available)
    removed = fitted.removed
    useSelection.getState().clear()
    useAnalysis
      .getState()
      .load(fitted.saved.analysis, fitted.saved.table, fitted.saved.queryRef ?? null)
    if (fitted.saved.view) useMapView.getState().zoomToFeature(fitted.saved.view, 'view')
  } catch (error) {
    if (!(error instanceof SessionFormatError)) throw error
    newSession()
    setReport({ name: detail.name, check: null, removed, error: error.message })
    return
  }
  setCurrent(current(detail))
  setReport({ name: detail.name, check: null, removed, error: null })
  const check = await api.sessions.check(detail.id, resultQuery(applied()))
  // Another session may have been opened meanwhile.
  if (useSession.getState().current?.id === detail.id)
    setReport({ name: detail.name, check, removed, error: null })
}
