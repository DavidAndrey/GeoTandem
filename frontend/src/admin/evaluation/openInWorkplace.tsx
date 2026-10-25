// "Im Arbeitsplatz öffnen" (design V2.1, V7.2): a case's reference or a run's
// answer becomes the workplace's query, as a saved query opens (B1), with the
// question before unsaved conditions are dropped.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { QueryPart } from '../../analysis/model'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import { ConfirmDialog } from '../../components/ui'
import { wouldLose } from '../../queries/part'
import { useSession } from '../../session/store'

/**
 * Replaces the workplace's query with ``part`` and goes there (the open session,
 * if any); asks first when unsaved conditions would be lost. ``answer``: the
 * query opened is a model answer of a run (V7.2), not a case's reference.
 */
export function useOpenInWorkplace() {
  const navigate = useNavigate()
  const [pending, setPending] = useState<{ part: QueryPart; answer: boolean } | null>(null)
  const go = (part: QueryPart) => {
    useAnalysis.getState().applyQuery(part, null)
    const session = useSession.getState().current
    navigate(session ? `/sitzung/${session.id}` : '/')
  }
  const open = (part: QueryPart, answer = false) => {
    const s = useAnalysis.getState()
    // As a saved query opens (B1): unsaved conditions are not dropped without a question.
    if (wouldLose(currentAnalysis(s), s.queryRef)) setPending({ part, answer })
    else go(part)
  }
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(next) => !next && setPending(null)}
      title={t`Abfrage im Arbeitsplatz ersetzen?`}
      confirm={t`Ersetzen`}
      onConfirm={() => pending && go(pending.part)}
    >
      {pending?.answer ? (
        <Trans>
          Die Abfrage im Arbeitsplatz hat ungespeicherte Bedingungen. Sie wird durch die Abfrage
          dieser Antwort ersetzt.
        </Trans>
      ) : (
        <Trans>
          Die Abfrage im Arbeitsplatz hat ungespeicherte Bedingungen. Sie wird durch die Referenz
          des Prüffalls ersetzt.
        </Trans>
      )}
    </ConfirmDialog>
  )
  return { open, dialog }
}
