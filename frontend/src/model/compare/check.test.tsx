// The chain's check of a direct answer (plan-check-mode) on the client: the
// mark under the answer, a check waiting with its plan as a side with a
// result, and *Vergleich ansehen*, which brings the check into the dialogue
// as a repeat and opens its comparison, the request polled left as it is.
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ModelActionView } from '../../api/client'
import { actionView, repeatView } from '../../test/model-mocks'
import { resetStores } from '../../test/prompt-panel'
import { fakeApi, renderAt } from '../../test/render'
import { sent, useModel } from '../store'
import { CheckNote } from './Check'
import { shown } from './checked'
import { comparisonRefusal, hasResult, useComparison } from './flow'

beforeEach(resetStores)
afterEach(() => vi.unstubAllGlobals())

const direct = (check: ModelActionView['check']): ModelActionView =>
  actionView('reference', { check })

/** The check of ``answer``: the reference chain's plan, waiting, never run. */
const checkOf = (answer: ModelActionView): ModelActionView => ({
  ...repeatView(answer, 'chain_reference'),
  id: answer.id + 50,
  is_check: true,
  status: 'proposed',
  query: null,
})

function showAnswer(view: ModelActionView) {
  useModel.setState((s) => sent(s, view))
  renderAt('/', <CheckNote view={view} />)
}

describe('the mark', () => {
  test('same: the count, quietly', () => {
    showAnswer(direct({ state: 'same', action_id: 9, direct_hits: 10, chain_hits: 10 }))
    expect(screen.getByText(/dieselben 10 Objekte/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('differs: unsicher with both counts and the comparison', () => {
    showAnswer(direct({ state: 'differs', action_id: 9, direct_hits: 10, chain_hits: 12 }))
    expect(screen.getByText(/findet 12 statt 10 Objekte/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Vergleich ansehen' })).toBeTruthy()
  })

  test('running and not checked say so', async () => {
    showAnswer(direct({ state: 'running', action_id: null }))
    expect(screen.getByText(/Werkzeugkette geprüft/)).toBeTruthy()
    useModel.setState((s) => ({
      views: {
        ...s.views,
        [actionView('reference').id]: direct({ state: 'not_checked', action_id: null }),
      },
    }))
    expect(await screen.findByText('Nicht geprüft.')).toBeTruthy()
  })

  test('an answer without a check has no mark', () => {
    const { container } = renderAt('/', <CheckNote view={direct(null)} />)
    expect(container.textContent).toBe('')
  })
})

describe('the comparison of a check', () => {
  test('a check waiting with its plan is a side with a result, as the server compares it', () => {
    const answer = direct({ state: 'differs', action_id: 1, direct_hits: 10, chain_hits: 12 })
    const check = checkOf(answer)
    expect(hasResult(check)).toBe(true)
    expect(hasResult({ ...check, is_check: false })).toBe(false)
    expect(hasResult({ ...check, steps: [] })).toBe(false)
    const state = shown(useModel.getState(), check)
    expect(
      comparisonRefusal({ ...state, views: { ...state.views, [answer.id]: answer } }, check),
    ).toBeNull()
  })

  test('Vergleich ansehen brings the check in and opens it; the request polled stays', async () => {
    const answer = direct(null)
    const check = checkOf(answer)
    const marked = {
      ...answer,
      check: { state: 'differs' as const, action_id: check.id, direct_hits: 10, chain_hits: 12 },
    }
    const calls = fakeApi({ [`GET /api/model/actions/${check.id}`]: check })
    useModel.setState((s) => sent(s, marked))
    useModel.setState({ running: { id: 777, status: 'thinking' } })
    renderAt('/', <CheckNote view={marked} />)

    await userEvent.click(screen.getByRole('button', { name: 'Vergleich ansehen' }))

    expect(calls.map((c) => c.key)).toEqual([`GET /api/model/actions/${check.id}`])
    const state = useModel.getState()
    expect(state.dialogue).toContain(check.id)
    expect(state.running).toEqual({ id: 777, status: 'thinking' })
    expect(useComparison.getState().shown).toBe(check.id)
  })
})
