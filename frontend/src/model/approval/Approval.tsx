// The approval docked in the answer (design M5, M6.3, M7.3; not modal, no
// auto-timeout) and the answer's parts after a decision: executing (P7),
// undo (M2.2, M6.1), undone (M2.3, M6.2) and rejected (M5.3).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Analysis } from '../../analysis/model'
import { useAnalysis } from '../../analysis/store'
import type { ModelActionView, RejectReason } from '../../api/client'
import { useLayers } from '../../api/queries'
import { ErrorNotice } from '../../components/ui'
import { useCounts } from '../../editor/useCounts'
import { formatNumber } from '../../i18n/locale'
import { rows } from '../../analysis/tree'
import { hitsOf } from '../../i18n/phrases'
import { useActiveModel } from '../panel/active'
import { useCatalog } from '../panel/catalog'
import { CatalogNote } from '../panel/CatalogNote'
import { proposalDraft } from '../panel/draft'
import { canTakeOver, takeOver } from '../panel/handover'
import { changeList, type Change } from './changes'
import {
  accept,
  applyHeld,
  canApply,
  chooseReason,
  escapeRejects,
  execute,
  fingerprint,
  reject,
  startRejecting,
  stopRejecting,
  undo,
  useApproval,
} from './flow'
import {
  autoReady,
  cellLabel,
  classLabel,
  classList,
  conditionCount,
  mixed,
  REASON_ORDER,
  reasonText,
} from './governance'
import { usePreview } from './waiting'

/** The committed analysis (the editor's draft is not the analysis yet). */
const useCommitted = (): Analysis =>
  useAnalysis(
    useShallow((s) => ({
      layers: s.layers,
      result: s.result,
      tree: s.tree,
      restriction: s.restriction,
    })),
  )

/** "~ Ergebnis-Layer: keiner → Schulen", one line per change (design D4 signs). */
export function ChangeLines({ changes }: { changes: Change[] }) {
  if (changes.length === 0)
    return (
      <p className="text-muted text-xs">
        <Trans>Keine Änderung: Die Analyse entspricht dem Vorschlag schon.</Trans>
      </p>
    )
  return (
    <ul aria-label={t`Änderungen`} className="flex flex-col gap-0.5 font-mono text-xs">
      {changes.map((change, i) => (
        <li key={i} className={change.sign === '−' ? 'text-muted' : ''}>
          <span aria-hidden>{change.sign} </span>
          <span className="sr-only">
            {change.sign === '+' ? t`neu:` : change.sign === '~' ? t`geändert:` : t`entfällt:`}{' '}
          </span>
          {change.text}
        </li>
      ))}
    </ul>
  )
}

/** "Treffer: 137 → 10 (Vorschau, gestrichelt auf der Karte)". */
function PreviewLine({ view, analysis }: { view: ModelActionView; analysis: Analysis }) {
  const preview = usePreview(view)
  const counts = useCounts(analysis)
  const catalog = useLayers().data
  const source = proposalDraft(view.query, view.id, catalog)?.result
  if (preview.isPending)
    return (
      <p className="text-muted text-xs">
        <Trans>Vorschau lädt …</Trans>
      </p>
    )
  if (!preview.data)
    return (
      <p className="text-muted text-xs">
        <Trans>Keine Vorschau verfügbar; die Analyse ändert sich erst mit „Annehmen“.</Trans>
      </p>
    )
  // On another result layer the analysis has no hits of it: all its objects
  // count. On the same one, its hits once counted ("…" meanwhile, never a guess).
  const counting = !counts.data || counts.isFetching || counts.isPlaceholderData
  const from =
    analysis.result !== source
      ? formatNumber(preview.data.total)
      : counting || !counts.data
        ? '…'
        : formatNumber(counts.data.hits)
  const to = formatNumber(preview.data.count)
  return (
    <p className="font-mono text-xs" aria-label={t`Trefferzahl der Vorschau`}>
      {t`Treffer: ${from} → ${to} (Vorschau, gestrichelt auf der Karte)`}
    </p>
  )
}

