// The global query in the sidebar (design B1): result layer, compact tree,
// "7 von 39", and the restriction "Nur in: Ausschnitt / Fläche" (F-4.3).
import { Pencil, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Node } from '../analysis/model'
import { resultLayer } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { newAttributeRow } from '../analysis/tree'
import { useLayers } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { describe } from '../editor/describe'
import { useCounts } from '../editor/useCounts'
import { catalogFields, fieldsOf, labelOf } from '../editor/fields'
import { useMapView } from '../map/view'
import { ResultSelect } from './ResultSelect'

export function QueryPanel() {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const { edit, addNode, draft, setRestriction } = useAnalysis(
    useShallow((s) => ({
      edit: s.edit,
      addNode: s.addNode,
      draft: s.draft,
      setRestriction: s.setRestriction,
    })),
  )
  const { bbox, drawing, setDrawing } = useMapView(
    useShallow((s) => ({ bbox: s.bbox, drawing: s.drawing, setDrawing: s.setDrawing })),
  )
  const catalog = useLayers()
  const counts = useCounts(analysis)
  const result = resultLayer(analysis)
  const fields = fieldsOf(result ?? undefined, catalog.data)
  const labels = {
    field: labelOf(fields),
    layer: (name: string) => catalog.data?.find((l) => l.name === name)?.title ?? name,
  }
  const filterLabels = (layer: string) => ({
    ...labels,
    field: labelOf(catalogFields(layer, catalog.data)),
  })
  const restriction = analysis.restriction

  return (
    <section aria-labelledby="query-title">
      <div className="mb-1 flex items-center">
        <h2 id="query-title" className="label-caps flex-1">
          Abfrage
        </h2>
        {counts.data && (
          <span className="text-sm" aria-label="Trefferzahl">
            {counts.data.hits} von {counts.data.total}
          </span>
        )}
      </div>
      <ResultSelect />
      {result && (
        <div className="card mt-2 p-2 text-sm" aria-label="Bedingungen (Übersicht)">
          {analysis.tree.children.length === 0 ? (
            <p className="text-muted text-xs">Keine Bedingung: alle Objekte sind Treffer.</p>
          ) : (
            <>
              <span className="chip mb-1 text-[11px]">
                {analysis.tree.op === 'and' ? 'UND' : 'ODER'}
              </span>
              <CompactTree
                nodes={analysis.tree.children}
                describe={(n) => describe(n, labels, filterLabels)}
                counts={counts.data?.rows}
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
                + Bedingung
              </button>
              <button type="button" className="text-accent-700" onClick={edit}>
                Bearbeiten ›
              </button>
            </div>
          )}
        </div>
      )}
      {result && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5 text-xs"
          aria-label="Einschränkung"
        >
          <span>Nur in:</span>
          <button
            type="button"
            className={`chip ${restriction?.kind === 'view' ? 'chip-active' : ''}`}
            aria-pressed={restriction?.kind === 'view'}
            disabled={!bbox}
            onClick={() =>
              setRestriction(restriction?.kind === 'view' || !bbox ? null : { kind: 'view', bbox })
            }
            title="Der aktuelle Kartenausschnitt, festgehalten beim Klick"
          >
            Ausschnitt
          </button>
          <button
            type="button"
            className={`chip ${restriction?.kind === 'shape' || drawing ? 'chip-active' : ''}`}
            aria-pressed={restriction?.kind === 'shape'}
            onClick={() => setDrawing(drawing ? null : 'polygon')}
            title="Eine Fläche auf der Karte zeichnen"
          >
            Fläche <Pencil size={11} aria-hidden />
          </button>
          {restriction && (
            <button
              type="button"
              aria-label="Einschränkung aufheben"
              onClick={() => setRestriction(null)}
            >
              <X size={12} />
            </button>
          )}
          {drawing && (
            <span className="text-muted w-full">
              Auf der Karte zeichnen; Doppelklick schliesst die Fläche.
            </span>
          )}
        </div>
      )}
      <ErrorNotice error={counts.error} />
    </section>
  )
}

function CompactTree({
  nodes,
  describe,
  counts,
}: {
  nodes: Node[]
  describe: (node: Node) => string
  counts: Map<string, number> | undefined
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) => (
        <li key={node.id} className="flex flex-col">
          <span className="flex items-baseline gap-1.5">
            <span className="text-muted w-3 text-[10px]">
              {node.kind === 'attribute' ? 'A' : node.kind === 'group' ? 'G' : 'R'}
            </span>
            <span className="flex-1">{describe(node)}</span>
            {node.kind !== 'group' && (
              <span className="text-muted text-xs">{counts?.get(node.id) ?? ''}</span>
            )}
          </span>
          {node.kind === 'group' && (
            <div className="border-divider ml-3 border-l pl-2">
              <CompactTree nodes={node.children} describe={describe} counts={counts} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
