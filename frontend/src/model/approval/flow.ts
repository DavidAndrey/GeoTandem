// Approval, auto execution and undo on the client (design M5, M6; plan D2,
// P2, P7, WP72). The server holds the record and runs only the stored query;
// the analysis is client state, so applying the result and putting the
// previous state back happen here:
//
// - *Annehmen* approves, then executes; ``execute`` answers with the record
//   and the rows (``ExecuteResponse``), and the record's stored query becomes
//   the analysis with the origin mark "Modell" on every condition (P3).
// - An ``auto`` answer arrives ``approved`` and is executed at once (P7);
//   while the editor holds a draft it waits until the editor closes, so it
//   never overwrites the user's open work.
// - The last model change keeps a snapshot of the analysis before it,
//   origin marks included (``load`` would clear them). Undo is reported to
//   the server first (log only, D2), then the snapshot comes back whole. Undo
//   is offered for that change only and only until the analysis is changed by
//   hand; the first hand edit is reported with ``touched`` (design rule 7).
//   There is no redo (design decision 6).
import { t } from '@lingui/core/macro'
import { create } from 'zustand'
import type { Analysis } from '../../analysis/model'
import { canBeResult, resultQuery } from '../../analysis/query'
import { useAnalysis, type AnalysisSnapshot } from '../../analysis/store'
import { api, ApiRequestError, type ModelActionView, type RejectReason } from '../../api/client'
import { proposalDraft } from '../panel/draft'
import { useModel, type ModelState } from '../store'
import { autoReady, needsApproval } from './governance'

export type Step = 'approve' | 'execute' | 'reject' | 'undo'

/** The last change the model made to the analysis: the one undo can take back. */
export interface LastChange {
  action: number
  /** The analysis before it, origin marks included. */
  before: AnalysisSnapshot
  /** Applied without a question (M6.1): the map's notice bar shows it. */
  auto: boolean
  /** Changed by hand since: undo is over (design rule 7). */
  touched: boolean
  /** × on the notice bar: hidden, nothing else changes. */
  hidden: boolean
}

interface ApprovalState {
  last: LastChange | null
  /** The analysis when a proposal arrived, to tell a hand edit meanwhile (M5.2). */
  baselines: Record<number, string>
  busy: { action: number; step: Step } | null
  failure: { action: number; step: Step; error: unknown } | null
  /** "Ablehnen" asks for the optional reason first (M5.3). */
  rejecting: { action: number; reason: RejectReason | null } | null
  /** Auto answers whose execution has started: never twice. */
  started: Record<number, true>
}

const initial = (): ApprovalState => ({
  last: null,
  baselines: {},
  busy: null,
  failure: null,
  rejecting: null,
  started: {},
})

export const useApproval = create<ApprovalState>()(initial)

/** A fresh workplace (and the tests' starting point). */
export const resetApproval = () => useApproval.setState(initial())

/** The committed analysis as the query sees it: what a hand edit changes (M5.2). */
export function fingerprint(analysis: Analysis): string {
  return JSON.stringify([analysis.result, resultQuery(analysis)])
}

const committed = (): Analysis => {
  const { layers, result, tree, restriction } = useAnalysis.getState()
  return { layers, result, tree, restriction }
}

/** Whether the record's stored query can become the analysis (D3: the editor shows it whole). */
export function canApply(view: ModelActionView): boolean {
  const draft = proposalDraft(view.query, view.id)
  if (!draft) return false
  const shown = useAnalysis.getState().layers.find((l) => l.id === draft.result)
  return !shown || canBeResult(shown)
}

/** Set while the flow itself changes the analysis: that is no hand edit. */
let applying = false

function changeAnalysis(change: () => void) {
  applying = true
  try {
    change()
  } finally {
    applying = false
  }
}

/** The executed record's stored query becomes the analysis, its conditions marked "Modell". */
function apply(view: ModelActionView): boolean {
  const draft = proposalDraft(view.query, view.id)
  if (!draft || !canApply(view)) return false
  const before = useAnalysis.getState().snapshot()
  changeAnalysis(() => {
    // A model query has no "Nur in" (D3) and is no saved query: both go.
    useAnalysis
      .getState()
      .applyQuery({ result: draft.result, tree: draft.tree, restriction: null }, null)
    useAnalysis.getState().markOrigin()
  })
  useApproval.setState({
    last: {
      action: view.id,
      before,
      auto: view.decision === 'auto',
      touched: false,
      hidden: false,
    },
  })
  return true
}

const notApplicable = () =>
  new Error(t`Diese Abfrage lässt sich nicht im Editor darstellen und darum nicht anwenden.`)

async function step<T>(action: number, name: Step, run: () => Promise<T>): Promise<T | null> {
  useApproval.setState({ busy: { action, step: name }, failure: null })
  try {
    return await run()
  } catch (error) {
    useApproval.setState({ failure: { action, step: name, error } })
    return null
  } finally {
    useApproval.setState((s) => (s.busy?.action === action ? { busy: null } : s))
  }
}

