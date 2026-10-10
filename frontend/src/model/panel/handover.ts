// "In Editor übernehmen" (design M4.1 → M4.2, plan P1): the proposal opens as
// the editor's draft (B2) in place of the panel. Nothing changes the analysis
// until the editor's own "Übernehmen" does, as the user's act; that is then
// reported with ``decide``. "Verwerfen" puts everything back as it was and
// reports nothing: the proposal stays open in the dialogue.
//
// The applied query is the model's query exactly (P1, D2, F-5.16): the result
// layer becomes the proposal's, and a "Nur in" restriction of the analysis is
// set aside while the proposal is in the editor (the notice says so); it comes
// back on "Verwerfen".
//
// Decision (plan section 2): ``proposal_only`` with ``applied_by_hand`` if the
// draft went in as proposed, ``adjusted`` with the applied query (and without
// ``applied_by_hand``, which belongs to ``proposal_only``) if it did not.
// "As proposed" needs both: every proposed row kept its mark "Modell" (P3; a
// value changed and changed back counts as an edit, as it does for the mark
// the user sees), and the applied query object equals the proposed one in
// canonical form (catches rows added, UND/ODER switched, another result layer).
import { create } from 'zustand'
import type { Group, Restriction } from '../../analysis/model'
import { canBeResult, resultQuery } from '../../analysis/query'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import { rows } from '../../analysis/tree'
import { api, type DecideRequest, type ModelActionView } from '../../api/client'
import { useMapView } from '../../map/view'
import { compactQuery } from '../readable'
import { useModel } from '../store'
import { assumptionRow, proposalDraft } from './draft'

export interface Handover {
  action: number
  /** When the proposal was made, for "Entwurf aus Vorschlag 14:05". */
  at: string
  /** The query the model proposed, as the record holds it. */
  query: unknown
  proposal: Group
  result: string
  /** What "Verwerfen" puts back. */
  before: {
    result: string | null
    restriction: Restriction
    dirty: boolean
    /** The result layer was added for the proposal. */
    added: boolean
  }
}

interface HandoverState {
  /** A proposal in the editor, not yet applied. */
  open: Handover | null
  /** A decision the server did not take; the analysis has it already. */
  failed: { action: number; body: DecideRequest; error: unknown } | null
}

export const useHandover = create<HandoverState>()(() => ({ open: null, failed: null }))

/**
 * Whether the editor can take the proposal: representable (D3; the server
 * refuses the others), and not already applied with its decision still to be
 * reported (a retry, not a second take-over).
 */
export const canTakeOver = (view: ModelActionView) =>
  view.status === 'proposed' &&
  useHandover.getState().failed?.action !== view.id &&
  proposalDraft(view.query, view.id) !== null

/**
 * Opens the proposal in the editor, its rows marked "Modell", ``row`` (an
 * assumption's condition, M12.1) active. Returns whether it could.
 */
export function takeOver(view: ModelActionView, row: string | null = null): boolean {
  const draft = proposalDraft(view.query, view.id)
  const analysis = useAnalysis.getState()
  if (!draft || !canTakeOver(view) || analysis.draft !== null) return false
  const shown = analysis.layers.find((l) => l.id === draft.result)
  if (shown && !canBeResult(shown)) return false
  const before = {
    result: analysis.result,
    restriction: analysis.restriction,
    dirty: analysis.dirty,
    added: !shown,
  }
  if (!shown) analysis.addLayer(draft.result, true)
  // Result layer and restriction are not part of a draft: set here, put back by
  // "Verwerfen" (watchHandover).
  useAnalysis.setState({ result: draft.result, restriction: null, draft: draft.tree })
  useAnalysis.getState().markOrigin()
  useHandover.setState({
    open: {
      action: view.id,
      at: view.created_at,
      query: view.query,
      proposal: draft.tree,
      result: draft.result,
      before,
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
  assumptionTarget(view, path) !== null && (view.status !== 'proposed' || canTakeOver(view))

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

/** JSON with sorted keys: two query objects that mean the same compare equal. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v
  return JSON.stringify(sort(value))
}

/**
 * The parts of a query object the editor decides. A layer's symbology is
 * display state the analysis adds to every query of it, ``output`` is ``map``
 * and ``schema_version`` the current one unless named, and a key that is null
 * or empty sets nothing (``compactQuery``).
 */
function decided(query: unknown): unknown {
  const compact = compactQuery(query)
  if (compact === null || typeof compact !== 'object') return compact
  const parts: Record<string, unknown> = { schema_version: '2', output: 'map', ...compact }
  delete parts.symbology
  return parts
}

type AnalysisState = ReturnType<typeof useAnalysis.getState>

/** What "Übernehmen" of the handed-over draft amounts to (see the head of this file). */
export function decisionFor(handover: Handover, applied: AnalysisState): DecideRequest {
  const query = resultQuery(currentAnalysis(applied))
  const marksKept = rows(handover.proposal).every((row) => applied.origin.marks[row.id])
  if (marksKept && canonical(decided(query)) === canonical(decided(handover.query)))
    return { decision: 'proposal_only', applied_by_hand: true }
  return { decision: 'adjusted', query }
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
 * is the draft) reports the decision; "Verwerfen" (tree and saved-query link
 * unchanged) puts back result layer, restriction and the unsaved mark; a
 * saved query or session loaded meanwhile replaced all of it and is left
 * alone. Returns the unsubscribe function.
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
    if (next.tree !== previous.tree || next.queryRef !== previous.queryRef) return
    const { before } = handover
    useAnalysis.setState((s) => ({
      result: before.result,
      restriction: before.restriction,
      dirty: before.dirty,
      layers: before.added ? s.layers.filter((l) => l.id !== handover.result) : s.layers,
    }))
  })
}
