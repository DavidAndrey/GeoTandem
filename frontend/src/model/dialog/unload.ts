// A window closed while a tool chain runs (plan WP82, F-5.18): the chain is
// stopped on the way out, so the server runs no further steps for a workplace
// that is gone; its last complete result stays adoptable from the log (P4).
// ``keepalive`` lets the request outlive the page. A page kept for the back
// button (``persisted``) is not gone: it polls again when it comes back.
//
// A prompt the model is still thinking about is left alone: ``pagehide`` fires
// on a reload too, and after a reload the next prompt finds it and shows it
// (P7, ``stillRunning`` in panel/state.ts), which an abort would break. It costs at most the model
// call's time (120 s); a record nobody collects is closed by the server
// (``close_stale``, ``fail_thinking``).
import { api } from '../../api/client'
import { useModel } from '../store'

/** Listens for the page going away; returns the function that stops listening. */
export function abortOnClose(): () => void {
  const pagehide = (event: PageTransitionEvent) => {
    if (event.persisted) return
    const running = useModel.getState().running
    if (running?.status === 'running') api.model.abort(running.id, true).catch(() => undefined)
  }
  window.addEventListener('pagehide', pagehide)
  return () => window.removeEventListener('pagehide', pagehide)
}
