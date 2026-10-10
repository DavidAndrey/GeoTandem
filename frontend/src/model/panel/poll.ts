// Polling the running record (plan P7): ``POST /api/model/prompt`` answers 202
// with the record ``thinking``; the client asks for it about once a second
// until its status changes. No streaming.
import { useEffect } from 'react'
import { api } from '../../api/client'
import { POLLED, useModel } from '../store'
import { usePanel } from './state'

export const POLL_MS = 1000

/** Failed polls in a row before the panel says so and waits for "Erneut versuchen". */
const MAX_FAILURES = 3

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
        if (stopped || usePanel.getState().aborting === id) return
        failures = 0
        received(view)
        if (POLLED.includes(view.status)) timer = setTimeout(tick, POLL_MS)
      } catch (error) {
        if (stopped) return
        failures += 1
        if (failures >= MAX_FAILURES) usePanel.setState({ pollError: { id, error } })
        else timer = setTimeout(tick, POLL_MS)
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
