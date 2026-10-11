// A step's result in plain language, one line (design M8, M9: "Schulen ·
// Schulstufe ist eins von primar"): its query object (``StepView.query``)
// read as the editor's rows (readable.ts) and said in the editor's words
// (editor/describe.ts), the layer by its title, a buffer by its distance. The
// tool's own name stays in the step's monospace detail.
import { t } from '@lingui/core/macro'
import type { DisplayLayer } from '../../analysis/model'
import { useLayers } from '../../api/queries'
import { describe, formatDistance } from '../../editor/describe'
import { labelsFor } from '../../editor/fields'
import { compactQuery, readQuery } from '../readable'

const catalogLayer = (layer: string): DisplayLayer => ({
  id: layer,
  source: { kind: 'catalog', layer },
  visible: true,
  opacity: 1,
  symbology: null,
})

/** The parts of the line: layer, conditions, buffer (a condition beyond the controls as "…"). */
function useStepWords(query: unknown): string[] {
  const catalog = useLayers().data
  const read = readQuery(query)
  const source = read.source
  const { labels, filterLabels } = labelsFor(source ? catalogLayer(source) : undefined, catalog)
  const conditions = read.tree.children.map((node) =>
    node.kind === 'opaque' || node.kind === 'within' ? '…' : describe(node, labels, filterLabels),
  )
  const buffer = (compactQuery(query) as { buffer?: { distance_m?: number } }).buffer?.distance_m
  const distance = buffer === undefined ? null : formatDistance(buffer)
  return [
    ...(source ? [labels.layer(source)] : []),
    ...conditions,
    ...(distance ? [t`Puffer ${distance}`] : []),
  ]
}

export function StepSummary({ query }: { query: unknown }) {
  const words = useStepWords(query)
  if (words.length === 0) return null
  return <p className="text-muted text-xs">{words.join(' · ')}</p>
}
