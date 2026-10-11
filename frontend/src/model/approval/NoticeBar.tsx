// M6.1: the notice bar at the map after an ``auto`` answer was applied:
// "Modell hat angewendet: … · Rückgängig · Änderung ansehen". It stays until
// the analysis changes next (by hand, or by the next model change); × only
// hides it, the answer keeps its undo.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Analysis } from '../../analysis/model'
import { emptyTree, resultLayer } from '../../analysis/query'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import { rows } from '../../analysis/tree'
import { useLayers } from '../../api/queries'
import { ErrorNotice } from '../../components/ui'
import { useCounts } from '../../editor/useCounts'
import { describe } from '../../editor/describe'
import { labelsFor } from '../../editor/fields'
import { formatNumber } from '../../i18n/locale'
import { hitsOf } from '../../i18n/phrases'
import { clockTime } from '../panel/time'
import { StatusLabel } from '../status'
import { FRAME } from '../statusKey'
import { useModel } from '../store'
import { ChangeLines } from './Approval'
import { changeList } from './changes'
import { hideNotice, undo, useApproval, type LastChange } from './flow'

/** No analysis: nothing to count while the list is closed. */
const NOTHING: Analysis = { layers: [], result: null, tree: emptyTree(), restriction: null }

/**
 * Shown only after an auto change nobody has touched since; costs nothing
 * otherwise. The live region stays mounted, so a screen reader announces the
 * bar when it appears (a region added with its text is often not read).
 */
export function NoticeBar() {
  const last = useApproval((s) => s.last)
  const shown = last !== null && last.auto && !last.touched && !last.hidden
  return (
    <>
      <p role="status" className="sr-only">
        {shown &&
          t`Modell hat angewendet. Rückgängig und die Änderung in der Hinweisleiste an der Karte.`}
      </p>
      {shown && <Notice last={last} />}
    </>
  )
}

function Notice({ last }: { last: LastChange }) {
  const busy = useApproval((s) => s.busy !== null)
  const failure = useApproval((s) =>
    s.failure?.action === last.action && s.failure.step === 'undo' ? s.failure.error : null,
  )
  const view = useModel((s) => s.views[last.action])
  const editing = useAnalysis((s) => s.draft !== null)
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const catalog = useLayers().data
  const counts = useCounts(analysis)
  const [open, setOpen] = useState(false)
  const before = useCounts(open ? last.before : NOTHING)

  const { labels, filterLabels } = labelsFor(resultLayer(analysis) ?? undefined, catalog)
  const said = rows(analysis.tree)
    .map((row) => describe(row, labels, filterLabels))
    .join(', ')
  const hits = counts.data ? hitsOf(counts.data.hits, counts.data.total) : ''
  // Before without conditions (or another layer): all objects of the result count.
  const hitsBefore =
    before.data && last.before.result === analysis.result
      ? formatNumber(before.data.hits)
      : counts.data && last.before.result !== analysis.result
        ? formatNumber(counts.data.total)
        : '…'
  const hitsAfter = counts.data ? formatNumber(counts.data.hits) : '…'
  const changes =
    analysis.result === null
      ? []
      : changeList(last.before, { result: analysis.result, tree: analysis.tree }, catalog)
  return (
    <aside
      id="model-notice"
      aria-label={t`Modell hat angewendet`}
      className={`card absolute top-3 right-14 left-3 z-[1100] flex flex-col gap-2 p-3 text-sm shadow-[var(--shadow-md)] ${FRAME.applied}`}
    >
      <div className="flex items-start gap-2">
        <StatusLabel status="auto" detail={clockTime(view?.decided_at) || undefined} />
        <p className="min-w-0 flex-1">
          {hits ? t`Modell hat angewendet: ${said} · ${hits}` : t`Modell hat angewendet: ${said}`}
        </p>
        <button
          type="button"
          className="text-muted"
          aria-label={t`Hinweis ausblenden`}
          title={t`Hinweis ausblenden; Rückgängig bleibt in der Antwort`}
          onClick={hideNotice}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          // While the editor is open, undo would drop its draft: close it first.
          disabled={busy || editing}
          onClick={() => void undo(last.action)}
        >
          <Trans>Rückgängig</Trans>
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          aria-controls="model-notice-changes"
          onClick={() => setOpen(!open)}
        >
          <Trans>Änderung ansehen</Trans>
        </button>
      </div>
      {open && (
        <div id="model-notice-changes" className="rounded bg-neutral-200 p-2">
          <ChangeLines changes={changes} />
          <p className="mt-1 font-mono text-xs" aria-label={t`Trefferzahl vorher und nachher`}>
            {t`Treffer: ${hitsBefore} → ${hitsAfter}`}
          </p>
        </div>
      )}
      <ErrorNotice error={failure} />
    </aside>
  )
}
