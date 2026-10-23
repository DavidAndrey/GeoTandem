// A window closed while the model works (plan WP82, F-5.18): the running record
// is aborted on the way out, so the server neither keeps a call nor runs a
// chain for a workplace that is gone. ``keepalive`` lets the request outlive the
// page. A page kept for the back button (``persisted``) is not gone: it polls
// again when it comes back. Should the request not arrive, the server closes
// the record itself once its time is up (``close_stale``, ``fail_thinking``).
import { api } from '../../api/client'
import { useModel } from '../store'

/** Listens for the page going away; returns the function that stops listening. */
export function abortOnClose(): () => void {
  const pagehide = (event: PageTransitionEvent) => {
    if (event.persisted) return
    const running = useModel.getState().running
    if (running) api.model.abort(running.id, true).catch(() => undefined)
  }
  window.addEventListener('pagehide', pagehide)
  return () => window.removeEventListener('pagehide', pagehide)
}
