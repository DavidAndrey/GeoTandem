// Model connections (plan E2.1, C4–C8, C12): list, form, connection test.
// Local or external comes from the host, and an external one names it (C7).
// The API key is write-only: the page only ever knows whether one is set.
import { Trans } from '@lingui/react/macro'
import { plural, t } from '@lingui/core/macro'
import { Check, Minus, Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  api,
  type CheckResult,
  type CheckStep,
  type ConnectionDraft,
  type ConnectionInfo,
  type ConnectionPatch,
  type ConnectionWrite,
  type Effort,
} from '../api/client'
import { useConnectionChange, useConnections } from '../api/queries'
import { LocalityBadge } from '../components/LocalityBadge'
import { ConfirmDialog, ErrorNotice, Loading, Menu, MenuItem } from '../components/ui'
import { errorText } from '../i18n/errors'
import { formatNumber } from '../i18n/locale'
import { actionsFor } from '../i18n/phrases'
import { formatDateTime } from './format'

const EFFORTS: Effort[] = ['default', 'none', 'low', 'medium', 'high']

const effortLabel = (e: Effort | '') =>
  ({
    '': t`nach Art (lokal: none, extern: default)`,
    default: t`default (nichts senden)`,
    none: t`none (ohne Nachdenken)`,
    low: t`low`,
    medium: t`medium`,
    high: t`high`,
  })[e]

const stepLabel = (name: CheckStep['name']) =>
  ({
    url: t`Adresse gültig`,
    reachable: t`Erreichbar`,
    authorised: t`Zugang angenommen`,
    model: t`Modell vorhanden`,
    server: t`Ollama-Version`,
    json_schema: t`Antwort nach JSON-Schema`,
    tool_call: t`Werkzeugaufruf`,
  })[name]

const seconds = (ms: unknown) => {
  const s = formatNumber(Number(ms) / 1000, { maximumFractionDigits: 1 })
  return t`${s} s`
}

function stepDetail(step: CheckStep): string {
  const d = step.details ?? {}
  if (step.status === 'failed') return errorText(step.code ?? 'internal_error', d)
  if (step.status === 'skipped') return step.name === 'server' ? t`kein Ollama` : ''
  switch (step.name) {
    case 'url':
      return String(d.host ?? '')
    case 'reachable': {
      const count = Number(d.models ?? 0)
      return plural(count, { one: '# Modell angeboten', other: '# Modelle angeboten' })
    }
    case 'model': {
      const digest = String(d.digest ?? '')
        .replace('sha256:', '')
        .slice(0, 12)
      const gb = formatNumber(Number(d.size ?? 0) / 1e9, { maximumFractionDigits: 1 })
      return d.digest ? t`${digest} · ${gb} GB` : ''
    }
    case 'server': {
      const version = String(d.ollama ?? '')
      return t`Ollama ${version}`
    }
    default:
      return seconds(d.latency_ms)
  }
}

const STEP_ICON: Record<CheckStep['status'], ReactNode> = {
  ok: <Check size={14} aria-hidden className="text-accent-700" />,
  failed: <X size={14} aria-hidden className="text-danger" />,
  skipped: <Minus size={14} aria-hidden className="text-muted" />,
}

const statusWord = (s: CheckStep['status']) =>
  ({ ok: t`in Ordnung`, failed: t`fehlgeschlagen`, skipped: t`übersprungen` })[s]

