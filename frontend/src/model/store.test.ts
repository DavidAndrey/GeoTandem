// The model slice (plan WP66): request flow by polling (P7), at most one open
// proposal, the follow-up reference (P6), and a dialogue that is never kept (D8).
import { beforeEach, expect, test } from 'vitest'
import type { ModelActionView } from '../api/client'
import { actionView, thinkingView } from '../test/model-mocks'
import { cleared, dialogueViews, initialModel, received, sent, useModel } from './store'

const store = () => useModel.getState()

beforeEach(() => {
  store().reset()
  localStorage.clear()
  sessionStorage.clear()
})

/** A second record of the same case, as a follow-up would create. */
const again = (view: ModelActionView, id: number): ModelActionView => ({ ...view, id })

test('a prompt runs while the model thinks; the answer ends the run and becomes the reference', () => {
  store().setDraft('Welche Primarschulen liegen nahe an Kantonsstrassen?')
  const thinking = thinkingView('reference')
  store().sent(thinking)
  expect(store().running).toEqual({ id: thinking.id, status: 'thinking' })
  expect(store().dialogue).toEqual([thinking.id])
  // The field keeps the prompt (locked) until the answer is there (M2.1).
  expect(store().draft).not.toBe('')

  const answer = actionView('reference')
  store().received(answer)
  expect(store().running).toBeNull()
  expect(store().proposal).toBe(answer.id)
  expect(store().reference).toBe(answer.id)
  expect(store().draft).toBe('')
  expect(dialogueViews(store())).toEqual([answer])
})

test.each(['unreachable', 'aborted'] as const)(
  'a request that ends %s keeps the prompt and the previous reference (M14)',
  (id) => {
    store().sent(thinkingView('clarification'))
    store().received(actionView('clarification'))
    const first = store().reference
    expect(first).toBe(actionView('clarification').id)
    store().setDraft('Und im Umkreis von 1 km?')
    store().sent(thinkingView(id))
    store().received(actionView(id))
    expect(store().running).toBeNull()
    expect(store().draft).toBe('Und im Umkreis von 1 km?')
    expect(store().reference).toBe(first)
  },
)

test('a refusal is no reference, but the prompt leaves the field (M3: "Prompt ändern" brings it back)', () => {
  store().setDraft('Kitas nahe Primarschulen')
  store().sent(thinkingView('unknown_layer'))
  store().received(actionView('unknown_layer'))
  expect(store().reference).toBeNull()
  expect(store().draft).toBe('')
})

test('at most one open proposal: a new prompt supersedes the open one (M5.2)', () => {
  const first = actionView('reference')
  store().sent(thinkingView('reference'))
  store().received(first)
  expect(store().proposal).toBe(first.id)

  const next = again(thinkingView('follow_up'), 50)
  store().sent(next)
  expect(store().proposal).toBeNull()
  expect(store().views[first.id]?.status).toBe('superseded')

  store().received(again(actionView('follow_up'), 50))
  expect(store().proposal).toBe(50)
  expect(dialogueViews(store()).map((v) => v.status)).toEqual(['superseded', 'proposed'])

  // A decision closes the proposal; the reference stays on the answer.
  store().received(again(actionView('follow_up', { status: 'rejected', decision: 'rejected' }), 50))
  expect(store().proposal).toBeNull()
  expect(store().reference).toBe(50)
})

test('a chain run is polled too, and its end does not touch the field', () => {
  const plan = actionView('chain_reference')
  store().sent(thinkingView('chain_reference'))
  store().received(plan)
  store().setDraft('Und nur grosse Schulen?')
  store().received({ ...plan, status: 'running' })
  expect(store().running).toEqual({ id: plan.id, status: 'running' })
  store().received({ ...plan, status: 'done' })
  expect(store().running).toBeNull()
  expect(store().draft).toBe('Und nur grosse Schulen?')
})

test('records outside the dialogue are ignored', () => {
  const state = received(initialModel(), actionView('reference'))
  expect(state).toEqual(initialModel())
})

test('the reference: × means no reference; only answers in the dialogue can be one (M11.1)', () => {
  store().sent(thinkingView('reference'))
  store().received(actionView('reference'))
  const id = store().reference
  store().setReference(null)
  expect(store().reference).toBeNull()
  store().setReference(999)
  expect(store().reference).toBeNull()
  store().setReference(id)
  expect(store().reference).toBe(id)
})

test('"Verlauf leeren" keeps a request still running', () => {
  store().sent(thinkingView('reference'))
  store().received(actionView('reference'))
  const running = again(thinkingView('follow_up'), 60)
  store().sent(running)
  store().clearDialogue()
  expect(store().dialogue).toEqual([60])
  expect(store().proposal).toBeNull()
  expect(store().reference).toBeNull()
  expect(cleared(initialModel())).toEqual(initialModel())
})

test('panel, field and approach', () => {
  store().setOpen(true)
  store().setApproach('chain')
  store().setDraft('x')
  expect([store().open, store().approach, store().draft]).toEqual([true, 'chain', 'x'])
})

test('flüchtig (D8): nothing is stored in the browser, a new store starts empty', () => {
  const state = sent(initialModel(), thinkingView('reference'))
  store().sent(thinkingView('reference'))
  store().received(actionView('reference'))
  expect(state.dialogue).toHaveLength(1)
  expect(localStorage.length + sessionStorage.length).toBe(0)
  store().reset()
  expect(store().dialogue).toEqual([])
})
