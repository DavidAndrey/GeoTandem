// Query editor (design B2, F-4.2 to F-4.4): an AND/OR tree of attribute,
// spatial and reference conditions. It edits the draft; "Übernehmen" writes it
// into the analysis, "Verwerfen" restores the previous state.
import { Crosshair, Plus, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type {
  AttributeRow,
  Group,
  Node,
  ReferenceRow,
  Scalar,
  SpatialOperator,
  SpatialRow,
} from '../analysis/model'
import { resultLayer } from '../analysis/query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { newAttributeRow, newGroup, newReferenceRow, newSpatialRow } from '../analysis/tree'
import type { LayerInfo } from '../api/client'
import { useLayers } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { useMapView } from '../map/view'
import { ResultSelect } from '../workplace/ResultSelect'
import {
  formatScalar,
  needsDistance,
  operatorLabel,
  operatorsFor,
  SPATIAL_OPERATOR_LIST,
  spatialLabel,
} from './describe'
import { catalogFields, fieldsOf, type Field } from './fields'
import { useCounts } from './useCounts'
import { parseNumber } from '../i18n/locale'

export function EditorPanel() {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const { apply, discard } = useAnalysis(
    useShallow((s) => ({ apply: s.apply, discard: s.discard })),
  )
  const setActiveRow = useMapView((s) => s.setActiveRow)
  const catalog = useLayers()
  const counts = useCounts(analysis)
  const fields = fieldsOf(resultLayer(analysis) ?? undefined, catalog.data)
  const close = (keep: boolean) => {
    setActiveRow(null)
    if (keep) apply()
    else discard()
  }

  return (
    <section
      aria-label="Abfrage-Editor"
      className="card flex min-h-0 flex-col overflow-hidden"
      onKeyDown={(e) => e.key === 'Escape' && close(false)}
    >
      <div className="border-divider flex items-center gap-2 border-b px-4 py-2">
        <h2 id="editor-title" className="flex-1 text-xl">
          Abfrage
        </h2>
        {counts.data && (
          <span className="text-sm" aria-label="Treffer im Entwurf">
            → {counts.data.hits} von {counts.data.total}
          </span>
        )}
        <button type="button" aria-label="Verwerfen und schliessen" onClick={() => close(false)}>
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3">
        <ResultSelect hint />
        {fields.length === 0 && analysis.result === null ? (
          <p className="text-muted mt-3 text-sm">Erst einen Ergebnis-Layer wählen.</p>
        ) : (
          <GroupEditor
            group={analysis.tree}
            root
            fields={fields}
            catalog={catalog.data}
            counts={counts.data?.rows}
          />
        )}
        <ErrorNotice error={counts.error} />
      </div>
      <div className="border-divider flex gap-2 border-t px-4 py-2">
        <button type="button" className="btn btn-primary" onClick={() => close(true)}>
          Übernehmen
        </button>
        <button type="button" className="btn" onClick={() => close(false)}>
          Verwerfen
        </button>
      </div>
    </section>
  )
}

interface Context {
  fields: Field[]
  catalog: LayerInfo[] | undefined
  counts: Map<string, number> | undefined
}

function GroupEditor({ group, root, ...context }: { group: Group; root?: boolean } & Context) {
  const { editNode, addNode, removeNode } = useAnalysis(
    useShallow((s) => ({ editNode: s.editNode, addNode: s.addNode, removeNode: s.removeNode })),
  )
  const resultName = useAnalysis((s) => s.result)
  const otherLayers = (context.catalog ?? []).filter(
    (l) => l.kind === 'vector' && l.name !== resultName,
  )
  return (
    <div
      role="group"
      aria-label={root ? 'Bedingungen' : 'Gruppe'}
      className={root ? 'mt-3' : 'border-divider my-1 rounded-[var(--radius-md)] border p-2'}
    >
      <div className="mb-1.5 flex items-center gap-2 text-sm">
        <div className="flex" role="radiogroup" aria-label="Verknüpfung">
          {(['and', 'or'] as const).map((op) => (
            <button
              key={op}
              type="button"
              role="radio"
              aria-checked={group.op === op}
              className={`border px-2 text-xs first:rounded-l last:rounded-r ${group.op === op ? 'border-accent text-accent-700' : 'border-neutral-400'}`}
              onClick={() => editNode<Group>(group.id, { op })}
            >
              {op === 'and' ? 'UND' : 'ODER'}
            </button>
          ))}
        </div>
        <span className="text-muted text-xs">
          {group.op === 'and' ? 'alle folgenden' : 'mindestens eine'}
        </span>
        {!root && (
          <>
            <NotToggle node={group} />
            <button
              type="button"
              className="ml-auto"
              aria-label="Gruppe entfernen"
              onClick={() => removeNode(group.id)}
            >
              <X size={13} />
            </button>
          </>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {group.children.map((child) => (
          <li key={child.id}>
            {child.kind === 'group' ? (
              <GroupEditor group={child} {...context} />
            ) : (
              <RowEditor row={child} {...context} />
            )}
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex gap-3 text-sm">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="text-accent-700 flex items-center gap-1">
            <Plus size={13} aria-hidden /> Bedingung
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="card z-[1100] min-w-40 py-1 shadow-[var(--shadow-md)]"
            >
              {[
                { label: 'Attribut', node: () => newAttributeRow(context.fields[0]?.name ?? '') },
                { label: 'Raum', node: () => newSpatialRow(otherLayers[0]?.name ?? '') },
                { label: 'Bezugsobjekt', node: () => newReferenceRow(otherLayers[0]?.name ?? '') },
              ].map((item) => (
                <DropdownMenu.Item
                  key={item.label}
                  className="cursor-pointer px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200"
                  onSelect={() => addNode(group.id, item.node())}
                >
                  {item.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          className="text-accent-700 flex items-center gap-1"
          onClick={() => addNode(group.id, newGroup(group.op === 'and' ? 'or' : 'and'))}
        >
          <Plus size={13} aria-hidden /> Gruppe
        </button>
      </div>
    </div>
  )
}

function NotToggle({ node }: { node: Node }) {
  const editNode = useAnalysis((s) => s.editNode)
  return (
    <label className="flex items-center gap-1 text-xs">
      <input
        type="checkbox"
        checked={node.not}
        onChange={(e) => editNode(node.id, { not: e.target.checked })}
      />
      NICHT
    </label>
  )
}

const BADGES = { attribute: 'Attribut', spatial: 'Raum', reference: 'Bezug' }

function RowEditor({
  row,
  fields,
  catalog,
  counts,
}: { row: AttributeRow | SpatialRow | ReferenceRow } & Context) {
  const removeNode = useAnalysis((s) => s.removeNode)
  const { activeRow, setActiveRow } = useMapView(
    useShallow((s) => ({ activeRow: s.activeRow, setActiveRow: s.setActiveRow })),
  )
  const count = counts?.get(row.id)
  return (
    <div
      role="group"
      aria-label={`Bedingung ${BADGES[row.kind]}`}
      className={`flex flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border px-2 py-1 text-sm ${activeRow === row.id ? 'border-accent' : 'border-transparent'}`}
      onFocus={() => setActiveRow(row.id)}
    >
      <span className="text-muted rounded-full border border-dashed border-neutral-400 px-1.5 text-[11px]">
        {BADGES[row.kind]}
      </span>
      <NotToggle node={row} />
      {row.kind === 'attribute' && <AttributeEditor row={row} fields={fields} />}
      {row.kind === 'spatial' && <SpatialEditor row={row} catalog={catalog} />}
      {row.kind === 'reference' && <ReferenceEditor row={row} catalog={catalog} />}
      <span className="text-muted ml-auto text-xs" aria-label="Treffer dieser Bedingung">
        {count ?? '–'}
      </span>
      <button type="button" aria-label="Bedingung entfernen" onClick={() => removeNode(row.id)}>
        <X size={13} />
      </button>
    </div>
  )
}

// --- attribute rows -------------------------------------------------------------

function parseValue(text: string, field: Field | undefined): Scalar | null {
  if (text === '') return null
  if (field?.type === 'integer' || field?.type === 'real') {
    return parseNumber(text)
  }
  return text
}

/** Edits an attribute row; ``onChange`` defaults to the store, a spatial filter passes its own. */
export function AttributeEditor({
  row,
  fields,
  onChange,
}: {
  row: AttributeRow
  fields: Field[]
  onChange?: (patch: Partial<AttributeRow>) => void
}) {
  const editNode = useAnalysis((s) => s.editNode)
  const change =
    onChange ?? ((patch: Partial<AttributeRow>) => editNode<AttributeRow>(row.id, patch))
  const field = fields.find((f) => f.name === row.attr)
  const operators = operatorsFor(field?.type)
  const listId = `codes-${row.id}`
  const numeric = field?.type === 'integer' || field?.type === 'real'
  // A date input yields ISO text "YYYY-MM-DD", what the query object expects (plan E1.8, G3).
  const dated = field?.type === 'date'
  const bound = (text: string) => (text === '' ? null : dated ? text : Number(text))
  return (
    <>
      <select
        className="input"
        aria-label="Feld"
        value={row.attr}
        onChange={(e) => {
          const next = fields.find((f) => f.name === e.target.value)
          const ops = operatorsFor(next?.type)
          change({
            attr: e.target.value,
            operator: ops.includes(row.operator) ? row.operator : 'eq',
            value: null,
            values: [],
            min: null,
            max: null,
          })
        }}
      >
        {!field && <option value="">Feld …</option>}
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className="input"
        aria-label="Operator"
        value={row.operator}
        onChange={(e) => change({ operator: e.target.value as AttributeRow['operator'] })}
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {operatorLabel(op, field?.type)}
          </option>
        ))}
      </select>
      {field?.codes && (
        <datalist id={listId}>
          {field.codes.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
      {row.operator === 'between' && (
        <>
          <input
            className={`input ${dated ? 'w-36' : 'w-20'}`}
            type={dated ? 'date' : 'number'}
            aria-label="von"
            value={row.min ?? ''}
            onChange={(e) => change({ min: bound(e.target.value) })}
          />
          –
          <input
            className={`input ${dated ? 'w-36' : 'w-20'}`}
            type={dated ? 'date' : 'number'}
            aria-label="bis"
            value={row.max ?? ''}
            onChange={(e) => change({ max: bound(e.target.value) })}
          />
        </>
      )}
      {row.operator === 'in' && (
        <ValueList row={row} field={field} listId={listId} onChange={change} />
      )}
      {!['between', 'in', 'is_empty'].includes(row.operator) &&
        (field?.type === 'boolean' ? (
          <select
            className="input"
            aria-label="Wert"
            value={row.value === null ? '' : String(row.value)}
            onChange={(e) =>
              change({ value: e.target.value === '' ? null : e.target.value === 'true' })
            }
          >
            <option value="">…</option>
            <option value="true">ja</option>
            <option value="false">nein</option>
          </select>
        ) : (
          <input
            className={`input ${numeric ? 'w-24' : dated ? 'w-36' : 'w-32'}`}
            type={numeric ? 'number' : dated ? 'date' : 'text'}
            aria-label="Wert"
            list={field?.codes ? listId : undefined}
            value={row.value === null ? '' : String(row.value)}
            onChange={(e) => change({ value: parseValue(e.target.value, field) })}
          />
        ))}
      {field?.unit && !['in', 'is_empty'].includes(row.operator) && (
        <span className="text-muted text-xs">{field.unit}</span>
      )}
    </>
  )
}

function ValueList({
  row,
  field,
  listId,
  onChange,
}: {
  row: AttributeRow
  field: Field | undefined
  listId: string
  onChange: (patch: Partial<AttributeRow>) => void
}) {
  const [text, setText] = useState('')
  const add = () => {
    const value = parseValue(text.trim(), field)
    if (value !== null && !row.values.includes(value)) onChange({ values: [...row.values, value] })
    setText('')
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.values.map((v) => (
        <span key={String(v)} className="chip chip-active text-xs">
          {formatScalar(v)}
          <button
            type="button"
            aria-label={`${String(v)} entfernen`}
            onClick={() => onChange({ values: row.values.filter((x) => x !== v) })}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="input w-28"
        aria-label="Wert hinzufügen"
        list={field?.codes ? listId : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={() => text && add()}
      />
    </span>
  )
}

// --- spatial and reference rows -----------------------------------------------

function LayerSelect({
  value,
  catalog,
  onChange,
  label,
}: {
  value: string
  catalog: LayerInfo[] | undefined
  onChange: (layer: string) => void
  label: string
}) {
  const result = useAnalysis((s) => s.result)
  const layers = (catalog ?? []).filter((l) => l.kind === 'vector' && l.name !== result)
  return (
    <select
      className="input"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {!value && <option value="">Layer …</option>}
      {layers.map((l) => (
        <option key={l.name} value={l.name}>
          {l.title}
        </option>
      ))}
    </select>
  )
}

function DistanceInput({
  value,
  onChange,
}: {
  value: number | null
  onChange: (m: number | null) => void
}): ReactNode {
  return (
    <span className="flex items-center gap-1">
      <input
        className="input w-20"
        type="number"
        min={0}
        aria-label="Distanz in Metern"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
      <span className="text-xs">m</span>
    </span>
  )
}

function SpatialEditor({ row, catalog }: { row: SpatialRow; catalog: LayerInfo[] | undefined }) {
  const editNode = useAnalysis((s) => s.editNode)
  const change = (patch: Partial<SpatialRow>) => editNode<SpatialRow>(row.id, patch)
  const filterFields = catalogFields(row.layer, catalog)
  return (
    <>
      <select
        className="input"
        aria-label="Beziehung"
        value={row.operator}
        onChange={(e) => change({ operator: e.target.value as SpatialOperator })}
      >
        {SPATIAL_OPERATOR_LIST.map((op) => (
          <option key={op} value={op}>
            {spatialLabel(op)}
          </option>
        ))}
      </select>
      {needsDistance(row.operator) && (
        <DistanceInput value={row.distance_m} onChange={(distance_m) => change({ distance_m })} />
      )}
      <LayerSelect
        label="Bezugslayer"
        value={row.layer}
        catalog={catalog}
        onChange={(layer) => change({ layer, filter: null })}
      />
      {row.filter ? (
        <span className="flex w-full flex-wrap items-center gap-1.5 pl-6 text-xs">
          <span className="text-muted">wo</span>
          <AttributeEditor
            row={row.filter}
            fields={filterFields}
            onChange={(patch) => change({ filter: { ...(row.filter as AttributeRow), ...patch } })}
          />
          <button
            type="button"
            aria-label="Filter entfernen"
            onClick={() => change({ filter: null })}
          >
            <X size={12} />
          </button>
        </span>
      ) : (
        row.layer && (
          <button
            type="button"
            className="text-accent-700 text-xs"
            onClick={() => change({ filter: newAttributeRow(filterFields[0]?.name ?? '') })}
          >
            + Filter
          </button>
        )
      )}
    </>
  )
}

function ReferenceEditor({
  row,
  catalog,
}: {
  row: ReferenceRow
  catalog: LayerInfo[] | undefined
}) {
  const editNode = useAnalysis((s) => s.editNode)
  const { pick, setPick } = useMapView(useShallow((s) => ({ pick: s.pick, setPick: s.setPick })))
  const change = (patch: Partial<ReferenceRow>) => editNode<ReferenceRow>(row.id, patch)
  const picking = pick?.rowId === row.id
  return (
    <>
      <span className="text-xs">≤</span>
      <DistanceInput value={row.distance_m} onChange={(m) => change({ distance_m: m ?? 0 })} />
      <span className="text-xs">um</span>
      <LayerSelect
        label="Layer des Bezugsobjekts"
        value={row.layer}
        catalog={catalog}
        onChange={(layer) => change({ layer, fid: null, label: '' })}
      />
      <button
        type="button"
        className={`chip ${picking ? 'chip-active' : ''}`}
        aria-pressed={picking}
        disabled={!row.layer}
        onClick={() => setPick(picking ? null : { layer: row.layer, rowId: row.id })}
      >
        <Crosshair size={12} aria-hidden />
        {row.fid === null
          ? picking
            ? 'auf der Karte klicken …'
            : 'Objekt wählen'
          : row.label || `Objekt ${row.fid}`}
      </button>
    </>
  )
}
