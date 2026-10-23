// The dialogue of the prompt panel (design M2, M3, M4, M14): each prompt with
// its answer. The latest answer is shown whole, earlier ones as one line with
// their status. The answer says what the model proposes, what it assumed and
// what has happened. It never changes the analysis itself: the approval
// (model/approval/) and the hand-over to the editor (handover.ts) do.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import type { Assumption as AssumptionData, ModelActionView, ModelAnswer } from '../../api/client'
import { ErrorNotice } from '../../components/ui'
import { useCounts } from '../../editor/useCounts'
import { errorText } from '../../i18n/errors'
import { formatNumber, parseTimestamp } from '../../i18n/locale'
import { hitsOf } from '../../i18n/phrases'
import { Approval, Approved, Rejected, Undone, UndoAction } from '../approval/Approval'
import { byHandOnly, classList, needsApproval } from '../approval/governance'
import { ChainAnswer } from '../chain/Chain'
import { CompareHost } from '../compare/CompareHost'
import { CompareMenu } from '../compare/Entry'
import { useStaleLayer } from '../dialog/reference'
import { openMyActions } from '../log/dialog'
import { approachText } from '../log/words'
import { StatusLabel } from '../status'
import { dialogueViews, useModel } from '../store'
import { FRAME, lineStyle, statusKey } from '../statusKey'
import { QueryTree } from '../tree'
import { CHAIN_AVAILABLE } from './chain'
import { proposalDraft } from './draft'
import {
  canEditAssumption,
  canTakeOver,
  editAssumption,
  report,
  takeOver,
  useHandover,
} from './handover'
import { resumePolling } from './poll'
import { ProblemCard } from './Problem'
import { recordProblem, requestProblem, technical } from './problems'
import { abort, focusPrompt, MODEL_CALL_S, prefill, send, usePanel } from './state'
import { clockTime, minutes, seconds } from './time'

type QueryAnswer = Extract<ModelAnswer, { kind: 'query' }>

export function Dialogue() {
  return (
    <>
      {/* The comparison of both approaches (design M10, model/compare/). */}
      <CompareHost />
      <DialogueList />
    </>
  )
}

function DialogueList() {
  const views = useModel(useShallow(dialogueViews))
  const failure = usePanel((s) => s.failure)
  if (views.length === 0 && !failure) return null
  return (
    <ol className="flex flex-col gap-4" aria-label={t`Verlauf`}>
      {views.map((view, i) => (
        <li key={view.id} className="flex flex-col gap-2">
          <PromptLine
            prompt={view.prompt}
            at={view.created_at}
            repeat={view.compare_of != null ? view.approach : null}
          />
          {i === views.length - 1 ? <Answer view={view} /> : <Earlier view={view} />}
        </li>
      ))}
      {/* A request refused before any record: the latest answer stays open above,
          since "Ihr Stand ist unverändert" includes the dialogue. */}
      {failure && (
        <li className="flex flex-col gap-2">
          <PromptLine prompt={failure.prompt} at={null} />
          <ProblemCard
            problem={requestProblem(failure.error)}
            onRetry={() => void send(failure.prompt, failure.approach, failure.parent)}
          />
        </li>
      )}
    </ol>
  )
}

/**
 * The prompt above its answer; a repeat (design M10.1) says with which approach
 * it asks the same again.
 */
function PromptLine({
  prompt,
  at,
  repeat = null,
}: {
  prompt: string
  at: string | null
  repeat?: ModelActionView['approach'] | null
}) {
  const time = clockTime(at)
  const label = time ? t`Prompt · ${time}` : t`Prompt`
  const again =
    repeat === 'chain'
      ? t`wiederholt mit Werkzeugkette`
      : repeat === 'direct'
        ? t`wiederholt als Direktabfrage`
        : null
  return (
    <div className="border-divider border-l-2 pl-2">
      <p className="label-caps">{again ? t`${label} · ${again}` : label}</p>
      <p className="whitespace-pre-wrap">{prompt}</p>
    </div>
  )
}

/** An earlier answer: its status and what it said, in one line. */
function Earlier({ view }: { view: ModelActionView }) {
  const stale = useStaleLayer(view) !== null
  const answer = view.answer
  const said =
    view.status === 'refused'
      ? errorText(view.refusal?.code ?? 'invalid_query', view.refusal?.details ?? {})
      : answer?.kind === 'clarification'
        ? answer.question
        : (answer && 'explanation' in answer ? answer.explanation : '') || ''
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-sm">
      <StatusLabel status={statusKey(view, { stale })} />
      <span className="text-muted min-w-0 truncate" title={said}>
        {said}
      </span>
    </p>
  )
}

