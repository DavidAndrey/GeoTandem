// The dialogue of the prompt panel (design M2, M3, M4, M14): each prompt with
// its answer. The latest answer is shown whole, earlier ones as one line with
// their status. The answer says what the model proposes, what it assumed and
// what has happened; it never changes the analysis itself (P1).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAnalysis } from '../../analysis/store'
import type { ModelActionView, ModelAnswer } from '../../api/client'
import { ErrorNotice } from '../../components/ui'
import { errorText } from '../../i18n/errors'
import { formatNumber } from '../../i18n/locale'
import { StatusLabel } from '../status'
import { dialogueViews, useModel } from '../store'
import { FRAME, lineStyle, statusKey } from '../statusKey'
import { QueryTree } from '../tree'
import { CHAIN_AVAILABLE } from './chain'
import { canTakeOver, report, takeOver, useHandover } from './handover'
import { resumePolling } from './poll'
import { ProblemCard } from './Problem'
import { recordProblem, requestProblem, technical } from './problems'
import { abort, MODEL_CALL_S, prefill, send, usePanel } from './state'
import { clockTime, minutes } from './time'

type QueryAnswer = Extract<ModelAnswer, { kind: 'query' }>

export function Dialogue() {
  const views = useModel(useShallow(dialogueViews))
  const failure = usePanel((s) => s.failure)
  if (views.length === 0 && !failure) return null
  return (
    <ol className="flex flex-col gap-4" aria-label={t`Verlauf`}>
      {views.map((view, i) => (
        <li key={view.id} className="flex flex-col gap-2">
          <PromptLine prompt={view.prompt} at={view.created_at} />
          {i === views.length - 1 && !failure ? <Answer view={view} /> : <Earlier view={view} />}
        </li>
      ))}
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

function PromptLine({ prompt, at }: { prompt: string; at: string | null }) {
  const time = clockTime(at)
  return (
    <div className="border-divider border-l-2 pl-2">
      <p className="label-caps">{time ? t`Prompt · ${time}` : t`Prompt`}</p>
      <p className="whitespace-pre-wrap">{prompt}</p>
    </div>
  )
}

/** An earlier answer: its status and what it said, in one line. */
function Earlier({ view }: { view: ModelActionView }) {
  const answer = view.answer
  const said =
    view.status === 'refused'
      ? errorText(view.refusal?.code ?? 'invalid_query', view.refusal?.details ?? {})
      : answer?.kind === 'clarification'
        ? answer.question
        : (answer && 'explanation' in answer ? answer.explanation : '') || ''
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-sm">
      <StatusLabel status={statusKey(view)} />
      <span className="text-muted min-w-0 truncate" title={said}>
        {said}
      </span>
    </p>
  )
}

export function Answer({ view }: { view: ModelActionView }) {
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
  const [now, setNow] = useState(since)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, (now - since) / 1000)
}

/** M2.1: the model works. Input locked, a timer up to 2:00, "Abbrechen"; no streaming. */
function Thinking({ view }: { view: ModelActionView }) {
  const started = usePanel((s) => s.started[view.id]) ?? Date.parse(view.created_at)
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
      {/* The offer of the chain shows only once there is one (plan WP67, E2.5). */}
      {CHAIN_AVAILABLE && code === 'not_representable' && (
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

const approachText = (approach: ModelActionView['approach']) =>
  approach === 'chain' ? t`Werkzeugkette` : t`Direktabfrage`

function seconds(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  const s = formatNumber(ms / 1000, { maximumFractionDigits: 0 })
  return t`${s} s`
}

/** M2.2, M4.1: a proposed query, applied by hand in E2.3 (P1). */
function Proposal({ view, answer }: { view: ModelActionView; answer: QueryAnswer }) {
  const key = statusKey(view)
  const line = lineStyle(key)
  const applied = view.status === 'applied'
  const failed = useHandover((s) => (s.failed?.action === view.id ? s.failed : null))
  const took = seconds(view.latency_ms)
  const approach = approachText(view.approach)
  const count = formatNumber(answer.assumptions.length)
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME[line]}`}>
      <p className="flex items-center gap-2">
        <StatusLabel status={key} detail={applied ? clockTime(view.decided_at) : undefined} live />
        <span className="text-muted ml-auto text-xs">
          {took ? t`${approach} · ${took}` : approach}
        </span>
      </p>
      <p>{answer.explanation}</p>
      {answer.assumptions.length > 0 && (
        <section aria-label={t`Annahmen`} className="flex flex-col gap-0.5 text-sm">
          <p className="label-caps">{t`Annahmen · ${count}`}</p>
          <ul className="flex flex-col gap-0.5">
            {answer.assumptions.map((assumption, i) => (
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
      <QueryTree query={view.query ?? answer.query} line={line} />
      <Actions view={view} />
      {view.status === 'proposed' && <ProposalOnly view={view} />}
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

/** M4.1: why there is no approval, preview or undo yet (P1). */
function ProposalOnly({ view }: { view: ModelActionView }) {
  const level = view.level.name
  return (
    <p className="text-muted text-xs">
      {t`Stufe ${level}: Das Modell wendet in dieser Ausbaustufe nichts selbst an. Keine Vorschau, keine Freigabe, kein Zurücknehmen; „Übernehmen“ im Editor ist Ihre Änderung.`}
    </p>
  )
}

/**
 * The answer's actions. "Zurücknehmen" (M2.2) is absent: in E2.3 nothing is
 * applied by the model, only by hand (P1, design M4.1 "ohne Rücknahme"); it
 * arrives with E2.4. "Protokoll" is disabled until the log pages (WP73).
 */
function Actions({ view }: { view: ModelActionView }) {
  const editing = useAnalysis((s) => s.draft !== null)
  const setOpen = useModel((s) => s.setOpen)
  const takeable = canTakeOver(view)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {view.status === 'proposed' && (
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
      <button type="button" className="btn" disabled aria-describedby={`log-${view.id}`}>
        <Trans>Protokoll</Trans>
      </button>
      <span id={`log-${view.id}`} className="text-muted text-xs">
        <Trans>ab E2.4</Trans>
      </span>
      {view.status === 'proposed' && !takeable && (
        <p className="text-muted w-full text-xs">
          <Trans>Diese Abfrage lässt sich nicht im Editor darstellen.</Trans>
        </p>
      )}
    </div>
  )
}

/** A clarification or a cannot-answer: nothing proposed, the analysis untouched. */
function Message({ view }: { view: ModelActionView }) {
  const answer = view.answer
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME.message}`}>
      <p className="flex items-center gap-2">
        <StatusLabel status={statusKey(view)} live />
        {unchanged()}
      </p>
      {answer?.kind === 'clarification' && <p>{answer.question}</p>}
      {(answer?.kind === 'cannot_answer' || answer?.kind === 'plan') && <p>{answer.explanation}</p>}
    </article>
  )
}
