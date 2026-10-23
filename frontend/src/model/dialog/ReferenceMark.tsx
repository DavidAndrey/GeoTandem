// The reference mark above the prompt field (design M11.1, M11.2): what the next
// prompt builds on, with × to ask without it. See ``reference.ts``.
import { t } from '@lingui/core/macro'
import { useShallow } from 'zustand/react/shallow'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import type { ModelActionView } from '../../api/client'
import { useCounts } from '../../editor/useCounts'
import { hitsOf } from '../../i18n/phrases'
import { useModel } from '../store'
import { referenceKind } from './reference'

export function ReferenceMark({ view }: { view: ModelActionView }) {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const counts = useCounts(analysis).data
  const setReference = useModel((s) => s.setReference)
  const kind = referenceKind(view, analysis)
  const what = kind === 'last_answer' ? t`Bezug: letzte Antwort` : t`Bezug: aktuelle Analyse`
  const label = counts ? `${what} · ${hitsOf(counts.hits, counts.total)}` : what
  return (
    <p className="flex items-center gap-1">
      <span className="chip text-xs" data-reference={kind}>
        {label}
        <button
          type="button"
          className="ml-1"
          aria-label={t`Ohne Bezug fragen`}
          title={t`Ohne Bezug fragen`}
          onClick={() => setReference(null)}
        >
          ×
        </button>
      </span>
    </p>
  )
}
