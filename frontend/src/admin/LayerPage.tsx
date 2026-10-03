// Layer detail (design D3): description, fields and preview. The tabs
// Verlauf, Darstellung and Verwendung follow with E1.5/E1.7 (plan WP15).
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Tabs } from 'radix-ui'
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type { AttributeInfo, LayerInfo } from '../api/client'
import {
  useLayer,
  useProfile,
  useSampleRows,
  useUpdateAttribute,
  useSetVisibility,
  useUpdateLayer,
  useVisibility,
} from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { formatCodes, parseCodes } from './codes'
import { DeleteLayerDialog } from './DeleteLayerDialog'
import { formatDateTime, layerType, sourceLabel } from './format'

const TABS = [
  { value: 'beschreibung', label: 'Beschreibung' },
  { value: 'felder', label: 'Felder' },
  { value: 'vorschau', label: 'Vorschau' },
]

export function LayerPage() {
  const { layer: name = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const layer = useLayer(name)
  const [deleting, setDeleting] = useState(false)
  const tab = TABS.some((t) => t.value === params.get('reiter'))
    ? (params.get('reiter') as string)
    : 'beschreibung'

  if (layer.isPending) return <Loading />
  if (!layer.data) return <ErrorNotice error={layer.error} />
  const info = layer.data

  return (
    <section aria-labelledby="layer-title">
      <p className="text-sm">
        <Link to="/admin/daten" className="text-accent-700">
          Datenkatalog
        </Link>{' '}
        › {info.name}
      </p>
      <div className="mb-3 flex items-center gap-3">
        <h2 id="layer-title" className="text-2xl">
          {info.title}
        </h2>
        <span className="text-muted text-sm">
          {layerType(info)} · {info.feature_count} Objekte
        </span>
        <Link to={`/admin/daten/import?ziel=${info.name}`} className="btn ml-auto">
          Aktualisieren
        </Link>
        <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
          Löschen
        </button>
      </div>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => setParams({ reiter: value }, { replace: true })}
      >
        <Tabs.List className="border-divider mb-4 flex gap-5 border-b" aria-label="Layer-Detail">
          {TABS.map((t) => (
            <Tabs.Trigger key={t.value} value={t.value} className="tab">
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="beschreibung">
          <DescriptionTab key={info.updated_at} layer={info} />
        </Tabs.Content>
        <Tabs.Content value="felder">
          <FieldsTab layer={info} />
        </Tabs.Content>
        <Tabs.Content value="vorschau">
          <PreviewTab layer={info} />
        </Tabs.Content>
      </Tabs.Root>
      {deleting && (
        <DeleteLayerDialog
          layer={info}
          onClose={() => setDeleting(false)}
          onDeleted={() => navigate('/admin/daten')}
        />
      )}
    </section>
  )
}

function DescriptionTab({ layer }: { layer: LayerInfo }) {
  const update = useUpdateLayer(layer.name)
  const [title, setTitle] = useState(layer.title)
  const [description, setDescription] = useState(layer.description)
  const [forModel, setForModel] = useState(layer.for_model)
  const dirty =
    title !== layer.title || description !== layer.description || forModel !== layer.for_model

  return (
    <form
      className="grid max-w-3xl grid-cols-[1fr_16rem] gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        update.mutate({ title: title.trim(), description, for_model: forModel })
      }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="label-caps">Bezeichnung</span>
          <input
            className="input"
            value={title}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Beschreibung für Mensch und Modell</span>
          <textarea
            className="input min-h-28"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={forModel}
            onChange={(e) => setForModel(e.target.checked)}
          />
          Für das Modell sichtbar (wirkt ab E2)
        </label>
        <UserVisibility layer={layer.name} />
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={!dirty || update.isPending}>
            Speichern
          </button>
          {update.isSuccess && !dirty && <span className="text-muted text-sm">Gespeichert.</span>}
        </div>
        <ErrorNotice error={update.error} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 self-start text-sm">
        <dt className="label-caps">Name</dt>
        <dd>
          <code>{layer.name}</code>
        </dd>
        <dt className="label-caps">Quelle</dt>
        <dd>{sourceLabel(layer.source)}</dd>
        <dt className="label-caps">Stand</dt>
        <dd>{formatDateTime(layer.updated_at ?? layer.created_at)}</dd>
        <dt className="label-caps">Fassung</dt>
        <dd>{layer.dataset_version ?? '–'}</dd>
        <dt className="label-caps">Geometrie</dt>
        <dd>{layer.geometry_type ?? '–'}</dd>
      </dl>
    </form>
  )
}

/** Released for the role "user" (design D10; the same switch as on the visibility page). */
function UserVisibility({ layer }: { layer: string }) {
  const rows = useVisibility()
  const set = useSetVisibility()
  const row = rows.data?.find((r) => r.layer === layer)
  if (!row) return null
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={row.roles.user ?? false}
        disabled={set.isPending}
        onChange={(e) => set.mutate({ layer, visible: e.target.checked })}
      />
      Für Anwender sichtbar
      <ErrorNotice error={set.error} />
    </label>
  )
}

function FieldsTab({ layer }: { layer: LayerInfo }) {
  return (
    <table className="data-table max-w-5xl">
      <thead>
        <tr>
          <th className="w-6">
            <span className="sr-only">Aufklappen</span>
          </th>
          <th>Feld</th>
          <th>Typ</th>
          <th>Bezeichnung</th>
          <th>Einheit</th>
          <th>Für Modell</th>
          <th>
            <span className="sr-only">Speichern</span>
          </th>
        </tr>
      </thead>
      {layer.attributes.map((attribute) => (
        <AttributeRows
          key={`${attribute.name}:${JSON.stringify(attribute)}`}
          layer={layer.name}
          attribute={attribute}
        />
      ))}
    </table>
  )
}

const TYPE_LABELS: Record<AttributeInfo['data_type'], string> = {
  integer: 'Ganzzahl',
  real: 'Zahl',
  text: 'Text',
  boolean: 'Ja/Nein',
}

export function AttributeRows({ layer, attribute }: { layer: string; attribute: AttributeInfo }) {
  const update = useUpdateAttribute(layer)
  const numeric = attribute.data_type === 'integer' || attribute.data_type === 'real'
  const domain = attribute.value_domain ?? {}
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState(attribute.label)
  const [unit, setUnit] = useState(attribute.unit ?? '')
  const [forModel, setForModel] = useState(attribute.for_model)
  const [description, setDescription] = useState(attribute.description)
  const [min, setMin] = useState(domain.min !== undefined ? String(domain.min) : '')
  const [max, setMax] = useState(domain.max !== undefined ? String(domain.max) : '')
  const [codes, setCodes] = useState(formatCodes(domain.codes as Record<string, string>))

  const valueDomain = numeric
    ? min === '' && max === ''
      ? null
      : { min: min === '' ? null : Number(min), max: max === '' ? null : Number(max) }
    : attribute.data_type === 'text'
      ? (() => {
          const parsed = parseCodes(codes)
          return parsed ? { codes: parsed } : null
        })()
      : null

  const save = () =>
    update.mutate({
      attribute: attribute.name,
      body: { label, unit, for_model: forModel, description, value_domain: valueDomain },
    })

  return (
    <tbody>
      <tr>
        <td>
          <button
            type="button"
            className="cursor-pointer"
            aria-expanded={open}
            aria-label={`Details zu ${attribute.name}`}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td>
          <code>{attribute.name}</code>
        </td>
        <td>{TYPE_LABELS[attribute.data_type]}</td>
        <td>
          <input
            className="input w-full"
            aria-label={`Bezeichnung ${attribute.name}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </td>
        <td>
          <input
            className="input w-24"
            aria-label={`Einheit ${attribute.name}`}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
        </td>
        <td>
          <input
            type="checkbox"
            aria-label={`${attribute.name} für Modell`}
            checked={forModel}
            onChange={(e) => setForModel(e.target.checked)}
          />
        </td>
        <td>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={update.isPending}
          >
            Speichern
          </button>
        </td>
      </tr>
      {(open || update.error) && (
        <tr>
          <td />
          <td colSpan={6}>
            <div className="grid grid-cols-2 gap-4 py-1">
              <label className="flex flex-col gap-1">
                <span className="label-caps">Beschreibung</span>
                <textarea
                  className="input min-h-16"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              {numeric && (
                <fieldset className="flex flex-col gap-1">
                  <legend className="label-caps">Wertebereich</legend>
                  <div className="flex items-center gap-2">
                    <input
                      className="input w-28"
                      type="number"
                      aria-label={`Minimum ${attribute.name}`}
                      value={min}
                      onChange={(e) => setMin(e.target.value)}
                    />
                    bis
                    <input
                      className="input w-28"
                      type="number"
                      aria-label={`Maximum ${attribute.name}`}
                      value={max}
                      onChange={(e) => setMax(e.target.value)}
                    />
                  </div>
                </fieldset>
              )}
              {attribute.data_type === 'text' && (
                <label className="flex flex-col gap-1">
                  <span className="label-caps">Codeliste (je Zeile „Code = Bedeutung")</span>
                  <textarea
                    className="input min-h-16 font-mono text-xs"
                    value={codes}
                    onChange={(e) => setCodes(e.target.value)}
                  />
                </label>
              )}
              {attribute.references && (
                <p className="text-sm">
                  Schlüssel auf <code>{attribute.references}</code>
                </p>
              )}
            </div>
            <ErrorNotice error={update.error} />
          </td>
        </tr>
      )}
    </tbody>
  )
}

function PreviewTab({ layer }: { layer: LayerInfo }) {
  const profile = useProfile(layer.name)
  const rows = useSampleRows(layer.name)
  const columns = layer.attributes.map((a) => a.name)
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_22rem] gap-6">
      <div className="overflow-auto">
        <p className="label-caps mb-1">Erste Objekte</p>
        {rows.isPending && <Loading />}
        <ErrorNotice error={rows.error} />
        {rows.data && (
          <table className="data-table">
            <thead>
              <tr>
                <th>fid</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.data.features.map((feature) => (
                <tr key={feature.id}>
                  <td>{feature.id}</td>
                  {columns.map((c) => (
                    <td key={c}>{String(feature.properties[c] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <p className="label-caps mb-1">Steckbrief für das Modell (F-2.9)</p>
        {profile.isPending && <Loading />}
        <ErrorNotice error={profile.error} />
        {profile.isSuccess && (
          <pre className="card overflow-auto p-3 text-xs">
            {profile.data
              ? JSON.stringify(profile.data, null, 2)
              : 'Dieser Layer ist für das Modell nicht sichtbar.'}
          </pre>
        )}
      </div>
    </div>
  )
}
