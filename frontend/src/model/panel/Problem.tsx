// Failures of a request (design M14): the model unreachable, too slow, its
// answer unreadable, the request limit reached; also a request the server
// refused before writing a record. Always: what happened · "Ihr Stand ist
// unverändert" · an action. The prompt stays in the field (model/store.ts).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { Link } from 'react-router'
import { useChooseLLM, useLLMOptions, useMe } from '../../api/queries'
import { errorText } from '../../i18n/errors'
import { FRAME } from '../statusKey'
import { MODEL_CALL_S } from './state'
import { technical, type Problem } from './problems'
import { minutes } from './time'

/** Codes where trying again changes nothing (design M14.4: no button then). */
const FINAL = [
  'quota_exceeded',
  'llm_rate_limited',
  'llm_quota_exhausted',
  'context_too_large',
  'stale_reference',
]
const LIMIT = ['quota_exceeded', 'llm_rate_limited', 'llm_quota_exhausted']
/** Codes where another connection may help. */
const SWITCH = ['llm_unreachable', 'llm_timeout', 'llm_server_error', 'model_truncated']
/** Codes an administrator can do something about. */
const ADMIN = ['llm_unreachable', 'llm_unauthorized', 'llm_not_found', 'model_truncated', ...LIMIT]
/** Codes with a technical cause worth showing under "Details". */
const DETAILED = ['model_unreadable', 'model_truncated', 'llm_bad_response', 'internal_error']

function title(code: string): string {
  if (code === 'llm_unreachable') return t`Modell nicht erreichbar`
  if (code === 'llm_timeout') return t`Zeitüberschreitung`
  if (code === 'model_unreadable' || code === 'llm_bad_response') return t`Antwort nicht lesbar`
  if (code === 'model_truncated') return t`Antwort abgeschnitten`
  if (LIMIT.includes(code)) return t`Grenzwert erreicht`
  return t`Anfrage nicht ausgeführt`
}

function what(problem: Problem): string {
  const name = problem.connection?.name
  if (problem.code === 'llm_unreachable' && name) return t`Die Anbindung „${name}“ antwortet nicht.`
  if (problem.code === 'llm_timeout') {
    const max = minutes(MODEL_CALL_S)
    return t`Nach ${max} kam keine Antwort. Die Anfrage wurde abgebrochen.`
  }
  const text = errorText(problem.code, problem.details, problem.message)
  // A follow-up's analysis refused (WP81): it is the user's state, × asks without it.
  if (aboutAnalysis(problem))
    return t`Die aktuelle Analyse lässt sich dem Modell so nicht mitgeben: ${text} Fragen Sie ohne Bezug (× über dem Feld).`
  return text
}

/** A refusal of the analysis a follow-up was sent with, not of the model's answer. */
const aboutAnalysis = (problem: Problem) => problem.details.of === 'analysis'

/** Trying again changes nothing: a final code, or the analysis sent along. */
const final = (problem: Problem) => FINAL.includes(problem.code) || aboutAnalysis(problem)

export function ProblemCard({ problem, onRetry }: { problem: Problem; onRetry: () => void }) {
  const me = useMe()
  const { code, connection } = problem
  const host = connection?.locality === 'external' ? connection.host : null
  return (
    <article aria-label={t`Antwort`} className={`card flex flex-col gap-2 p-3 ${FRAME.message}`}>
      <div role="alert" className="flex flex-col gap-1">
        <p className="flex items-start gap-2">
          <strong className="flex-1">{title(code)}</strong>
          {host && <code className="chip font-mono text-[11px]">{host}</code>}
        </p>
        <p>{what(problem)}</p>
        <p className="text-accent-700">
          <Trans>Ihr Stand ist unverändert.</Trans>
        </p>
        {LIMIT.includes(code) && (
          <p className="text-muted text-xs">
            {/* The limit counts per calendar day of the server's time zone (P5). */}
            {code === 'quota_exceeded' && (
              <Trans>Wieder verfügbar ab 00:00 (Zeit des Servers).</Trans>
            )}{' '}
            <Trans>Klassik bleibt nutzbar.</Trans>
          </p>
        )}
      </div>
      {(!final(problem) || SWITCH.includes(code)) && (
        <div className="flex flex-wrap gap-2">
          {!final(problem) && (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              <Trans>Erneut versuchen</Trans>
            </button>
          )}
          {SWITCH.includes(code) && <SwitchConnection current={connection?.id ?? null} />}
        </div>
      )}
      {me.data?.role === 'admin' && ADMIN.includes(code) && (
        <p className="text-muted text-xs">
          <Trans>
            Admin:{' '}
            <Link to="/admin/modelle" className="text-accent-700">
              Modellanbindungen ›
            </Link>
          </Trans>
        </p>
      )}
      {DETAILED.includes(code) && (
        <details className="text-xs">
          <summary className="text-muted cursor-pointer">
            <Trans>Details</Trans>
          </summary>
          <pre className="mt-1 overflow-auto bg-neutral-200 p-2 font-mono whitespace-pre-wrap">
            {technical(code, problem.details)}
          </pre>
        </details>
      )}
    </article>
  )
}

/** "Anbindung wechseln ▾" (M14.1): the other connections the account may use. */
function SwitchConnection({ current }: { current: number | null }) {
  const options = useLLMOptions()
  const choose = useChooseLLM()
  const active = current ?? options.data?.active_connection_id ?? null
  const others = (options.data?.connections ?? []).filter((c) => c.id !== active)
  if (others.length === 0) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="btn flex items-center gap-1">
        <Trans>Anbindung wechseln</Trans> <ChevronDown size={13} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="card z-[1300] min-w-48 bg-neutral-100 py-1 shadow-[var(--shadow-md)]"
        >
          {others.map((c) => (
            <DropdownMenu.Item
              key={c.id}
              className="cursor-pointer px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200"
              onSelect={() => choose.mutate({ connection_id: c.id })}
            >
              {c.name}
              {c.locality === 'external' && (
                <span className="text-muted block font-mono text-xs">{c.host}</span>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