export function Answer({ view }: { view: ModelActionView }) {
  const stale = useStaleLayer(view)
  if (stale !== null) return <Stale view={view} layer={stale} />
  switch (view.status) {
    case 'thinking':
      return <Thinking view={view} />
    case 'refused':
      return <Refusal view={view} />
    case 'failed':
      return (
        <ProblemCard
          problem={recordProblem(view)}
          onRetry={() => void send(view.prompt, view.approach, view.parent_action_id ?? null)}
        />
      )
    case 'aborted':
      return <Aborted />
    default:
      // A tool chain's plan, run and result (design M8, M9): model/chain/.
      if (view.answer?.kind === 'plan')
        return <ChainAnswer view={view} actions={<Actions view={view} />} />
      return view.answer?.kind === 'query' ? (
        <Proposal view={view} answer={view.answer} />
      ) : (
        <Message view={view} />
      )
  }
}

const unchanged = () => (
  <span className="text-muted ml-auto text-xs">
    <Trans>Analyse unverändert</Trans>
  </span>
)

/** Seconds since ``since`` (ms), counting up once a second. */
function useElapsed(since: number): number {
  // From the clock, not ``since``: a remount (panel reopened) shows the time at once.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, (now - since) / 1000)
}

/**
 * M2.1: the model works. Input locked, a timer up to 2:00 (the model call's
 * limit; also for a chain's plan, one model call, P4), "Abbrechen"; no streaming.
 */
function Thinking({ view }: { view: ModelActionView }) {
  const started = usePanel((s) => s.started[view.id]) ?? parseTimestamp(view.created_at).getTime()
  const aborting = usePanel((s) => s.aborting === view.id)
  const abortError = usePanel((s) => s.abortError)
  const pollError = usePanel((s) => (s.pollError?.id === view.id ? s.pollError.error : null))
  const elapsed = Math.min(useElapsed(started), MODEL_CALL_S)
  const shown = minutes(elapsed)
  const max = minutes(MODEL_CALL_S)
  return (
    <article
      aria-label={t`Antwort`}
      aria-busy="true"
      className={`card flex flex-col gap-2 p-3 ${FRAME.dashed}`}
    >
      <p className="flex items-center gap-2">
        <StatusLabel status="thinking" live />
        <span className="text-muted ml-auto text-xs tabular-nums">{t`${shown} / max. ${max}`}</span>
      </p>
      <div className="h-1 rounded bg-neutral-200" aria-hidden>
        <div
          className="h-1 rounded bg-neutral-400"
          style={{ width: `${(elapsed / MODEL_CALL_S) * 100}%` }}
        />
      </div>
      <p className="flex items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={aborting}
          onClick={() => void abort(view.id)}
        >
          <Trans>Abbrechen</Trans>
        </button>
        <span className="text-muted text-xs">
          <Trans>Analyse bleibt unverändert</Trans>
        </span>
      </p>
      <ErrorNotice error={abortError ?? pollError} />
      {pollError !== null && (
        <button type="button" className="btn self-start" onClick={resumePolling}>
          <Trans>Erneut nachfragen</Trans>
        </button>
      )}
    </article>
  )
}

