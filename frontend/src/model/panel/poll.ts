// Polling the running record (plan P7, P4): ``POST /api/model/prompt`` answers 202
// with the record ``thinking``; the client asks for it about once a second
// until its status changes; a tool chain's run (``POST .../run``, 202) is polled
// the same way while it is ``running``. No streaming.
import { useEffect } from 'react'
import { api } from '../../api/client'
import { POLLED, useModel } from '../store'
import { usePanel } from './state'

export const POLL_MS = 1000

/** Failed polls in a row before the panel says so and waits for "Erneut versuchen". */
const MAX_FAILURES = 3

/** The wait after ``failures`` failed polls in a row: doubled each time, at most 8 s. */
export const backoff = (failures: number) => Math.min(POLL_MS * 2 ** failures, 8 * POLL_MS)

/**
 * Polls the record ``useModel().running`` names. Mounted once by the workplace,
 * so a request goes on while the user works in Klassik. Stops when the status
 * leaves ``POLLED``, on unmount, and while an abort is under way (the abort's
 * answer ends it). Never two requests at once: the next poll is timed from the
 * last answer. A poll that keeps failing stops and is reported in the panel
 * (``usePanel().pollError``); ``resumePolling`` starts it again.
 */
export function useActionPolling() {
  const id = useModel((s) => s.running?.id ?? null)
  const received = useModel((s) => s.received)
  const round = usePanel((s) => s.pollRound)

  useEffect(() => {
    if (id === null) return
    let stopped = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (usePanel.getState().aborting === id) {
        timer = setTimeout(tick, POLL_MS)
        return
      }
      try {
        const view = await api.model.action(id)
        if (stopped) return
        // An abort started meanwhile: its answer decides; poll again in case it fails.
        if (usePanel.getState().aborting === id) {
          timer = setTimeout(tick, POLL_MS)
          return
        }
        failures = 0
        if (usePanel.getState().pollError?.id === id) usePanel.setState({ pollError: null })
        received(view)
        if (POLLED.includes(view.status)) timer = setTimeout(tick, POLL_MS)
      } catch (error) {
        if (stopped) return
        failures += 1
        if (failures >= MAX_FAILURES) usePanel.setState({ pollError: { id, error } })
        // Backing off: a server in trouble is not asked once a second (2 s, 4 s …).
        else timer = setTimeout(tick, backoff(failures))
      }
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [id, received, round])
}

export const resumePolling = () =>
  usePanel.setState((s) => ({ pollError: null, pollRound: s.pollRound + 1 }))
