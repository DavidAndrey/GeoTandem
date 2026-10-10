// Modus B in the workplace (plan WP66): the prompt panel, the request that is
// running and the dialogue, beside the analysis store. Server state stays in
// the action records; this holds what the open workplace shows of them.
//
// Flüchtig (plan D8, design Q3): nothing here is persisted or part of a saved
// session; after a reload the dialogue is empty. The durable trace is the log.
// The server builds the model's turns from the parent chain (P6), so the
// dialogue is only a list of the records this workplace has seen.
import { create } from 'zustand'
import type { ActionStatus, ModelActionView } from '../api/client'

export type Approach = ModelActionView['approach']

/** Statuses during which the client polls the record (P4, P7). */
export const POLLED: readonly ActionStatus[] = ['thinking', 'running']

/** Statuses after which the record is an answer a follow-up can refer to (M11.1). */
const ANSWERED: readonly ActionStatus[] = [
  'answered',
  'proposed',
  'approved',
  'running',
  'done',
  'limited',
  'applied',
]

/** Requests that ended without an answer keep the prompt in the field (M14). */
const KEEPS_PROMPT: readonly ActionStatus[] = ['failed', 'aborted']

export interface ModelState {
  /** The prompt panel (design M1). */
  open: boolean
  /** The prompt text in the field. */
  draft: string
  /** Direktabfrage | Werkzeugkette, chosen per request (F-5.4). */
  approach: Approach
  /** The record being polled: while the model thinks or a chain runs (P7). */
  running: { id: number; status: ActionStatus } | null
  /** Action ids, oldest first. */
  dialogue: number[]
  /** The latest view of each record in the dialogue. */
  views: Record<number, ModelActionView>
  /** At most one open proposal (design M5.2). */
  proposal: number | null
  /** The answer a follow-up prompt refers to; ``null`` = fresh question (P6, M11.1 ×). */
  reference: number | null
}

export const initialModel = (): ModelState => ({
  open: false,
  draft: '',
  approach: 'direct',
  running: null,
  dialogue: [],
  views: {},
  proposal: null,
  reference: null,
})

/**
 * A prompt was accepted (``POST /api/model/prompt`` answered 202 with the record
 * in ``thinking``). The server supersedes the open proposal (plan WP65); its
 * record is shown so at once, the next poll of it says the same.
 */
export function sent(state: ModelState, view: ModelActionView): ModelState {
  const previous = state.proposal !== null ? state.views[state.proposal] : undefined
  const views = { ...state.views, [view.id]: view }
  if (previous && previous.id !== view.id)
    views[previous.id] = { ...previous, status: 'superseded' }
  return {
    ...state,
    views,
    dialogue: state.dialogue.includes(view.id) ? state.dialogue : [...state.dialogue, view.id],
    running: POLLED.includes(view.status) ? { id: view.id, status: view.status } : null,
    proposal: view.status === 'proposed' ? view.id : null,
  }
}

/** A newer view of a record (a poll, or the answer of a decision). */
export function received(state: ModelState, view: ModelActionView): ModelState {
  if (!state.dialogue.includes(view.id)) return state
  const views = { ...state.views, [view.id]: view }
  const polled = POLLED.includes(view.status)
  const wasRunning = state.running?.id === view.id
  // The model has answered the prompt (not: a chain run has ended).
  const answered = wasRunning && state.running?.status === 'thinking' && !polled
  const proposal =
    view.status === 'proposed' ? view.id : state.proposal === view.id ? null : state.proposal
  return {
    ...state,
    views,
    running: polled ? { id: view.id, status: view.status } : wasRunning ? null : state.running,
    proposal,
    reference: answered && ANSWERED.includes(view.status) ? view.id : state.reference,
    draft: answered && !KEEPS_PROMPT.includes(view.status) ? '' : state.draft,
  }
}

/** "Verlauf leeren": the dialogue goes, a request still running stays. */
export function cleared(state: ModelState): ModelState {
  const running = state.running ? state.views[state.running.id] : undefined
  return {
    ...state,
    dialogue: running ? [running.id] : [],
    views: running ? { [running.id]: running } : {},
    proposal: null,
    reference: null,
  }
}

/** The dialogue's records, oldest first. */
export const dialogueViews = (state: ModelState): ModelActionView[] =>
  state.dialogue.flatMap((id) => {
    const view = state.views[id]
    return view ? [view] : []
  })

interface ModelStore extends ModelState {
  setOpen: (open: boolean) => void
  setDraft: (draft: string) => void
  setApproach: (approach: Approach) => void
  sent: (view: ModelActionView) => void
  received: (view: ModelActionView) => void
  /** A parent action id, or ``null`` for "ohne Bezug" (M11.1 ×). */
  setReference: (id: number | null) => void
  clearDialogue: () => void
  reset: () => void
}

export const useModel = create<ModelStore>()((set) => ({
  ...initialModel(),
  setOpen: (open) => set({ open }),
  setDraft: (draft) => set({ draft }),
  setApproach: (approach) => set({ approach }),
  sent: (view) => set((s) => sent(s, view)),
  received: (view) => set((s) => received(s, view)),
  setReference: (reference) =>
    set((s) => (reference === null || s.dialogue.includes(reference) ? { reference } : s)),
  clearDialogue: () => set(cleared),
  reset: () => set(initialModel()),
}))