/** M2.1 → Abbrechen: nothing proposed, the prompt back in the field. */
function Aborted() {
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME.void}`}>
      <p className="flex items-center gap-2">
        <StatusLabel status="aborted" live />
        {unchanged()}
      </p>
      <p className="text-sm">
        <Trans>Die Anfrage wurde abgebrochen. Ihr Stand ist unverändert.</Trans>
      </p>
    </article>
  )
}

/** M3: the application refused the answer. Viewable, never applicable. */
function Refusal({ view }: { view: ModelActionView }) {
  const refusal = view.refusal
  const code = refusal?.code ?? 'invalid_query'
  const details = refusal?.details ?? {}
  const query = view.answer?.kind === 'query' ? view.answer.query : null
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME.void}`}>
      <div role="alert" className="flex flex-col gap-1">
        <p className="flex items-center gap-2">
          <StatusLabel status="refused" detail={t`· nicht anwendbar`} />
          {unchanged()}
        </p>
        <p>{errorText(code, details, refusal?.message)}</p>
      </div>
      {/* The offer of the chain shows only once there is one (plan WP67, E2.5), and
          never on a chain's own refusal. */}
      {CHAIN_AVAILABLE && code === 'not_representable' && view.approach !== 'chain' && (
        <button
          type="button"
          className="text-accent-700 self-start text-sm"
          onClick={() => prefill(view.prompt, 'chain')}
        >
          <Trans>Mit Werkzeugkette versuchen ›</Trans>
        </button>
      )}
      <details className="text-xs">
        <summary className="text-muted cursor-pointer">
          <Trans>Details</Trans>
        </summary>
        <pre className="mt-1 overflow-auto bg-neutral-200 p-2 font-mono whitespace-pre-wrap">
          {technical(code, details)}
        </pre>
      </details>
      {query && (
        <details className="text-sm">
          <summary className="text-muted cursor-pointer text-xs">
            <Trans>Abgewiesene Abfrage ansehen</Trans>
          </summary>
          <div className="mt-1 opacity-70">
            <QueryTree query={query} line="void" />
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => prefill(view.prompt)}>
          <Trans>Prompt ändern</Trans>
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void send(view.prompt, view.approach, view.parent_action_id ?? null)}
        >
          <Trans>Erneut versuchen</Trans>
        </button>
      </div>
    </article>
  )
}

/**
 * An answer whose layer the catalog no longer has (design M11.3): it can no
 * longer be applied, opened in the editor or referred to; the prompt can be
 * sent again as a fresh question.
 */
function Stale({ view, layer }: { view: ModelActionView; layer: string }) {
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME.void}`}>
      <p className="flex flex-wrap items-center justify-between gap-2">
        <StatusLabel status="stale" />
        <span className="text-muted text-xs">
          <Trans>nicht mehr anwendbar</Trans>
        </span>
      </p>
      <p className="text-sm">
        <Trans>
          Die Antwort nutzt den Layer „{layer}“, den es nicht mehr gibt. Sie kann nicht mehr
          angewendet oder im Editor geöffnet werden.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          onClick={() => void send(view.prompt, view.approach, null)}
        >
          <Trans>Prompt erneut senden</Trans>
        </button>
        <button type="button" className="btn" onClick={openMyActions}>
          <Trans>Protokoll</Trans>
        </button>
      </div>
    </article>
  )
}

/**
 * A query answer through its life: waiting for approval (M5), proposal only
 * (M4.1), approved and running (P7), applied (M2.2, M6.1), undone (M2.3,
 * M6.2) or rejected (M5.3).
 */
function Proposal({ view, answer }: { view: ModelActionView; answer: QueryAnswer }) {
  const key = statusKey(view)
  const line = lineStyle(key)
  const applied = view.status === 'applied'
  const handOnly = byHandOnly(view)
  const failed = useHandover((s) => (s.failed?.action === view.id ? s.failed : null))
  const took = seconds(view.latency_ms)
  const approach = approachText(view.approach)
  const count = formatNumber(answer.assumptions.length)
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME[line]}`}>
      <p className="flex flex-wrap items-center gap-2">
        <StatusLabel
          status={key}
          detail={
            applied || view.status === 'rejected'
              ? clockTime(view.decided_at)
              : view.status === 'undone'
                ? clockTime(view.undone_at)
                : handOnly
                  ? t`· von Hand übernehmen`
                  : undefined
          }
          live
        />
        <span className="text-muted ml-auto text-xs">
          {took ? t`${approach} · ${took}` : approach}
        </span>
        {/* Applied: the analysis's hits (M2.2); before, the approval shows the preview (P2). */}
        {applied && <AppliedCount />}
      </p>
      <p>{answer.explanation}</p>
      {answer.assumptions.length > 0 && (
        <section aria-label={t`Annahmen`} className="flex flex-col gap-0.5 text-sm">
          <p className="label-caps">{t`Annahmen · ${count}`}</p>
          <ul className="flex flex-col gap-0.5">
            {answer.assumptions.map((assumption, i) => (
              <Assumption key={i} view={view} assumption={assumption} />
            ))}
          </ul>
        </section>
      )}
      {/* M11.2: the analysis was changed by hand since; a follow-up builds on that. */}
      {applied && view.touched_at && (
        <p className="text-muted text-xs">
          <Trans>danach von Hand geändert</Trans>
        </p>
      )}
      <QueryTree query={view.query ?? answer.query} line={line} />
      {needsApproval(view) && <Approval view={view} />}
      {view.status === 'approved' && <Approved view={view} />}
      {view.status === 'undone' && <Undone view={view} />}
      {view.status === 'rejected' && <Rejected view={view} />}
      <Actions view={view} />
      {handOnly && <ProposalOnly view={view} />}
      {failed && (
        <div className="flex flex-col gap-1 text-sm">
          <ErrorNotice error={failed.error} />
          <p>
            <Trans>
              Die Abfrage ist übernommen, die Entscheidung aber noch nicht im Protokoll vermerkt.
            </Trans>
          </p>
          <button
            type="button"
            className="btn self-start"
            onClick={() => void report(failed.action, failed.body)}
          >
            <Trans>Erneut vermerken</Trans>
          </button>
        </div>
      )}
    </article>
  )
}

