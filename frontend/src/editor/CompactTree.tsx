// The compact condition tree (design B1 sidebar), shared with Modus B (design
// M2 answer, M5 approval, M15): one line per condition in the editor's words,
// the hits per condition where counted, and the origin mark "Modell" (plan P3).
// Read-only.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import type { Group, Row } from '../analysis/model'

/** A condition without a row form (a model's query, design M3): shown as its JSON. */
export interface Opaque {
  id: string
  kind: 'opaque'
  json: string
}

/** "Nur in: Ausschnitt / Fläche" inside a query object. */
export interface Within {
  id: string
  kind: 'within'
  shape: 'view' | 'shape'
}

/** A group whose children may also be conditions without a row form. */
export interface TreeGroup {
  id: string
  kind: 'group'
  op: Group['op']
  not: boolean
  children: TreeNode[]
}

export type TreeNode = Row | TreeGroup | Opaque | Within

/** The origin mark "Modell": set by the model, not yet changed by hand. */
export function OriginMark() {
  return (
    <span
      className="border-accent text-accent-700 rounded-[var(--radius-sm)] border border-dashed px-1 text-[10px] tracking-wide uppercase"
      title={t`Vom Modell gesetzt; die Marke fällt weg, sobald Sie Feld, Operator oder Wert ändern.`}
    >
      <Trans context="origin mark">Modell</Trans>
    </span>
  )
}

function badge(node: TreeNode): string {
  switch (node.kind) {
    case 'attribute':
      return t({ message: 'A', comment: 'Badge: attribute condition' })
    case 'group':
      return t({ message: 'G', comment: 'Badge: group' })
    case 'opaque':
      return '?'
    default:
      return t({ message: 'R', comment: 'Badge: spatial or reference condition (Raum)' })
  }
}

function Line({ node, describe }: { node: TreeNode; describe: (node: Row | TreeGroup) => string }) {
  switch (node.kind) {
    case 'opaque':
      return (
        <span className="flex flex-1 flex-wrap items-baseline gap-1.5">
          <span className="text-muted text-xs">
            <Trans>ohne Klartext:</Trans>
          </span>
          <code className="font-mono text-xs break-all">{node.json}</code>
        </span>
      )
    case 'within':
      return (
        <span className="flex-1">
          {node.shape === 'view' ? t`nur im Kartenausschnitt` : t`nur in der Fläche`}
        </span>
      )
    default:
      return <span className="flex-1">{describe(node)}</span>
  }
}

export function CompactTree({
  nodes,
  describe,
  counts,
  marked,
}: {
  nodes: TreeNode[]
  describe: (node: Row | TreeGroup) => string
  /** Hits per condition (design B2 "Trefferzahl je Bedingung"). */
  counts?: Map<string, number>
  /** Whether a row carries the origin mark. */
  marked?: (row: Row) => boolean
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) => (
        <li key={node.id} className="flex flex-col">
          <span className="flex items-baseline gap-1.5">
            <span className="text-muted w-3 text-[10px]">{badge(node)}</span>
            {node.kind !== 'group' &&
              node.kind !== 'opaque' &&
              node.kind !== 'within' &&
              marked?.(node) && <OriginMark />}
            <Line node={node} describe={describe} />
            {node.kind !== 'group' && (
              <span className="text-muted text-xs">{counts?.get(node.id) ?? ''}</span>
            )}
          </span>
          {node.kind === 'group' && (
            <div className="border-divider ml-3 border-l pl-2">
              <CompactTree
                nodes={node.children}
                describe={describe}
                counts={counts}
                marked={marked}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
