// The result of opening a session, under the header (design C4, C8):
// identical closes by itself, a deviation stays until decided.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader, X } from 'lucide-react'
import { useEffect } from 'react'
import { useLayers } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { saveSession } from './actions'
import { noticeOf } from './notice'
import { useSession } from './store'
import { sessionKeys } from './ui'

const CLOSE_AFTER_MS = 6000

export function OpenNotice() {
  const report = useSession((s) => s.report)
  const setReport = useSession((s) => s.setReport)
  const client = useQueryClient()
  const catalog = useLayers()
  const title = (name: string) => catalog.data?.find((l) => l.name === name)?.title ?? name
  const notice = report ? noticeOf(report, title) : null
  const adopt = useMutation({
    mutationFn: saveSession,
    onSuccess: () => {
      setReport(null)
      return client.invalidateQueries({ queryKey: sessionKeys.list })
    },
  })

  useEffect(() => {
    if (!notice?.autoClose) return
    const timer = setTimeout(() => setReport(null), CLOSE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [notice?.autoClose, report, setReport])

  if (!notice) return null
  const Icon = { pending: Loader, ok: Check, warn: AlertTriangle, error: AlertTriangle }[
    notice.tone
  ]
  return (
    <section
      role={notice.tone === 'ok' || notice.tone === 'pending' ? 'status' : 'alert'}
      aria-label={t`Ergebnisprüfung`}
      className={`border-divider flex items-start gap-3 border-b px-4 py-2 text-sm ${notice.tone === 'warn' || notice.tone === 'error' ? 'bg-accent-100' : ''}`}
    >
      <Icon
        size={16}
        aria-hidden
        className={`mt-0.5 shrink-0 ${notice.tone === 'ok' ? 'text-accent-700' : notice.tone === 'pending' ? 'animate-spin' : 'text-accent-700'}`}
      />
      <div className="flex flex-1 flex-col gap-1">
        <p className={notice.tone === 'ok' ? '' : 'font-semibold'}>{notice.headline}</p>
        {notice.lines.map((line) => (
          <p key={line} className="text-muted">
            {line}
          </p>
        ))}
        {(notice.adopt || notice.chooseResult) && (
          <div className="mt-1 flex gap-2">
            {notice.chooseResult && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setReport(null)
                  document
                    .querySelector<HTMLSelectElement>(`[aria-label="${t`Ergebnis-Layer`}"]`)
                    ?.focus()
                }}
              >
                <Trans>Anderen Ergebnis-Layer wählen</Trans>
              </button>
            )}
            {notice.adopt && (
              <button
                type="button"
                className="btn"
                disabled={adopt.isPending}
                onClick={() => adopt.mutate()}
                title={t`Speichert die Sitzung mit dem heutigen Ergebnis als neuen Stempel.`}
              >
                <Trans>Mit aktuellen Daten übernehmen</Trans>
              </button>
            )}
          </div>
        )}
        {adopt.isError && <ErrorNotice error={adopt.error} />}
      </div>
      <button
        type="button"
        className="text-muted hover:text-ink"
        aria-label={t`Hinweis schliessen`}
        onClick={() => setReport(null)}
      >
        <X size={15} />
      </button>
    </section>
  )
}