/**
 * One assumption with ≈ (F-5.12); "ändern" opens the condition it is about in
 * B2 (design M12.1) when the model named one and it can be opened.
 */
function Assumption({ view, assumption }: { view: ModelActionView; assumption: AssumptionData }) {
  const path = assumption.condition
  // The analysis decides whether an applied answer's row is still there.
  const editable = useAnalysis((s) => s.draft === null && !!path && canEditAssumption(view, path))
  const text = assumption.text
  return (
    <li className="flex items-baseline gap-1.5">
      <span aria-hidden className="text-accent-700">
        ≈
      </span>
      <span className="min-w-0 flex-1">{text}</span>
      {editable && path && (
        <button
          type="button"
          className="text-accent-700 text-xs"
          aria-label={t`Annahme ändern: ${text}`}
          onClick={() => editAssumption(view, path)}
        >
          <Trans>ändern</Trans>
        </button>
      )}
    </li>
  )
}

/** "10 von 137": the hits of the analysis the answer was applied to. */
function AppliedCount() {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const counts = useCounts(analysis)
  if (!counts.data) return null
  return (
    <span className="text-sm tabular-nums" aria-label={t`Trefferzahl der Analyse`}>
      {hitsOf(counts.data.hits, counts.data.total)}
    </span>
  )
}

/**
 * M4.1: why there is no approval, preview or undo: a class of the answer is
 * ``off`` at the level as it was (D1). The level's name is the admin's text.
 */
function ProposalOnly({ view }: { view: ModelActionView }) {
  const level = view.level.name
  const off = classList(view.governance?.off ?? [])
  return (
    <p className="text-muted text-xs">
      {off
        ? t`Stufe ${level}: Das Modell darf hier nur vorschlagen (aus: ${off}). Keine Vorschau, keine Freigabe, kein Zurücknehmen; „Übernehmen“ im Editor ist Ihre Änderung.`
        : t`Stufe ${level}: Das Modell darf hier nur vorschlagen. Keine Vorschau, keine Freigabe, kein Zurücknehmen; „Übernehmen“ im Editor ist Ihre Änderung.`}
    </p>
  )
}

/**
 * The answer's actions. "Zurücknehmen" (M2.2) only for a change the model
 * made (never for one applied by hand, design M4.1 "ohne Rücknahme").
 * "Protokoll" opens the account's own log, "Meine Modellaktionen" (M16.3).
 */
function Actions({ view }: { view: ModelActionView }) {
  const editing = useAnalysis((s) => s.draft !== null)
  const setOpen = useModel((s) => s.setOpen)
  // Applied, its decision not yet reported: "Erneut vermerken", not a second take-over.
  const reporting = useHandover((s) => s.failed?.action === view.id)
  const representable = proposalDraft(view.query, view.id) !== null
  const takeable = !reporting && canTakeOver(view)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {byHandOnly(view) && (
        <button
          type="button"
          className="btn btn-primary"
          disabled={!takeable || editing}
          onClick={() => takeOver(view)}
        >
          <Trans>In Editor übernehmen</Trans>
        </button>
      )}
      {view.status === 'applied' && (
        <button
          type="button"
          className="btn"
          disabled={editing}
          onClick={() => {
            setOpen(false)
            useAnalysis.getState().edit()
          }}
        >
          <Trans>Im Editor öffnen</Trans>
        </button>
      )}
      <UndoAction view={view} />
      <button type="button" className="btn" onClick={openMyActions}>
        <Trans>Protokoll</Trans>
      </button>
      {/* M10.1: ⋯ *Mit Werkzeugkette wiederholen*, and once compared *Vergleich ansehen*. */}
      <CompareMenu view={view} />
      {byHandOnly(view) && !representable && (
        <p className="text-muted w-full text-xs">
          <Trans>Diese Abfrage lässt sich nicht im Editor darstellen.</Trans>
        </p>
      )}
    </div>
  )
}

