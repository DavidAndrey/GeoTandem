// Parts of the model connection pages (plan E2.1, C12): the steps of a
// connection test, the last test and the newest run that measured it.
import { plural, t } from '@lingui/core/macro'
import { Check, Minus, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { CheckResult, CheckStep, ConnectionInfo } from '../api/client'
import { errorText } from '../i18n/errors'
import { formatNumber } from '../i18n/locale'
import { useLastRun } from './evaluation/runs'
import { RunStatusLabel } from './evaluation/RunsPage'
import { formatDate, formatDateTime } from './format'

const stepLabel = (name: CheckStep['name']) =>
  ({
    url: t`Adresse gültig`,
    reachable: t`Erreichbar`,
    authorised: t`Zugang angenommen`,
    model: t`Modell vorhanden`,
    server: t`Ollama-Version`,
    json_schema: t`Antwort nach JSON-Schema`,
    tool_call: t`Werkzeugaufruf`,
  })[name]

const seconds = (ms: unknown) => {
  const s = formatNumber(Number(ms) / 1000, { maximumFractionDigits: 1 })
  return t`${s} s`
}

function stepDetail(step: CheckStep): string {
  const d = step.details ?? {}
  if (step.status === 'failed') return errorText(step.code ?? 'internal_error', d)
  if (step.status === 'skipped') return step.name === 'server' ? t`kein Ollama` : ''
  switch (step.name) {
    case 'url':
      return String(d.host ?? '')
    case 'reachable': {
      const count = Number(d.models ?? 0)
      return plural(count, { one: '# Modell angeboten', other: '# Modelle angeboten' })
    }
    case 'model': {
      const digest = String(d.digest ?? '')
        .replace('sha256:', '')
        .slice(0, 12)
      const gb = formatNumber(Number(d.size ?? 0) / 1e9, { maximumFractionDigits: 1 })
      return d.digest ? t`${digest} · ${gb} GB` : ''
    }
    case 'server': {
      const version = String(d.ollama ?? '')
      return t`Ollama ${version}`
    }
    default:
      return seconds(d.latency_ms)
  }
}

const STEP_ICON: Record<CheckStep['status'], ReactNode> = {
  ok: <Check size={14} aria-hidden className="text-accent-700" />,
  failed: <X size={14} aria-hidden className="text-danger" />,
  skipped: <Minus size={14} aria-hidden className="text-muted" />,
}

const statusWord = (s: CheckStep['status']) =>
  ({ ok: t`in Ordnung`, failed: t`fehlgeschlagen`, skipped: t`übersprungen` })[s]

export function CheckSteps({ result, title }: { result: CheckResult; title: string }) {
  const when = formatDateTime(result.tested_at)
  return (
    <section aria-label={title} className="card my-3 max-w-2xl p-3 text-sm">
      <p className="mb-2 font-semibold">
        {result.ok ? t`Verbindungstest bestanden` : t`Verbindungstest nicht bestanden`}{' '}
        <span className="text-muted font-normal">{when}</span>
      </p>
      <ol>
        {result.steps.map((step) => (
          <li key={step.name} className="flex gap-2 py-0.5">
            <span className="mt-0.5" title={statusWord(step.status)}>
              {STEP_ICON[step.status]}
            </span>
            <span className="w-48 shrink-0">
              {stepLabel(step.name)}
              <span className="sr-only">: {statusWord(step.status)}</span>
            </span>
            <span className={step.status === 'failed' ? 'text-danger' : 'text-muted'}>
              {stepDetail(step)}
              {step.cause && (
                <code className="text-muted ml-2 text-xs" title={t`Ursache`}>
                  {step.cause}
                </code>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function LastTest({ connection }: { connection: ConnectionInfo }) {
  const last = connection.last_test
  if (!last) return <span className="text-muted">–</span>
  const when = formatDateTime(last.tested_at)
  return (
    <span className="flex items-center gap-1">
      {last.ok ? STEP_ICON.ok : STEP_ICON.failed}
      {last.ok ? t`bestanden` : t`nicht bestanden`}
      <span className="text-muted text-xs">{when}</span>
    </span>
  )
}

/** "zuletzt bewertet" (O7, design review 6): the newest run that measured it, with a link. */
export function LastRun({ connection }: { connection: ConnectionInfo }) {
  const last = useLastRun(connection.id)
  if (last.isPending) return <span className="text-muted">…</span>
  if (last.isError) return <span className="text-muted">–</span>
  if (!last.data) return <span className="text-muted">{t`noch nie`}</span>
  const run = last.data
  const id = run.id
  const when = formatDate(run.started_at)
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Link to={`/admin/bewertung/lauf/${id}`} className="text-accent-700 tabular-nums">
        {t`Lauf #${id}`}
      </Link>
      <span className="text-muted text-xs">{when}</span>
      {run.status !== 'done' && <RunStatusLabel status={run.status} />}
    </span>
  )
}
