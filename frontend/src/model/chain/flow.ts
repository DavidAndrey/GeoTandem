// The tool chain on the client (design M8, M9; plan P4, WP77). The server
// plans, runs and decides; the client asks for each transition and polls.
// Every request goes through the approval flow's ``step`` (approval/flow.ts):
// one ``busy`` and one ``failure`` for a record, whatever the request.
//
// - A plan is ``proposed`` (or ``approved`` when no step needs approval).
//   *Kette freigeben und starten* / *Starten* / *Schritt freigeben* are the
//   approval flow's ``approve``; an ``approved`` chain is then run
//   (``POST .../run``, 202) by ``useChainRunner``, which also starts an
//   ``auto`` plan without a question (*Automatisch*: never asked).
// - While it is ``running`` the workplace's polling (panel/poll.ts) brings the
//   steps as they finish; a halt before a step that needs approval, or a
//   re-plan the level wants approved, makes it ``proposed`` again (P4).
// - *Abbrechen* of a running chain is the panel's abort: answered at once
//   with ``stop_reason`` ``aborted``, the chain ends ``limited`` at its next
//   step, and the polling brings that. A chain waiting (halted, or approved
//   at a halt and not run again) is stopped at once (``stopChain``).
// - *Ergebnis übernehmen* / *Zwischenstand übernehmen* is the approval flow's
//   ``adopt``: the result is applied as ``execute``'s is, origin marks and
//   undo included. The analysis is unchanged until then.
// - *Anpassen …* edits the plan before it starts (M8.3): values changed and
//   steps removed through ``PATCH .../plan``; there is no way to add a step.
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, ApiRequestError, type ModelActionView, type PlanEdit } from '../../api/client'
import { approve, step, useApproval } from '../approval/flow'
import { backoff } from '../panel/poll'
import { abort } from '../panel/state'
import { sameGeneration, useModel, type ModelState } from '../store'
import { isChain } from './steps'

interface ChainState {
  /** The plan open in the editor of M8.3. */
  editing: number | null
  /** The plan whose editor just closed: its *Anpassen …* takes the focus back. */
  edited: number | null
  /**
   * Approved chains whose run was asked for: never twice. Cleared when the
   * record leaves ``approved`` (it runs) and by *Erneut starten* after a failure.
   */
  runs: Record<number, true>
}

const initial = (): ChainState => ({ editing: null, edited: null, runs: {} })

export const useChain = create<ChainState>()(initial)

/** Part of ``resetModelState``: a fresh workplace, and the tests' starting point. */
export function resetChain() {
  clocks.clear()
  useChain.setState(initial())
}

const received = (view: ModelActionView) => useModel.getState().received(view)

/** The record as it is now, when a request about it failed: the dialogue follows it. */
function refetch(id: number) {
  const current = sameGeneration()
  api.model
    .action(id)
    .then((view) => {
      if (current()) received(view)
    })
    .catch(() => undefined)
}

/**
 * *Kette freigeben und starten* (M8.1), *Starten* (M8.2), *Schritt freigeben*
 * (M9.2), *Freigeben und fortsetzen* (a re-plan): the approval of the level
 * as it was. The run follows (``useChainRunner``) once the record is ``approved``.
 */
export async function approveChain(view: ModelActionView) {
  if (useApproval.getState().busy) return
  await approve(view)
}

/** ``run`` tried again after ``busy`` before the failure shows. */
const BUSY_TRIES = 5

/**
 * The account's model calls are taken (409 ``busy``, P7), or all of the
 * instance's (503 ``busy``): also for a moment right after a halt, while the
 * run that halted gives its place back (WP75). Worth another try.
 */
const isBusy = (error: unknown) =>
  error instanceof ApiRequestError &&
  (error.status === 409 || error.status === 503) &&
  error.body?.code === 'busy'

/**
 * Runs an approved chain (202, P4); the workplace's polling takes over. A
 * ``busy`` answer is tried again after a growing wait, while the record is
 * still ``approved`` and the workplace the same. Any other failure is shown
 * and the record asked for again: a run the server started all the same
 * (an answer lost on the way) is polled on.
 */
