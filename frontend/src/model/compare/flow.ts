// The comparison on the client (design M10; plan P7, WP76, WP78). The server
// asks the model again and computes the difference; the client asks for both
// and takes a side through the record's own flow:
//
// - *Mit Werkzeugkette wiederholen* / *Mit Direktabfrage vergleichen*
//   (``repeat``): ``POST .../compare`` answers 202 with a new record
//   ``thinking`` that repeats the one compared (``compare_of``). It is a prompt
//   of the dialogue like any other, polled by the workplace (panel/poll.ts),
//   but it closes nothing: the record compared stays as it is (the server
//   passes ``supersede=False``), and the text in the field stays the user's.
// - The repeat is always stored ``proposed`` (``store.propose``), *Automatisch*
//   included: nothing of it applies before the person compared. A direct
//   repeat has its query at once; a repeated chain is a plan that is approved
//   and run in the dialogue as every chain is (model/chain/), halts included.
// - Once both sides have a result the dialog opens, once per repeat this
//   workplace asked for (``asked``); it can be opened again from the repeat's
//   card (the record compared is an earlier answer by then, one line). Opened
//   automatically because the person just asked for it and waits for it; the
//   panel is open then and the editor is not (the panel is not shown beside
//   the editor), so it interrupts no work in progress. Never where the server
//   refuses the comparison (a side with a class ``off``): the card says why.
// - A side is compared by its query alone, as the server does (``_compared``):
//   an undone or overtaken record too. The record compared may have left the
//   dialogue ("Verlauf leeren" while its repeat ran): the dialog asks for it.
// - *Diese übernehmen* (``take``) is that record's own approval: ``accept``
//   (approve, then execute) for a direct query that waits, ``execute`` for one
//   approved, ``adopt`` for a finished chain, all through approval/flow.ts, so
//   the analysis changes as there: origin marks, undo, the editor waited for.
//   The server decides ``accepted`` (a repeat is never ``auto``). The other
//   side is left as it is.
import { t } from '@lingui/core/macro'
import { create } from 'zustand'
import { api, ApiRequestError, type ModelActionView } from '../../api/client'
import { accept, adopt, canApply, execute, layerList, useApproval } from '../approval/flow'
import { classList, proposalOnly } from '../approval/governance'
import { isChain } from '../chain/steps'
import { usePanel } from '../panel/state'
import { sameGeneration, useModel, type ModelState } from '../store'
import { statusKey, statusText } from '../statusKey'

/**
 * Statuses of a record that may be repeated (``COMPARABLE`` of the server's
 * ``model/service.py``): an answer waiting or applied, a chain that ended.
 * Its query decides.
 */
export const COMPARABLE: readonly ModelActionView['status'][] = [
  'proposed',
  'approved',
  'applied',
  'done',
  'limited',
]

/** Statuses in which a record may still get a result (``PENDING`` of the server). */
const PENDING: readonly ModelActionView['status'][] = [
  'thinking',
  'proposed',
  'approved',
  'running',
]

/** Has a result to compare: a stored query, whatever the status (the server's ``_compared``). */
export const hasResult = (view: ModelActionView): boolean => view.query != null

/** The classes ``off`` at the level the record was answered under (D1). */
const offOf = (view: ModelActionView) => view.governance?.off ?? []

interface CompareState {
  /** The repeat whose comparison the dialog shows. */
  shown: number | null
  /** The repeat last shown: the focus goes back to its card when the dialog closes. */
  last: number | null
  /** Repeats this workplace asked for, until their dialog opened once. */
  asked: Record<number, true>
  /** The record a repeat is being asked for (``POST .../compare`` on its way). */
  asking: number | null
  /** A refused repeat, at the record it repeats. */
  failure: { action: number; error: unknown } | null
}

const initial = (): CompareState => ({
  shown: null,
  last: null,
  asked: {},
  asking: null,
  failure: null,
})

export const useComparison = create<CompareState>()(initial)

/** Part of ``resetModelState``: a fresh workplace, and the tests' starting point. */
export const resetComparison = () => useComparison.setState(initial())

/**
 * The repeat of ``view`` in the dialogue, if any: ``view`` itself when it is
 * one; else, as the server names the right side (``store.compared``), its
 * newest repeat with a result, else its newest.
 */
