// One entry of the model log (design M16.2, F-6.9): the request as it was
// asked, with level and connection as they were then (H7), the answer with
// its assumptions and query, the steps of a chain, the decision with its
// time, and the hashes that tie it to level, layer profile and prompt.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import type { ModelActionView, OpClass, StepView } from '../api/client'
import { ErrorNotice, Loading } from '../components/ui'
import { LocalityBadge } from '../components/LocalityBadge'
import { errorText, type Details } from '../i18n/errors'
import { formatNumber } from '../i18n/locale'
import { useLogEntry } from '../model/log/queries'
import { approachText, decisionText, entryOutcome, modeText, reasonText } from '../model/log/words'
import { StatusLabel } from '../model/status'
import { statusKey } from '../model/statusKey'
import { QueryTree } from '../model/tree'
import { clockTime } from '../model/panel/time'
import { formatDateTime } from './format'

const CLASSES: OpClass[] = ['catalog', 'query', 'spatial', 'derive', 'display']

/** A row of the entry: a small caps label and its value (design M16.2). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] gap-3 py-1">
      <dt className="label-caps pt-0.5">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function Hash({ value }: { value: string }) {
  return <code className="font-mono text-xs break-all">{value}</code>
}

/** "6 s", "0,4 s". */
function seconds(ms: number): string {
  const s = formatNumber(ms / 1000, { maximumFractionDigits: 1 })
  return t`${s} s`
}

/** "10 Treffer". */
function hits(count: number): string {
  const n = formatNumber(count)
  return t`${n} Treffer`
}

export function ModelActionPage() {
  const { id } = useParams()
  const entry = useLogEntry(Number(id))
  return (
    <section aria-labelledby="model-entry-title">
      <p className="text-muted mb-1 text-sm">
        <Link to="/admin/modellprotokoll" className="hover:text-accent-700">
          <Trans>Modellprotokoll</Trans>
        </Link>{' '}
        ›
      </p>
      {entry.isPending && <Loading />}
      <ErrorNotice error={entry.error} />
      {entry.data && <Entry view={entry.data} />}
    </section>
  )
}

function Entry({ view }: { view: ModelActionView }) {
  const when = formatDateTime(view.created_at)
  const account = view.account
  const answer = view.answer
  const assumptions = answer && 'assumptions' in answer ? answer.assumptions : []
  // A refused answer's query is kept for inspection (design M3): the raw one.
  const query = view.query ?? (answer?.kind === 'query' ? answer.query : null)
  const latency = view.latency_ms ?? null
  const parent = view.parent_action_id
  const matrix = CLASSES.filter((c) => c in view.level.matrix)
    .map((c) => `${c} ${modeText(view.level.matrix[c])}`)
    .join(' · ')
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="model-entry-title" className="mr-auto text-2xl">
          <Trans>
            {when} · {account}
          </Trans>
        </h2>
        <StatusLabel status={statusKey(view)} detail={clockTime(view.decided_at ?? null)} />
      </div>
      <dl className="max-w-4xl text-sm">
        <Row label={t`Prompt`}>
          <p className="whitespace-pre-wrap">{view.prompt}</p>
        </Row>
        <Row label={t`Stufe damals`}>
          <span className="font-semibold">{view.level.name}</span> · {matrix} ·{' '}
          <Hash value={view.level.prompt_hash} />
        </Row>
        <Row label={t`Anbindung`}>
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {view.connection.name} · {view.connection.model}
            </span>
            <LocalityBadge locality={view.connection.locality} host={view.connection.host} />
          </span>
        </Row>
        <Row label={t`Arbeitsweise`}>
          {approachText(view.approach)}
          {latency !== null && ` · ${seconds(latency)}`}
        </Row>
        {parent != null && (
          <Row label={t`Folgt auf`}>
            <Link to={`/admin/modellprotokoll/${parent}`} className="text-accent-700">
              {t`Eintrag ${parent}`}
            </Link>
            {view.reference === 'hand_edited' && ` · ${t`Stand von Hand geändert`}`}
          </Row>
        )}
        {answer && answer.kind !== 'clarification' && (
          <Row label={t`Erläuterung`}>{answer.explanation}</Row>
        )}
        {answer?.kind === 'clarification' && (
          <Row label={t`Rückfrage`}>
            {answer.question}
            <ul className="text-muted mt-1 list-disc pl-5">
              {answer.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          </Row>
        )}
        {answer?.kind === 'cannot_answer' && answer.missing.length > 0 && (
          <Row label={t`Was fehlt`}>{answer.missing.join(' · ')}</Row>
        )}
        <Row label={t`Annahmen`}>
          {assumptions.length === 0 ? (
            <span className="text-muted">{t`keine`}</span>
          ) : (
            <ul>
              {assumptions.map((assumption, i) => (
                <li key={i} className="flex items-baseline gap-1.5">
                  <span aria-hidden className="text-accent-700">
                    ≈
                  </span>
                  {assumption.text}
                </li>
              ))}
            </ul>
          )}
        </Row>
        {view.refusal && (
          <Row label={t`Abgewiesen`}>
            {errorText(view.refusal.code, view.refusal.details as Details, view.refusal.message)}{' '}
            <code className="font-mono text-xs">{view.refusal.code}</code>
          </Row>
        )}
        {view.error && (
          <Row label={t`Fehler`}>
            {typeof view.error.code === 'string'
              ? errorText(view.error.code, (view.error.details ?? {}) as Details)
              : t`unbekannt`}
          </Row>
        )}
        {query && (
          <Row label={t`Abfrage`}>
            <QueryTree query={query} />
          </Row>
        )}
        {view.applied_query && (
          <Row label={t`Angewendet stattdessen`}>
            <QueryTree query={view.applied_query} />
          </Row>
        )}
        {view.approach === 'chain' && (
          <Row label={t`Schritte`}>
            <Steps steps={view.steps} />
          </Row>
        )}
        <Row label={t`Entscheidung`}>
          <Decision view={view} />
        </Row>
        <Row label={t`Ergebnis`}>{view.stamp ? hits(view.stamp.count) : '–'}</Row>
        <Row label={t`Layer-Steckbrief`}>
          <Hash value={view.profile_hash} />
        </Row>
        <Row label={t`Prompt-Hash`}>
          <Hash value={view.prompt_hash} />
        </Row>
      </dl>
      <p className="text-muted mt-3 text-xs">
        <Trans>Stufe und Anbindung so, wie sie zum Zeitpunkt der Anfrage waren.</Trans>
      </p>
    </>
  )
}

