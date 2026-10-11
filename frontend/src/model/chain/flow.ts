// The tool chain on the client (design M8, M9; plan P4, WP77). The server
// plans, runs and decides; the client asks for each transition and polls:
//
// - A plan is ``proposed`` (or ``approved`` when every step's cell is
//   ``auto``). *Kette freigeben und starten* / *Starten* / *Schritt freigeben*
//   approve it (``approve``, as a proposal is approved, E2.4); an ``approved``
//   chain is then run (``POST .../run``, 202) by ``useChainRunner``, which
//   also starts an ``auto`` plan without a question (*Automatisch*: never).
// - While it is ``running`` the workplace's polling (panel/poll.ts) brings the
//   steps as they finish; a halt before a step that needs approval, or a
//   re-plan the level wants approved, makes it ``proposed`` again (P4).
// - *Abbrechen* / *Kette abbrechen* is the panel's abort (``POST .../abort``):
//   the chain stops before its next step, ``limited`` with its last complete
//   result adoptable (M9.4).
// - *Ergebnis übernehmen* / *Zwischenstand übernehmen* is the approval flow's
//   ``adopt`` (approval/flow.ts): the result is applied as ``execute``'s is,
//   origin marks and undo included. The analysis is unchanged until then.
// - *Anpassen …* edits the plan before it starts (M8.3): values changed and
//   steps removed through ``PATCH .../plan``; there is no way to add a step.
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, ApiRequestError, type ModelActionView, type PlanEdit } from '../../api/client'
import { backoff } from '../panel/poll'
import { sameGeneration, useModel, type ModelState } from '../store'
import { finished, isChain, started } from './steps'

export type ChainStep = 'start' | 'run' | 'plan'

interface ChainState {
  busy: { action: number; step: ChainStep } | null
  failure: { action: number; step: ChainStep; error: unknown } | null
  /** The plan open in the editor of M8.3. */
  editing: number | null
  /**
   * Approved chains whose run was asked for: never twice. Cleared when the
   * record leaves ``approved`` (it runs) and by *Erneut starten* after a failure.
   */
  runs: Record<number, true>
}

const initial = (): ChainState => ({ busy: null, failure: null, editing: null, runs: {} })

export const useChain = create<ChainState>()(initial)

/** Part of ``resetModelState``: a fresh workplace, and the tests' starting point. */
export function resetChain() {
  clocks.clear()
  useChain.setState(initial())
}

/** One request of the flow, ``busy`` while it runs; ``null`` when it failed or a reset came first. */
async function request<T>(
  action: number,
  name: ChainStep,
  run: () => Promise<T>,
): Promise<T | null> {
  const current = sameGeneration()
  useChain.setState({ busy: { action, step: name }, failure: null })
  try {
    const answer = await run()
    return current() ? answer : null
  } catch (error) {
    if (current()) useChain.setState({ failure: { action, step: name, error } })
    return null
  } finally {
    if (current()) useChain.setState((s) => (s.busy?.action === action ? { busy: null } : s))
  }
}

/**
 * *Kette freigeben und starten* (M8.1), *Starten* (M8.2), *Schritt freigeben*
 * (M9.2): the approval of the level as it was. The run follows
 * (``useChainRunner``) once the record is ``approved``.
 */
export async function approveChain(view: ModelActionView) {
  if (useChain.getState().busy) return
  const approved = await request(view.id, 'start', () => api.model.approve(view.id))
  if (approved) useModel.getState().received(approved)
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
 * still ``approved`` and the workplace the same.
 */
export async function runChain(id: number, tries = 0) {
  useChain.setState((s) => ({ runs: { ...s.runs, [id]: true } }))
  const current = sameGeneration()
  useChain.setState({ busy: { action: id, step: 'run' }, failure: null })
  try {
    const running = await api.model.run(id)
    if (current()) useModel.getState().received(running)
  } catch (error) {
    if (!current()) return
    if (isBusy(error) && tries + 1 < BUSY_TRIES) {
      setTimeout(
        () => {
          if (current() && useModel.getState().views[id]?.status === 'approved')
            void runChain(id, tries + 1)
        },
        backoff(tries + 1),
      )
      return
    }
    useChain.setState({ failure: { action: id, step: 'run', error } })
  } finally {
    if (current()) useChain.setState((s) => (s.busy?.action === id ? { busy: null } : s))
  }
}

/** *Erneut starten* after a run request failed. */
export function retryRun(id: number) {
  useChain.setState((s) => ({ ...withoutRun(s, id), failure: null }))
  void runChain(id)
}

/** *Änderungen übernehmen* (M8.3): values and removals at once; the server checks the plan again. */
export async function editPlan(view: ModelActionView, edit: PlanEdit) {
  if (useChain.getState().busy) return
  const revised = await request(view.id, 'plan', () => api.model.editPlan(view.id, edit))
  if (!revised) return
  useModel.getState().received(revised)
  useChain.setState({ editing: null })
}

export const openPlanEditor = (id: number) => useChain.setState({ editing: id, failure: null })
export const closePlanEditor = () => useChain.setState({ editing: null, failure: null })

/** Runs every approved chain of the dialogue not asked for yet (P4: *Automatisch* never asks). */
function runApproved(model: ModelState) {
  const { runs, failure } = useChain.getState()
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
 * The server keeps a step's duration once it finished (``duration_ms``); the
 * step running now is timed on this clock from the poll that first showed it.
 * A halt for approval stops the clock (M9.2: "Laufzeit ist angehalten, solange
 * die Freigabe offen ist"). By record, outside React: a remount keeps it.
 */
const clocks = new Map<number, { finished: number; since: number }>()

/** Milliseconds the run took so far, at ``now``. */
export function runMs(view: ModelActionView, now: number): number {
  const done = view.steps.filter(finished)
  const ran = done.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0)
  if (view.status !== 'running' || !started(view)) {
    clocks.delete(view.id)
    return ran
  }
  const clock = clocks.get(view.id)
  if (!clock || clock.finished !== done.length) {
    clocks.set(view.id, { finished: done.length, since: now })
    return ran
  }
  return ran + Math.max(0, now - clock.since)
}
