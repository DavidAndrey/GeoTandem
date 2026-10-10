// The readable condition tree of Modus B (design M2 answer, M5 approval, M15
// editor): the sidebar's compact tree (editor/CompactTree.tsx) with the origin
// mark "Modell" per condition (plan P3), and the query object as JSON only
// under "Technisch". Read-only.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useShallow } from 'zustand/react/shallow'
import type { DisplayLayer } from '../analysis/model'
import { resultLayer } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { useLayers } from '../api/queries'
import { CompactTree } from '../editor/CompactTree'
import { describe } from '../editor/describe'
import { labelsFor } from '../editor/fields'
import { isMarked, type Origin } from './origin'
import { readQuery, type ReadGroup } from './readable'
import { FRAME, type LineStyle } from './statusKey'

/** A catalog layer as the result of a query object. */
const catalogResult = (layer: string): DisplayLayer => ({
  id: layer,
  source: { kind: 'catalog', layer },
  visible: true,
  opacity: 1,
  symbology: null,
})

/**
 * A condition tree in plain language. ``result`` is the layer whose fields the
 * conditions use; ``origin`` shows the mark on the rows it holds.
 */
export function ConditionTree({
  result,
  tree,
  origin,
  counts,
  line,
}: {
  result: DisplayLayer | null
  tree: ReadGroup
  origin?: Origin
  counts?: Map<string, number>
  /** The status line style of the box (design: dashed while a proposal). */
  line?: LineStyle
}) {
  const catalog = useLayers().data
  const { labels, filterLabels } = labelsFor(result ?? undefined, catalog)
  return (
    <div
      role="group"
      aria-label={t`Bedingungen`}
      className={`rounded-[var(--radius-md)] p-2 text-sm ${line ? FRAME[line] : 'border-divider border'}`}
    >
      {tree.children.length === 0 ? (
        <p className="text-muted text-xs">
          <Trans>Keine Bedingung: alle Objekte sind Treffer.</Trans>
        </p>
      ) : (
        <>
          <span className="chip mb-1 text-[11px]">{tree.op === 'and' ? t`UND` : t`ODER`}</span>
          <CompactTree
            nodes={tree.children}
            describe={(node) => describe(node, labels, filterLabels)}
            counts={counts}
            marked={origin && ((row) => isMarked(origin, row))}
          />
        </>
      )}
    </div>
  )
}

/** The analysis's conditions with their origin marks (design M2.2 sidebar, M15). */
export function AnalysisConditions() {
  const { tree, origin, result } = useAnalysis(
    useShallow((s) => ({
      tree: s.draft ?? s.tree,
      origin: s.origin,
      result: resultLayer(currentAnalysis(s)),
    })),
  )
  return <ConditionTree result={result} tree={tree} origin={origin} />
}

/** A query object as the answer shows it (design M2): result layer, tree, "Technisch". */
export function QueryTree({ query, line }: { query: unknown; line?: LineStyle }) {
  const read = readQuery(query)
  const catalog = useLayers().data
  const source = read.source
  const title = source ? (catalog?.find((l) => l.name === source)?.title ?? source) : null
  const extra = read.extra.join(', ')
  return (
    <div className="flex flex-col gap-1">
      <p className="label-caps">{title ? t`Abfrage · Ergebnis ${title}` : t`Abfrage`}</p>
      <ConditionTree result={source ? catalogResult(source) : null} tree={read.tree} line={line} />
      {extra && (
        <p className="text-muted text-xs">{t`Ausserdem, nur unter „Technisch“: ${extra}`}</p>
      )}
      <details className="text-xs">
        <summary className="text-muted cursor-pointer">
          <Trans>Technisch (Abfrageobjekt JSON)</Trans>
        </summary>
        <pre className="mt-1 overflow-auto bg-neutral-200 p-2 font-mono">
          {JSON.stringify(query, null, 2)}
        </pre>
      </details>
    </div>
  )
}
