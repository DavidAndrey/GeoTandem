// The prompt panel's own transient state (plan WP67): a request on its way,
// a request the server refused before writing a record, when each request
// started on this clock, and an abort under way. The records themselves live
// in the model slice (model/store.ts); nothing here is saved (D8).
import { create } from 'zustand'
import { resultQuery } from '../../analysis/query'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import { api, type PromptRequest } from '../../api/client'
import { useModel, type Approach } from '../store'

/** The prompt field, for actions that hand it the focus ("Prompt ändern"). */
export const PROMPT_INPUT = 'prompt-input'

/** The Prompt tab: Esc in the panel gives the focus back to it. */
export const PROMPT_TAB = '[data-tab="prompt"]'

/** Seconds of one model call before the server gives up (plan section 1, limits). */
export const MODEL_CALL_S = 120

/** A request refused before any record exists (quota, context, stale reference, transport). */
export interface Failure {
  prompt: string
  approach: Approach
  parent: number | null
  error: unknown
}

interface PanelState {
  /** ``POST /api/model/prompt`` is on its way. */
  sending: boolean
  failure: Failure | null
  /** When each request was sent, on this clock: the timer of M2.1. */
  started: Record<number, number>
  /** The record an abort is under way for; its polls are ignored meanwhile. */
  aborting: number | null
  abortError: unknown
  /** Polling the record kept failing (poll.ts). */
  pollError: { id: number; error: unknown } | null
  pollRound: number
}

export const usePanel = create<PanelState>()(() => ({
  sending: false,
  failure: null,
  started: {},
  aborting: null,
  abortError: null,
  pollError: null,
  pollRound: 0,
}))

/** A fresh workplace (and the tests' starting point). */
export const resetPanel = () =>
  usePanel.setState({
    sending: false,
    failure: null,
    started: {},
    aborting: null,
    abortError: null,
    pollError: null,
  })

export const focusPrompt = () => document.getElementById(PROMPT_INPUT)?.focus()

/**
 * Sends a prompt. ``parent`` names the answer it follows (P6): only the reply
 * to a clarification does so in E2.3 (M12.2); the reference mark of M11 and
 * with it follow-ups on any answer arrive with E2.6 (WP81).
 */
export async function send(text: string, approach: Approach, parent: number | null = null) {
  const prompt = text.trim()
  if (!prompt || usePanel.getState().sending || useModel.getState().running) return
  usePanel.setState({ sending: true, failure: null })
  const body: PromptRequest =
    parent === null
      ? { text: prompt, approach }
      : {
          text: prompt,
          approach,
          parent_action_id: parent,
          analysis: resultQuery(currentAnalysis(useAnalysis.getState())),
        }
  try {
    const view = await api.model.prompt(body)
    usePanel.setState((s) => ({ sending: false, started: { ...s.started, [view.id]: Date.now() } }))
    useModel.getState().sent(view)
  } catch (error) {
    usePanel.setState({ sending: false, failure: { prompt, approach, parent, error } })
  }
}

/**
 * Puts a prompt back in the field, never sending it: "Prompt ändern" (M3),
 * and with ``approach`` the offer of the other way of working (M13.1, D6).
 */
export function prefill(text: string, approach?: Approach) {
  const model = useModel.getState()
  model.setDraft(text)
  if (approach) model.setApproach(approach)
  focusPrompt()
}

/** "Abbrechen" while the model thinks (M2.1, P7). */
export async function abort(id: number) {
  usePanel.setState({ aborting: id, abortError: null })
  const { received } = useModel.getState()
  try {
    received(await api.model.abort(id))
  } catch (error) {
    // The answer may have come first; the record says what happened.
    try {
      received(await api.model.action(id))
    } catch {
      // Neither answered: say so, and poll on (a new round) so the record still
      // arrives; "Erneut nachfragen" restarts it by hand.
      usePanel.setState((s) => ({
        abortError: error,
        pollError: { id, error },
        pollRound: s.pollRound + 1,
      }))
    }
  } finally {
    usePanel.setState({ aborting: null })
  }
}

/** "Verlauf leeren": the dialogue and a refused request go; a running request stays. */
export function clearHistory() {
  useModel.getState().clearDialogue()
  usePanel.setState({ failure: null })
}
