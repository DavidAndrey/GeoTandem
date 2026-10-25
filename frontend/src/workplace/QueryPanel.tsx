// The global query in the sidebar (design B1): result layer, compact tree,
// "7 von 39", and the restriction "Nur in: Ausschnitt / Fläche" (F-4.3).
import { hitsOf } from '../i18n/phrases'
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Pencil, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { resultLayer } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { newAttributeRow } from '../analysis/tree'
import { useLayers } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { CompactTree } from '../editor/CompactTree'
import { describe } from '../editor/describe'
import { useCounts } from '../editor/useCounts'
import { labelsFor } from '../editor/fields'
import { useMapView } from '../map/view'
import { isMarked } from '../model/origin'
import { ResultSelect } from './ResultSelect'
import { SaveAsCase } from '../admin/evaluation/SaveCaseDialog'

export function QueryPanel() {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const { edit, addNode, draft, setRestriction, origin } = useAnalysis(
    useShallow((s) => ({
      edit: s.edit,
      addNode: s.addNode,
      draft: s.draft,
      setRestriction: s.setRestriction,
      // The origin mark "Modell" per condition (design M2.2, plan P3).
      origin: s.origin,
    })),
  )
  const { bbox, drawing, setDrawing } = useMapView(
    useShallow((s) => ({ bbox: s.bbox, drawing: s.drawing, setDrawing: s.setDrawing })),
  )
  const catalog = useLayers()
  const counts = useCounts(analysis)
  const result = resultLayer(analysis)
  const { fields, labels, filterLabels } = labelsFor(result ?? undefined, catalog.data)
  const restriction = analysis.restriction

  return (
    <section aria-labelledby="query-title">
      <div className="mb-1 flex items-center">
        <h2 id="query-title" className="label-caps flex-1">
          <Trans>Abfrage</Trans>
        </h2>
        {counts.data && (
          <span className="text-sm" aria-label={t`Trefferzahl`}>
            {hitsOf(counts.data.hits, counts.data.total)}
          </span>
        )}
      </div>
      <ResultSelect />
      {result && (
        <div className="card mt-2 p-2 text-sm" aria-label={t`Bedingungen (Übersicht)`}>
          {analysis.tree.children.length === 0 ? (
            <p className="text-muted text-xs">
              <Trans>Keine Bedingung: alle Objekte sind Treffer.</Trans>
            </p>
          ) : (
            <>
              <span className="chip mb-1 text-[11px]">
                {analysis.tree.op === 'and' ? t`UND` : t`ODER`}
              </span>
              <CompactTree
                nodes={analysis.tree.children}
                describe={(n) => describe(n, labels, filterLabels)}
                counts={counts.data?.rows}
                marked={(row) => isMarked(origin, row)}
              />
            </>
          )}
          {!draft && (
            <div className="mt-2 flex justify-between text-xs">
              <button
                type="button"
                className="text-accent-700"
                onClick={() => {
                  edit()
                  addNode('root', newAttributeRow(fields[0]?.name ?? ''))
                }}
              >
                <Trans>+ Bedingung</Trans>
              </button>
              <button type="button" className="text-accent-700" onClick={edit}>
                <Trans>Bearbeiten ›</Trans>
              </button>
            </div>
          )}
        </div>
      )}
      {/* Administrators only (design V3): the analysis as the reference of a new case. */}
      {result && !draft && <SaveAsCase />}
      {result && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5 text-xs"
          aria-label={t`Einschränkung`}
        >
          <span>
            <Trans>Nur in:</Trans>
          </span>
          <button
            type="button"
            className={`chip ${restriction?.kind === 'view' ? 'chip-active' : ''}`}
            aria-pressed={restriction?.kind === 'view'}
            disabled={!bbox}
            onClick={() =>
              setRestriction(restriction?.kind === 'view' || !bbox ? null : { kind: 'view', bbox })
            }
            title={t`Der aktuelle Kartenausschnitt, festgehalten beim Klick`}
          >
            <Trans>Ausschnitt</Trans>
          </button>
          <button
            type="button"
            className={`chip ${restriction?.kind === 'shape' || drawing ? 'chip-active' : ''}`}
            aria-pressed={restriction?.kind === 'shape'}
            onClick={() => setDrawing(drawing ? null : 'polygon')}
            title={t`Eine Fläche auf der Karte zeichnen`}
          >
            <Trans>Fläche</Trans> <Pencil size={11} aria-hidden />
          </button>
          {restriction && (
            <button
              type="button"
              aria-label={t`Einschränkung aufheben`}
              onClick={() => setRestriction(null)}
            >
              <X size={12} />
            </button>
          )}
          {drawing && (
            <span className="text-muted w-full">
              <Trans>Auf der Karte zeichnen; Doppelklick schliesst die Fläche.</Trans>
            </span>
          )}
        </div>
      )}
      <ErrorNotice error={counts.error} />
    </section>
  )
}
