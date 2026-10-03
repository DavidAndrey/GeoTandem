// "Ergebnis: Schulen ▾" (design B1, B2), with the confirmation of B13 when
// attribute conditions would drop out.
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { canBeResult } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { rows } from '../analysis/tree'
import { useLayers } from '../api/queries'
import { ConfirmDialog } from '../components/ui'
import { layerTitle } from './layerInfo'

export function ResultSelect({ hint }: { hint?: boolean }) {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const setResult = useAnalysis((s) => s.setResult)
  const catalog = useLayers()
  const [pending, setPending] = useState<string | null>(null)
  const candidates = analysis.layers.filter(canBeResult)
  const attributeRows = rows(analysis.tree).filter((r) => r.kind === 'attribute').length

  if (candidates.length === 0)
    return (
      <p className="text-muted text-sm">Erst einen Layer hinzufügen; er wird Ergebnis-Layer.</p>
    )

  return (
    <>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Ergebnis:
        <select
          className="input flex-1"
          aria-label="Ergebnis-Layer"
          value={analysis.result ?? ''}
          onChange={(e) =>
            attributeRows > 0 ? setPending(e.target.value) : setResult(e.target.value)
          }
        >
          {analysis.result === null && <option value="">–</option>}
          {candidates.map((layer) => (
            <option key={layer.id} value={layer.id}>
              {layerTitle(layer, catalog.data)}
            </option>
          ))}
        </select>
        {hint && (
          <span className="text-muted w-full text-xs">
            Ziel-Layer wechseln setzt Attribut-Bedingungen zurück.
          </span>
        )}
      </label>
      {pending && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title="Ergebnis-Layer wechseln?"
          confirm="Wechseln"
          onConfirm={() => {
            setResult(pending)
            setPending(null)
          }}
        >
          <p>
            {attributeRows === 1
              ? 'Eine Attribut-Bedingung bezieht'
              : `${attributeRows} Attribut-Bedingungen beziehen`}{' '}
            sich auf die Felder des bisherigen Layers und {attributeRows === 1 ? 'fällt' : 'fallen'}{' '}
            weg. Räumliche Bedingungen bleiben.
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}