export function repeatOf(state: ModelState, view: ModelActionView): ModelActionView | null {
  if (view.compare_of != null) return view
  const repeats = state.dialogue
    .map((id) => state.views[id])
    .filter((v): v is ModelActionView => v?.compare_of === view.id)
    .reverse()
  return repeats.find(hasResult) ?? repeats[0] ?? null
}

/** A repeat whose comparison can still come: it has a result, or may get one. */
const live = (view: ModelActionView) => hasResult(view) || PENDING.includes(view.status)

/** Whether ``view`` has a repeat that is not over: offer its comparison, not another repeat. */
export const repeated = (state: ModelState, view: ModelActionView): boolean => {
  const repeat = repeatOf(state, view)
  return repeat !== null && live(repeat)
}

/** A class ``off`` at the record's level: its query is run for no comparison (D1, P2). */
function onlyProposes(view: ModelActionView): string {
  const level = view.level.name
  const classes = classList(offOf(view))
  return classes
    ? t`Stufe ${level}: Das Modell darf hier nur vorschlagen (aus: ${classes}); seine Abfrage wird für keinen Vergleich ausgeführt.`
    : t`Stufe ${level}: Das Modell darf hier nur vorschlagen; seine Abfrage wird für keinen Vergleich ausgeführt.`
}

/**
 * Why a repeat of ``view`` would be refused, in words, or ``null``: the checks
 * of the server's ``compare`` in its order (a record with a result, no class
 * ``off``, not a repeat itself), then one request at a time (``busy``: the
 * dialogue's request, ``state.running``, or one on its way, ``sending``).
 */
export function repeatRefusal(
  state: ModelState,
  view: ModelActionView,
  sending: boolean,
): string | null {
  if (!COMPARABLE.includes(view.status)) {
    const status = statusText(statusKey(view))
    return t`Nicht mehr offen (${status}): Wiederholt wird eine wartende oder angewendete Antwort.`
  }
  if (proposalOnly(view) || offOf(view).length > 0) return onlyProposes(view)
  if (view.compare_of != null)
    return t`Diese Antwort ist schon die Wiederholung mit der anderen Arbeitsweise.`
  if (view.query == null) return t`Ohne Ergebnis gibt es nichts zu vergleichen.`
  if (state.running !== null || sending)
    return t`Eine Anfrage läuft noch. Wiederholen geht, sobald sie beantwortet ist.`
  return null
}

/**
 * Why the comparison of ``repeat`` cannot be shown, in words, or ``null``: as
 * the server's ``comparison`` checks (``store.compared``, ``_compared``), a
 * side with a class ``off``, then a side without a query, which may still get
 * one ("läuft noch") or never will. A record compared that left the dialogue
 * had its query when it was compared, and a query stays.
 */
export function comparisonRefusal(state: ModelState, repeat: ModelActionView): string | null {
  const original = repeat.compare_of != null ? state.views[repeat.compare_of] : undefined
  const sides = original ? [original, repeat] : [repeat]
  const off = sides.find((side) => proposalOnly(side) || offOf(side).length > 0)
  if (off) return onlyProposes(off)
  const empty = sides.find((side) => !hasResult(side))
  if (!empty) return null
  return PENDING.includes(empty.status)
    ? t`Läuft noch: Verglichen wird, sobald beide Wege ein Ergebnis haben.`
    : t`Eine der beiden Antworten hat kein Ergebnis; es gibt nichts zu vergleichen.`
}

/**
 * *Mit Werkzeugkette wiederholen* (M10.1) and the reverse: the same prompt
 * with the other approach, under the level as it is now. A refusal (quota,
 * ``busy``, a repeat of a repeat …) is shown at ``view``. ``true`` once the
 * repeat is in the dialogue.
 */
export async function repeat(view: ModelActionView): Promise<boolean> {
  const sending = usePanel.getState().sending || useComparison.getState().asking !== null
  if (repeatRefusal(useModel.getState(), view, sending) !== null) return false
  const current = sameGeneration()
  useComparison.setState({ asking: view.id, failure: null })
  try {
    const thinking = await api.model.compare(view.id)
    if (!current()) return false
    usePanel.setState((s) => ({ started: { ...s.started, [thinking.id]: Date.now() } }))
    useComparison.setState((s) => ({ asked: { ...s.asked, [thinking.id]: true } }))
    // Polled as a prompt, closing nothing (``sent``: a repeat supersedes no
    // record), the text in the field left alone (``resumed``).
    useModel.getState().resumed(thinking)
    return true
  } catch (error) {
    if (current()) useComparison.setState({ failure: { action: view.id, error } })
    return false
  } finally {
    if (current()) useComparison.setState({ asking: null })
  }
}