function Decision({ view }: { view: ModelActionView }) {
  if (!view.decision) return <>{entryOutcome(view)}</>
  const decided = formatDateTime(view.decided_at)
  const decision = decisionText(view.decision)
  const undone = view.undone_at ? formatDateTime(view.undone_at) : null
  const previewed = view.previewed_at ? formatDateTime(view.previewed_at) : null
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <Trans>
          {decision} {decided}
        </Trans>
        {view.reject_reason && ` · ${reasonText(view.reject_reason)}`}
        {view.applied_by_hand && ` · ${t`von Hand übernommen`}`}
      </span>
      {undone && <span className="text-muted">{t`zurückgenommen ${undone}`}</span>}
      {previewed && <span className="text-muted">{t`Vorschau ${previewed}`}</span>}
    </div>
  )
}

/** The chain's steps (design M16.2 "Schritte bei Kette"): call, result, what the model saw. */
function Steps({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) return <span className="text-muted">{t`keine Schritte`}</span>
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((step) => (
        <li key={step.position} className="flex flex-wrap items-baseline gap-2">
          <span className="tabular-nums">{formatNumber(step.position)}.</span>
          <span>{step.text}</span>
          <code className="font-mono text-xs">{step.tool}</code>
          <span className="text-muted">{step.status}</span>
          {step.hits != null && <span>{hits(step.hits)}</span>}
          {step.model_view && (
            <span className="font-mono text-xs">
              {t`Modell sieht`}: {modelSees(step.model_view)}
            </span>
          )}
          {step.duration_ms != null && (
            <span className="text-muted">{seconds(step.duration_ms)}</span>
          )}
        </li>
      ))}
    </ol>
  )
}

/** ``ok · nicht leer · 10`` as the model got it (D9): flags, a code, a count. */
const modelSees = (seen: NonNullable<StepView['model_view']>) =>
  [
    seen.outcome,
    seen.code,
    seen.part,
    seen.empty == null ? null : seen.empty ? t`leer` : t`nicht leer`,
    seen.count == null ? null : String(seen.count),
  ]
    .filter(Boolean)
    .join(' · ')
