// WP82: a window closed while the model works aborts the running record.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resetModelState } from '../reset'
import { useModel } from '../store'
import { abortOnClose } from './unload'

let stop = () => {}
beforeEach(() => {
  resetModelState()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
  stop = abortOnClose()
})
afterEach(() => {
  stop()
  vi.restoreAllMocks()
})

const leave = (persisted: boolean) => {
  const event = new Event('pagehide')
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

test('a running chain is stopped on the way out, the request outliving the page', () => {
  useModel.setState({ running: { id: 7, status: 'running' } })
  leave(false)
  expect(fetch).toHaveBeenCalledWith(
    '/api/model/actions/7/abort',
    expect.objectContaining({ method: 'POST', keepalive: true }),
  )
})

test('nothing running, a page kept for the back button, or a prompt still thinking: nothing is sent', () => {
  leave(false)
  useModel.setState({ running: { id: 7, status: 'running' } })
  leave(true)
  // A reload fires pagehide too, and picks a thinking prompt up again (P7).
  useModel.setState({ running: { id: 8, status: 'thinking' } })
  leave(false)
  expect(fetch).not.toHaveBeenCalled()
})
