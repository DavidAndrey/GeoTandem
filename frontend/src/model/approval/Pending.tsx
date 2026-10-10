// The open proposal in the sidebar (design M5.1, M5.2, M7.3): "Vorschlag offen
// · 3 Bedingungen · Vorschau 10 · wird erst bei Annehmen übernommen". The
// sidebar's query stays the analysis's until then; this says what waits.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { rows } from '../../analysis/tree'
import { formatNumber } from '../../i18n/locale'
import { proposalDraft } from '../panel/draft'
import { FRAME } from '../statusKey'
import { useModel } from '../store'
import { conditionCount } from './governance'
import { awaiting, usePreview } from './waiting'

export function PendingProposal() {
  const view = useModel(awaiting)
  const preview = usePreview(view)
  if (!view) return null
  const draft = proposalDraft(view.query, view.id)
  const conditions = conditionCount(draft ? rows(draft.tree).length : 0)
  const count = preview.data ? formatNumber(preview.data.count) : null
  return (
    <div
      role="note"
      aria-label={t`Vorschlag offen`}
      className={`flex flex-col gap-1 rounded p-2 text-xs ${FRAME.dashed}`}
    >
      <span className="border-accent text-accent-700 self-start rounded-full border border-dashed px-2">
        <Trans>Vorschlag offen</Trans>
      </span>
      <p>{count === null ? conditions : t`${conditions} · Vorschau ${count}`}</p>
      <p className="text-muted">
        <Trans>wird erst bei Annehmen übernommen</Trans>
      </p>
    </div>
  )
}