/**
 * A clarification or a cannot-answer (design M12.2, M13): nothing proposed,
 * the analysis untouched; black line, no status line style (design decision 10).
 */
function Message({ view }: { view: ModelActionView }) {
  const answer = view.answer
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME.message}`}>
      {answer?.kind === 'clarification' ? (
        <Clarification view={view} question={answer.question} options={answer.options} />
      ) : answer?.kind === 'cannot_answer' ? (
        <CannotAnswer view={view} answer={answer} />
      ) : (
        <>
          <p className="flex items-center gap-2">
            <StatusLabel status={statusKey(view)} live />
            {unchanged()}
          </p>
          {answer && 'explanation' in answer && <p>{answer.explanation}</p>}
        </>
      )}
    </article>
  )
}

/**
 * M12.2: the model asks back, with 2–4 options. An option is sent at once as
 * the answer to this question (its record is the parent, P6); "anderes …"
 * leaves the free answer to the field, which then answers the question too.
 * The analysis is not touched.
 */
function Clarification({
  view,
  question,
  options,
}: {
  view: ModelActionView
  question: string
  options: string[]
}) {
  const running = useModel((s) => s.running !== null)
  const sending = usePanel((s) => s.sending)
  const locked = running || sending
  return (
    <>
      <p className="flex items-center gap-2">
        <StatusLabel status="clarification" live />
        {unchanged()}
      </p>
      <p>{question}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t`Antworten`}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className="btn"
            disabled={locked}
            onClick={() => void send(option, view.approach, view.id)}
          >
            {option}
          </button>
        ))}
        <button type="button" className="btn" disabled={locked} onClick={focusPrompt}>
          <Trans>anderes …</Trans>
        </button>
      </div>
      <p className="text-muted text-xs">
        <Trans>Ein Knopf sendet die Antwort sofort; eine eigene Antwort geht über das Feld.</Trans>
      </p>
    </>
  )
}

/**
 * M13: no query from this approach. With ``other_approach`` the model offers
 * the other way of working (M13.1, D6): the button switches the toggle and
 * fills the field with the same prompt, and never sends. Without, it says what
 * is missing and offers nothing (M13.2).
 *
 * In E2.3 the chain cannot be chosen yet: its offer is shown disabled with
 * "ab E2.5" rather than hidden, because the offer is the answer itself (the
 * reason this prompt needs several steps) and matches the disabled chain in
 * the approach toggle. The refusal M3.3, where the offer is only an extra,
 * leaves it out until the chain exists.
 */
function CannotAnswer({
  view,
  answer,
}: {
  view: ModelActionView
  answer: Extract<ModelAnswer, { kind: 'cannot_answer' }>
}) {
  const other = answer.other_approach
  const offer = other && other !== view.approach ? other : null
  const unavailable = offer === 'chain' && !CHAIN_AVAILABLE
  const hint = `offer-${view.id}`
  return (
    <>
      <p className="flex items-center gap-2">
        <StatusLabel
          status="message"
          detail={offer ? t`· Arbeitsweise passt nicht` : t`· nicht beantwortbar`}
          live
        />
        {unchanged()}
      </p>
      <p>{answer.explanation}</p>
      {!offer && answer.missing.length > 0 && (
        <section aria-labelledby={`missing-${view.id}`} className="text-sm">
          <p id={`missing-${view.id}`} className="label-caps">
            <Trans>Es fehlt</Trans>
          </p>
          <ul className="list-disc pl-5">
            {answer.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      {offer && (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={unavailable}
              aria-describedby={hint}
              onClick={() => prefill(view.prompt, offer)}
            >
              {offer === 'chain' ? t`Mit Werkzeugkette versuchen` : t`Als Direktabfrage versuchen`}
            </button>
            {unavailable && (
              <span className="text-muted text-xs">
                <Trans>ab E2.5</Trans>
              </span>
            )}
          </p>
          <p id={hint} className="text-muted text-xs">
            {offer === 'chain'
              ? t`Stellt den Schalter auf Werkzeugkette und setzt denselben Prompt ins Feld. Gesendet wird erst mit Senden.`
              : t`Stellt den Schalter auf Direktabfrage und setzt denselben Prompt ins Feld. Gesendet wird erst mit Senden.`}
          </p>
        </>
      )}
    </>
  )
}
