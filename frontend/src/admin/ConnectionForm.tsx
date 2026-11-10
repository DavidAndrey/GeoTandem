// The form of a model connection (plan E2.1, C4–C8; plan-connection-detail 3):
// five groups, each with a heading and a line on what it is for. Local or
// external comes from the host, and an external one names it (C7). The API key
// is write-only: the form only ever knows whether one is set.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  api,
  type ConnectionDraft,
  type ConnectionInfo,
  type ConnectionPatch,
  type ConnectionWrite,
  type Effort,
  type PromptProfile,
} from '../api/client'
import { useConnectionChange } from '../api/queries'
import { ErrorNotice } from '../components/ui'
import { CheckSteps } from './connectionParts'
import {
  DEFAULT_PROMPT_PROFILE,
  EXAMPLE_SETS,
  examplesLabel,
  OUTPUT_MODES,
  outputLabel,
  placementHint,
  placementsFor,
  withExamples,
  placementLabel,
  sameProfile,
} from './promptProfile'

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
  limit_enabled: boolean
  limit_per_day: string
  prompt_profile: PromptProfile
  check_mode: ConnectionInfo['check_mode']
  price_input: string
  price_output: string
  price_currency: string
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
  limit_enabled: false,
  limit_per_day: '',
  prompt_profile: DEFAULT_PROMPT_PROFILE,
  check_mode: 'off',
  price_input: '',
  price_output: '',
  price_currency: '',
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
  limit_enabled: c.request_limit_enabled,
  limit_per_day: String(c.request_limit_per_day ?? ''),
  prompt_profile: c.prompt_profile,
  check_mode: c.check_mode,
  price_input: String(c.price_input_per_mtok ?? ''),
  price_output: String(c.price_output_per_mtok ?? ''),
  price_currency: c.price_currency ?? '',
})

/**
 * The request limit per connection (plan P5): an administrator's decision, off
 * by default; the threshold is required while it is on. Switched off, the
 * switch alone is sent: the backend keeps the threshold for the next time on.
 */
const requestLimit = (f: Form) =>
  f.limit_enabled
    ? { request_limit_enabled: true, request_limit_per_day: optionalNumber(f.limit_per_day) }
    : { request_limit_enabled: false }

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

const optionalNumber = (value: string) => (value.trim() === '' ? null : Number(value))

/**
 * The prices per million tokens (plan E3, O4): all three or none. An empty
 * field is sent as null, so the back end words a half-filled price
 * (``price_incomplete``).
 */
const prices = (f: Form) => ({
  price_input_per_mtok: optionalNumber(f.price_input),
  price_output_per_mtok: optionalNumber(f.price_output),
  price_currency: f.price_currency.trim() || null,
})

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
    ...requestLimit(f),
    // Only what was set, so the audit lists it (O8): today's profile and an
    // empty price are the back end's defaults.
    ...(sameProfile(f.prompt_profile, DEFAULT_PROMPT_PROFILE)
      ? {}
      : { prompt_profile: f.prompt_profile }),
    check_mode: f.check_mode,
    ...Object.fromEntries(Object.entries(prices(f)).filter(([, v]) => v !== null)),
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
    check_mode: f.check_mode,
    ...requestLimit(f),
    ...prices(f),
  }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(next))
    if (value !== (c[key as keyof ConnectionInfo] ?? null)) patch[key] = value
  if (!sameProfile(f.prompt_profile, c.prompt_profile)) patch.prompt_profile = f.prompt_profile
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
 * input's name is the label alone. Label and input side by side from ``sm`` up. */
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
      <label className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
        <span className="shrink-0 sm:w-44 sm:pt-1">{label}</span>
        <span className="flex-1">{children}</span>
      </label>
      {(hint || extra) && (
        <div className="text-xs sm:ml-47">
          {hint && <p className="text-muted mt-0.5">{hint}</p>}
          {extra}
        </div>
      )}
    </div>
  )
}

/** One of the form's five groups: a heading and a line on what it is for. */
function Group({
  title,
  purpose,
  children,
}: {
  title: string
  purpose: string
  children: ReactNode
}) {
  return (
    <fieldset className="border-divider mt-5 border-t pt-3 text-sm first-of-type:mt-0 first-of-type:border-t-0 first-of-type:pt-0">
      <legend className="label-caps float-left w-full">{title}</legend>
      <p className="text-muted clear-left mb-3 pt-0.5 text-xs">{purpose}</p>
      {children}
    </fieldset>
  )
}

/** A named set of checkboxes inside a group (Verfügbarkeit, Datenschutz). */
function Choices({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3"
    >
      <span id={id} className="shrink-0 sm:w-44">
        {title}
      </span>
      <div className="flex flex-1 flex-col gap-1">{children}</div>
    </div>
  )
}

