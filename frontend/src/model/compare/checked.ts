// The chain's check of a direct answer (plan-check-mode), its flow; the
// mark is Check.tsx. Where the
// connection checks, the server asks the prompt again with the chain by
// itself, after the answer, as a repeat marked ``is_check``, and compares the
// chain's plan with the answer by feature ids (``view.check``). The answer
// stays as it is; the mark says what the check found:
//
// - ``running``: the check plans; the workplace polls the answer until the
//   mark changes (``useCheckPolling``), as it polls a request, but without
//   holding the field: the account's next prompt aborts the check (D3).
// - ``same``: the chain finds the same features.
// - ``differs``: *Unsicher*, with both counts and *Vergleich ansehen*, which
//   brings the check into the dialogue as a repeat (``shown``) and opens the
//   comparison of the plan (the server's ``_compared``: a check waiting with
//   its plan compares the plan's query, no step runs). Taking the chain's
//   side is that plan's own approval and run, as for any repeated chain.
// - ``not_checked``: the check ended without a plan to compare.
import { useEffect } from 'react'
import { api, type ModelActionView } from '../../api/client'
import { POLL_MS } from '../panel/poll'
import { OPEN, sameGeneration, useModel, type ModelState } from '../store'
import { openComparison } from './flow'

/** A check brought into the dialogue: a repeat that closes nothing and leaves a request polled as it is. */
export function shown(state: ModelState, check: ModelActionView): ModelState {
  return {
    ...state,
    views: { ...state.views, [check.id]: check },
    dialogue: state.dialogue.includes(check.id) ? state.dialogue : [...state.dialogue, check.id],
    pending: OPEN.includes(check.status) ? check.id : state.pending,
  }
}

/** *Vergleich ansehen* of a check: its record in the dialogue, then the comparison. */
export async function showCheck(checkId: number): Promise<void> {
  const current = sameGeneration()
  const known = useModel.getState().views[checkId]
  const check = known ?? (await api.model.action(checkId))
  if (!current()) return
  useModel.setState((s) => shown(s, check))
  openComparison(checkId)
}

/** The answers of the dialogue whose check still runs, as a stable key. */
const runningChecks = (state: ModelState): string =>
  state.dialogue.filter((id) => state.views[id]?.check?.state === 'running').join(',')

/**
 * Polls the answers whose check runs, about once a second, until their mark
 * changes. Mounted once by the workplace, beside the request's polling. A
 * failed poll is tried again at the next tick: the mark is no request of the
 * user's, so no failure is shown.
 */
export function useCheckPolling() {
  const key = useModel(runningChecks)
  const received = useModel((s) => s.received)

  useEffect(() => {
    if (key === '') return
    const ids = key.split(',').map(Number)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      for (const id of ids) {
        try {
          const view = await api.model.action(id)
          if (stopped) return
          received(view)
        } catch {
          // The next tick asks again.
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [key, received])
}
