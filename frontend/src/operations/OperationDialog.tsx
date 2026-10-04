// Operations on a layer (design B4 buffer, B5 join, B6 aggregation) and its
// symbology (B7, F-4.8). Each operation makes a derived layer: a recipe, i.e.
// a query object, recomputed when shown (plan D7).
import { i18n, type MessageDescriptor } from '@lingui/core'
import { Trans } from '@lingui/react/macro'
import { msg, t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { Dialog } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import type { Aggregate, DisplayLayer, Recipe, Symbology } from '../analysis/model'
import { recipeQuery } from '../analysis/query'
import { useAnalysis } from '../analysis/store'
import { api, type LayerInfo } from '../api/client'
import { useLayers } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { catalogFields, fieldsOf, keyKind, type Field } from '../editor/fields'
import { isIdentifier } from '../admin/wizard'
import { ACCENT, layerColor } from '../map/style'
import { layerTitle } from '../workplace/layerInfo'

export type Operation = 'buffer' | 'join' | 'aggregate' | 'symbology'

const TITLES: Record<Operation, MessageDescriptor> = {
  buffer: msg`Puffer`,
  join: msg`Join`,
  aggregate: msg`Aggregieren`,
  symbology: msg`Darstellung`,
}

export function OperationDialog({
  layer,
  operation,
  onClose,
}: {
  layer: DisplayLayer
  operation: Operation
  onClose: () => void
}) {
  const catalog = useLayers()
  const title = layerTitle(layer, catalog.data)
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="bg-ink/30 fixed inset-0 z-[1200]" />
        <Dialog.Content className="card fixed top-[15%] left-1/2 z-[1300] w-[30rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5 shadow-[var(--shadow-md)]">
          <Dialog.Title className="mb-1 text-xl">
            {i18n._(TITLES[operation])} · {title}
          </Dialog.Title>
          <Dialog.Description className="text-muted mb-3 text-xs">
            {operation === 'symbology'
              ? t`Wie der Layer auf der Karte erscheint (F-4.8).`
              : t`Ergibt einen abgeleiteten Layer dieser Sitzung; er wird bei jedem Öffnen neu berechnet.`}
          </Dialog.Description>
          {/* The forms take their defaults from the catalog, so they wait for it. */}
          {catalog.isPending && <Loading />}
          <ErrorNotice error={catalog.error} />
          {catalog.data && operation === 'buffer' && (
            <BufferForm layer={layer} title={title} onDone={onClose} />
          )}
          {catalog.data && operation === 'join' && (
            <JoinForm layer={layer} title={title} catalog={catalog.data} onDone={onClose} />
          )}
          {catalog.data && operation === 'aggregate' && (
            <AggregateForm layer={layer} title={title} catalog={catalog.data} onDone={onClose} />
          )}
          {catalog.data && operation === 'symbology' && (
            <SymbologyForm layer={layer} catalog={catalog.data} onDone={onClose} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-2 flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0">{label}</span>
      {children}
    </label>
  )
}

function Actions({
  onDone,
  disabled,
  label,
  onSubmit,
}: {
  onDone: () => void
  disabled: boolean
  label: string
  onSubmit: () => void
}) {
  return (
    <div className="mt-4 flex gap-2">
      <button type="button" className="btn" onClick={onDone}>
        <Trans>Abbrechen</Trans>
      </button>
      <button
        type="button"
        className="btn btn-primary ml-auto"
        disabled={disabled}
        onClick={() => {
          onSubmit()
          onDone()
        }}
      >
        {label}
      </button>
    </div>
  )
}

const sourceName = (layer: DisplayLayer) =>
  layer.source.kind === 'catalog' ? layer.source.layer : layer.source.recipe.layer

// --- B4 buffer ------------------------------------------------------------------

function BufferForm({
  layer,
  title,
  onDone,
}: {
  layer: DisplayLayer
  title: string
  onDone: () => void
}) {
  const addDerived = useAnalysis((s) => s.addDerived)
  const setSymbology = useAnalysis((s) => s.setSymbology)
  const isResult = useAnalysis((s) => s.result === layer.id)
  const [distance, setDistance] = useState(500)
  const [unit, setUnit] = useState<'m' | 'km'>('m')
  const [onlyFiltered, setOnlyFiltered] = useState(false)
  const meters = unit === 'km' ? distance * 1000 : distance
  const [name, setName] = useState('')
  const shownName = name || t`Puffer ${distance} ${unit} · ${title}`
  return (
    <>
      <Row label={t`Distanz`}>
        <input
          className="input w-24"
          type="number"
          min={0}
          aria-label={t`Distanz`}
          value={distance}
          onChange={(e) => setDistance(Number(e.target.value))}
        />
        <select
          className="input"
          aria-label={t`Einheit`}
          value={unit}
          onChange={(e) => setUnit(e.target.value as 'm' | 'km')}
        >
          <option value="m">m</option>
          <option value="km">km</option>
        </select>
      </Row>
      {isResult && (
        <label className="mb-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyFiltered}
            onChange={(e) => setOnlyFiltered(e.target.checked)}
          />
          <Trans>Nur gefilterte Objekte (Treffer der Abfrage)</Trans>
        </label>
      )}
      <Row label={t`Name`}>
        <input
          className="input flex-1"
          aria-label={t`Name`}
          placeholder={shownName}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Row>
      <Actions
        onDone={onDone}
        label={t`Puffer anlegen`}
        disabled={!(meters > 0)}
        onSubmit={() => {
          const id = addDerived(shownName, {
            op: 'buffer',
            layer: sourceName(layer),
            distance_m: meters,
            onlyFiltered: isResult && onlyFiltered,
          })
          // Design B7: buffers default to a half-transparent accent area.
          setSymbology(id, { kind: 'single', color: ACCENT })
        }}
      />
    </>
  )
}

// --- B5 join --------------------------------------------------------------------

function JoinForm({
  layer,
  title,
  catalog,
  onDone,
}: {
  layer: DisplayLayer
  title: string
  catalog: LayerInfo[] | undefined
  onDone: () => void
}) {
  const addDerived = useAnalysis((s) => s.addDerived)
  const setSymbology = useAnalysis((s) => s.setSymbology)
  const base = sourceName(layer)
  const leftFields = catalogFields(base, catalog)
  const tables = (catalog ?? []).filter((l) => l.name !== base)
  const [right, setRight] = useState(
    tables.find((l) => l.kind === 'table')?.name ?? tables[0]?.name ?? '',
  )
  const rightFields = catalogFields(right, catalog)
  const [leftKey, setLeftKey] = useState(leftFields[0]?.name ?? '')
  // Only keys of the same kind can match (F-2.14); the same name is proposed first.
  const partners = (key: string, fields: Field[]) => {
    const kind = leftFields.find((f) => f.name === key)?.type
    return fields.filter((f) => kind === undefined || keyKind(f.type) === keyKind(kind))
  }
  const partnerFor = (key: string, fields: Field[]) => {
    const candidates = partners(key, fields)
    return (candidates.find((f) => f.name === key) ?? candidates[0])?.name ?? ''
  }
  const [rightKey, setRightKey] = useState(partnerFor(leftFields[0]?.name ?? '', rightFields))
  const [chosen, setChosen] = useState<string[]>([])
  const [keepUnmatched, setKeepUnmatched] = useState(true)
  const taken = new Set(leftFields.map((f) => f.name))
  const clash = chosen.some((f) => taken.has(f))
  const prefix = clash ? `${right.slice(0, 20)}_` : null
  const recipe: Recipe | null =
    leftKey && rightKey && chosen.length
      ? {
          op: 'join',
          layer: base,
          join: { layer: right, left_key: leftKey, right_key: rightKey, fields: chosen, prefix },
          keepUnmatched: false,
        }
      : null
  // Match rate (design B5 "36 / 38"): features with a partner among all features.
  const rate = useQuery({
    queryKey: ['join-rate', recipe],
    queryFn: () =>
      recipe
        ? api.count([recipeQuery(recipe), { schema_version: '2', source: base, output: 'map' }])
        : null,
    enabled: Boolean(recipe),
  })
  const [matched, total] = rate.data?.counts ?? []
  const rightTitle = catalog?.find((l) => l.name === right)?.title ?? right

  return (
    <>
      <Row label={t`Tabelle`}>
        <select
          className="input flex-1"
          aria-label={t`Tabelle`}
          value={right}
          onChange={(e) => {
            setRight(e.target.value)
            setChosen([])
            setRightKey(partnerFor(leftKey, catalogFields(e.target.value, catalog)))
          }}
        >
          {tables.map((l) => (
            <option key={l.name} value={l.name}>
              {l.title}
              {l.kind === 'table' ? t` (Tabelle)` : ''}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t`Schlüssel`}>
        <FieldSelect
          label={t`Schlüssel im Layer`}
          fields={leftFields}
          value={leftKey}
          onChange={(key) => {
            setLeftKey(key)
            setRightKey(partnerFor(key, rightFields))
          }}
        />
        =
        <FieldSelect
          label={t`Schlüssel in der Tabelle`}
          fields={partners(leftKey, rightFields)}
          value={rightKey}
          onChange={setRightKey}
        />
      </Row>
      <fieldset className="mb-2 text-sm">
        <legend className="mb-1">
          <Trans>Felder aus {rightTitle}</Trans>
        </legend>
        <div className="flex flex-wrap gap-x-4">
          {rightFields
            .filter((f) => f.name !== rightKey)
            .map((f) => (
              <label key={f.name} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={chosen.includes(f.name)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked ? [...chosen, f.name] : chosen.filter((n) => n !== f.name),
                    )
                  }
                />
                {f.label}
              </label>
            ))}
        </div>
        {prefix && (
          <p className="text-muted text-xs">
            <Trans>Gleichnamige Felder erhalten das Präfix „{prefix}".</Trans>
          </p>
        )}
      </fieldset>
      {matched !== undefined && (
        <p className="mb-2 text-sm" aria-label={t`Trefferquote`}>
          <Trans>
            {matched} / {total} Objekte finden einen Partner
          </Trans>
        </p>
      )}
      <ErrorNotice error={rate.error} />
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={keepUnmatched}
          onChange={(e) => setKeepUnmatched(e.target.checked)}
        />
        <Trans>Objekte ohne Partner behalten</Trans>
      </label>
      <Actions
        onDone={onDone}
        label={t`Join anlegen`}
        disabled={!recipe}
        onSubmit={() => {
          if (!recipe || recipe.op !== 'join') return
          const id = addDerived(`${title} + ${rightTitle}`, { ...recipe, keepUnmatched })
          setSymbology(id, { kind: 'single', color: layerColor(layer) }) // design B7
        }}
      />
    </>
  )
}

function FieldSelect({
  label,
  fields,
  value,
  onChange,
}: {
  label: string
  fields: Field[]
  value: string
  onChange: (name: string) => void
}) {
  return (
    <select
      className="input"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {fields.map((f) => (
        <option key={f.name} value={f.name}>
          {f.label}
        </option>
      ))}
    </select>
  )
}

// --- B6 aggregation -------------------------------------------------------------

type MetricDraft = { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; attr: string; as: string }

const FUNCTIONS: Record<MetricDraft['fn'], MessageDescriptor> = {
  count: msg`Anzahl`,
  sum: msg`Summe`,
  avg: msg`Mittelwert`,
  min: msg`Minimum`,
  max: msg`Maximum`,
}

function AggregateForm({
  layer,
  title,
  catalog,
  onDone,
}: {
  layer: DisplayLayer
  title: string
  catalog: LayerInfo[] | undefined
  onDone: () => void
}) {
  const addDerived = useAnalysis((s) => s.addDerived)
  const setSymbology = useAnalysis((s) => s.setSymbology)
  const base = sourceName(layer)
  const areas = (catalog ?? []).filter(
    (l) => l.kind === 'vector' && l.name !== base && (l.geometry_type ?? '').includes('Polygon'),
  )
  const numeric = catalogFields(base, catalog).filter(
    (f) => f.type === 'integer' || f.type === 'real',
  )
  const [byLayer, setByLayer] = useState(areas[0]?.name ?? '')
  const areaFields = catalogFields(byLayer, catalog)
  const [predicate, setPredicate] = useState<'within' | 'intersects'>('within')
  const [metrics, setMetrics] = useState<MetricDraft[]>([{ fn: 'count', attr: '', as: 'anzahl' }])
  const names = metrics.map((m) => m.as)
  const valid =
    byLayer !== '' &&
    metrics.every((m) => isIdentifier(m.as) && (m.fn === 'count' || m.attr)) &&
    new Set(names).size === names.length &&
    !names.some((n) => areaFields.some((f) => f.name === n))
  const areaTitle = catalog?.find((l) => l.name === byLayer)?.title ?? byLayer
  const set = (i: number, patch: Partial<MetricDraft>) =>
    setMetrics(metrics.map((m, j) => (j === i ? { ...m, ...patch } : m)))

  return (
    <>
      <Row label={t`Je Gebiet aus`}>
        <select
          className="input flex-1"
          aria-label={t`Gebietslayer`}
          value={byLayer}
          onChange={(e) => setByLayer(e.target.value)}
        >
          {areas.map((l) => (
            <option key={l.name} value={l.name}>
              {l.title}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t`Zuordnung`}>
        <select
          className="input"
          aria-label={t`Zuordnung`}
          value={predicate}
          onChange={(e) => setPredicate(e.target.value as 'within' | 'intersects')}
        >
          <option value="within">
            <Trans>liegt in</Trans>
          </option>
          <option value="intersects">{t`schneidet`}</option>
        </select>
      </Row>
      <p className="mb-1 text-sm">
        <Trans>Kennzahlen</Trans>
      </p>
      <ul className="mb-2 flex flex-col gap-1">
        {metrics.map((metric, i) => (
          <li key={i} className="flex items-center gap-1.5 text-sm">
            <select
              className="input"
              aria-label={t`Funktion`}
              value={metric.fn}
              onChange={(e) => set(i, { fn: e.target.value as MetricDraft['fn'] })}
            >
              {Object.entries(FUNCTIONS).map(([fn, label]) => (
                <option key={fn} value={fn}>
                  {i18n._(label)}
                </option>
              ))}
            </select>
            {metric.fn !== 'count' && (
              <select
                className="input"
                aria-label={t`Feld`}
                value={metric.attr}
                onChange={(e) =>
                  set(i, {
                    attr: e.target.value,
                    as: `${metric.fn}_${e.target.value}`.slice(0, 63),
                  })
                }
              >
                <option value="">
                  <Trans>Feld …</Trans>
                </option>
                {numeric.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
            <Trans context="metric name">als</Trans>
            <input
              className="input w-32 font-mono"
              aria-label={t`Name der Kennzahl`}
              value={metric.as}
              onChange={(e) => set(i, { as: e.target.value })}
            />
            {metrics.length > 1 && (
              <button
                type="button"
                aria-label={t`Kennzahl entfernen`}
                onClick={() => setMetrics(metrics.filter((_, j) => j !== i))}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="text-accent-700 text-sm"
        onClick={() => setMetrics([...metrics, { fn: 'sum', attr: '', as: '' }])}
      >
        <Trans>+ Kennzahl</Trans>
      </button>
      <Actions
        onDone={onDone}
        label={t`Aggregieren`}
        disabled={!valid}
        onSubmit={() => {
          const aggregate: Aggregate = {
            by_layer: byLayer,
            predicate,
            area_fields: areaFields
              .filter((f) => f.type === 'text')
              .slice(0, 1)
              .map((f) => f.name),
            metrics: metrics.map((m) =>
              m.fn === 'count' ? { fn: 'count', as: m.as } : { fn: m.fn, attr: m.attr, as: m.as },
            ),
          }
          const id = addDerived(`${title} je ${areaTitle}`, {
            op: 'aggregate',
            layer: base,
            aggregate,
          })
          // Design B7: classes over the first metric.
          setSymbology(id, {
            kind: 'classified',
            attr: metrics[0]?.as ?? 'anzahl',
            method: 'quantile',
            classes: 5,
          })
        }}
      />
    </>
  )
}

// --- B7 / F-4.8 symbology -------------------------------------------------------

function SymbologyForm({
  layer,
  catalog,
  onDone,
}: {
  layer: DisplayLayer
  catalog: LayerInfo[] | undefined
  onDone: () => void
}) {
  const setSymbology = useAnalysis((s) => s.setSymbology)
  const current = layer.symbology
  const fields = symbologyFields(layer, catalog)
  const numeric = fields.filter((f) => f.type === 'integer' || f.type === 'real')
  const [kind, setKind] = useState<Symbology['kind']>(current?.kind ?? 'single')
  const [color, setColor] = useState(current?.kind === 'single' ? current.color : layerColor(layer))
  const [attr, setAttr] = useState(
    current && 'attr' in current ? current.attr : (fields[0]?.name ?? ''),
  )
  const [method, setMethod] = useState<'quantile' | 'equal_interval'>(
    current?.kind === 'classified' ? current.method : 'quantile',
  )
  const [classes, setClasses] = useState(
    current?.kind === 'classified' ? (current.classes ?? 5) : 5,
  )
  const choices = kind === 'classified' || kind === 'graduated_size' ? numeric : fields
  const field = choices.some((f) => f.name === attr) ? attr : (choices[0]?.name ?? '')
  const symbology: Symbology | null =
    kind === 'single'
      ? { kind, color }
      : !field
        ? null
        : kind === 'categorized'
          ? { kind, attr: field, colors: {} }
          : kind === 'classified'
            ? { kind, attr: field, method, classes }
            : { kind, attr: field, min_size: 4, max_size: 24 }

  return (
    <>
      <Row label={t`Art`}>
        <select
          className="input flex-1"
          aria-label={t`Art der Darstellung`}
          value={kind}
          onChange={(e) => setKind(e.target.value as Symbology['kind'])}
        >
          <option value="single">
            <Trans>Einzelfarbe</Trans>
          </option>
          <option value="categorized">
            <Trans>Kategorien</Trans>
          </option>
          <option value="classified">
            <Trans>Klassen</Trans>
          </option>
          <option value="graduated_size">
            <Trans>Abgestufte Grösse</Trans>
          </option>
        </select>
      </Row>
      {kind === 'single' ? (
        <Row label={t`Farbe`}>
          <input
            type="color"
            aria-label={t`Farbe`}
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </Row>
      ) : (
        <Row label={t`Feld`}>
          <FieldSelect
            label={t`Feld der Darstellung`}
            fields={choices}
            value={field}
            onChange={setAttr}
          />
        </Row>
      )}
      {kind === 'classified' && (
        <>
          <Row label={t`Methode`}>
            <select
              className="input"
              aria-label={t`Methode`}
              value={method}
              onChange={(e) => setMethod(e.target.value as 'quantile' | 'equal_interval')}
            >
              <option value="quantile">
                <Trans>Quantile</Trans>
              </option>
              <option value="equal_interval">
                <Trans>gleiche Intervalle</Trans>
              </option>
            </select>
          </Row>
          <Row label={t`Klassen`}>
            <input
              className="input w-16"
              type="number"
              min={2}
              max={9}
              aria-label={t`Anzahl Klassen`}
              value={classes}
              onChange={(e) => setClasses(Math.min(9, Math.max(2, Number(e.target.value))))}
            />
          </Row>
        </>
      )}
      {kind !== 'single' && choices.length === 0 && (
        <p className="text-muted text-sm">
          <Trans>Dieser Layer hat kein passendes Feld.</Trans>
        </p>
      )}
      <Actions
        onDone={onDone}
        label={t`Übernehmen`}
        disabled={!symbology}
        onSubmit={() => setSymbology(layer.id, symbology)}
      />
    </>
  )
}

/** Fields a layer's features carry: catalog attributes, joined fields or metrics. */
function symbologyFields(layer: DisplayLayer, catalog: LayerInfo[] | undefined): Field[] {
  if (layer.source.kind === 'derived' && layer.source.recipe.op === 'aggregate') {
    const { aggregate } = layer.source.recipe
    return [
      ...aggregate.metrics.map((m) => ({
        name: m.as,
        label: m.as,
        type: 'real' as const,
        unit: null,
        codes: null,
      })),
      ...catalogFields(aggregate.by_layer, catalog).filter((f) =>
        (aggregate.area_fields ?? []).includes(f.name),
      ),
    ]
  }
  return fieldsOf(layer, catalog)
}