/** Opens the comparison of ``repeat`` (the dialog asks the server for the difference). */
export function openComparison(repeat: number) {
  useComparison.setState((s) => ({
    shown: repeat,
    last: repeat,
    asked: Object.fromEntries(
      Object.entries(s.asked).filter(([id]) => Number(id) !== repeat),
    ) as Record<number, true>,
  }))
}

export const closeComparison = () => useComparison.setState({ shown: null })

/**
 * A repeat this workplace asked for whose comparison can now be shown: its
 * dialog is due (opened once, then dropped from ``asked``).
 */
export function due(state: ModelState, asked: Record<number, true>): number | null {
  for (const key of Object.keys(asked)) {
    const repeat = state.views[Number(key)]
    if (repeat && comparisonRefusal(state, repeat) === null) return repeat.id
  }
  return null
}

/**
 * Why ``view`` cannot be taken from the comparison, in words, or ``null``.
 * Its own governance holds: a class ``off`` is applied by hand only (D1); a
 * chain is adopted once its run ended, so its halts happened in the dialogue.
 * ``inDialogue``: the analysis takes an answer of the dialogue only
 * (approval/flow.ts); one that left it is asked anew.
 */
export function takeRefusal(view: ModelActionView, inDialogue = true): string | null {
  const level = view.level.name
  if (offOf(view).length > 0 || proposalOnly(view))
    return t`Stufe ${level}: Das Modell darf hier nur vorschlagen. Übernehmen geht nur von Hand im Editor.`
  switch (view.status) {
    case 'applied':
      return t`Schon angewendet.`
    case 'thinking':
    case 'running':
      return t`Läuft noch.`
    case 'proposed':
    case 'approved':
      if (isChain(view)) return t`Läuft noch: Die Kette hat noch kein Ergebnis.`
      if (!canApply(view, layerList()))
        return t`Diese Abfrage lässt sich nicht im Editor darstellen und darum nicht anwenden.`
      break
    case 'done':
    case 'limited':
      if (view.query == null) return t`Die Kette brachte kein Ergebnis.`
      break
    default: {
      const status = statusText(statusKey(view))
      return t`Nicht mehr offen (${status}).`
    }
  }
  return inDialogue ? null : t`Nicht mehr im Verlauf. Bitte neu fragen.`
}

/**
 * *Diese übernehmen* (M10.2, M10.3): the record's own approval and run, through
 * approval/flow.ts. ``true`` once the analysis is that side's (or waits for the
 * editor to close); a refusal stays at the side (``useApproval().failure``).
 */
export async function take(view: ModelActionView): Promise<boolean> {
  const inDialogue = useModel.getState().dialogue.includes(view.id)
  if (takeRefusal(view, inDialogue) !== null || useApproval.getState().busy) return false
  if (isChain(view)) await adopt(view)
  else if (view.status === 'approved') await execute(view)
  else await accept(view)
  const now = useModel.getState().views[view.id]
  return now?.status === 'applied' || useApproval.getState().parked[view.id] === 'execute'
}

/**
 * A refusal of the comparison or of a repeat in words. ``not_approved`` here
 * means a side may still get a result (the model thinks, a chain waits or
 * runs): "läuft noch". The other codes as everywhere (i18n/errors.ts).
 */
export function compareErrorText(error: unknown): string {
  if (error instanceof ApiRequestError && error.body?.code === 'not_approved')
    return t`Eine Seite läuft noch: Verglichen wird, sobald beide ein Ergebnis haben.`
  return error instanceof Error ? error.message : String(error)
}

/**
 * Where the focus goes once the dialog closed, or a repeat was asked for (its
 * card replaced the one the menu was in): the repeat's *Vergleich ansehen*
 * when it can be pressed, else the latest answer.
 */
export function focusComparison(repeat: number | null) {
  const open =
    repeat === null
      ? null
      : document.querySelector<HTMLButtonElement>(`button[data-compare="${repeat}"]:not(:disabled)`)
  if (open) {
    open.focus()
    return
  }
  const cards = document.querySelectorAll<HTMLElement>('#prompt-panel article')
  const latest = cards[cards.length - 1]
  if (!latest) return
  if (!latest.hasAttribute('tabindex')) latest.tabIndex = -1
  latest.focus()
}
