// Query editor (design B2, F-4.2 to F-4.4): an AND/OR tree of attribute,
// spatial and reference conditions. It edits the draft; "Übernehmen" writes it
// into the analysis, "Verwerfen" restores the previous state.
import { hitsOf } from '../i18n/phrases'
import { i18n } from '@lingui/core'
import { Trans } from '@lingui/react/macro'
import { msg, t } from '@lingui/core/macro'
import { Crosshair, Info, MapPin, MoreHorizontal, Plus, Tag, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
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
import { HandoverNotice } from '../model/panel/HandoverNotice'
import { isMarked } from '../model/origin'
import { ResultSelect } from '../workplace/ResultSelect'
import { OriginMark } from './CompactTree'
import {
  formatScalar,
  needsDistance,
  objectLabel,
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
  // The explanation is open while there is nothing to edit yet, otherwise behind ⓘ.
  const [info, setInfo] = useState(analysis.tree.children.length === 0)
  const close = (keep: boolean) => {
    setActiveRow(null)
    if (keep) apply()
    else discard()
  }
  const panel = useRef<HTMLElement>(null)
  // Opened at one condition (design M12.1 "ändern"): its first control gets the focus.
  // Otherwise the panel itself: the entry that opened it is gone, and without the
  // focus inside, Esc would not reach the panel.
  useEffect(() => {
    const row = useMapView.getState().activeRow
    const control = row
      ? document.querySelector<HTMLElement>(
          `[data-row-id="${row}"] select, [data-row-id="${row}"] input`,
        )
      : null
    ;(control ?? panel.current)?.focus()
  }, [])

  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-label={t`Abfrage-Editor`}
      className="card flex min-h-0 flex-col overflow-hidden outline-none"
      onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && close(false)}
    >
      <div className="border-divider flex items-center gap-2 border-b px-4 py-2">
        <h2 id="editor-title" className="flex-1 text-xl">
          <Trans>Abfrage</Trans>
        </h2>
        {counts.data && (
          <span className="text-sm" aria-label={t`Treffer im Entwurf`}>
            → {hitsOf(counts.data.hits, counts.data.total)}
          </span>
        )}
        <button type="button" aria-label={t`Verwerfen und schliessen`} onClick={() => close(false)}>
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        <div className="relative">
          <ResultSelect label={t`Die Abfrage bezieht sich auf den Layer`} />
          <button
            type="button"
            className="text-muted hover:text-ink absolute top-0 right-0"
            aria-label={t`Wie funktioniert die Abfrage?`}
            aria-expanded={info}
            aria-controls="editor-info"
            onClick={() => setInfo(!info)}
          >
            <Info size={15} aria-hidden />
          </button>
        </div>
        {info && (
          <p
            id="editor-info"
            className="border-divider rounded-[var(--radius-lg)] border bg-white px-3 py-2 text-sm"
          >
            <Trans>
              Jede Bedingung ist ein Satz. Die umrandeten Teile sind Auswahlfelder: anklicken und
              ändern. Mehrere Bedingungen verknüpfen Sie mit «alle» (UND) oder «mindestens eine»
              (ODER) und ordnen sie in Gruppen. Das Ergebnis erscheint in der Karte und in der
              Tabelle unter «Datendetails». Ein anderer Layer setzt die Attribut-Bedingungen zurück.
            </Trans>
          </p>
        )}
        {fields.length === 0 && analysis.result === null ? (
          <p className="text-muted text-sm">
            <Trans>Erst einen Ergebnis-Layer wählen.</Trans>
          </p>
        ) : (
          <GroupEditor
            group={analysis.tree}
            root
            fields={fields}
            catalog={catalog.data}
            counts={counts.data?.rows}
          />
        )}
        <HandoverNotice />
        <ErrorNotice error={counts.error} />
      </div>
      <div className="border-divider flex gap-2 border-t px-4 py-2">
        <button type="button" className="btn btn-primary" onClick={() => close(true)}>
          <Trans>Übernehmen</Trans>
        </button>
        <button type="button" className="btn" onClick={() => close(false)}>
          <Trans>Verwerfen</Trans>
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

/** A sentence's plain words, between its controls. */
function Word({ children }: { children: ReactNode }) {
  return <span className="text-muted text-[13px]">{children}</span>
}

/** The editable part of a sentence: named by a tooltip and for screen readers (variant C). */
const chip = (label: string) => ({ className: 'chip-control', 'aria-label': label, title: label })

function NotMark() {
  return (
    <span className="bg-ink rounded-full px-2 text-[11px] tracking-wide text-white">
      <Trans>NICHT</Trans>
    </span>
  )
}

/** "Treffer erfüllen [alle ▾]": how the group's conditions combine. */
function JoinSelect({ group }: { group: Group }) {
  const editNode = useAnalysis((s) => s.editNode)
  return (
    <select
      {...chip(t`Verknüpfung`)}
      value={group.op}
      onChange={(e) => editNode<Group>(group.id, { op: e.target.value as Group['op'] })}
    >
      <option value="and">{t`alle`}</option>
      <option value="or">{t`mindestens eine`}</option>
    </select>
  )
}

const MENU_ITEM =
  'cursor-pointer rounded-[var(--radius-md)] px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-neutral-200'

/** One place for a condition's or a group's actions: NICHT, Duplizieren, Entfernen. */
function NodeMenu({ node, label }: { node: Node; label: string }) {
  const { editNode, duplicateNode, removeNode } = useAnalysis(
    useShallow((s) => ({
      editNode: s.editNode,
      duplicateNode: s.duplicateNode,
      removeNode: s.removeNode,
    })),
  )
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="text-muted hover:text-ink rounded-[var(--radius-md)] px-1 hover:bg-neutral-200"
        aria-label={label}
      >
        <MoreHorizontal size={16} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="card z-[1100] flex min-w-44 flex-col p-1 shadow-[var(--shadow-md)]"
        >
          <DropdownMenu.Item
            className={MENU_ITEM}
            onSelect={() => editNode(node.id, { not: !node.not })}
          >
            {node.not ? t`NICHT aufheben` : t`Mit NICHT umkehren`}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => duplicateNode(node.id)}>
            <Trans>Duplizieren</Trans>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={`${MENU_ITEM} text-danger`}
            onSelect={() => removeNode(node.id)}
          >
            <Trans>Entfernen</Trans>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function GroupEditor({ group, root, ...context }: { group: Group; root?: boolean } & Context) {
  const addNode = useAnalysis((s) => s.addNode)
  const resultName = useAnalysis((s) => s.result)
  const otherLayers = (context.catalog ?? []).filter(
    (l) => l.kind === 'vector' && l.name !== resultName,
  )
  const empty = group.children.length === 0
  return (
    <div
      role="group"
      aria-label={root ? t`Bedingungen` : t`Gruppe`}
      className={root ? '' : 'border-accent-400 ml-1 border-l-2 py-1 pl-3'}
    >
      {root ? (
        !empty && (
          <p className="mb-2 flex flex-wrap items-center gap-1.5 text-sm">
            <Trans>
              Treffer erfüllen <JoinSelect group={group} /> dieser Bedingungen:
            </Trans>
          </p>
        )
      ) : (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-sm">
          {group.not && <NotMark />}
          <Trans>
            Gruppe: Treffer erfüllen <JoinSelect group={group} />
          </Trans>
          <span className="ml-auto">
            <NodeMenu node={group} label={t`Aktionen für diese Gruppe`} />
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-2">
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
      <div className={`flex gap-4 text-sm ${empty ? '' : 'mt-2'}`}>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="text-accent-700 flex items-center gap-1">
            <Plus size={13} aria-hidden /> <Trans>Bedingung</Trans>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="card z-[1100] flex min-w-40 flex-col p-1 shadow-[var(--shadow-md)]"
            >
              {[
                { label: t`Attribut`, node: () => newAttributeRow(context.fields[0]?.name ?? '') },
                { label: t`Raum`, node: () => newSpatialRow(otherLayers[0]?.name ?? '') },
                { label: t`Bezugsobjekt`, node: () => newReferenceRow(otherLayers[0]?.name ?? '') },
              ].map((item) => (
                <DropdownMenu.Item
                  key={item.label}
                  className={MENU_ITEM}
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
          <Plus size={13} aria-hidden /> <Trans>Gruppe</Trans>
        </button>
      </div>
    </div>
  )
}

const KINDS = {
  attribute: { name: msg`Attribut`, Icon: Tag },
  spatial: { name: msg`Raum`, Icon: MapPin },
  reference: { name: msg`Bezug`, Icon: Crosshair },
}

/**
 * One condition as one card: the sentence of chips, then a line with its kind,
 * its origin, its hits alone and its actions (variant C of the editor review).
 */
function RowEditor({
  row,
  fields,
  catalog,
  counts,
}: { row: AttributeRow | SpatialRow | ReferenceRow } & Context) {
  const editNode = useAnalysis((s) => s.editNode)
  const marked = useAnalysis((s) => isMarked(s.origin, row))
  const { activeRow, setActiveRow } = useMapView(
    useShallow((s) => ({ activeRow: s.activeRow, setActiveRow: s.setActiveRow })),
  )
  const count = counts?.get(row.id)
  const { name, Icon } = KINDS[row.kind]
  const kind = i18n._(name)
  const filterFields = row.kind === 'spatial' ? catalogFields(row.layer, catalog) : []
  const change = (patch: Partial<SpatialRow>) => editNode<SpatialRow>(row.id, patch)
  const reference = row.kind === 'spatial' ? layerName(row.layer, catalog) : ''
  return (
    <div
      role="group"
      aria-label={t`Bedingung ${kind}`}
      data-row-id={row.id}
      className={`focus-within:border-accent rounded-[var(--radius-lg)] border bg-white px-3 py-2 ${activeRow === row.id ? 'border-accent' : 'border-divider'}`}
      onFocus={() => setActiveRow(row.id)}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {row.not && <NotMark />}
        {row.kind === 'attribute' && <AttributeEditor row={row} fields={fields} />}
        {row.kind === 'spatial' && (
          <SpatialEditor row={row} catalog={catalog} fields={filterFields} />
        )}
        {row.kind === 'reference' && <ReferenceEditor row={row} catalog={catalog} />}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {/* The group's name says the kind already; the icon only shows it. */}
        <span aria-hidden title={kind} className="text-neutral-800">
          <Icon size={14} />
        </span>
        {/* Set by the model and not changed by hand since (design M15.1, plan P3). */}
        {marked && <OriginMark />}
        {row.kind === 'spatial' &&
          (row.filter ? (
            <button
              type="button"
              className="text-accent-700 hover:underline"
              onClick={() => change({ filter: null })}
            >
              <Trans>Filter entfernen</Trans>
            </button>
          ) : (
            row.layer && (
              <button
                type="button"
                className="text-accent-700 hover:underline"
                onClick={() => change({ filter: newAttributeRow(filterFields[0]?.name ?? '') })}
              >
                <Trans>+ Filter auf {reference}</Trans>
              </button>
            )
          ))}
        <span className="text-muted ml-auto tabular-nums" aria-label={t`Treffer dieser Bedingung`}>
          {count === undefined ? '–' : t`${count} Treffer allein`}
        </span>
        <NodeMenu node={row} label={t`Aktionen für diese Bedingung`} />
      </div>
    </div>
  )
}

const layerName = (name: string, catalog: LayerInfo[] | undefined) =>
  catalog?.find((l) => l.name === name)?.title ?? name

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
        {...chip(t`Attribut`)}
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
        {!field && (
          <option value="">
            <Trans>Attribut …</Trans>
          </option>
        )}
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        {...chip(t`Operator`)}
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
            {...chip(t`von`)}
            className={`chip-control ${dated ? 'min-w-36' : 'min-w-16'}`}
            type={dated ? 'date' : 'number'}
            value={row.min ?? ''}
            onChange={(e) => change({ min: bound(e.target.value) })}
          />
          <Word>
            <Trans context="range">und</Trans>
          </Word>
          <input
            {...chip(t({ message: 'bis', context: 'range' }))}
            className={`chip-control ${dated ? 'min-w-36' : 'min-w-16'}`}
            type={dated ? 'date' : 'number'}
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
            {...chip(t`Wert`)}
            value={row.value === null ? '' : String(row.value)}
            onChange={(e) =>
              change({ value: e.target.value === '' ? null : e.target.value === 'true' })
            }
          >
            <option value="">…</option>
            <option value="true">{t`ja`}</option>
            <option value="false">{t`nein`}</option>
          </select>
        ) : (
          <input
            {...chip(t`Wert`)}
            className={`chip-control ${numeric ? 'min-w-16' : dated ? 'min-w-36' : 'min-w-24'}`}
            type={numeric ? 'number' : dated ? 'date' : 'text'}
            list={field?.codes ? listId : undefined}
            value={row.value === null ? '' : String(row.value)}
            onChange={(e) => change({ value: parseValue(e.target.value, field) })}
          />
        ))}
      {field?.unit && !['in', 'is_empty'].includes(row.operator) && <Word>{field.unit}</Word>}
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
    <>
      {row.values.map((v) => (
        <span key={String(v)} className="chip chip-active h-7 bg-white">
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
        {...chip(t`Wert hinzufügen`)}
        className="chip-control min-w-24"
        placeholder={t`Wert, Enter`}
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
    </>
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
    <select {...chip(label)} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && (
        <option value="">
          <Trans>Layer …</Trans>
        </option>
      )}
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
    <input
      {...chip(t`Distanz in Metern`)}
      className="chip-control min-w-16"
      type="number"
      min={0}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

/**
 * The relation as the sentence's verb: "≤ Distanz" asks for the metres and
 * "zu" next, so "[≤ Distanz] [300] m zu [Haltestellen]" reads as one sentence.
 */
const relationLabel = (op: SpatialOperator) =>
  op === 'near' ? t`≤ Distanz` : op === 'far' ? t`> Distanz` : spatialLabel(op)

function SpatialEditor({
  row,
  catalog,
  fields,
}: {
  row: SpatialRow
  catalog: LayerInfo[] | undefined
  fields: Field[]
}) {
  const editNode = useAnalysis((s) => s.editNode)
  const change = (patch: Partial<SpatialRow>) => editNode<SpatialRow>(row.id, patch)
  return (
    <>
      <select
        {...chip(t`Beziehung`)}
        value={row.operator}
        onChange={(e) => change({ operator: e.target.value as SpatialOperator })}
      >
        {SPATIAL_OPERATOR_LIST.map((op) => (
          <option key={op} value={op}>
            {relationLabel(op)}
          </option>
        ))}
      </select>
      {needsDistance(row.operator) && (
        <>
          <DistanceInput value={row.distance_m} onChange={(distance_m) => change({ distance_m })} />
          <Word>
            <Trans context="distance to a layer">m zu</Trans>
          </Word>
        </>
      )}
      <LayerSelect
        label={t`Bezugslayer`}
        value={row.layer}
        catalog={catalog}
        onChange={(layer) => change({ layer, filter: null })}
      />
      {row.filter && (
        <>
          <Word>
            <Trans context="filter on the reference layer">mit</Trans>
          </Word>
          <AttributeEditor
            row={row.filter}
            fields={fields}
            onChange={(patch) => change({ filter: { ...(row.filter as AttributeRow), ...patch } })}
          />
        </>
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
      <Word>≤</Word>
      <DistanceInput value={row.distance_m} onChange={(m) => change({ distance_m: m ?? 0 })} />
      <Word>
        <Trans context="around a feature">m um</Trans>
      </Word>
      <button
        type="button"
        className={`chip-control inline-flex items-center gap-1 ${picking ? 'bg-accent-100' : ''}`}
        aria-pressed={picking}
        disabled={!row.layer}
        onClick={() => setPick(picking ? null : { layer: row.layer, rowId: row.id })}
      >
        <Crosshair size={12} aria-hidden />
        {row.fid === null
          ? picking
            ? t`auf der Karte klicken …`
            : t`Objekt wählen`
          : row.label || objectLabel(row.fid)}
      </button>
      <Word>
        <Trans context="feature of a layer">aus</Trans>
      </Word>
      <LayerSelect
        label={t`Layer des Bezugsobjekts`}
        value={row.layer}
        catalog={catalog}
        onChange={(layer) => change({ layer, fid: null, label: '' })}
      />
    </>
  )
}
