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
//   There is no redo (design decision 6). After an undo the analysis counts
//   as unsaved: the snapshot's own mark may be older than the last save.
// - An answer that arrives while the editor holds a draft (a run or an undo
//   answered meanwhile) is parked and applied when the editor closes, so it
//   never drops the user's draft. "Anpassen …" is no hand edit by itself:
//   while the hand-over is open, changes are judged when it closes (applied =
//   a hand edit, "Verwerfen" with the analysis as before = none).
// - An answer whose record left the dialogue ("Verlauf leeren") changes
//   nothing here any more.
import { t } from '@lingui/core/macro'
import { create } from 'zustand'
import type { Analysis } from '../../analysis/model'
import { canBeResult, resultQuery } from '../../analysis/query'
import { useAnalysis, type AnalysisSnapshot } from '../../analysis/store'
import { api, ApiRequestError, type ModelActionView, type RejectReason } from '../../api/client'
import { proposalDraft } from '../panel/draft'
import { useHandover } from '../panel/handover'
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
  /** Answers parked until the editor closes, by record. */
  parked: Record<number, 'execute' | 'undo'>
  /** What an undo put back, by record: the "vorher" of M2.3, M6.2. */
  restored: Record<number, AnalysisSnapshot>
}

const initial = (): ApprovalState => ({
  last: null,
  baselines: {},
  busy: null,
  failure: null,
  rejecting: null,
  started: {},
  parked: {},
  restored: {},
})

export const useApproval = create<ApprovalState>()(initial)

/** Work waiting for the editor to close (see ``whenEditorClosed``). */
let waiting: (() => void)[] = []

/** A fresh workplace (and the tests' starting point). */
export const resetApproval = () => {
  waiting = []
  useApproval.setState(initial())
}

/** The committed analysis as the query sees it: what a hand edit changes (M5.2). */
export function fingerprint(analysis: Analysis): string {
  return JSON.stringify([analysis.result, resultQuery(analysis)])
}

const committedOf = ({ layers, result, tree, restriction }: Analysis): Analysis => ({
  layers,
  result,
  tree,
  restriction,
})

const committed = (): Analysis => committedOf(useAnalysis.getState())

const sameRefs = (a: Analysis, b: Analysis) =>
  a.layers === b.layers &&
  a.result === b.result &&
  a.tree === b.tree &&
  a.restriction === b.restriction

/** The committed analysis by value: what a hand edit changes, whatever the path. */
const shape = (analysis: Analysis) =>
  JSON.stringify([analysis.layers, analysis.result, analysis.tree, analysis.restriction])

/** A hand edit after the last model change: its undo is over, reported once (WP70). */
function handEdited() {
  const last = useApproval.getState().last
  if (!last || last.touched) return
  useApproval.setState({ last: { ...last, touched: true } })
  // For the log's undo rule; the button here is off already.
  api.model.touched(last.action).catch(() => undefined)
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

/** Whether the record is still in this workplace's dialogue ("Verlauf leeren" drops it). */
const inDialogue = (action: number) => useModel.getState().dialogue.includes(action)

/**
 * Runs ``apply`` now, or once the editor closes when it holds a draft: an
 * answer must never drop the user's open work (applyQuery and restore both
 * end the draft).
 */
function whenEditorClosed(action: number, kind: 'execute' | 'undo', apply: () => void) {
  if (useAnalysis.getState().draft === null) {
    apply()
    return
  }
  waiting.push(apply)
  useApproval.setState((s) => ({ parked: { ...s.parked, [action]: kind } }))
}

function flushParked() {
  if (useAnalysis.getState().draft !== null || waiting.length === 0) return
  const due = waiting
  waiting = []
  useApproval.setState({ parked: {} })
  for (const apply of due) apply()
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
  whenEditorClosed(done.id, 'execute', () => {
    if (!inDialogue(done.id)) return
    if (!apply({ ...done, query: done.query ?? view.query })) {
      useApproval.setState({
        failure: { action: view.id, step: 'execute', error: notApplicable() },
      })
      return
    }
    useModel.getState().received(done)
  })
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
  whenEditorClosed(action, 'undo', () => {
    // The snapshot's unsaved mark may predate a save since: unsaved after an undo.
    changeAnalysis(() => useAnalysis.getState().restore({ ...last.before, dirty: true }))
    useApproval.setState((s) => ({
      last: s.last?.action === action ? null : s.last,
      restored: { ...s.restored, [action]: last.before },
    }))
    useModel.getState().received(view)
  })
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
  // The committed analysis as last judged: by reference first (cheap), then by value.
  let seen = committed()
  let known = shape(seen)
  /** Judges the analysis as it is now; a nested change may have come after ``next``. */
  const judge = () => {
    const now = committed()
    if (sameRefs(now, seen)) return
    seen = now
    // The flow's own change, or a hand-over in the editor (judged when it closes).
    if (applying) {
      known = shape(now)
      return
    }
    if (useHandover.getState().open) return
    const value = shape(now)
    if (value === known) return
    known = value
    handEdited()
  }
  const offAnalysis = useAnalysis.subscribe((next, previous) => {
    // The user's change first, then what waited for the editor to close.
    judge()
    if (previous.draft !== null && next.draft === null) {
      flushParked()
      runAuto(useModel.getState())
    }
  })
  onModel(useModel.getState())
  return () => {
    offModel()
    offAnalysis()
  }
}