export function CheckSteps({ result, title }: { result: CheckResult; title: string }) {
  const when = formatDateTime(result.tested_at)
  return (
    <section aria-label={title} className="card my-3 max-w-2xl p-3 text-sm">
      <p className="mb-2 font-semibold">
        {result.ok ? t`Verbindungstest bestanden` : t`Verbindungstest nicht bestanden`}{' '}
        <span className="text-muted font-normal">{when}</span>
      </p>
      <ol>
        {result.steps.map((step) => (
          <li key={step.name} className="flex gap-2 py-0.5">
            <span className="mt-0.5" title={statusWord(step.status)}>
              {STEP_ICON[step.status]}
            </span>
            <span className="w-48 shrink-0">
              {stepLabel(step.name)}
              <span className="sr-only">: {statusWord(step.status)}</span>
            </span>
            <span className={step.status === 'failed' ? 'text-danger' : 'text-muted'}>
              {stepDetail(step)}
              {step.cause && (
                <code className="text-muted ml-2 text-xs" title={t`Ursache`}>
                  {step.cause}
                </code>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

// --- the form ------------------------------------------------------------------

type Form = {
  name: string
  base_url: string
  model: string
  api_key: string
  remove_key: boolean
  temperature: string
  seed: string
  timeout_s: string
  reasoning_effort: Effort | ''
  context_length: string
  enabled: boolean
  is_default: boolean
  may_receive_data: boolean
  marked_external: boolean
  confirm_data_release: boolean
}

const blank: Form = {
  name: '',
  base_url: 'http://host.docker.internal:11434/v1',
  model: '',
  api_key: '',
  remove_key: false,
  temperature: '0',
  seed: '42',
  timeout_s: '120',
  reasoning_effort: '',
  context_length: '',
  enabled: false,
  is_default: false,
  may_receive_data: true,
  marked_external: false,
  confirm_data_release: false,
}

const fromConnection = (c: ConnectionInfo): Form => ({
  ...blank,
  name: c.name,
  base_url: c.base_url,
  model: c.model,
  temperature: String(c.temperature),
  seed: c.seed === null ? '' : String(c.seed),
  timeout_s: String(c.timeout_s),
  reasoning_effort: c.reasoning_effort,
  context_length: c.context_length === null ? '' : String(c.context_length),
  enabled: c.enabled,
  is_default: c.is_default,
  may_receive_data: c.may_receive_data,
  marked_external: c.marked_external,
})

const optionalNumber = (value: string) => (value.trim() === '' ? null : Number(value))

/** The fields both a saved connection and a draft test share. */
const parameters = (f: Form) => ({
  base_url: f.base_url,
  model: f.model,
  temperature: Number(f.temperature),
  seed: optionalNumber(f.seed),
  timeout_s: Number(f.timeout_s),
  marked_external: f.marked_external,
})

function createBody(f: Form): ConnectionWrite {
  return {
    ...parameters(f),
    name: f.name,
    api_key: f.api_key || undefined,
    reasoning_effort: f.reasoning_effort || undefined,
    context_length: optionalNumber(f.context_length),
    enabled: f.enabled,
    is_default: f.is_default,
    confirm_data_release: false,
  }
}

function patchBody(f: Form, c: ConnectionInfo): ConnectionPatch {
  const next = {
    ...parameters(f),
    name: f.name,
    reasoning_effort: f.reasoning_effort || c.reasoning_effort,
    context_length: optionalNumber(f.context_length),
    enabled: f.enabled,
    is_default: f.is_default,
    may_receive_data: f.may_receive_data,
  }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(next))
    if (value !== c[key as keyof ConnectionInfo]) patch[key] = value
  if (f.api_key) patch.api_key = f.api_key
  else if (f.remove_key) patch.api_key = null
  if (f.confirm_data_release) patch.confirm_data_release = true
  return patch as ConnectionPatch
}

function draftBody(f: Form, c?: ConnectionInfo): ConnectionDraft {
  return {
    ...parameters(f),
    api_key: f.api_key || undefined,
    connection_id: c && !f.api_key && !f.remove_key ? c.id : undefined,
    reasoning_effort: f.reasoning_effort || undefined,
  }
}

/** A labelled input; the hint and any extra control sit outside the label, so the
 * input's name is the label alone. */
function Field({
  label,
  hint,
  extra,
  children,
}: {
  label: string
  hint?: string
  extra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mb-2 text-sm">
      <label className="flex items-start gap-3">
        <span className="w-40 shrink-0 pt-1">{label}</span>
        <span className="flex-1">{children}</span>
      </label>
      {(hint || extra) && (
        <div className="ml-43 text-xs">
          {hint && <p className="text-muted mt-0.5">{hint}</p>}
          {extra}
        </div>
      )}
    </div>
  )
}

function ConnectionForm({
  connection,
  onDone,
}: {
  connection?: ConnectionInfo
  onDone: () => void
}) {
  const [form, setForm] = useState<Form>(connection ? fromConnection(connection) : blank)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const save = useConnectionChange(() =>
    connection
      ? api.admin.updateConnection(connection.id, patchBody(form, connection))
      : api.admin.createConnection(createBody(form)),
  )
  const test = useConnectionChange(() => api.admin.testDraft(draftBody(form, connection)))
  const external = connection?.locality === 'external' || form.marked_external
  const releasing = external && form.may_receive_data && !connection?.may_receive_data
  const host = connection?.host ?? ''

  return (
    <form
      aria-label={connection ? t`Anbindung bearbeiten` : t`Neue Anbindung`}
      className="card mb-4 max-w-2xl p-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined, { onSuccess: onDone })
      }}
    >
      <h3 className="mb-3 text-lg">
        {connection ? connection.name : <Trans>Neue Anbindung</Trans>}
      </h3>
      <Field label={t`Name`}>
        <input
          className="input w-full"
          required
          maxLength={60}
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <Field
        label={t`Adresse`}
        hint={t`OpenAI-kompatibel, mit /v1. Lokal sind 127.0.0.1, localhost, host.docker.internal und die Namen in GEOTANDEM_LLM_LOCAL_HOSTS; alles andere ist extern.`}
      >
        <input
          className="input w-full font-mono"
          required
          maxLength={500}
          value={form.base_url}
          onChange={(e) => set({ base_url: e.target.value })}
        />
      </Field>
      <Field label={t`Modell`}>
        <input
          className="input w-full font-mono"
          required
          maxLength={200}
          value={form.model}
          onChange={(e) => set({ model: e.target.value })}
        />
      </Field>
      <Field
        label={t`API-Schlüssel`}
        extra={
          connection?.has_api_key && (
            <label className="mt-1 flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={form.remove_key}
                disabled={form.api_key !== ''}
                onChange={(e) => set({ remove_key: e.target.checked })}
              />
              <Trans>Schlüssel entfernen</Trans>
            </label>
          )
        }
        hint={
          connection?.has_api_key
            ? t`Ein Schlüssel ist gespeichert. Leer lassen, um ihn zu behalten.`
            : t`Wird verschlüsselt gespeichert und nie wieder angezeigt.`
        }
      >
        <input
          className="input w-full font-mono"
          type="password"
          autoComplete="off"
          value={form.api_key}
          onChange={(e) => set({ api_key: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label={t`Temperatur`}>
          <input
            className="input w-24"
            type="number"
            min={0}
            max={2}
            step={0.1}
            required
            value={form.temperature}
            onChange={(e) => set({ temperature: e.target.value })}
          />
        </Field>
        <Field label={t`Seed`}>
          <input
            className="input w-24"
            type="number"
            value={form.seed}
            onChange={(e) => set({ seed: e.target.value })}
          />
        </Field>
        <Field label={t`Zeitlimit (s)`}>
          <input
            className="input w-24"
            type="number"
            min={1}
            max={600}
            required
            value={form.timeout_s}
            onChange={(e) => set({ timeout_s: e.target.value })}
          />
        </Field>
        <Field
          label={t`Kontextlänge`}
          hint={t`Budget für den Layer-Steckbrief; wird nicht gesendet.`}
        >
          <input
            className="input w-28"
            type="number"
            min={256}
            value={form.context_length}
            onChange={(e) => set({ context_length: e.target.value })}
          />
        </Field>
      </div>
      <Field label={t`Denkaufwand`}>
        <select
          className="input"
          value={form.reasoning_effort}
          onChange={(e) => set({ reasoning_effort: e.target.value as Effort | '' })}
        >
          {(connection ? EFFORTS : (['', ...EFFORTS] as const)).map((e) => (
            <option key={e} value={e}>
              {effortLabel(e)}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="mt-3 text-sm">
        <legend className="label-caps mb-1">
          <Trans>Freigabe</Trans>
        </legend>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          <Trans>Für Anwender freigegeben</Trans>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={(e) => set({ is_default: e.target.checked })}
          />
          <Trans>Voreingestellt</Trans>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.marked_external}
            onChange={(e) => set({ marked_external: e.target.checked })}
          />
          <Trans>Als extern behandeln, obwohl der Host lokal ist</Trans>
        </label>
        {connection ? (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.may_receive_data}
              onChange={(e) =>
                set({ may_receive_data: e.target.checked, confirm_data_release: false })
              }
            />
            <Trans>Darf Dateninhalte erhalten (sonst nur Metadaten)</Trans>
          </label>
        ) : (
          <p className="text-muted mt-1 text-xs">
            <Trans>
              Lokale Anbindungen dürfen Dateninhalte erhalten, externe nur Metadaten; nach dem
              Speichern änderbar.
            </Trans>
          </p>
        )}
        {releasing && (
          <label className="text-danger mt-1 flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.confirm_data_release}
              onChange={(e) => set({ confirm_data_release: e.target.checked })}
            />
            {host ? (
              <Trans>Ich bestätige: Dateninhalte dürfen an {host} gehen.</Trans>
            ) : (
              <Trans>Ich bestätige: Dateninhalte dürfen nach aussen gehen.</Trans>
            )}
          </label>
        )}
        <p className="text-muted mt-1 text-xs">
          <Trans>Der Text der Anfrage geht in jedem Fall an das Modell.</Trans>
        </p>
      </fieldset>
      <ErrorNotice error={save.error ?? test.error} />
      {test.data && <CheckSteps result={test.data} title={t`Ergebnis des Verbindungstests`} />}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn" onClick={onDone}>
          <Trans>Abbrechen</Trans>
        </button>
        <button
          type="button"
          className="btn ml-auto"
          disabled={test.isPending || !form.base_url || !form.model}
          onClick={() => test.mutate(undefined)}
        >
          {test.isPending ? t`Testet …` : t`Verbindung testen`}
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          <Trans>Speichern</Trans>
        </button>
      </div>
    </form>
  )
}

// --- the page ------------------------------------------------------------------

const deleteTitle = (name: string) => t`Anbindung „${name}" löschen?`
const testTitle = (name: string) => t`Verbindungstest „${name}"`

function LastTest({ connection }: { connection: ConnectionInfo }) {
  const last = connection.last_test as CheckResult | null
  if (!last) return <span className="text-muted">–</span>
  const when = formatDateTime(last.tested_at)
  return (
    <span className="flex items-center gap-1">
      {last.ok ? STEP_ICON.ok : STEP_ICON.failed}
      {last.ok ? t`bestanden` : t`nicht bestanden`}
      <span className="text-muted text-xs">{when}</span>
    </span>
  )
}

export function ConnectionsPage() {
  const connections = useConnections()
  const [editing, setEditing] = useState<ConnectionInfo | 'new'>()
  const [deleting, setDeleting] = useState<ConnectionInfo>()
  const [tested, setTested] = useState<{ name: string; result: CheckResult }>()
  const remove = useConnectionChange(api.admin.deleteConnection)
  const test = useConnectionChange((c: ConnectionInfo) =>
    api.admin.testConnection(c.id).then((result) => setTested({ name: c.name, result })),
  )

  return (
    <section aria-labelledby="connections-title" className="max-w-5xl">
      <div className="mb-1 flex items-center gap-3">
        <h2 id="connections-title" className="text-2xl">
          <Trans>Modellanbindungen</Trans>
        </h2>
        <button type="button" className="btn btn-primary ml-auto" onClick={() => setEditing('new')}>
          <Plus size={14} aria-hidden /> <Trans>Anbindung</Trans>
        </button>
      </div>
      <p className="text-muted mb-3 max-w-3xl text-sm">
        <Trans>
          Modelle hinter einer OpenAI-kompatiblen Schnittstelle (Ollama, vLLM, llama.cpp, Cloud).
          Anwender wählen unter den freigegebenen; eine nicht freigegebene nutzt niemand, auch kein
          Administrator.
        </Trans>
      </p>
      {editing && (
        <ConnectionForm
          key={editing === 'new' ? 'new' : editing.id}
          connection={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(undefined)}
        />
      )}
      {connections.isPending && <Loading />}
      <ErrorNotice error={connections.error ?? test.error} />
      {test.isPending && <Loading />}
      {tested && <CheckSteps result={tested.result} title={testTitle(tested.name)} />}
      {connections.data?.length === 0 && (
        <p className="text-muted text-sm">
          <Trans>
            Noch keine Anbindung. Ohne sie steht nur die klassische Bedienung (Modus A) zur
            Verfügung.
          </Trans>
        </p>
      )}
      {!!connections.data?.length && (
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <Trans>Name</Trans>
              </th>
              <th>
                <Trans>Modell</Trans>
              </th>
              <th>
                <Trans>Art</Trans>
              </th>
              <th>
                <Trans>Für Anwender</Trans>
              </th>
              <th>
                <Trans>Dateninhalte</Trans>
              </th>
              <th>
                <Trans>Letzter Test</Trans>
              </th>
              <th>
                <span className="sr-only">
                  <Trans>Aktionen</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {connections.data.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  {c.is_default && (
                    <span className="chip ml-2">
                      <Trans>voreingestellt</Trans>
                    </span>
                  )}
                  {c.credentials_unreadable && (
                    <div className="text-danger text-xs">{errorText('credentials_unreadable')}</div>
                  )}
                </td>
                <td className="font-mono text-xs">{c.model}</td>
                <td>
                  <LocalityBadge locality={c.locality} host={c.host} />
                </td>
                <td>{c.enabled ? t`freigegeben` : t`nicht freigegeben`}</td>
                <td>{c.may_receive_data ? t`erlaubt` : t`nur Metadaten`}</td>
                <td>
                  <LastTest connection={c} />
                </td>
                <td className="text-right">
                  <Menu label={actionsFor(c.name)}>
                    <MenuItem onSelect={() => setEditing(c)}>
                      <Trans>Bearbeiten</Trans>
                    </MenuItem>
                    <MenuItem onSelect={() => test.mutate(c)}>
                      <Trans>Verbindung testen</Trans>
                    </MenuItem>
                    <MenuItem danger onSelect={() => setDeleting(c)}>
                      <Trans>Löschen</Trans>
                    </MenuItem>
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(undefined)}
          title={deleteTitle(deleting.name)}
          confirm={t`Löschen`}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(undefined) })}
        >
          <p>
            <Trans>
              Wer sie gewählt hatte, arbeitet mit der voreingestellten Anbindung weiter.
            </Trans>
          </p>
          <ErrorNotice error={remove.error} />
        </ConfirmDialog>
      )}
    </section>
  )
}
