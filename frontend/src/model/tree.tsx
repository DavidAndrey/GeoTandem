// The readable condition tree of Modus B (design M2 answer, M5 approval, M15
// editor): the words of the editor's compact tree (editor/describe.ts), the
// origin mark "Modell" per condition (plan P3), and the query object as JSON
// only under "Technisch". Read-only.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useShallow } from 'zustand/react/shallow'
import type { Row } from '../analysis/model'
import { resultLayer } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { useLayers } from '../api/queries'
import { describe } from '../editor/describe'
import { catalogFields, labelOf, type Field } from '../editor/fields'
import { isMarked, type OriginMarks } from './origin'
import { readQuery, type ReadGroup, type ReadNode } from './readable'
import { FRAME, type LineStyle } from './statusKey'

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

const typeOf = (fields: Field[]) => (name: string) => fields.find((f) => f.name === name)?.type

/** Field and layer names as the catalog labels them, like the sidebar (design B1). */
function useLabels(source: string | null) {
  const catalog = useLayers().data
  const layer = (name: string) => catalog?.find((l) => l.name === name)?.title ?? name
  const fields = source ? catalogFields(source, catalog) : []
  const labels = { field: labelOf(fields), layer, type: typeOf(fields) }
  const filterLabels = (name: string) => {
    const related = catalogFields(name, catalog)
    return { ...labels, field: labelOf(related), type: typeOf(related) }
  }
  return { labels, filterLabels }
}

type Say = (row: Row) => string

function opLabel(group: ReadGroup): string {
  const op = group.op === 'and' ? t`UND` : t`ODER`
  return group.not ? t({ message: `NICHT ${op}`, comment: 'A negated group: NICHT UND' }) : op
}

function NodeItem({ node, say, marks }: { node: ReadNode; say: Say; marks?: OriginMarks }) {
  switch (node.kind) {
    case 'group':
      return (
        <>
          <span className="chip w-fit text-[11px]">{opLabel(node)}</span>
          <div className="border-divider ml-3 border-l pl-2">
            <Nodes nodes={node.children} say={say} marks={marks} />
          </div>
        </>
      )
    case 'opaque':
      return (
        <span className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-muted text-xs">
            <Trans>ohne Klartext:</Trans>
          </span>
          <code className="font-mono text-xs break-all">{node.json}</code>
        </span>
      )
    case 'within':
      return (
        <span>{node.shape === 'view' ? t`nur im Kartenausschnitt` : t`nur in der Fläche`}</span>
      )
    default:
      return (
        <span className="flex items-baseline gap-1.5">
          {marks && isMarked(marks, node) && <OriginMark />}
          <span>{say(node)}</span>
        </span>
      )
  }
}

function Nodes({ nodes, say, marks }: { nodes: ReadNode[]; say: Say; marks?: OriginMarks }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) => (
        <li key={node.id} className="flex flex-col">
          <NodeItem node={node} say={say} marks={marks} />
        </li>
      ))}
    </ul>
  )
}

/**
 * A condition tree in plain language. ``source`` names the layer whose fields
 * the conditions use; ``marks`` shows the origin mark on the rows it holds.
 */
export function ConditionTree({
  source,
  tree,
  marks,
  line,
}: {
  source: string | null
  tree: ReadGroup
  marks?: OriginMarks
  /** The status line style of the box (design: dashed while a proposal). */
  line?: LineStyle
}) {
  const { labels, filterLabels } = useLabels(source)
  const say: Say = (row) => describe(row, labels, filterLabels)
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
          <span className="chip mb-1 text-[11px]">{opLabel(tree)}</span>
          <Nodes nodes={tree.children} say={say} marks={marks} />
        </>
      )}
    </div>
  )
}

/** The analysis's conditions with their origin marks (design M2.2 sidebar, M15). */
export function AnalysisConditions() {
  const { tree, origin, source } = useAnalysis(
    useShallow((s) => {
      const layer = resultLayer(currentAnalysis(s))
      return {
        tree: s.draft ?? s.tree,
        origin: s.origin,
        source: layer?.source.kind === 'catalog' ? layer.source.layer : null,
      }
    }),
  )
  return <ConditionTree source={source} tree={tree} marks={origin} />
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
      <ConditionTree source={source} tree={read.tree} line={line} />
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
