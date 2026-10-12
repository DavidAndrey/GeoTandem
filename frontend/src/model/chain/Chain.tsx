// A tool chain in the dialogue (design M8, M9; plan P4, WP77): the same card
// as a direct answer, with a numbered list of steps instead of a condition
// tree. Before the run the plan with class and cell per step and its approval
// (M8.1, M8.2) or its editor (M8.3); during the run each step's result for the
// user and, in monospace, what the model saw of it (M9.1, D9); the halt for
// approval (M9.2); the end: done (M9.3), aborted (M9.4) or stopped by a limit
// (M9.5), with the last complete result adoptable. The analysis is unchanged
// until *übernehmen*.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Check, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ModelActionView, StepView } from '../../api/client'
import { useLayers } from '../../api/queries'
import { ErrorNotice } from '../../components/ui'
import { errorText, type Details } from '../../i18n/errors'
import { formatNumber } from '../../i18n/locale'
import { hitsOf } from '../../i18n/phrases'
import { RejectStep, Rejected, Undone } from '../approval/Approval'
import { adopt, escapeRejects, startRejecting, useApproval } from '../approval/flow'
import { cellLabel, classList } from '../approval/governance'
import { resumePolling } from '../panel/poll'
import { openMyActions } from '../log/dialog'
import { prefill, usePanel } from '../panel/state'
import { clockTime, minutes, seconds } from '../panel/time'
import { readQuery } from '../readable'
import { StatusLabel } from '../status'
import { FRAME, lineStyle, statusKey } from '../statusKey'
import { QueryTree } from '../tree'
import { useCompare } from './compare'
import {
  approveChain,
  focusReturned,
  openPlanEditor,
  requestMs,
  retryRun,
  stopChain,
  useChain,
} from './flow'
import { PlanEditor, StepLimit } from './PlanEditor'
import { StepSummary } from './StepSummary'
import {
  aborted,
  adoptable,
  adoptedHits,
  CHAIN_S,
  current,
  finished,
  halts,
  MAX_FEATURES,
  MAX_REPLANS,
  MAX_STEPS,
  modelSees,
  phaseOf,
  placeAt,
  placeOf,
  planned,
  ranCount,
  ranMs,
  stepCount,
  stepState,
  oneApproval,
  type Phase,
  type PlanAnswer,
} from './steps'

/** The time now, once a second: the run's clock (M9.1). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * ``text``, but changed at most once per ``ms`` (the latest wins): a status
 * region that announces each step would flood a screen reader (plan WP77).
 */