/** M6.3: the classes of the answer with their cells; the strictest is outlined black. */
function ClassList({ view }: { view: ModelActionView }) {
  const governance = view.governance
  if (!governance) return null
  return (
    <section aria-label={t`Klassen dieser Antwort`} className="flex flex-col gap-1">
      <p className="label-caps">
        <Trans>Klassen dieser Antwort</Trans>
      </p>
      <ul className="flex flex-wrap gap-1">
        {governance.classes.map((k) => {
          const cell = view.level.matrix[k]
          const strictest = cell === governance.cell
          const name = classLabel(k)
          const mode = cellLabel(cell)
          return (
            <li
              key={k}
              className={`chip text-xs ${strictest ? 'border-ink font-semibold' : ''}`}
              data-strictest={strictest || undefined}
            >
              {t`${name} · ${mode}`}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * M5.1–M5.3: the approval of a proposal, docked in its answer. *Annehmen*
 * has the focus; Esc rejects (with the reason chosen so far); there is no
 * timeout. A hand edit meanwhile recomputes the list and says so (M5.2).
 */
export function Approval({ view }: { view: ModelActionView }) {
  const analysis = useCommitted()
  const { catalog, known, failed } = useCatalog()
  const editing = useAnalysis((s) => s.draft !== null)
  const draft = proposalDraft(view.query, view.id, catalog)
  const changes = draft ? changeList(analysis, draft, catalog) : []
  const baseline = useApproval((s) => s.baselines[view.id])
  const changed = baseline !== undefined && baseline !== fingerprint(analysis)
  const busy = useApproval((s) => (s.busy?.action === view.id ? s.busy.step : null))
  const failure = useApproval((s) => (s.failure?.action === view.id ? s.failure.error : null))
  const rejecting = useApproval((s) => (s.rejecting?.action === view.id ? s.rejecting : null))
  const { level } = useActiveModel()
  const acceptButton = useRef<HTMLButtonElement>(null)
  const applicable = canApply(view, catalog)
  const governance = view.governance
  const needs = classList(governance?.needs_approval ?? [])
  const levelName = view.level.name

  const choosing = rejecting !== null
  // Design "Barrierefreiheit": the approval takes the focus on "Annehmen",
  // also back from the reason step.
  useEffect(() => {
    if (!choosing) acceptButton.current?.focus()
  }, [view.id, choosing])

  return (
    <section
      aria-label={t`Freigabe`}
      className="border-divider flex flex-col gap-2 border-t pt-2"
      onKeyDown={escapeRejects(view, rejecting?.reason ?? null)}
    >
      <p className="label-caps">
        <Trans>Freigabe · Änderung gegenüber jetzt</Trans>
      </p>
      {changed && (
        <div role="status" className="border-ink rounded border p-2 text-sm">
          <p className="font-semibold">
            <Trans>Stand hat sich seit dem Vorschlag geändert</Trans>
          </p>
          <p>
            <Trans>Von Hand geändert. Änderungsliste neu berechnet.</Trans>
          </p>
        </div>
      )}
      <div className="flex flex-col gap-1 rounded bg-neutral-200 p-2">
        <ChangeLines changes={changes} />
        <PreviewLine view={view} analysis={analysis} />
      </div>
      {governance && mixed(view) && <ClassList view={view} />}
      <p className="text-sm">
        {governance && mixed(view)
          ? t`Braucht Freigabe: ${needs}. Die strengste Festlegung gilt für die ganze Antwort.`
          : t`Braucht Freigabe: ${needs} (Stufe ${levelName})`}
      </p>
      {/* M7.3: the proposal stays bound to the level it was made under. */}
      {level && level.id !== view.level.id && (
        <p className="text-muted text-xs">
          {t`Gestellt unter Stufe ${levelName}; dieser Vorschlag folgt weiter ihr und wird nicht automatisch angewendet.`}
        </p>
      )}
      {known && !applicable && (
        <p className="text-muted text-xs">
          <Trans>Diese Abfrage lässt sich nicht im Editor darstellen.</Trans>
        </p>
      )}
      <CatalogNote failed={failed} />
      {rejecting ? (
        <RejectStep view={view} reason={rejecting.reason} busy={busy !== null} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            ref={acceptButton}
            type="button"
            className="btn btn-primary"
            disabled={busy !== null || editing || !applicable}
            onClick={() => void accept(view)}
          >
            <Trans>Annehmen</Trans>
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || editing || !canTakeOver(view, catalog)}
            onClick={() => takeOver(view, catalog)}
          >
            <Trans>Anpassen …</Trans>
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            aria-keyshortcuts="Escape"
            aria-describedby={`esc-${view.id}`}
            onClick={() => startRejecting(view.id)}
          >
            <Trans>Ablehnen</Trans>
          </button>
          <span id={`esc-${view.id}`} className="text-muted ml-auto text-xs">
            <Trans>Esc = Ablehnen</Trans>
          </span>
        </div>
      )}
      {busy && (
        <p role="status" className="text-muted text-xs">
          {busy === 'reject' ? t`Wird abgelehnt …` : t`Wird angewendet …`}
        </p>
      )}
      <ErrorNotice error={failure} />
    </section>
  )
}

/** M5.3 before sending: the optional reason, then *Ablehnen* (also a chain plan's, M8.1). */
export function RejectStep({
  view,
  reason,
  busy,
}: {
  view: ModelActionView
  reason: RejectReason | null
  busy: boolean
}) {
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => confirm.current?.focus(), [])
  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label={t`Grund (optional)`}
        className="flex flex-wrap items-center gap-1 text-sm"
      >
        <span className="text-muted text-xs" aria-hidden>
          <Trans>Grund (optional):</Trans>
        </span>
        {REASON_ORDER.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            className={`chip text-xs ${reason === r ? 'border-ink font-semibold' : ''}`}
            onClick={() => chooseReason(reason === r ? null : r)}
          >
            {reasonText(r)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={confirm}
          type="button"
          className="btn btn-primary"
          disabled={busy}
          aria-keyshortcuts="Escape"
          onClick={() => void reject(view, reason)}
        >
          <Trans>Ablehnen</Trans>
        </button>
        <button type="button" className="btn" disabled={busy} onClick={stopRejecting}>
          <Trans>Zurück</Trans>
        </button>
        <span className="text-muted text-xs">
          <Trans>Der Grund geht ins Protokoll. Die Analyse bleibt unverändert.</Trans>
        </span>
      </div>
    </div>
  )
}

/**
 * An approved answer before its result is applied (P7): an ``auto`` answer
 * runs at once, an approved one right after *Annehmen*. A failed run says why
 * and can be repeated; the analysis is unchanged until it succeeds.
 */
export function Approved({ view }: { view: ModelActionView }) {
  const busy = useApproval((s) => s.busy?.action === view.id)
  const failure = useApproval((s) =>
    s.failure?.action === view.id && s.failure.step === 'execute' ? s.failure.error : null,
  )
  const parked = useApproval((s) => s.parked[view.id] === 'execute')
  const held = useApproval((s) => s.held[view.id] === true)
  const editing = useAnalysis((s) => s.draft !== null)
  const waitsForEditor = parked || (editing && autoReady(view))
  if (held)
    return (
      <div className="flex flex-col gap-1">
        <p role="status" className="text-sm">
          <Trans>
            Seit dem Prompt von Hand geändert: nicht automatisch angewendet. Die Antwort bezieht
            sich auf den Stand davor.
          </Trans>
        </p>
        <button type="button" className="btn self-start" onClick={() => void applyHeld(view)}>
          <Trans>Trotzdem anwenden</Trans>
        </button>
      </div>
    )
  if (failure)
    return (
      <div className="flex flex-col gap-1">
        <ErrorNotice error={failure} />
        <p className="text-sm">
          <Trans>Ihr Stand ist unverändert.</Trans>
        </p>
        <button type="button" className="btn self-start" onClick={() => void execute(view)}>
          <Trans>Erneut ausführen</Trans>
        </button>
      </div>
    )
  if (waitsForEditor)
    return (
      <p role="status" className="text-muted text-sm">
        <Trans>Wird angewendet, sobald der Editor geschlossen ist.</Trans>
      </p>
    )
  if (busy || autoReady(view))
    return (
      <p role="status" className="text-muted text-sm">
        <Trans>Wird angewendet …</Trans>
      </p>
    )
  // Approved, not yet run (e.g. its run was cut off): the stored query on request.
  return (
    <button type="button" className="btn btn-primary self-start" onClick={() => void execute(view)}>
      <Trans>Anwenden</Trans>
    </button>
  )
}

/**
 * *Zurücknehmen* (M2.2) or *Rückgängig* (M6.1) of a change the model made:
 * only the last one, and only while nothing was changed by hand since.
 */
export function UndoAction({ view }: { view: ModelActionView }) {
  const last = useApproval((s) => (s.last?.action === view.id ? s.last : null))
  const busy = useApproval((s) => s.busy !== null)
  const editing = useAnalysis((s) => s.draft !== null)
  const parked = useApproval((s) => s.parked[view.id] === 'undo')
  const failure = useApproval((s) =>
    s.failure?.action === view.id && s.failure.step === 'undo' ? s.failure.error : null,
  )
  if (view.status !== 'applied' || (view.decision !== 'accepted' && view.decision !== 'auto'))
    return null
  if (parked)
    return (
      <p role="status" className="text-muted w-full text-xs">
        <Trans>Wird zurückgenommen, sobald der Editor geschlossen ist.</Trans>
      </p>
    )
  const why = !last
    ? t`Zurücknehmen geht nur für die letzte Modelländerung.`
    : last.touched
      ? t`Seit der Modelländerung von Hand geändert. Bitte im Editor zurücksetzen.`
      : editing
        ? t`Erst den Editor schliessen: Zurücknehmen würde den Entwurf verwerfen.`
        : null
  const id = `undo-${view.id}`
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={why !== null || busy}
        aria-describedby={why ? id : undefined}
        onClick={() => void undo(view.id)}
      >
        {view.decision === 'auto' ? t`Rückgängig` : t`Zurücknehmen`}
      </button>
      {why && (
        <span id={id} className="text-muted w-full text-xs">
          {why}
        </span>
      )}
      {failure !== null && (
        <span className="w-full">
          <ErrorNotice error={failure} />
        </span>
      )}
    </>
  )
}

/**
 * M2.3, M6.2: taken back; stays in the dialogue without an action, no redo.
 * "vorher: …" is the state the undo put back, "war … angewendet" the run's hits.
 */
export function Undone({ view }: { view: ModelActionView }) {
  const restored = useApproval((s) => s.restored[view.id])
  const hits = view.stamp ? formatNumber(view.stamp.count) : null
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {restored && <Before snapshot={restored} />}
      {hits !== null && (
        <p className="text-muted">
          {view.decision === 'auto'
            ? t`war automatisch angewendet · ${hits} Treffer`
            : t`war angewendet · ${hits} Treffer`}
        </p>
      )}
      <p className="text-muted">
        {view.decision === 'auto'
          ? t`Die Analyse ist auf den Stand davor zurückgesetzt. Bleibt als Eintrag im Verlauf, ohne Aktion; kein „Wiederholen“.`
          : t`Die Analyse ist auf den Stand vor dem Annehmen zurückgesetzt. Bleibt als Eintrag im Verlauf, ohne Aktion; kein „Wiederholen“.`}
      </p>
    </div>
  )
}

/** "vorher: keine Abfrage · 137" or "vorher: 2 Bedingungen · 24 von 137". */
function Before({ snapshot }: { snapshot: Analysis }) {
  const counts = useCounts(snapshot)
  const conditions = rows(snapshot.tree).length
  const what = conditions === 0 ? t`keine Abfrage` : conditionCount(conditions)
  const hits = !counts.data
    ? '…'
    : conditions === 0
      ? formatNumber(counts.data.total)
      : hitsOf(counts.data.hits, counts.data.total)
  return <p className="text-muted">{t`vorher: ${what} · ${hits}`}</p>
}

/** M5.3: rejected, with its reason; the analysis was not touched. */
export function Rejected({ view }: { view: ModelActionView }) {
  const reason = view.reject_reason
  return (
    <div className="flex flex-col gap-1 text-sm">
      {reason ? (
        <p className="flex items-center gap-1">
          <span className="text-muted text-xs">
            <Trans>Grund:</Trans>
          </span>
          <span className="chip border-ink text-xs">{reasonText(reason)}</span>
        </p>
      ) : (
        <p className="text-muted text-xs">
          <Trans>Ohne Grund abgelehnt.</Trans>
        </p>
      )}
      <p className="text-muted text-xs">
        <Trans>
          Bleibt als Eintrag im Verlauf, ohne Aktion. Neuer Versuch über das Eingabefeld.
        </Trans>
      </p>
    </div>
  )
}
