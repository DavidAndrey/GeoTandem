// Sign-out and sign-in of another account in the same window, no reload
// (security review, gate E2.4): the next account sees nothing of the last
// one's Modus B, and a run of the last one parked for the editor never lands
// in the next one's analysis.
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { App } from '../App'
import { useAnalysis } from '../analysis/store'
import { rows } from '../analysis/tree'
import type { Account } from '../api/client'
import { account } from '../test/fixtures'
import { actionView, isFakeError, modelServer, thinkingView } from '../test/model-mocks'
import {
  ask,
  backend,
  done,
  fakeTimers,
  json,
  llmOptions,
  promptFlow,
  resetStores,
  thinking,
  tick,
} from '../test/prompt-panel'
import { renderAt } from '../test/render'
import { useApproval } from './approval/flow'
import { useMyActionsDialog } from './log/dialog'
import { useHandover } from './panel/handover'
import { usePanel } from './panel/state'
import { useModel } from './store'

beforeEach(resetStores)
afterEach(done)

const A = account({ id: 1, username: 'a.anders', display_name: 'A. Anders', role: 'admin' })
const B = account({ id: 2, username: 'b.berger', display_name: 'B. Berger', role: 'user' })

test("B signs in after A signed out: nothing of A's Modus B, A's parked run never lands", async () => {
  const user = fakeTimers()
  let me: Account | null = A
  // An auto answer (Teilautonom): its run answers while A has the editor open, so it is parked.
  const answer = actionView('reference', {}, 'Teilautonom')
  const server = modelServer([answer])
  const calls = backend(
    {
      'GET /api/auth/me': () =>
        me
          ? json(me)
          : json({ code: 'not_authenticated', message: 'Please sign in.', details: {} }, 401),
      ...promptFlow(thinkingView('reference', 'Teilautonom'), answer),
      [`POST /api/model/actions/${answer.id}/execute`]: () => {
        useAnalysis.getState().edit()
        const response = server.execute(answer.id)
        return isFakeError(response) ? json(response.body, response.status) : json(response)
      },
      'POST /api/auth/logout': () => {
        me = null
        return new Response(null, { status: 204 })
      },
      'POST /api/auth/login': () => {
        me = B
        return json(B)
      },
    },
    llmOptions(1, 3),
  )
  useModel.getState().setOpen(true)
  renderAt('/', <App />)
  await waitFor(() => expect(document.getElementById('prompt-panel')).not.toBeNull())
  await ask(user, answer.prompt)
  await thinking()
  await tick()
  await waitFor(() => expect(useApproval.getState().parked).toEqual({ [answer.id]: 'execute' }))
  expect(useModel.getState().dialogue).toEqual([answer.id])
  expect(rows(useAnalysis.getState().tree)).toEqual([])

  // A signs out; the open editor is unsaved work, discarded.
  await user.click(screen.getByRole('button', { name: 'Benutzermenü' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Abmelden' }))
  const unsaved = await screen.findByRole('alertdialog', { name: 'Ungespeicherte Änderungen' })
  await user.click(within(unsaved).getByRole('button', { name: 'Verwerfen' }))
  await screen.findByLabelText('Benutzername')

  // B signs in, in the same window.
  await user.type(screen.getByLabelText('Benutzername'), B.username)
  await user.type(screen.getByLabelText('Passwort'), 'b-passwort-lang-genug')
  await user.click(screen.getByRole('button', { name: 'Anmelden' }))
  await screen.findByRole('button', { name: 'Benutzermenü' })
  await tick()

  // Nothing of A's: dialogue, records, the change and its snapshot, the panel.
  expect(useModel.getState()).toMatchObject({
    dialogue: [],
    views: {},
    running: null,
    pending: null,
    reference: null,
    draft: '',
  })
  expect(useApproval.getState()).toMatchObject({
    last: null,
    baselines: {},
    parked: {},
    restored: {},
    started: {},
    busy: null,
    failure: null,
  })
  expect(useHandover.getState()).toEqual({ open: null, failed: null })
  expect(usePanel.getState()).toMatchObject({ sending: false, failure: null, started: {} })
  expect(useMyActionsDialog.getState().open).toBe(false)
  // A's run never applies to B's analysis, not even when B's editor closes.
  expect(rows(useAnalysis.getState().tree)).toEqual([])
  act(() => useAnalysis.getState().edit())
  act(() => useAnalysis.getState().discard())
  await tick()
  expect(rows(useAnalysis.getState().tree)).toEqual([])
  expect(useAnalysis.getState().origin.marks).toEqual({})
  expect(screen.queryByRole('complementary', { name: 'Modell hat angewendet' })).toBeNull()
  // The prompt panel shows B no answer.
  await user.click(screen.getByRole('tab', { name: 'Prompt' }))
  await waitFor(() => expect(document.getElementById('prompt-panel')).not.toBeNull())
  expect(document.querySelectorAll('#prompt-panel article')).toHaveLength(0)
  // A's one run is all that ran.
  expect(calls.filter((c) => /\/(execute|undo|touched|decide)$/.test(c.key))).toHaveLength(1)
})
