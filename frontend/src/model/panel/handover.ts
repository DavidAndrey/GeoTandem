// "In Editor übernehmen" (design M4.1 → M4.2, plan P1): the proposal opens as
// the editor's draft (B2) in place of the panel. Nothing changes the analysis
// until the editor's own "Übernehmen" does, as the user's act; that is then
// reported with ``decide``. "Verwerfen" leaves the analysis as it was and
// reports nothing: the proposal stays open in the dialogue.
//
// Decision (plan section 2): ``proposal_only`` with ``applied_by_hand`` if the
// draft went in as proposed, ``adjusted`` with the applied query if the user
// changed it first. "Changed" is read from the touched marks (P3): a proposed
// row whose mark "Modell" did not survive "Übernehmen" was edited or removed.
// The marks cannot see a row added or an UND/ODER switched, so the condition
// and the result layer are compared as well. A value changed and changed back
// counts as an edit, as it does for the mark the user sees.
import { create } from 'zustand'
import type { DisplayLayer, Group } from '../../analysis/model'
import { canBeResult, nodeCondition, resultQuery } from '../../analysis/query'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import { rows } from '../../analysis/tree'
import { api, type DecideRequest, type ModelActionView } from '../../api/client'
import { useMapView } from '../../map/view'
import { useModel } from '../store'
import { assumptionRow, proposalDraft } from './draft'

export interface Handover {
  action: number
  /** When the proposal was made, for "Entwurf aus Vorschlag 14:05". */
  at: string
  proposal: Group
  result: string
  /** To put back on "Verwerfen": the result layer before, and whether the layer was added. */
  previousResult: string | null
  added: boolean
}

interface HandoverState {
  /** A proposal in the editor, not yet applied. */
  open: Handover | null
  /** A decision the server did not take; the analysis has it already. */
  failed: { action: number; body: DecideRequest; error: unknown } | null
}

export const useHandover = create<HandoverState>()(() => ({ open: null, failed: null }))

const catalogLayer = (layer: string): DisplayLayer => ({
  id: layer,
  source: { kind: 'catalog', layer },
  visible: true,
  opacity: 1,
  symbology: null,
})

/** Whether the editor can take the proposal (D3); the server refuses the others. */
export const canTakeOver = (view: ModelActionView) =>
  view.status === 'proposed' && proposalDraft(view.query, view.id) !== null

/**
 * Opens the proposal in the editor, its rows marked "Modell", ``row`` (an
 * assumption's condition, M12.1) active. Returns whether it could.
 */
export function takeOver(view: ModelActionView, row: string | null = null): boolean {
  const draft = proposalDraft(view.query, view.id)
  const analysis = useAnalysis.getState()
  if (!draft || analysis.draft !== null) return false
  const shown = analysis.layers.find((l) => l.id === draft.result)
  if (shown && !canBeResult(shown)) return false
  // The result layer is not part of the draft; "Verwerfen" puts it back (watchHandover).
  useAnalysis.setState((s) => ({
    layers: shown ? s.layers : [catalogLayer(draft.result), ...s.layers],
    result: draft.result,
    draft: draft.tree,
    ...(shown ? {} : { dirty: true }),
  }))
  useAnalysis.getState().markOrigin()
  useHandover.setState({
    open: {
      action: view.id,
      at: view.created_at,
      proposal: draft.tree,
      result: draft.result,
      previousResult: analysis.result,
      added: !shown,
    },
    failed: null,
  })
  useMapView.getState().setActiveRow(row)
  // "In Editor übernehmen" switches to Klassik; B2 takes the panel's place.
  useModel.getState().setOpen(false)
  return true
}

/** The row "ändern" opens (M12.1): in the proposal, or in the analysis once applied. */
function assumptionTarget(view: ModelActionView, path: readonly number[]): string | null {
  if (view.status === 'proposed') {
    const draft = proposalDraft(view.query, view.id)
    return draft && assumptionRow(path, view.id, draft.tree)
  }
  if (view.status !== 'applied') return null
  return assumptionRow(path, view.id, useAnalysis.getState().tree)
}

/** Whether an assumption's "ändern" has a condition to open. */
export const canEditAssumption = (view: ModelActionView, path: readonly number[]) =>
  assumptionTarget(view, path) !== null

/**
 * "ändern" next to an assumption (design M12.1): the condition it is about,
 * active in B2 with the focus on it. A proposal opens as the draft, as with
 * "In Editor übernehmen"; an answer already applied opens the analysis.
 */
export function editAssumption(view: ModelActionView, path: readonly number[]): boolean {
  const row = assumptionTarget(view, path)
  if (row === null) return false
  if (view.status === 'proposed') return takeOver(view, row)
  const analysis = useAnalysis.getState()
  if (analysis.draft !== null) return false
  analysis.edit()
  useMapView.getState().setActiveRow(row)
  useModel.getState().setOpen(false)
  return true
}

type AnalysisState = ReturnType<typeof useAnalysis.getState>

/** What "Übernehmen" of the handed-over draft amounts to (see the head of this file). */
export function decisionFor(handover: Handover, applied: AnalysisState): DecideRequest {
  const marksKept = rows(handover.proposal).every((row) => applied.origin.marks[row.id])
  const same =
    applied.result === handover.result &&
    JSON.stringify(nodeCondition(handover.proposal)) === JSON.stringify(nodeCondition(applied.tree))
  if (marksKept && same) return { decision: 'proposal_only', applied_by_hand: true }
  return {
    decision: 'adjusted',
    applied_by_hand: true,
    query: resultQuery(currentAnalysis(applied)),
  }
}

/** Reports a decision; a failure stays visible with "Erneut vermerken". */
export async function report(action: number, body: DecideRequest) {
  useHandover.setState({ failed: null })
  try {
    useModel.getState().received(await api.model.decide(action, body))
  } catch (error) {
    useHandover.setState({ failed: { action, body, error } })
  }
}

/**
 * Watches the editor close while a proposal is in it: "Übernehmen" (the tree
 * is the draft) reports the decision, anything else puts the result layer
 * back. Returns the unsubscribe function.
 */
export function watchHandover(): () => void {
  return useAnalysis.subscribe((next, previous) => {
    const handover = useHandover.getState().open
    if (!handover || previous.draft === null || next.draft !== null) return
    useHandover.setState({ open: null })
    if (next.tree === previous.draft) {
      void report(handover.action, decisionFor(handover, next))
      return
    }
    // Discarded; a saved query or session loaded meanwhile brings its own layer.
    if (next.result !== handover.result) return
    useAnalysis.setState((s) => ({
      result: handover.previousResult,
      layers: handover.added ? s.layers.filter((l) => l.id !== handover.result) : s.layers,
    }))
  })
}
