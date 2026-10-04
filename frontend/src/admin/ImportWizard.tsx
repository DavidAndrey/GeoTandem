// Import wizard (design D6, with D4 for a replace and D11 for failures):
// 1 file · 2 geo-reference · 3 fields · 4 check. Warnings never block; the
// backend decides and logs every attempt (F-2.10).
import { messageText } from '../i18n/errors'
import { objectCount } from '../i18n/phrases'
import { Trans } from '@lingui/react/macro'
import { plural, t } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronRight, Circle, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, type ImportRunInfo, type Preview, type ReadOptions } from '../api/client'
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
import { fieldLabels, importedText, recordCount, typeLabel } from './format'
import { formatNumber } from '../i18n/locale'

// Names of coordinate systems and encodings, the same in every language.
/* eslint-disable lingui/no-unlocalized-strings */
const COMMON_CRS = [
  { epsg: 2056, label: 'CH1903+ / LV95' },
  { epsg: 21781, label: 'CH1903 / LV03' },
  { epsg: 4326, label: 'WGS 84' },
  { epsg: 25832, label: 'ETRS89 / UTM 32N' },
  { epsg: 3857, label: 'Web Mercator' },
]
const ENCODINGS = [
  { value: 'utf-8-sig', label: 'UTF-8' },
  { value: 'cp1252', label: 'Windows-1252' },
  { value: 'iso-8859-1', label: 'ISO-8859-1' },
]
/* eslint-enable lingui/no-unlocalized-strings */

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
  const blocked = state ? problems(state, step) : [t`Bitte eine Datei wählen.`]

  return (
    <section aria-labelledby="wizard-title" className="max-w-4xl">
      <h2 id="wizard-title" className="mb-2 text-2xl">
        {replace ? t`Layer aktualisieren` : t`Daten importieren`}
      </h2>
      <ol className="mb-4 flex items-center gap-2" aria-label={t`Schritte`}>
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
              {s} {i18n._(label)}
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
                <Trans>Abbrechen</Trans>
              </button>
              {step > 1 && (
                <button type="button" className="btn" onClick={() => setStep((step - 1) as Step)}>
                  <Trans>Zurück</Trans>
                </button>
              )}
              {step < 4 ? (
                <button
                  type="button"
                  className="btn btn-primary ml-auto"
                  disabled={blocked.length > 0}
                  onClick={() => setStep((step + 1) as Step)}
                >
                  <Trans>Weiter</Trans>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary ml-auto"
                  disabled={commit.isPending}
                  onClick={() => state && commit.mutate(state)}
                >
                  {state?.replace ? t`Ersetzen` : t`Übernehmen`}
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
  const targetTitle = target.data?.title ?? replace
  const preview = state?.preview
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xl">
        <Trans>Datei wählen</Trans>
      </h3>
      {replace && (
        <p className="text-sm">
          <Trans>
            Ersetzt den Inhalt von <strong>{targetTitle}</strong>; Bezeichnungen und Beschreibungen
            gleichnamiger Felder bleiben erhalten.
          </Trans>
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
          <Trans>
            Datei hierher ziehen oder <span className="text-accent-700 underline">auswählen</span>
          </Trans>
        </span>
        <span className="text-muted">
          <Trans>CSV · Excel · GeoPackage · Shapefile (zip) · GeoJSON</Trans>
        </span>
        <input
          type="file"
          className="sr-only"
          aria-label={t`Importdatei`}
          accept=".csv,.txt,.xlsx,.gpkg,.zip,.geojson,.json"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onFile(file)
          }}
        />
      </label>
      {uploading && (
        <p className="text-muted text-sm">
          <Trans>Datei wird gelesen …</Trans>
        </p>
      )}
      {preview && state && (
        <>
          <div className="card bg-neutral-200 p-3 text-sm">
            <p className="font-semibold">{preview.file_name}</p>
            <p className="text-muted">{previewSummary(preview)}</p>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            {preview.sublayers.length > 1 && (
              <label className="flex items-center gap-2">
                {preview.format === 'xlsx' ? t`Tabellenblatt` : t`Layer in der Datei`}
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
                  <Trans>Trennzeichen</Trans>
                  <select
                    className="input"
                    value={preview.options.delimiter ?? ','}
                    onChange={(e) => onOptions({ ...preview.options, delimiter: e.target.value })}
                  >
                    <option value=",">
                      <Trans>Komma</Trans>
                    </option>
                    <option value=";">
                      <Trans>Semikolon</Trans>
                    </option>
                    <option value={'\t'}>
                      <Trans>Tabulator</Trans>
                    </option>
                    <option value="|">
                      <Trans>Senkrechter Strich</Trans>
                    </option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <Trans>Kodierung</Trans>
                  <select
                    className="input"
                    value={preview.options.encoding ?? 'utf-8-sig'}
                    onChange={(e) => onOptions({ ...preview.options, encoding: e.target.value })}
                  >
                    {ENCODINGS.map((e) => (
                      <option key={e.value} value={e.value}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="label-caps">
                <Trans>Bezeichnung</Trans>
              </span>
              <input
                className="input"
                value={state.title}
                onChange={(e) => onChange({ title: e.target.value })}
              />
            </label>
            {!state.replace && (
              <label className="flex flex-col gap-1">
                <span className="label-caps">
                  <Trans>Technischer Name</Trans>
                </span>
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
      <p className="label-caps mb-1">
        <Trans>Vorschau</Trans>
      </p>
      <table className="data-table text-xs">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name}>
                {c.source_name}
                <div className="text-muted font-normal">{typeLabel(c.data_type)}</div>
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
      <Trans>Koordinatensystem EPSG:</Trans>
      <input
        className="input w-24"
        inputMode="numeric"
        list="common-crs"
        aria-label={t`EPSG-Code`}
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

const toStep = (step: number) => t`→ Schritt ${step}`

/** "Schulen: 120 Objekte → 124 Datensätze in der Datei. Felder: + typ" (design D4). */
function replaceSummary(layer: string, features: number, records: number, changes: string) {
  const objects = objectCount(features)
  const read = recordCount(records)
  return t`${layer}: ${objects} → ${read} in der Datei. Felder: ${changes}`
}

function CrsLabel({ label }: { label: string }) {
  return (
    <p className="text-muted text-xs">
      <Trans>Die Datei nennt: {label}</Trans>
    </p>
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
      <h3 className="text-xl">
        <Trans>Wie ist der Raumbezug angegeben?</Trans>
      </h3>
      {radio(
        'geometry',
        <>
          <Trans>Geometrie in der Datei</Trans>{' '}
          {!hasGeometry && (
            <span className="text-muted">
              <Trans>(nicht gefunden)</Trans>
            </span>
          )}
        </>,
        !hasGeometry,
      )}
      {geo.mode === 'geometry' && (
        <div className="ml-6">
          <CrsInput value={geo.crs} onChange={(crs) => onGeo({ ...geo, crs })} />
          {preview.crs_label && <CrsLabel label={preview.crs_label} />}
        </div>
      )}
      {radio('xy', t`Koordinatenspalten (X / Y)`, hasGeometry)}
      {geo.mode === 'xy' && (
        <div className="ml-6 flex flex-col gap-2 text-sm">
          <div className="flex gap-4">
            {(['x', 'y'] as const).map((axis) => (
              <label key={axis} className="flex items-center gap-2">
                {axis === 'x' ? t`X-Spalte` : t`Y-Spalte`}
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
      {radio('key', t`Schlüssel auf vorhandenen Layer`, hasGeometry)}
      {geo.mode === 'key' && (
        <div className="ml-6 flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <Trans>Spalte</Trans>
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
              aria-label={t`Ziel-Layer und Schlüssel`}
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
                <Trans>Weniger als die Hälfte der Schlüssel findet einen Treffer.</Trans>
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
      <h3 className="mb-2 text-xl">
        <Trans>Felder beschreiben</Trans>
      </h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>
              <Trans>Übernehmen</Trans>
            </th>
            <th>
              <Trans>Spalte</Trans>
            </th>
            <th>
              <Trans>Feldname</Trans>
            </th>
            <th>
              <Trans>Bezeichnung</Trans>
            </th>
            <th>
              <Trans>Einheit</Trans>
            </th>
            <th>
              <Trans>Für Modell</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {state.fields.map((field, i) => (
            <tr key={field.source_name} className={field.include ? '' : 'opacity-45'}>
              <td>
                <input
                  type="checkbox"
                  aria-label={fieldLabels(field.source_name).include}
                  checked={field.include}
                  onChange={(e) => set(i, { include: e.target.checked })}
                />
              </td>
              <td>
                {field.source_name}
                <div className="text-muted text-xs">{typeLabel(field.data_type)}</div>
              </td>
              <td>
                <input
                  className="input w-36 font-mono"
                  aria-label={fieldLabels(field.source_name).name}
                  value={field.name}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input w-full"
                  aria-label={fieldLabels(field.source_name).label}
                  value={field.label}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input w-20"
                  aria-label={fieldLabels(field.source_name).unit}
                  value={field.unit}
                  onChange={(e) => set(i, { unit: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={fieldLabels(field.source_name).forModel}
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

/** "120 Datensätze · 6 Spalten · Point · Trennzeichen „;" · UTF-8" (design D6). */
function previewSummary(preview: Preview): string {
  const columns = formatNumber(preview.columns.length)
  const delimiter = preview.options.delimiter
  return [
    recordCount(preview.record_count),
    plural(preview.columns.length, { one: `${columns} Spalte`, other: `${columns} Spalten` }),
    preview.geometry_type,
    delimiter && t`Trennzeichen „${delimiter}"`,
    preview.options.encoding,
  ]
    .filter(Boolean)
    .join(' · ')
}

// --- step 4 -------------------------------------------------------------------

function checkIcon(kind: 'ok' | 'warning' | 'todo') {
  if (kind === 'ok') return <Check size={14} aria-label={t`erledigt`} />
  if (kind === 'warning')
    return <AlertTriangle size={14} className="text-accent-700" aria-label={t`Warnung`} />
  return <Circle size={12} aria-label={t`offen`} />
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
      <h3 className="text-xl">
        <Trans>Prüfen und übernehmen</Trans>
      </h3>
      <ul className="flex flex-col gap-1.5">
        {checks(state).map((check, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            {checkIcon(check.kind)}
            <span>{check.text}</span>
            {check.step && check.kind !== 'ok' && (
              <button
                type="button"
                className="btn ml-auto text-sm"
                onClick={() => onJump(check.step as Step)}
              >
                {toStep(check.step)}
              </button>
            )}
          </li>
        ))}
      </ul>
      {state.replace && target.data && (
        <div className="card bg-neutral-200 p-3 text-sm">
          <p className="label-caps">
            <Trans>Aktualisieren</Trans>
          </p>
          <p>
            {replaceSummary(
              target.data.title,
              target.data.feature_count,
              state.preview.record_count,
              fieldChanges(
                target.data.attributes.map((a) => a.name),
                state.fields.filter((f) => f.include).map((f) => f.name),
              ),
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
        <Trans>Für das Modell sichtbar (wirkt ab E2)</Trans>
      </label>
    </div>
  )
}

// --- outcome ------------------------------------------------------------------

function FailedRun({ run }: { run: ImportRunInfo }) {
  if (run.status !== 'failed') return null
  const id = run.id
  const logPath = `/admin/protokoll/${id}`
  return (
    <div role="alert" className="border-danger mt-4 rounded-[var(--radius-md)] border p-3 text-sm">
      <p className="text-danger font-semibold">
        <Trans>Import fehlgeschlagen — nichts wurde übernommen.</Trans>
      </p>
      <ul className="list-disc pl-5">
        {run.errors.map((e) => (
          <li key={e.code}>{messageText(e)}</li>
        ))}
      </ul>
      <p className="text-muted mt-1">
        <Trans>
          Der Versuch ist protokolliert (
          <Link to={logPath} className="text-accent-700">
            Vorgang {id}
          </Link>
          ). Entscheidungen korrigieren und erneut übernehmen.
        </Trans>
      </p>
    </div>
  )
}

function Finished({ run }: { run: ImportRunInfo }) {
  return (
    <div className="flex flex-col gap-3" role="status">
      <h3 className="flex items-center gap-2 text-xl">
        <Trans>Import abgeschlossen</Trans> <StatusBadge status={run.status} />
      </h3>
      <p>{importedText(run)}.</p>
      {run.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-sm">
          {run.warnings.map((w, i) => (
            <li key={i}>{messageText(w)}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Link to={`/admin/daten/${run.layer_name}`} className="btn btn-primary">
          <Trans>Layer öffnen</Trans>
        </Link>
        <Link to={`/admin/protokoll/${run.id}`} className="btn">
          <Trans>Zum Protokoll</Trans>
        </Link>
        <Link to="/admin/daten" className="btn">
          <Trans>Zum Katalog</Trans>
        </Link>
      </div>
    </div>
  )
}