export async function runChain(id: number, tries = 0) {
  useChain.setState((s) => ({ runs: { ...s.runs, [id]: true } }))
  const current = sameGeneration()
  const running = await step(id, 'run', () => api.model.run(id))
  if (!current()) return
  if (running) {
    received(running)
    return
  }
  const failure = useApproval.getState().failure
  if (failure?.action === id && isBusy(failure.error) && tries + 1 < BUSY_TRIES) {
    useApproval.setState({ failure: null })
    setTimeout(
      () => {
        if (current() && useModel.getState().views[id]?.status === 'approved')
          void runChain(id, tries + 1)
      },
      backoff(tries + 1),
    )
    return
  }
  refetch(id)
}

/** *Erneut starten* after a run request failed. */
export function retryRun(id: number) {
  useChain.setState((s) => withoutRun(s, id))
  useApproval.setState({ failure: null })
  void runChain(id)
}

/**
 * *Kette abbrechen* / *Abbrechen* (M9.2, M9.4). A running chain goes through
 * the panel's abort, which holds the polling meanwhile; a waiting one is
 * stopped at once, ``limited`` with its last complete result. A refusal is
 * shown (``failure``) and the record asked for again.
 */
export async function stopChain(view: ModelActionView) {
  if (view.status === 'running') return abort(view.id)
  const stopped = await step(view.id, 'abort', () => api.model.abort(view.id))
  if (stopped) received(stopped)
  else refetch(view.id)
}

/** *Änderungen übernehmen* (M8.3): values and removals at once; the server checks the plan again. */
export async function editPlan(view: ModelActionView, edit: PlanEdit) {
  if (useApproval.getState().busy) return
  const revised = await step(view.id, 'plan', () => api.model.editPlan(view.id, edit))
  if (!revised) return
  received(revised)
  closePlanEditor()
}

export function openPlanEditor(id: number) {
  useApproval.setState({ failure: null })
  useChain.setState({ editing: id, edited: null })
}

export function closePlanEditor() {
  const { editing } = useChain.getState()
  useApproval.setState((s) => (s.failure?.step === 'plan' ? { failure: null } : s))
  useChain.setState({ editing: null, edited: editing })
}

/** The focus went back to *Anpassen …* (``PlanActions``). */
export const focusReturned = () => useChain.setState({ edited: null })

/** Runs every approved chain of the dialogue not asked for yet (P4: *Automatisch* never asks). */
function runApproved(model: ModelState) {
  const { runs } = useChain.getState()
  const failure = useApproval.getState().failure
  for (const id of model.dialogue) {
    const view = model.views[id]
    if (!view || !isChain(view)) continue
    if (view.status !== 'approved') {
      // Left ``approved``: a later approval (after a halt) runs it again.
      if (runs[id]) useChain.setState((s) => withoutRun(s, id))
      continue
    }
    if (runs[id] || failure?.action === id) continue
    void runChain(id)
  }
}

const withoutRun = (s: ChainState, id: number): Pick<ChainState, 'runs'> => ({
  runs: Object.fromEntries(Object.entries(s.runs).filter(([key]) => Number(key) !== id)),
})

/** Mounted once by the workplace: approved chains are run as they arrive. */
export function useChainRunner() {
  useEffect(() => {
    const off = useModel.subscribe(runApproved)
    runApproved(useModel.getState())
    return off
  }, [])
}

// --- The run's clock (M9.1 "0:03 / max. 5:00") -------------------------------

/**
 * What counts against the request's cap (P4, ``CHAIN_TIME_LIMIT_S``): the
 * planning call (``latency_ms``) and the run so far (``run_ms``, halts left
 * out), as the server counts them. The server writes ``run_ms`` as each step
 * starts and ends; in between this clock goes on from the poll that brought
 * the value. A halt stops it (M9.2: "Laufzeit ist angehalten, solange die
 * Freigabe offen ist"). By record, outside React: a remount keeps it.
 */
const clocks = new Map<number, { base: number; since: number }>()

/** Milliseconds of the request so far, at ``now``. */
export function requestMs(view: ModelActionView, now: number): number {
  const base = (view.latency_ms ?? 0) + (view.run_ms ?? 0)
  if (view.status !== 'running') {
    clocks.delete(view.id)
    return base
  }
  const clock = clocks.get(view.id)
  if (!clock || clock.base !== base) {
    clocks.set(view.id, { base, since: now })
    return base
  }
  return base + Math.max(0, now - clock.since)
}