export function ConnectionForm({
  connection,
  saved: savedBefore = false,
  onSaved,
  onCancel,
  onDirty,
}: {
  connection?: ConnectionInfo
  /** Arrives just saved (a new connection, now on its own page). */
  saved?: boolean
  onSaved: (connection: ConnectionInfo) => void
  onCancel: () => void
  /** Whether the form holds unsaved changes, on every change of it. */
  onDirty: (dirty: boolean) => void
}) {
  const [base, setBase] = useState<Form>(() => (connection ? fromConnection(connection) : blank))
  const [form, setForm] = useState<Form>(base)
  const [saved, setSaved] = useState(savedBefore)
  const dirty = JSON.stringify(form) !== JSON.stringify(base)
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  const set = (patch: Partial<Form>) => {
    setSaved(false)
    setForm((f) => ({ ...f, ...patch }))
  }
  const setProfile = (patch: Partial<PromptProfile>) =>
    set({ prompt_profile: { ...form.prompt_profile, ...patch } })
  const save = useConnectionChange(() =>
    connection
      ? api.admin.updateConnection(connection.id, patchBody(form, connection))
      : api.admin.createConnection(createBody(form)),
  )
  const test = useConnectionChange(() => api.admin.testDraft(draftBody(form, connection)))
  // A new address may be external: only the back end knows the local hosts.
  const moved = connection !== undefined && form.base_url.trim() !== connection.base_url
  const external = connection?.locality === 'external' || form.marked_external || moved
  const releasedBefore = connection?.locality === 'external' && connection.may_receive_data
  const releasing = external && form.may_receive_data && !releasedBefore
  const host = hostOf(form.base_url.trim())
  // The stored key goes to its own address only (C8).
  const keyNeeded = !!connection?.has_api_key && moved && !form.remove_key

  return (
    <form
      aria-label={connection ? t`Anbindung bearbeiten` : t`Neue Anbindung`}
      className="card max-w-3xl px-4 pt-4"
      onSubmit={(e) => {
        e.preventDefault()
        // The browser checks before submitting; this holds for any other way in.
        if (!e.currentTarget.reportValidity()) return
        save.mutate(undefined, {
          onSuccess: (stored) => {
            const next = fromConnection(stored)
            setBase(next)
            setForm(next)
            setSaved(true)
            onSaved(stored)
          },
        })
      }}
    >
      <Group title={t`Verbindung`} purpose={t`Wo das Modell läuft und wie man es erreicht.`}>
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
            keyNeeded
              ? t`Neue Adresse: den Schlüssel neu eintragen oder entfernen. Der gespeicherte geht nur an die bisherige.`
              : connection?.has_api_key
                ? t`Ein Schlüssel ist gespeichert. Leer lassen, um ihn zu behalten.`
                : t`Wird verschlüsselt gespeichert und nie wieder angezeigt.`
          }
        >
          <input
            className="input w-full font-mono"
            type="password"
            autoComplete="off"
            required={keyNeeded}
            value={form.api_key}
            onChange={(e) => set({ api_key: e.target.value })}
          />
        </Field>
        <Field
          label={t`Zeitlimit (s)`}
          hint={t`So lange wartet die Anwendung auf eine Antwort des Modells.`}
        >
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
      </Group>

      <Group
        title={t`Nutzung und Datenschutz`}
        purpose={t`Wer die Anbindung wählen kann und was sie erhält.`}
      >
        <Choices title={t`Verfügbarkeit`}>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            <Trans>Für Anwender verfügbar</Trans>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.is_default}
              onChange={(e) => set({ is_default: e.target.checked })}
            />
            <Trans>Voreingestellt</Trans>
          </label>
        </Choices>
        <Choices title={t`Datenschutz`}>
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
            <p className="text-muted text-xs">
              <Trans>
                Lokale Anbindungen dürfen Dateninhalte erhalten, externe nur Metadaten; nach dem
                Speichern änderbar.
              </Trans>
            </p>
          )}
          {releasing && (
            <label className="text-danger flex items-center gap-1.5">
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
          <p className="text-muted text-xs">
            <Trans>Der Text der Anfrage geht in jedem Fall an das Modell.</Trans>
          </p>
        </Choices>
      </Group>

      <Group title={t`Antwortverhalten`} purpose={t`Wie das Modell antwortet.`}>
        <Field label={t`Temperatur`} hint={t`0: immer gleich; höher: vielfältiger.`}>
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
        <Field
          label={t`Seed`}
          hint={t`Gleicher Wert: wiederholbare Antworten. Leer: es wird keiner gesendet.`}
        >
          <input
            className="input w-24"
            type="number"
            value={form.seed}
            onChange={(e) => set({ seed: e.target.value })}
          />
        </Field>
        <Field
          label={t`Denkaufwand`}
          hint={t`Wie viel das Modell vor der Antwort nachdenken darf; nur bei Modellen, die es unterstützen.`}
        >
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
        <Field
          label={t`Kontextlänge (Tokens)`}
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
      </Group>

      <Group
        title={t`Prompt und Prüfung`}
        purpose={t`Feinabstimmung der Direktabfrage; die Werkzeugkette nutzt immer den Standard. Welche Einstellung einem Modell hilft, zeigt ein Bewertungslauf.`}
      >
        <Field
          label={t`Beispiele im Prompt`}
          hint={t`Eigene: zu jeder Frage drei passende geprüfte Abstimmungsfälle, aus dem Startbestand und den als Beispiel markierten eigenen Fällen; nur mit der Standard-Reihenfolge.`}
        >
          <select
            className="input"
            value={form.prompt_profile.examples}
            onChange={(e) =>
              set({
                prompt_profile: withExamples(
                  form.prompt_profile,
                  e.target.value as PromptProfile['examples'],
                ),
              })
            }
          >
            {EXAMPLE_SETS.map((e) => (
              <option key={e} value={e}>
                {examplesLabel(e)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t`Reihenfolge im Prompt`} hint={placementHint(form.prompt_profile.placement)}>
          <select
            className="input"
            value={form.prompt_profile.placement}
            onChange={(e) =>
              setProfile({ placement: e.target.value as PromptProfile['placement'] })
            }
          >
            {placementsFor(form.prompt_profile.examples).map((p) => (
              <option key={p} value={p}>
                {placementLabel(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t`Antwortformat`}
          hint={t`Erzwungen: das Modell kann nur nach dem Antwortschema antworten. Nur im Prompt: das Schema steht als Text im Prompt.`}
        >
          <select
            className="input"
            value={form.prompt_profile.output}
            onChange={(e) => setProfile({ output: e.target.value as PromptProfile['output'] })}
          >
            {OUTPUT_MODES.map((o) => (
              <option key={o} value={o}>
                {outputLabel(o)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t`Gegenprüfung`}
          hint={t`Jede Antwort der Direktabfrage wird zusätzlich mit der Werkzeugkette gefragt; findet sie andere Objekte, ist die Antwort als unsicher markiert. Etwa doppelte Modellzeit; zählt zum Anfragelimit.`}
        >
          <select
            className="input"
            value={form.check_mode}
            onChange={(e) => set({ check_mode: e.target.value as Form['check_mode'] })}
          >
            <option value="off">{t`Aus`}</option>
            <option value="chain">{t`Mit der Werkzeugkette prüfen`}</option>
          </select>
        </Field>
      </Group>

      <Group
        title={t`Kosten und Grenzen`}
        purpose={t`Optional. Mit Preisen zeigt die Bewertung Schätzung und Kosten in Geld, sonst in Tokens.`}
      >
        <Field
          label={t`Eingabe je Mio. Tokens`}
          hint={t`Beide Beträge und die Währung, oder keines davon.`}
        >
          <input
            className="input w-28"
            type="number"
            min={0}
            step="any"
            value={form.price_input}
            onChange={(e) => set({ price_input: e.target.value })}
          />
        </Field>
        <Field label={t`Ausgabe je Mio. Tokens`}>
          <input
            className="input w-28"
            type="number"
            min={0}
            step="any"
            value={form.price_output}
            onChange={(e) => set({ price_output: e.target.value })}
          />
        </Field>
        <Field label={t`Währung`} hint={t`Drei Buchstaben, z. B. CHF, EUR, USD.`}>
          <input
            className="input w-20 font-mono"
            maxLength={3}
            pattern="[A-Z]{3}"
            title={t`Drei Grossbuchstaben, z. B. CHF`}
            autoComplete="off"
            value={form.price_currency}
            onChange={(e) => set({ price_currency: e.target.value.toUpperCase() })}
          />
        </Field>
        <label className="mt-3 mb-2 flex items-center gap-1.5">
          <input
            type="checkbox"
            role="switch"
            checked={form.limit_enabled}
            onChange={(e) => set({ limit_enabled: e.target.checked })}
          />
          <Trans>Anfragen pro Tag begrenzen</Trans>
        </label>
        <Field
          label={t`Anfragen pro Tag`}
          hint={t`Gezählt über alle Konten je Kalendertag; eine Anfrage zählt, sobald sie das Modell erreicht. Ist die Grenze erreicht, wird die Anbindung bis zum nächsten Tag abgewiesen.`}
        >
          <input
            className="input w-28"
            type="number"
            min={1}
            step={1}
            disabled={!form.limit_enabled}
            required={form.limit_enabled}
            value={form.limit_enabled ? form.limit_per_day : ''}
            onChange={(e) => set({ limit_per_day: e.target.value })}
          />
        </Field>
      </Group>

      <div className="mt-4">
        <ErrorNotice error={save.error ?? test.error} />
        {test.data && <CheckSteps result={test.data} title={t`Ergebnis des Verbindungstests`} />}
      </div>
      {/* Stays at the window's bottom edge while the form runs below it. */}
      <div className="border-divider sticky bottom-0 -mx-4 mt-2 flex items-center gap-2 rounded-b-lg border-t bg-neutral-100 px-4 py-3">
        <button type="button" className="btn" onClick={onCancel}>
          <Trans>Abbrechen</Trans>
        </button>
        {saved && !dirty && (
          <span role="status" className="text-accent-700 text-sm">
            <Trans>Gespeichert</Trans>
          </span>
        )}
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