function useThrottled(text: string, ms: number): string {
  const [shown, setShown] = useState(text)
  const last = useRef(0)
  useEffect(() => {
    if (text === shown) return
    const timer = setTimeout(
      () => {
        last.current = Date.now()
        setShown(text)
      },
      Math.max(0, last.current + ms - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [text, shown, ms])
  return shown
}

/** How often the chain's status region may speak. */
const ANNOUNCE_MS = 3000

/**
 * The chain's answer card. ``actions``: the answer's actions once it is applied
 * (*Im Editor öffnen*, *Zurücknehmen*, *Protokoll*), from the dialogue.
 */
export function ChainAnswer({ view, actions }: { view: ModelActionView; actions?: ReactNode }) {
  const phase = phaseOf(view)
  const key = statusKey(view)
  const plan = view.answer?.kind === 'plan' ? view.answer : null
  const editing = useChain((s) => s.editing === view.id)
  const announced = useThrottled(announcement(view, phase), ANNOUNCE_MS)
  return (
    <article
      aria-label={t`Antwort`}
      data-phase={phase}
      className={`card flex flex-col gap-2 p-3 ${FRAME[lineStyle(key)]}`}
    >
      <Header view={view} phase={phase} />
      {/* One region for the run's changes, throttled; the label above stays quiet then. */}
      <p role="status" className="sr-only">
        {announced}
      </p>
      {phase === 'plan' && plan && <Explanation plan={plan} />}
      {editing && phase === 'plan' ? (
        <PlanEditor view={view} />
      ) : (
        <>
          <Steps view={view} phase={phase} />
          <PhaseActions view={view} phase={phase} actions={actions} />
        </>
      )}
    </article>
  )
}

/** What the status region says of the chain now; empty where the label speaks itself. */
function announcement(view: ModelActionView, phase: Phase): string {
  const total = formatNumber(planned(view).length)
  const step = current(view)
  const at = step ? formatNumber(placeOf(view, step)) : ''
  switch (phase) {
    case 'running':
      if (view.stop_reason === 'aborted') return t`Kette wird abgebrochen`
      return step ? t`Schritt ${at} von ${total} läuft` : ''
    case 'halt':
      return step?.status === 'waiting'
        ? t`Kette wartet auf Freigabe vor Schritt ${at} von ${total}`
        : t`Kette neu geplant, wartet auf Freigabe`
    case 'done': {
      const count = adoptedHits(view)
      const hits = count === null ? null : formatNumber(count)
      return hits === null
        ? t`Kette fertig, nicht angewendet`
        : t`Kette fertig: ${hits} Treffer, nicht angewendet`
    }
    case 'stopped': {
      const limit = limitTitle(view)
      return aborted(view.stop_reason)
        ? t`Kette abgebrochen, Analyse unverändert`
        : t`Kette angehalten: ${limit}. Analyse unverändert`
    }
    default:
      return ''
  }
}

function Header({ view, phase }: { view: ModelActionView; phase: Phase }) {
  const key = statusKey(view)
  const total = formatNumber(planned(view).length)
  const step = current(view)
  const at = step ? formatNumber(placeOf(view, step)) : ''
  const quiet = phase !== 'plan' && phase !== 'closed'
  let detail: string | undefined
  let side: ReactNode = null
  switch (phase) {
    case 'plan': {
      const took = seconds(view.latency_ms)
      side = took ? t`Werkzeugkette · ${took}` : t`Werkzeugkette`
      break
    }
    case 'running':
      // An abort answers at once; the step that runs still ends (P4).
      detail =
        view.stop_reason === 'aborted'
          ? t`· wird abgebrochen`
          : step
            ? t`· Schritt ${at} von ${total}`
            : undefined
      side = <RunClock view={view} />
      break
    case 'halt':
      side = step ? t`Schritt ${at} von ${total}` : null
      break
    case 'done':
      detail = t`· Ergebnis nicht angewendet`
      side = <ResultCount view={view} />
      break
    case 'stopped': {
      const last = view.steps.filter(finished).pop()
      const after = last ? formatNumber(placeOf(view, last)) : null
      detail = aborted(view.stop_reason) && after ? t`· nach Schritt ${after}` : undefined
      side = t`Analyse unverändert`
      break
    }
    default:
      detail =
        view.status === 'undone'
          ? clockTime(view.undone_at)
          : view.decided_at
            ? clockTime(view.decided_at)
            : undefined
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2">
        <StatusLabel status={key} detail={detail} live={!quiet} />
        <span className="text-muted ml-auto text-xs tabular-nums">{side}</span>
      </p>
      {phase === 'running' && <RunBar view={view} />}
    </div>
  )
}

/**
 * "0:09 / max. 5:00": the request so far, the planning call and the run as the
 * server counts them (``latency_ms`` + ``run_ms``), against its cap (P4).
 */
function RunClock({ view }: { view: ModelActionView }) {
  const now = useNow()
  const shown = minutes(Math.min(requestMs(view, now), CHAIN_S * 1000) / 1000)
  const max = minutes(CHAIN_S)
  return <span aria-label={t`Laufzeit der Kette`}>{t`${shown} / max. ${max}`}</span>
}

/** Steps done of the plan's steps. */
function RunBar({ view }: { view: ModelActionView }) {
  const steps = planned(view)
  const done = steps.filter(finished).length
  return (
    <div className="h-1 rounded bg-neutral-200" aria-hidden>
      <div
        className="bg-accent h-1 rounded"
        style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }}
      />
    </div>
  )
}

/** "10 von 137": the chain's hits of the result layer's objects (M9.3). */
function ResultCount({ view }: { view: ModelActionView }) {
  const catalog = useLayers().data
  const hits = adoptedHits(view)
  if (hits === null) return null
  const source = readQuery(view.query).source
  const total = catalog?.find((l) => l.name === source)?.feature_count
  return (
    <span aria-label={t`Trefferzahl der Kette`}>
      {total != null ? hitsOf(hits, total) : formatNumber(hits)}
    </span>
  )
}

/** M8: how the model read the question and what it assumed, as for a direct answer. */
function Explanation({ plan }: { plan: PlanAnswer }) {
  const count = formatNumber(plan.assumptions.length)
  return (
    <>
      <p>{plan.explanation}</p>
      {plan.assumptions.length > 0 && (
        <section aria-label={t`Annahmen`} className="flex flex-col gap-0.5 text-sm">
          <p className="label-caps">{t`Annahmen · ${count}`}</p>
          <ul className="flex flex-col gap-0.5">
            {plan.assumptions.map((assumption, i) => (
              <li key={i} className="flex items-baseline gap-1.5">
                <span aria-hidden className="text-accent-700">
                  ≈
                </span>
                <span className="min-w-0 flex-1">{assumption.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function Steps({ view, phase }: { view: ModelActionView; phase: Phase }) {
  const steps = planned(view)
  return (
    <section aria-label={t`Schritte`} className="flex flex-col gap-1">
      {(phase === 'plan' || phase === 'halt') && <StepLimit count={steps.length} />}
      <ol className="flex flex-col gap-1.5">
        {steps.map((step, i) => (
          <StepItem key={step.position} view={view} step={step} place={i + 1} phase={phase} />
        ))}
      </ol>
      {phase === 'halt' && current(view)?.status === 'waiting' && (
        <p className="text-muted text-xs">
          <Trans>Die Laufzeit ist angehalten, solange die Freigabe offen ist.</Trans>
        </p>
      )}
      {phase === 'halt' && current(view)?.status !== 'waiting' && <HaltApproval view={view} />}
    </section>
  )
}

function Mark({ step, place }: { step: StepView; place: number }) {
  const base = 'flex size-5 shrink-0 items-center justify-center rounded-full border text-xs'
  if (step.status === 'ok' || step.status === 'empty')
    return (
      <span aria-hidden className={`${base} border-ink bg-ink text-neutral-100`}>
        <Check size={11} />
      </span>
    )
  if (step.status === 'error')
    return (
      <span aria-hidden className={`${base} border-ink`}>
        <X size={11} />
      </span>
    )
  const dashed = step.status === 'running' || step.status === 'waiting'
  return (
    <span
      aria-hidden
      className={`${base} ${dashed ? 'border-accent text-accent-700 border-dashed' : 'border-neutral-400'}`}
    >
      {formatNumber(place)}
    </span>
  )
}

function StepItem({
  view,
  step,
  place,
  phase,
}: {
  view: ModelActionView
  step: StepView
  place: number
  phase: Phase
}) {
  const active = step.status === 'running' || step.status === 'waiting'
  const ran = finished(step)
  const skipped = step.status === 'skipped'
  const seen = step.model_view ? modelSees(step.model_view) : null
  const n = formatNumber(place)
  const text = step.text
  return (
    <li
      data-status={step.status}
      aria-label={t`Schritt ${n}: ${text}`}
      className={`rounded p-2 text-sm ${active ? FRAME.dashed : 'border-divider border'} ${skipped ? 'text-muted' : ''}`}
    >
      <div className="flex items-start gap-2">
        <Mark step={step} place={place} />
        <div className="min-w-0 flex-1">
          <p className={ran ? 'font-semibold' : ''}>
            {step.text}
            <span className="sr-only">{` · ${stepState(step)}`}</span>
            {step.revised && (
              <span className="chip ml-1.5 text-xs">
                <Trans>neu geplant</Trans>
              </span>
            )}
          </p>
          {step.query && <StepSummary query={step.query} />}
          <p className="text-muted font-mono text-xs">{step.tool}</p>
          {seen && <p className="text-muted font-mono text-xs">{t`Modell sieht: ${seen}`}</p>}
        </div>
        <StepSide step={step} phase={phase} />
      </div>
      {step.status === 'waiting' && phase === 'halt' && <HaltApproval view={view} step={step} />}
    </li>
  )
}

/** Right of a step: class and cell before it runs (M8), its result and duration after (M9). */
function StepSide({ step, phase }: { step: StepView; phase: Phase }) {
  if (finished(step))
    return (
      <span className="flex shrink-0 gap-3 text-xs tabular-nums">
        {step.hits != null && (
          <span aria-label={t`Treffer`} className="text-sm font-semibold">
            {formatNumber(step.hits)}
          </span>
        )}
        {step.duration_ms != null && (
          <span className="text-muted" aria-label={t`Dauer`}>
            {seconds(step.duration_ms, 1)}
          </span>
        )}
      </span>
    )
  if (step.status === 'running')
    return (
      <span className="text-muted shrink-0 text-xs">
        <Trans>läuft …</Trans>
      </span>
    )
  if (phase === 'plan' || phase === 'halt') {
    const classes = classList(step.classes)
    const cell = cellLabel(step.cell)
    return <span className="chip shrink-0 text-xs">{t`${classes} · ${cell}`}</span>
  }
  return null
}

function PhaseActions({
  view,
  phase,
  actions,
}: {
  view: ModelActionView
  phase: Phase
  actions?: ReactNode
}) {
  switch (phase) {
    case 'plan':
      return <PlanActions view={view} />
    case 'running':
      return <RunActions view={view} />
    case 'done':
      return <DoneActions view={view} />
    case 'stopped':
      return <StoppedActions view={view} />
    case 'halt':
      return <ChainFailure view={view} />
    default:
      return (
        <>
          {view.status === 'applied' && <AppliedNote view={view} />}
          {view.status === 'undone' && <Undone view={view} />}
          {view.status === 'rejected' && <Rejected view={view} />}
          {actions}
        </>
      )
  }
}

/**
 * A request of the record's flow that failed (``failure`` of approval/flow.ts,
 * an alert): what, and *Erneut starten* for a run. An adoption's own is
 * ``AdoptState``'s.
 */
function ChainFailure({ view }: { view: ModelActionView }) {
  const failure = useApproval((s) =>
    s.failure?.action === view.id && s.failure.step !== 'adopt' ? s.failure : null,
  )
  if (!failure) return null
  return (
    <div className="flex flex-col gap-1">
      <ErrorNotice error={failure.error} />
      {failure.step === 'run' && (
        <button type="button" className="btn self-start" onClick={() => retryRun(view.id)}>
          <Trans>Erneut starten</Trans>
        </button>
      )}
    </div>
  )
}

/**
 * M8.1, M8.2: the plan's approval, docked in the answer as a proposal's is
 * (E2.4): the first button has the focus, Esc rejects with the reason chosen
 * so far, no timeout. *Prüfen*: one approval for the whole chain; *Teilautonom*:
 * *Starten*, and the run halts before each step that needs approval (P4).
 */
function PlanActions({ view }: { view: ModelActionView }) {
  const rejecting = useApproval((s) => (s.rejecting?.action === view.id ? s.rejecting : null))
  const busy = useApproval((s) => s.busy?.action === view.id)
  const primary = useRef<HTMLButtonElement>(null)
  const adjust = useRef<HTMLButtonElement>(null)
  const choosing = rejecting !== null
  const waits = view.status === 'proposed' && !view.proposal_only
  useEffect(() => {
    // Back from the plan editor: the focus returns to *Anpassen …* (M8.3).
    if (useChain.getState().edited === view.id) {
      adjust.current?.focus()
      focusReturned()
      return
    }
    if (waits && !choosing) primary.current?.focus()
  }, [view.id, waits, choosing])

  if (view.status === 'approved')
    return (
      <>
        <p role="status" className="text-muted text-sm">
          <Trans>Freigegeben: Die Kette startet …</Trans>
        </p>
        <ChainFailure view={view} />
      </>
    )
  if (view.proposal_only) {
    const level = view.level.name
    const off = classList(view.governance?.off ?? [])
    return (
      <p className="text-muted text-xs">
        {t`Stufe ${level}: Das Modell darf hier nur vorschlagen (aus: ${off}). Eine Werkzeugkette läuft nicht; neue Frage über das Eingabefeld.`}
      </p>
    )
  }
  const whole = oneApproval(view)
  const stops = halts(view).map((n) => formatNumber(n))
  const where = stops.join(', ')
  return (
    <section
      aria-label={t`Freigabe`}
      className="border-divider flex flex-col gap-2 border-t pt-2"
      onKeyDown={escapeRejects(view, rejecting?.reason ?? null)}
    >
      <p className="text-muted text-xs">
        {whole
          ? t`Eine Freigabe für die ganze Kette; danach läuft sie ohne weitere Halte durch.`
          : stops.length > 0
            ? t`Je Schritt Klasse und Festlegung. Schritte mit „auto“ laufen ohne Halt; die Kette hält vor Schritt ${where} zur Freigabe.`
            : t`Je Schritt Klasse und Festlegung. Schritte mit „auto“ laufen ohne Halt.`}
      </p>
      {rejecting ? (
        <RejectStep view={view} reason={rejecting.reason} busy={busy} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            ref={primary}
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void approveChain(view)}
          >
            {whole ? t`Kette freigeben und starten` : t`Starten`}
          </button>
          <button
            ref={adjust}
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => openPlanEditor(view.id)}
          >
            <Trans>Anpassen …</Trans>
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
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
      <ChainFailure view={view} />
    </section>
  )
}

/**
 * M9.2: halted before ``step``, whose cell is ``approve`` (*Teilautonom*), or
 * after a re-plan the level wants approved (P4; without ``step``). *Schritt
 * freigeben* has the focus; Esc stops the chain (``stopChain``), its last
 * complete result stays adoptable (M9.4). A refusal shows as an alert
 * (``ChainFailure`` of the phase).
 */
function HaltApproval({ view, step }: { view: ModelActionView; step?: StepView }) {
  const busy = useApproval((s) => s.busy?.action === view.id)
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => primary.current?.focus(), [view.id, step?.position])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    void stopChain(view)
  }
  const needs = classList(step ? step.classes : [])
  const level = view.level.name
  // A re-plan follows the last step that ran: an error, or no result (P4).
  const before = view.steps.filter(finished).pop()
  const at = before ? formatNumber(placeOf(view, before)) : ''
  const why = step
    ? t`Braucht Freigabe: ${needs} (Stufe ${level})`
    : before?.status === 'error'
      ? t`Schritt ${at} brachte einen Fehler; die Kette wurde neu geplant, geänderte Schritte sind markiert. Die Stufe verlangt eine neue Freigabe.`
      : t`Schritt ${at} brachte kein Ergebnis; die Kette wurde neu geplant, geänderte Schritte sind markiert. Die Stufe verlangt eine neue Freigabe.`
  return (
    <div
      role="group"
      aria-label={t`Freigabe`}
      className="mt-2 flex flex-col gap-2"
      onKeyDown={onKeyDown}
    >
      <p className="text-sm">{why}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={primary}
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void approveChain(view)}
        >
          {step ? t`Schritt freigeben` : t`Freigeben und fortsetzen`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-keyshortcuts="Escape"
          aria-describedby={`halt-esc-${view.id}`}
          onClick={() => void stopChain(view)}
        >
          <Trans>Kette abbrechen</Trans>
        </button>
        <span id={`halt-esc-${view.id}`} className="text-muted ml-auto text-xs">
          <Trans>Esc = Kette abbrechen</Trans>
        </span>
      </div>
    </div>
  )
}

/** M9.1: *Abbrechen* stops before the next step; the analysis is unchanged meanwhile. */
function RunActions({ view }: { view: ModelActionView }) {
  const aborting = usePanel((s) => s.aborting === view.id)
  const busy = useApproval((s) => s.busy?.action === view.id)
  const abortError = usePanel((s) => s.abortError)
  const pollError = usePanel((s) => (s.pollError?.id === view.id ? s.pollError.error : null))
  // Asked to stop: the step that runs ends, no other starts; the poll brings the end.
  const stopping = view.stop_reason === 'aborted'
  // Running, or approved at a halt and not run again: the server stops it at once.
  const stoppable = view.status === 'running' || view.status === 'approved'
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={aborting || busy || stopping || !stoppable}
          onClick={() => void stopChain(view)}
        >
          <Trans>Abbrechen</Trans>
        </button>
        <span className="text-muted text-xs">
          {stopping ? (
            <Trans>Wird abgebrochen: Der laufende Schritt endet noch, dann hält die Kette.</Trans>
          ) : (
            <Trans>Analyse bleibt unverändert</Trans>
          )}
        </span>
      </p>
      <ChainFailure view={view} />
      <ErrorNotice error={abortError ?? pollError} />
      {pollError !== null && (
        <button type="button" className="btn self-start" onClick={resumePolling}>
          <Trans>Erneut nachfragen</Trans>
        </button>
      )}
    </div>
  )
}

/** Adopting: under way, waiting for the editor, or failed (the analysis is unchanged then). */
function AdoptState({ view }: { view: ModelActionView }) {
  const busy = useApproval((s) => s.busy?.action === view.id && s.busy.step === 'adopt')
  const parked = useApproval((s) => s.parked[view.id] === 'execute')
  const failure = useApproval((s) =>
    s.failure?.action === view.id && s.failure.step === 'adopt' ? s.failure.error : null,
  )
  if (parked)
    return (
      <p role="status" className="text-muted text-sm">
        <Trans>Wird übernommen, sobald der Editor geschlossen ist.</Trans>
      </p>
    )
  if (busy)
    return (
      <p role="status" className="text-muted text-sm">
        <Trans>Wird übernommen …</Trans>
      </p>
    )
  if (failure)
    return (
      <div className="flex flex-col gap-1 text-sm">
        <ErrorNotice error={failure} />
        <p>
          <Trans>Ihr Stand ist unverändert.</Trans>
        </p>
      </div>
    )
  return null
}

/**
 * M9.3: done, the result marked, not applied. *Ergebnis übernehmen* adopts it
 * (in *Prüfen* it counts as *Annehmen*: the chain was approved already);
 * *Als Abfrage ansehen* shows the result as the query object it becomes;
 * *Mit Direktabfrage vergleichen* is the comparison's entry (model/compare/,
 * registered through ``compare.ts``).
 */
function DoneActions({ view }: { view: ModelActionView }) {
  const [shown, setShown] = useState(false)
  const compareEntry = useCompare((s) => s.entry)
  const busy = useApproval((s) => s.busy !== null)
  // The steps that ran, and their time (M9.3 "5 Schritte · 3,6 s").
  const count = stepCount(ranCount(view))
  const took = seconds(ranMs(view), 1) ?? ''
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted text-xs tabular-nums">{t`${count} · ${took}`}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void adopt(view)}
        >
          <Trans>Ergebnis übernehmen</Trans>
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={shown}
          disabled={!view.query}
          onClick={() => setShown(!shown)}
        >
          <Trans>Als Abfrage ansehen</Trans>
        </button>
        {compareEntry?.(view)}
      </div>
      {shown && view.query && <QueryTree query={view.query} line="dashed" />}
      <AdoptState view={view} />
      <p className="text-muted text-xs">
        <Trans>
          Übernehmen schreibt das Ergebnis als eine Abfrage in die Analyse, ihre Bedingungen mit der
          Marke „Modell“; die Zwischenstände entfallen.
        </Trans>
      </p>
    </div>
  )
}

/** The limit a chain stopped at, as a title (M9.5). */
function limitTitle(view: ModelActionView): string {
  switch (view.stop_reason) {
    case 'step_limit':
      return t`Schrittzahl erreicht`
    case 'time_limit':
      return t`Laufzeit überschritten`
    case 'result_too_large':
      return t`Ergebnisgrösse überschritten`
    case 'replan_limit':
      return t`Keine weitere Neuplanung`
    case 'interrupted':
      return t`Lauf unterbrochen`
    default:
      return t`Begrenzung erreicht`
  }
}

/** Codes of a refused re-plan that name its step (store.py ``NAMED``): "Schritt n". */
const NAMES_STEP = ['class_not_allowed', 'unknown_layer', 'not_representable']

/**
 * Why a re-plan brought no plan to run on (``replan_limit``), from the stop's
 * error: none, the re-plans are used up; ``model_unreadable``, the model
 * answered with no plan; ``model_truncated``, its answer was cut off; no call made (the level or the connection changed,
 * the daily limit); else its refusal, with the step it names.
 */
function replanText(view: ModelActionView, at: string | null): string {
  const error = view.error
  const code = typeof error?.code === 'string' ? error.code : null
  const details = (error?.details ?? {}) as Details
  if (code === null) {
    const max = formatNumber(MAX_REPLANS)
    return t`Ein Schritt brachte einen Fehler oder kein Ergebnis, und die Neuplanungen sind aufgebraucht (höchstens ${max}).`
  }
  switch (code) {
    case 'model_unreadable':
      return t`Das Modell antwortete auf die Neuplanung nicht mit einem Plan.`
    case 'model_truncated':
      return t`Die Antwort des Modells auf die Neuplanung wurde abgeschnitten, ehe sie einen Plan enthielt.`
    case 'level_not_available':
      return t`Ihre Stufe wurde seit dem Plan geändert; unter ihr läuft die Kette nicht weiter.`
    case 'connection_not_available':
    case 'quota_exceeded': {
      const reason = errorText(code, details, String(error?.message ?? ''))
      return t`Keine Neuplanung möglich: ${reason}`
    }
  }
  const reason = errorText(code, details, String(error?.message ?? ''))
  return NAMES_STEP.includes(code) && at
    ? t`Die Neuplanung brachte keinen brauchbaren Plan (Schritt ${at}): ${reason}`
    : t`Die Neuplanung brachte keinen brauchbaren Plan: ${reason}`
}

/**
 * M9.5: why the chain stopped, with the numbers and names the server gives
 * (``error.details``: ``step``, ``value``, ``max``; a refused re-plan's
 * ``level``, ``op_class``, ``layer``, …); the same shape for steps, time and
 * size, a re-plan that brought nothing, a step without a query slot and a restart.
 */
function LimitBox({ view }: { view: ModelActionView }) {
  const details = (view.error?.details ?? {}) as Details
  const position = typeof details.step === 'number' ? details.step : null
  const place = position !== null ? placeAt(view, position) : null
  const at = place !== null ? formatNumber(place) : null
  const value = typeof details.value === 'number' ? details.value : null
  let text: string
  switch (view.stop_reason) {
    case 'step_limit': {
      const max = formatNumber(MAX_STEPS)
      const total = value !== null ? formatNumber(value) : null
      text =
        total !== null
          ? t`Die Kette bräuchte ${total} Schritte, neu geplante eingeschlossen (höchstens ${max}).`
          : t`Die Kette bräuchte mehr als ${max} Schritte, neu geplante eingeschlossen (höchstens ${max}).`
      break
    }
    case 'time_limit': {
      const max = minutes(CHAIN_S)
      text = at
        ? t`Die Kette lief länger als erlaubt und hielt vor Schritt ${at} (höchstens ${max} je Anfrage).`
        : t`Die Kette lief länger als erlaubt (höchstens ${max} je Anfrage).`
      break
    }
    case 'replan_limit':
      text = replanText(view, at)
      break
    case 'interrupted':
      // No query slot came free for a step (``busy``), or a restart, or the run failed.
      text =
        view.error?.code === 'busy'
          ? at
            ? t`Zu viele Abfragen liefen gleichzeitig; die Kette wurde vor Schritt ${at} angehalten.`
            : t`Zu viele Abfragen liefen gleichzeitig; die Kette wurde angehalten.`
          : t`Der Lauf wurde unterbrochen: Die Anwendung wurde neu gestartet, oder der Lauf selbst ist fehlgeschlagen.`
      break
    default: {
      const max = formatNumber(MAX_FEATURES)
      const shown = value !== null ? formatNumber(value) : null
      text =
        at && shown
          ? t`Schritt ${at} hätte ${shown} Objekte erzeugt (höchstens ${max}).`
          : at
            ? t`Schritt ${at} hätte mehr als ${max} Objekte erzeugt (höchstens ${max}).`
            : t`Ein Schritt hätte mehr als ${max} Objekte erzeugt (höchstens ${max}).`
    }
  }
  return (
    <div className="border-ink rounded border p-2 text-sm">
      <p className="font-semibold">{limitTitle(view)}</p>
      <p>{text}</p>
    </div>
  )
}

/**
 * M9.4 aborted, M9.5 stopped otherwise: the result the server chose is
 * adoptable (*Zwischenstand übernehmen (17)*); the analysis is unchanged
 * until then. After a limit the prompt can go back to the field.
 */
function StoppedActions({ view }: { view: ModelActionView }) {
  // The server's choice of what to adopt (``query``, ``stamp``), never the client's.
  const last = adoptable(view)
  const busy = useApproval((s) => s.busy !== null)
  const compareEntry = useCompare((s) => s.entry)
  const byUser = aborted(view.stop_reason)
  const count = adoptedHits(view)
  const hits = count !== null ? formatNumber(count) : null
  const adoptButton = last && (
    <button
      type="button"
      className={`btn ${byUser ? 'btn-primary' : ''}`}
      disabled={busy}
      onClick={() => void adopt(view)}
    >
      {hits !== null ? t`Zwischenstand übernehmen (${hits})` : t`Zwischenstand übernehmen`}
    </button>
  )
  return (
    <div className="flex flex-col gap-2">
      {!byUser && <LimitBox view={view} />}
      <div className="flex flex-wrap items-center gap-2">
        {!byUser && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => prefill(view.prompt, view.approach)}
          >
            <Trans>Prompt ändern</Trans>
          </button>
        )}
        {adoptButton}
        {/* M9.4: the account's own log (M16.3). */}
        <button type="button" className="btn" onClick={openMyActions}>
          <Trans>Protokoll</Trans>
        </button>
        {/* A stopped chain with a result is compared too (service.py ``COMPARABLE``). */}
        {last && compareEntry?.(view)}
      </div>
      <AdoptState view={view} />
      <p className="text-muted text-xs">
        {last ? (
          <Trans>
            Der letzte vollständige Zwischenstand bleibt gedämpft auf der Karte, bis er übernommen
            oder neu gefragt wird.
          </Trans>
        ) : overLimit(view) ? (
          <Trans>
            Nichts zu übernehmen: Der letzte vollständige Zwischenstand hat mehr Objekte, als ein
            Ergebnis haben darf.
          </Trans>
        ) : (
          <Trans>Kein Schritt brachte ein vollständiges Ergebnis: nichts zu übernehmen.</Trans>
        )}
      </p>
    </div>
  )
}

/**
 * Nothing adoptable although a step that is no buffer brought a complete
 * result: the server chose no result (``query``, WP75 ``last_complete``), and
 * the one reason it leaves such a step out is the result-size limit. The
 * server decides; no count is judged here.
 */
function overLimit(view: ModelActionView): boolean {
  return (
    !adoptable(view) &&
    view.steps.some(
      (s) =>
        (s.status === 'ok' || s.status === 'empty') &&
        !(s.query as { buffer?: unknown } | null | undefined)?.buffer,
    )
  )
}

/** Adopted: "angewendet" with the hits the chain brought. */
function AppliedNote({ view }: { view: ModelActionView }) {
  const hits = view.stamp?.count
  if (hits == null) return null
  const count = formatNumber(hits)
  return <p className="text-muted text-xs">{t`Kette übernommen · ${count} Treffer`}</p>
}