/** Runs the stored query of an approved record and applies it (D2). */
export async function execute(view: ModelActionView) {
  if (!canApply(view)) {
    useApproval.setState({ failure: { action: view.id, step: 'execute', error: notApplicable() } })
    return
  }
  const response = await step(view.id, 'execute', () => api.model.execute(view.id))
  if (!response) return
  // The record says what ran; apply exactly that.
  const done = response.action
  if (!apply({ ...done, query: done.query ?? view.query })) {
    useApproval.setState({ failure: { action: view.id, step: 'execute', error: notApplicable() } })
    return
  }
  useModel.getState().received(done)
}

/** *Annehmen* (M5.1): approve, then execute. */
export async function accept(view: ModelActionView) {
  if (useApproval.getState().busy) return
  if (!canApply(view)) {
    useApproval.setState({ failure: { action: view.id, step: 'approve', error: notApplicable() } })
    return
  }
  const approved = await step(view.id, 'approve', () => api.model.approve(view.id))
  if (!approved) return
  useModel.getState().received(approved)
  await execute(approved)
}

/** *Ablehnen* (M5.3) with the optional reason chip; the analysis stays as it is. */
export async function reject(view: ModelActionView, reason: RejectReason | null) {
  if (useApproval.getState().busy) return
  const rejected = await step(view.id, 'reject', () => api.model.reject(view.id, reason))
  if (!rejected) return
  useApproval.setState({ rejecting: null })
  useModel.getState().received(rejected)
}

/** *Zurücknehmen* / *Rückgängig* (M2.3, M6.2): the log first, then the analysis as it was. */
export async function undo(action: number) {
  const last = useApproval.getState().last
  if (!last || last.action !== action || last.touched || useApproval.getState().busy) return
  // An open editor's draft would be dropped by the restore: the buttons wait for it.
  if (useAnalysis.getState().draft !== null) return
  const view = await step(action, 'undo', () => api.model.undo(action))
  if (!view) {
    const failure = useApproval.getState().failure?.error
    // The server knows of a hand edit this window did not report: undo is over here too.
    if (failure instanceof ApiRequestError && failure.body?.code === 'undo_blocked')
      useApproval.setState((s) => (s.last ? { last: { ...s.last, touched: true } } : s))
    return
  }
  changeAnalysis(() => useAnalysis.getState().restore(last.before))
  useApproval.setState({ last: null })
  useModel.getState().received(view)
}

/** × on the notice bar (M6.1): hidden only; undo stays in the answer. */
export const hideNotice = () =>
  useApproval.setState((s) => (s.last ? { last: { ...s.last, hidden: true } } : s))

export const startRejecting = (action: number) =>
  useApproval.setState({ rejecting: { action, reason: null }, failure: null })

export const chooseReason = (reason: RejectReason | null) =>
  useApproval.setState((s) => (s.rejecting ? { rejecting: { ...s.rejecting, reason } } : s))

export const stopRejecting = () => useApproval.setState({ rejecting: null })

/** Executes the auto answers of the dialogue that wait (P7), unless the editor is open. */
function runAuto(model: ModelState) {
  if (useAnalysis.getState().draft !== null) return
  for (const id of model.dialogue) {
    const view = model.views[id]
    if (!view || !autoReady(view) || useApproval.getState().started[id]) continue
    useApproval.setState((s) => ({ started: { ...s.started, [id]: true } }))
    void execute(view)
  }
}

/** Notes the analysis a proposal was made against, once (M5.2). */
function rememberBaselines(model: ModelState) {
  const known = useApproval.getState().baselines
  const fresh = Object.values(model.views).filter((v) => needsApproval(v) && !(v.id in known))
  if (fresh.length === 0) return
  const now = fingerprint(committed())
  useApproval.setState((s) => ({
    baselines: { ...s.baselines, ...Object.fromEntries(fresh.map((v) => [v.id, now])) },
  }))
}

/**
 * Mounted once by the workplace (beside ``watchHandover``): executes auto
 * answers as they arrive, remembers what each proposal was made against, and
 * reports the first hand edit after a model change. Returns the unsubscribe.
 */
export function watchApproval(): () => void {
  const onModel = (model: ModelState) => {
    rememberBaselines(model)
    runAuto(model)
  }
  const offModel = useModel.subscribe(onModel)
  const offAnalysis = useAnalysis.subscribe((next, previous) => {
    if (previous.draft !== null && next.draft === null) runAuto(useModel.getState())
    if (applying) return
    const last = useApproval.getState().last
    if (!last || last.touched) return
    const same =
      next.layers === previous.layers &&
      next.result === previous.result &&
      next.tree === previous.tree &&
      next.restriction === previous.restriction
    if (same) return
    useApproval.setState({ last: { ...last, touched: true } })
    // For the log's undo rule (WP70); the button here is off already.
    api.model.touched(last.action).catch(() => undefined)
  })
  onModel(useModel.getState())
  return () => {
    offModel()
    offAnalysis()
  }
}
