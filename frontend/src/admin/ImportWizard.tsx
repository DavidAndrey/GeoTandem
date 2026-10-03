// Import wizard (design D6, with D4 for a replace and D11 for failures):
// 1 file · 2 geo-reference · 3 fields · 4 check. Warnings never block; the
// backend decides and logs every attempt (F-2.10).
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronRight, Circle, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, type ImportRunInfo, type ReadOptions } from '../api/client'
import { useAdminLayers, useInvalidateLayers, useLayer } from '../api/queries'
import { ErrorNotice, StatusBadge } from '../components/ui'
import {
  checks,
  fieldChanges,
  initialState,
  problems,
  STEPS,
  toDecisions,
  withPreview,
  type FieldDraft,
  type Geo,
  type Step,
  type WizardState,
} from './wizard'

const COMMON_CRS = [
  { epsg: 2056, label: 'CH1903+ / LV95' },
  { epsg: 21781, label: 'CH1903 / LV03' },
  { epsg: 4326, label: 'WGS 84' },
  { epsg: 25832, label: 'ETRS89 / UTM 32N' },
  { epsg: 3857, label: 'Web Mercator' },
]

export function ImportWizard() {
  const [params] = useSearchParams()
  const replace = params.get('ziel')
  const navigate = useNavigate()
  const invalidate = useInvalidateLayers()
  const [state, setState] = useState<WizardState>()
  const [step, setStep] = useState<Step>(1)
  const [result, setResult] = useState<ImportRunInfo>()

  const upload = useMutation({
    mutationFn: api.admin.upload,
    onSuccess: (body) => setState(initialState(body.import_id, body.preview, replace)),
  })
  const repreview = useMutation({
    mutationFn: ({ importId, options }: { importId: string; options: ReadOptions }) =>
      api.admin.repreview(importId, options),
    onSuccess: (preview) => setState((s) => s && withPreview(s, preview)),
  })
  const commit = useMutation({
    mutationFn: (current: WizardState) => api.admin.commit(current.importId, toDecisions(current)),
    onSuccess: async (run) => {
      setResult(run)
      if (run.status === 'ok' || run.status === 'warning') await invalidate()
    },
  })
  const cancel = useMutation({
    mutationFn: async () => {
      if (state && !done) await api.admin.cancel(state.importId)
    },
    onSettled: () => navigate(replace ? `/admin/daten/${replace}` : '/admin/daten'),
  })

  const done = result?.status === 'ok' || result?.status === 'warning'
  const update = (patch: Partial<WizardState>) => setState((s) => s && { ...s, ...patch })
  const blocked = state ? problems(state, step) : ['Bitte eine Datei wählen.']

  return (
    <section aria-labelledby="wizard-title" className="max-w-4xl">
      <h2 id="wizard-title" className="mb-2 text-2xl">
        {replace ? 'Layer aktualisieren' : 'Daten importieren'}
      </h2>
      <ol className="mb-4 flex items-center gap-2" aria-label="Schritte">
        {STEPS.map(({ step: s, label }, i) => (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <ChevronRight size={14} aria-hidden className="text-muted" />}
            <button
              type="button"
              className={`chip ${s === step ? 'chip-active' : ''}`}
              aria-current={s === step ? 'step' : undefined}
              disabled={!state || done || s > step}
              onClick={() => setStep(s)}
            >
              {s < step && <Check size={12} aria-hidden />}
              {s} {label}
            </button>
          </li>
        ))}
      </ol>

      <div className="card p-5">
        {done && result ? (
          <Finished run={result} />
        ) : (
          <>
            {step === 1 && (
              <FileStep
                state={state}
                replace={replace}
                uploading={upload.isPending}
                onFile={(file) => upload.mutate(file)}
                onOptions={(options) =>
                  state && repreview.mutate({ importId: state.importId, options })
                }
                onChange={update}
              />
            )}
            {state && step === 2 && <GeoStep state={state} onGeo={(geo) => update({ geo })} />}
            {state && step === 3 && (
              <FieldsStep state={state} onFields={(fields) => update({ fields })} />
            )}
            {state && step === 4 && <CheckStep state={state} onJump={setStep} onChange={update} />}
            <ErrorNotice error={upload.error ?? repreview.error ?? commit.error} />
            {result && <FailedRun run={result} />}
            {step < 4 && blocked.length > 0 && state && (
              <ul className="text-muted mt-3 list-disc pl-5 text-sm">
                {blocked.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="btn"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                Abbrechen
              </button>
              {step > 1 && (
                <button type="button" className="btn" onClick={() => setStep((step - 1) as Step)}>
                  Zurück
                </button>
              )}
              {step < 4 ? (
                <button
                  type="button"
                  className="btn btn-primary ml-auto"
                  disabled={blocked.length > 0}
                  onClick={() => setStep((step + 1) as Step)}
                >
                  Weiter
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary ml-auto"
                  disabled={commit.isPending}
                  onClick={() => state && commit.mutate(state)}
                >
                  {state?.replace ? 'Ersetzen' : 'Übernehmen'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// --- step 1 -------------------------------------------------------------------

function FileStep({
  state,
  replace,
  uploading,
  onFile,
  onOptions,
  onChange,
}: {
  state: WizardState | undefined
  replace: string | null
  uploading: boolean
  onFile: (file: File) => void
  onOptions: (options: ReadOptions) => void
  onChange: (patch: Partial<WizardState>) => void
}) {
  const target = useLayer(replace ?? '')
  const preview = state?.preview
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xl">Datei wählen</h3>
      {replace && (
        <p className="text-sm">
          Ersetzt den Inhalt von <strong>{target.data?.title ?? replace}</strong>; Bezeichnungen und
          Beschreibungen gleichnamiger Felder bleiben erhalten.
        </p>
      )}
      <label
        className="border-neutral-400 flex cursor-pointer flex-col items-center gap-1 rounded-[var(--radius-lg)] border border-dashed p-6 text-sm"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) onFile(file)
        }}
      >
        <Upload size={18} aria-hidden />
        <span>
          Datei hierher ziehen oder <span className="text-accent-700 underline">auswählen</span>
        </span>
        <span className="text-muted">CSV · Excel · GeoPackage · Shapefile (zip) · GeoJSON</span>
        <input
          type="file"
          className="sr-only"
          aria-label="Importdatei"
          accept=".csv,.txt,.xlsx,.gpkg,.zip,.geojson,.json"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onFile(file)
          }}
        />
      </label>
      {uploading && <p className="text-muted text-sm">Datei wird gelesen …</p>}
      {preview && state && (
        <>
          <div className="card bg-neutral-200 p-3 text-sm">
            <p className="font-semibold">{preview.file_name}</p>
            <p className="text-muted">
              {preview.record_count} Datensätze · {preview.columns.length} Spalten
              {preview.geometry_type && ` · ${preview.geometry_type}`}
              {preview.options.delimiter && ` · Trennzeichen „${preview.options.delimiter}"`}
              {preview.options.encoding && ` · ${preview.options.encoding}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            {preview.sublayers.length > 1 && (
              <label className="flex items-center gap-2">
                {preview.format === 'xlsx' ? 'Tabellenblatt' : 'Layer in der Datei'}
                <select
                  className="input"
                  value={preview.options.sublayer ?? ''}
                  onChange={(e) => onOptions({ ...preview.options, sublayer: e.target.value })}
                >
                  {preview.sublayers.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            {preview.format === 'csv' && (
              <>
                <label className="flex items-center gap-2">
                  Trennzeichen
                  <select
                    className="input"
                    value={preview.options.delimiter ?? ','}
                    onChange={(e) => onOptions({ ...preview.options, delimiter: e.target.value })}
                  >
                    <option value=",">Komma</option>
                    <option value=";">Semikolon</option>
                    <option value={'\t'}>Tabulator</option>
                    <option value="|">Senkrechter Strich</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  Kodierung
                  <select
                    className="input"
                    value={preview.options.encoding ?? 'utf-8-sig'}
                    onChange={(e) => onOptions({ ...preview.options, encoding: e.target.value })}
                  >
                    <option value="utf-8-sig">UTF-8</option>
                    <option value="cp1252">Windows-1252</option>
                    <option value="iso-8859-1">ISO-8859-1</option>
                  </select>
                </label>
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="label-caps">Bezeichnung</span>
              <input
                className="input"
                value={state.title}
                onChange={(e) => onChange({ title: e.target.value })}
              />
            </label>
            {!state.replace && (
              <label className="flex flex-col gap-1">
                <span className="label-caps">Technischer Name</span>
                <input
                  className="input font-mono"
                  value={state.layerName}
                  onChange={(e) => onChange({ layerName: e.target.value })}
                />
              </label>
            )}
          </div>
          <SampleTable state={state} />
        </>
      )}
    </div>
  )
}

function SampleTable({ state }: { state: WizardState }) {
  const columns = state.preview.columns
  return (
    <div className="overflow-auto">
      <p className="label-caps mb-1">Vorschau</p>
      <table className="data-table text-xs">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name}>
                {c.source_name}
                <div className="text-muted font-normal">{c.data_type}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.preview.sample_rows.slice(0, 5).map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.name}>{String(row[c.name] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- step 2 -------------------------------------------------------------------

function CrsInput({
  value,
  onChange,
}: {
  value: number | null
  onChange: (v: number | null) => void
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      Koordinatensystem EPSG:
      <input
        className="input w-24"
        inputMode="numeric"
        list="common-crs"
        aria-label="EPSG-Code"
        value={value ?? ''}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10)
          onChange(Number.isNaN(n) ? null : n)
        }}
      />
      <datalist id="common-crs">
        {COMMON_CRS.map((c) => (
          <option key={c.epsg} value={c.epsg}>
            {c.label}
          </option>
        ))}
      </datalist>
      <span className="text-muted">{COMMON_CRS.find((c) => c.epsg === value)?.label ?? ''}</span>
    </label>
  )
}

function GeoStep({ state, onGeo }: { state: WizardState; onGeo: (geo: Geo) => void }) {
  const { preview, geo } = state
  const layers = useAdminLayers()
  const numeric = preview.columns.filter((c) => c.data_type === 'integer' || c.data_type === 'real')
  const keyColumns = preview.columns.filter(
    (c) => c.data_type === 'integer' || c.data_type === 'text',
  )
  const targets = (layers.data ?? [])
    .filter((l) => l.kind === 'vector' && l.name !== state.replace)
    .flatMap((l) =>
      l.attributes
        .filter((a) => a.data_type === 'integer' || a.data_type === 'text')
        .map((a) => ({ value: `${l.name}.${a.name}`, label: `${l.title}.${a.label || a.name}` })),
    )
  const hasGeometry = preview.geometry_type !== null
  const radio = (mode: Geo['mode'], label: ReactNode, disabled = false) => (
    <label className={`flex items-center gap-2 ${disabled ? 'opacity-45' : ''}`}>
      <input
        type="radio"
        name="geo-mode"
        checked={geo.mode === mode}
        disabled={disabled}
        onChange={() =>
          onGeo(
            mode === 'geometry'
              ? { mode, crs: preview.crs ?? null }
              : mode === 'xy'
                ? {
                    mode,
                    x: preview.xy?.x ?? '',
                    y: preview.xy?.y ?? '',
                    crs: preview.xy?.crs ?? null,
                  }
                : {
                    mode,
                    column: preview.keys[0]?.column ?? '',
                    layer: preview.keys[0]?.layer ?? '',
                    attribute: preview.keys[0]?.attribute ?? '',
                  },
          )
        }
      />
      {label}
    </label>
  )
  const match =
    geo.mode === 'key'
      ? preview.keys.find(
          (k) => k.column === geo.column && k.layer === geo.layer && k.attribute === geo.attribute,
        )
      : undefined

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xl">Wie ist der Raumbezug angegeben?</h3>
      {radio(
        'geometry',
        <>
          Geometrie in der Datei{' '}
          {!hasGeometry && <span className="text-muted">(nicht gefunden)</span>}
        </>,
        !hasGeometry,
      )}
      {geo.mode === 'geometry' && (
        <div className="ml-6">
          <CrsInput value={geo.crs} onChange={(crs) => onGeo({ ...geo, crs })} />
          {preview.crs_label && (
            <p className="text-muted text-xs">Die Datei nennt: {preview.crs_label}</p>
          )}
        </div>
      )}
      {radio('xy', 'Koordinatenspalten (X / Y)', hasGeometry)}
      {geo.mode === 'xy' && (
        <div className="ml-6 flex flex-col gap-2 text-sm">
          <div className="flex gap-4">
            {(['x', 'y'] as const).map((axis) => (
              <label key={axis} className="flex items-center gap-2">
                {axis.toUpperCase()}-Spalte
                <select
                  className="input"
                  value={geo[axis]}
                  onChange={(e) => onGeo({ ...geo, [axis]: e.target.value })}
                >
                  <option value="">–</option>
                  {numeric.map((c) => (
                    <option key={c.source_name}>{c.source_name}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <CrsInput value={geo.crs} onChange={(crs) => onGeo({ ...geo, crs })} />
        </div>
      )}
      {radio('key', 'Schlüssel auf vorhandenen Layer', hasGeometry)}
      {geo.mode === 'key' && (
        <div className="ml-6 flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            Spalte
            <select
              className="input"
              value={geo.column}
              onChange={(e) => onGeo({ ...geo, column: e.target.value })}
            >
              <option value="">–</option>
              {keyColumns.map((c) => (
                <option key={c.source_name}>{c.source_name}</option>
              ))}
            </select>
            =
            <select
              className="input"
              aria-label="Ziel-Layer und Schlüssel"
              value={geo.layer ? `${geo.layer}.${geo.attribute}` : ''}
              onChange={(e) => {
                const [layer = '', attribute = ''] = e.target.value.split('.')
                onGeo({ ...geo, layer, attribute })
              }}
            >
              <option value="">–</option>
              {targets.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {match ? (
            <p>
              {match.matched} / {match.total} zugeordnet
            </p>
          ) : (
            geo.column &&
            geo.layer && (
              <p className="text-muted">
                Weniger als die Hälfte der Schlüssel findet einen Treffer.
              </p>
            )
          )}
        </div>
      )}
    </div>
  )
}

// --- step 3 -------------------------------------------------------------------

function FieldsStep({
  state,
  onFields,
}: {
  state: WizardState
  onFields: (fields: FieldDraft[]) => void
}) {
  const set = (i: number, patch: Partial<FieldDraft>) =>
    onFields(state.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <div>
      <h3 className="mb-2 text-xl">Felder beschreiben</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Übernehmen</th>
            <th>Spalte</th>
            <th>Feldname</th>
            <th>Bezeichnung</th>
            <th>Einheit</th>
            <th>Für Modell</th>
          </tr>
        </thead>
        <tbody>
          {state.fields.map((field, i) => (
            <tr key={field.source_name} className={field.include ? '' : 'opacity-45'}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${field.source_name} übernehmen`}
                  checked={field.include}
                  onChange={(e) => set(i, { include: e.target.checked })}
                />
              </td>
              <td>
                {field.source_name}
                <div className="text-muted text-xs">{field.data_type}</div>
              </td>
              <td>
                <input
                  className="input w-36 font-mono"
                  aria-label={`Feldname ${field.source_name}`}
                  value={field.name}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input w-full"
                  aria-label={`Bezeichnung ${field.source_name}`}
                  value={field.label}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input w-20"
                  aria-label={`Einheit ${field.source_name}`}
                  value={field.unit}
                  onChange={(e) => set(i, { unit: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${field.source_name} für Modell`}
                  checked={field.for_model}
                  onChange={(e) => set(i, { for_model: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- step 4 -------------------------------------------------------------------

const CHECK_ICONS = {
  ok: <Check size={14} aria-label="erledigt" />,
  warning: <AlertTriangle size={14} className="text-accent-700" aria-label="Warnung" />,
  todo: <Circle size={12} aria-label="offen" />,
}

function CheckStep({
  state,
  onJump,
  onChange,
}: {
  state: WizardState
  onJump: (step: Step) => void
  onChange: (patch: Partial<WizardState>) => void
}) {
  const target = useLayer(state.replace ?? '')
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xl">Prüfen und übernehmen</h3>
      <ul className="flex flex-col gap-1.5">
        {checks(state).map((check, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            {CHECK_ICONS[check.kind]}
            <span>{check.text}</span>
            {check.step && check.kind !== 'ok' && (
              <button
                type="button"
                className="btn ml-auto text-sm"
                onClick={() => onJump(check.step as Step)}
              >
                → Schritt {check.step}
              </button>
            )}
          </li>
        ))}
      </ul>
      {state.replace && target.data && (
        <div className="card bg-neutral-200 p-3 text-sm">
          <p className="label-caps">Aktualisieren</p>
          <p>
            {target.data.title}: {target.data.feature_count} Objekte → {state.preview.record_count}{' '}
            Datensätze in der Datei. Felder:{' '}
            {fieldChanges(
              target.data.attributes.map((a) => a.name),
              state.fields.filter((f) => f.include).map((f) => f.name),
            )}
          </p>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={state.forModel}
          onChange={(e) => onChange({ forModel: e.target.checked })}
        />
        Für das Modell sichtbar (wirkt ab E2)
      </label>
    </div>
  )
}

// --- outcome ------------------------------------------------------------------

function FailedRun({ run }: { run: ImportRunInfo }) {
  if (run.status !== 'failed') return null
  return (
    <div role="alert" className="border-danger mt-4 rounded-[var(--radius-md)] border p-3 text-sm">
      <p className="text-danger font-semibold">Import fehlgeschlagen — nichts wurde übernommen.</p>
      <ul className="list-disc pl-5">
        {run.errors.map((e) => (
          <li key={e.code}>{e.message}</li>
        ))}
      </ul>
      <p className="text-muted mt-1">
        Der Versuch ist protokolliert (
        <Link to={`/admin/protokoll/${run.id}`} className="text-accent-700">
          Vorgang {run.id}
        </Link>
        ). Entscheidungen korrigieren und erneut übernehmen.
      </p>
    </div>
  )
}

function Finished({ run }: { run: ImportRunInfo }) {
  return (
    <div className="flex flex-col gap-3" role="status">
      <h3 className="flex items-center gap-2 text-xl">
        Import abgeschlossen <StatusBadge status={run.status} />
      </h3>
      <p>
        {run.imported_count} von {run.read_count} Datensätzen übernommen
        {run.rejected_count > 0 && `, ${run.rejected_count} verworfen`}.
      </p>
      {run.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-sm">
          {run.warnings.map((w, i) => (
            <li key={i}>{w.message}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Link to={`/admin/daten/${run.layer_name}`} className="btn btn-primary">
          Layer öffnen
        </Link>
        <Link to={`/admin/protokoll/${run.id}`} className="btn">
          Zum Protokoll
        </Link>
        <Link to="/admin/daten" className="btn">
          Zum Katalog
        </Link>
      </div>
    </div>
  )
}
