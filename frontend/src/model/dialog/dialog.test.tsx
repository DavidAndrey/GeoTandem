// The dialogue's reference (plan WP81, P6, D8; design M11): the next prompt
// follows the latest answer with the analysis as it is, the mark above the
// field says which state that is, × asks without it, an answer whose layer is
// gone is stale and no reference, and a saved session holds no dialogue.
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import type { ModelActionView } from '../../api/client'
import { saveSessionAs } from '../../session/actions'
import { actionView, thinkingView } from '../../test/model-mocks'
import {
  ask,
  backend,
  done,
  fakeTimers,
  json,
  LAYERS,
  openPanel,
  promptFlow,
  resetStores,
  thinking,
  tick,
} from '../../test/prompt-panel'
import { proposalDraft } from '../panel/draft'
import { useModel } from '../store'
import { queryLayers, referenceKind, staleLayer } from './reference'

beforeEach(resetStores)
afterEach(() => {
  done()
  cleanup()
})

const posts = (calls: { key: string; body: unknown }[]) =>
  calls.filter((c) => c.key === 'POST /api/model/prompt').map((c) => c.body)

/** The reference question answered, under *Prüfen* a proposal; ``routes`` added. */
async function answered(answer: ModelActionView = actionView('reference'), routes = {}) {
  const user = fakeTimers()
  const calls = backend({ ...promptFlow(thinkingView('reference'), answer), ...routes })
  await openPanel()
  await ask(user, answer.prompt)
  await thinking()
  await tick()
  await screen.findByRole('article', { name: 'Antwort' })
  return { user, calls, answer }
}

describe('reference kind and stale layers', () => {
  const view = actionView('reference')
  const applied = () => {
    const draft = proposalDraft(view.query, view.id, LAYERS)
    if (!draft) throw new Error('the reference question is representable')
    return { ...currentAnalysis(useAnalysis.getState()), tree: draft.tree }
  }

  test('the analysis as the answer left it is the last answer, changed it is the current one (M11.2)', () => {
    expect(referenceKind(view, applied())).toBe('last_answer')
    const changed = applied()
    expect(
      referenceKind(view, {
        ...changed,
        tree: { ...changed.tree, children: changed.tree.children.slice(1) },
      }),
    ).toBe('current')
    // Nothing applied yet: the analysis is not the answer's.
    expect(referenceKind(view, currentAnalysis(useAnalysis.getState()))).toBe('current')
  })

  test('"Nur in" is the user\'s and does not change the reference', () => {
    const restricted = {
      ...applied(),
      restriction: {
        kind: 'view' as const,
        bbox: [7.3, 46.8, 7.6, 47] as [number, number, number, number],
      },
    }
    expect(referenceKind(view, restricted)).toBe('last_answer')
  })

  test('the layers of a query and the first one the catalog lacks (M11.3)', () => {
    expect(queryLayers(view.query).sort()).toEqual(['gemeinden_steuern', 'schulen', 'strassen'])
    expect(staleLayer(view, ['schulen', 'strassen', 'gemeinden_steuern'])).toBeNull()
    expect(staleLayer(view, ['schulen', 'strassen'])).toBe('gemeinden_steuern')
    expect(staleLayer(actionView('clarification'), [])).toBeNull()
  })
})

describe('M11.1 the reference above the field', () => {
  test('the next prompt follows the latest answer, with the analysis as it is', async () => {
    const { user, calls, answer } = await answered()
    const mark = await screen.findByText(/^Bezug: aktuelle Analyse · 137 von 137/)
    expect(mark).toBeInTheDocument()

    await ask(user, 'Welche davon haben mehr als einen Standort?')
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
    expect(posts(calls)[1]).toMatchObject({
      text: 'Welche davon haben mehr als einen Standort?',
      parent_action_id: answer.id,
      analysis: { source: 'schulen' },
    })
  })

  test('× asks without reference: no parent, no analysis', async () => {
    const { user, calls } = await answered()
    await user.click(await screen.findByRole('button', { name: 'Ohne Bezug fragen' }))
    expect(screen.queryByText(/^Bezug:/)).toBeNull()
    expect(useModel.getState().reference).toBeNull()

    await ask(user, 'Wie viele Schulen gibt es?')
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
    expect(posts(calls)[1]).toEqual({ text: 'Wie viele Schulen gibt es?', approach: 'direct' })
  })
})

describe('M11.2 changed by hand since', () => {
  test('an applied answer the user touched says so, and the reference is the current state', async () => {
    await answered(
      actionView('reference', {
        status: 'applied',
        decision: 'accepted',
        touched_at: '2026-10-23T12:01:00Z',
      }),
    )
    const card = screen.getByRole('article', { name: 'Antwort' })
    expect(card).toHaveTextContent('danach von Hand geändert')
    expect(await screen.findByText(/^Bezug: aktuelle Analyse/)).toBeInTheDocument()
  })
})

describe('M11.3 a stale answer', () => {
  const applied = () => actionView('reference', { status: 'applied', decision: 'accepted' })
  const without = LAYERS.filter((layer) => layer.name !== 'gemeinden_steuern')

  test('its layer gone, it is stale, offers a fresh prompt and is no reference', async () => {
    const { user, calls, answer } = await answered(applied(), { 'GET /api/layers': without })
    const card = screen.getByRole('article', { name: 'Antwort' })
    expect(card).toHaveTextContent('veraltet')
    expect(card).toHaveTextContent('nicht mehr anwendbar')
    expect(card).toHaveTextContent('„gemeinden_steuern“, den es nicht mehr gibt')
    expect(within(card).queryByRole('button', { name: /Editor/ })).toBeNull()
    expect(screen.queryByText(/^Bezug:/)).toBeNull()

    await user.click(within(card).getByRole('button', { name: 'Prompt erneut senden' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
    expect(posts(calls)[1]).toEqual({ text: answer.prompt, approach: 'direct' })
  })

  test('a layer withdrawn from the model is gone for it too, as the server checks', async () => {
    const withdrawn = LAYERS.map((layer) =>
      layer.name === 'gemeinden_steuern' ? { ...layer, for_model: false } : layer,
    )
    await answered(applied(), { 'GET /api/layers': withdrawn })
    expect(screen.getByRole('article', { name: 'Antwort' })).toHaveTextContent('veraltet')
  })

  test('an open proposal keeps its card and controls, but is no reference', async () => {
    await answered(actionView('reference'), { 'GET /api/layers': without })
    const card = screen.getByRole('article', { name: 'Antwort' })
    expect(card).not.toHaveTextContent('nicht mehr anwendbar')
    expect(within(card).getAllByRole('button').length).toBeGreaterThan(0)
    expect(screen.queryByText(/^Bezug:/)).toBeNull()
  })
})

describe('D8 the dialogue is not saved', () => {
  test('a saved session holds nothing of the dialogue', async () => {
    const { calls, answer } = await answered(actionView('reference'), {
      'POST /api/sessions': () =>
        json(
          {
            id: 's1',
            name: 'Mit Verlauf',
            note: '',
            updated_at: '2026-10-23T12:00:00Z',
            stamp: null,
            state_version: 1,
            state: {},
          },
          201,
        ),
    })
    expect(useModel.getState().dialogue).toEqual([answer.id])
    await saveSessionAs('Mit Verlauf', '')
    const saved = calls.find((c) => c.key === 'POST /api/sessions')
    const body = JSON.stringify(saved?.body)
    expect(body).not.toContain(answer.prompt)
    expect(body).not.toContain('"action')
    expect(body).not.toContain('dialogue')
  })
})
