// State of the import wizard (design D6) and its translation into the
// backend's ImportDecisions. Pure: the components only render and dispatch.
import { messageText } from '../i18n/errors'
import type { MessageDescriptor } from '@lingui/core'
import { msg, plural, t } from '@lingui/core/macro'
import type { FieldDecision, ImportDecisions, Preview } from '../api/client'
import { formatNumber } from '../i18n/locale'

export type Step = 1 | 2 | 3 | 4
export const STEPS: { step: Step; label: MessageDescriptor }[] = [
  { step: 1, label: msg`Datei` },
  { step: 2, label: msg`Geobezug` },
  { step: 3, label: msg`Felder` },
  { step: 4, label: msg`Prüfen` },
]

export type Geo =
  | { mode: 'geometry'; crs: number | null }
  | { mode: 'xy'; x: string; y: string; crs: number | null }
  | { mode: 'key'; column: string; layer: string; attribute: string }

export interface FieldDraft {
  source_name: string
  name: string
  include: boolean
  label: string
  description: string
  unit: string
  for_model: boolean
  data_type: string
}

export interface WizardState {
  importId: string
  preview: Preview
  /** Existing layer whose content is replaced (F-2.7 "Aktualisieren", design D4). */
  replace: string | null
  layerName: string
  title: string
  forModel: boolean
  geo: Geo
  fields: FieldDraft[]
}

const RESERVED = new Set(['fid', 'geom'])
/** Mirrors the backend's identifier(): what it would leave unchanged. */
const IDENTIFIER = /^[a-z](?:[a-z0-9]|_(?=[a-z0-9])){0,62}$/

export const isIdentifier = (name: string) => IDENTIFIER.test(name)

export function defaultGeo(preview: Preview): Geo {
  if (preview.geometry_type !== null || (preview.format !== 'csv' && preview.format !== 'xlsx'))
    return { mode: 'geometry', crs: preview.crs ?? null }
  if (preview.xy)
    return { mode: 'xy', x: preview.xy.x, y: preview.xy.y, crs: preview.xy.crs ?? null }
  const key = preview.keys[0]
  if (key) return { mode: 'key', column: key.column, layer: key.layer, attribute: key.attribute }
  return { mode: 'xy', x: '', y: '', crs: null }
}

export function initialState(
  importId: string,
  preview: Preview,
  replace: string | null = null,
): WizardState {
  return {
    importId,
    preview,
    replace,
    layerName: replace ?? preview.layer_name,
    title: preview.title,
    forModel: true,
    geo: defaultGeo(preview),
    fields: preview.columns.map((c) => ({
      source_name: c.source_name,
      name: c.name,
      include: true,
      label: c.source_name,
      description: '',
      unit: '',
      for_model: true,
      data_type: c.data_type,
    })),
  }
}

/** A new preview (other read options) keeps the decisions that still apply. */
export function withPreview(state: WizardState, preview: Preview): WizardState {
  const fresh = initialState(state.importId, preview, state.replace)
  const previous = new Map(state.fields.map((f) => [f.source_name, f]))
  return {
    ...fresh,
    layerName: state.layerName,
    title: state.title,
    forModel: state.forModel,
    fields: fresh.fields.map((f) => {
      const kept = previous.get(f.source_name)
      return kept ? { ...kept, data_type: f.data_type } : f
    }),
  }
}

/** Problems that block leaving ``step``; empty when it may proceed. */
export function problems(state: WizardState, step: Step): string[] {
  const found: string[] = []
  if (step === 1) {
    if (!state.replace && !isIdentifier(state.layerName))
      found.push(
        t`Der Layername besteht aus Kleinbuchstaben, Ziffern und einzelnen Unterstrichen und beginnt mit einem Buchstaben.`,
      )
    if (!state.title.trim()) found.push(t`Der Layer braucht eine Bezeichnung.`)
  }
  if (step === 2) {
    const geo = state.geo
    if (geo.mode === 'geometry') {
      if (state.preview.geometry_type === null) found.push(t`Die Datei enthält keine Geometrien.`)
      if (geo.crs === null) found.push(t`Das Koordinatensystem ist nicht erkannt; bitte wählen.`)
    } else if (geo.mode === 'xy') {
      if (!geo.x || !geo.y) found.push(t`Bitte X- und Y-Spalte wählen.`)
      if (geo.crs === null) found.push(t`Bitte das Koordinatensystem der Spalten wählen.`)
    } else if (!geo.column || !geo.layer || !geo.attribute) {
      found.push(t`Bitte Schlüsselspalte und Ziel-Layer wählen.`)
    }
  }
  if (step === 3) {
    const included = state.fields.filter((f) => f.include)
    const seen = new Set<string>()
    for (const { name } of included) {
      if (!isIdentifier(name)) found.push(t`„${name}" ist kein gültiger Feldname.`)
      else if (RESERVED.has(name)) found.push(t`„${name}" ist reserviert.`)
      else if (seen.has(name)) found.push(t`„${name}" kommt mehrfach vor.`)
      seen.add(name)
    }
  }
  return found
}

export const firstBlockedStep = (state: WizardState): Step | null =>
  ([1, 2, 3] as const).find((step) => problems(state, step).length > 0) ?? null

export interface Check {
  kind: 'ok' | 'warning' | 'todo'
  text: string
  step?: Step
}

const records = (n: number) => {
  const count = formatNumber(n)
  return plural(n, { one: `${count} Datensatz gelesen`, other: `${count} Datensätze gelesen` })
}

/** The summary of step 4 (design D6 "Prüfen"): ✓ done, ⚠ warning, ○ to do. */
export function checks(state: WizardState): Check[] {
  const { preview, geo } = state
  const result: Check[] = []
  const crs = geo.mode === 'key' ? null : geo.crs
  if (geo.mode === 'key') {
    const proposal = preview.keys.find(
      (k) => k.column === geo.column && k.layer === geo.layer && k.attribute === geo.attribute,
    )
    const key = `${geo.column} → ${geo.layer}.${geo.attribute}`
    let text = t`Schlüssel ${key}`
    if (proposal) {
      const matched = formatNumber(proposal.matched)
      const total = formatNumber(proposal.total)
      text = t`Schlüssel ${key}: ${matched} / ${total} zugeordnet`
    }
    result.push({
      kind: proposal && proposal.matched === proposal.total ? 'ok' : 'warning',
      text,
      step: 2,
    })
  } else if (crs !== null) {
    result.push({ kind: 'ok', text: t`Koordinatensystem EPSG:${crs}`, step: 2 })
  } else {
    result.push({ kind: 'todo', text: t`Koordinatensystem fehlt`, step: 2 })
  }
  for (const message of preview.warnings) {
    result.push({ kind: 'warning', text: messageText(message) })
  }
  for (const message of preview.errors) {
    if (message.code === 'crs_unknown' && crs !== null) continue
    result.push({
      kind: 'todo',
      text: messageText(message),
      step: message.code === 'no_rows' ? 1 : 2,
    })
  }
  const unlabelled = state.fields.filter((f) => f.include && !f.label.trim()).length
  if (unlabelled)
    result.push({
      kind: 'todo',
      text: plural(unlabelled, {
        one: '# Feld ohne Bezeichnung',
        other: '# Felder ohne Bezeichnung',
      }),
      step: 3,
    })
  if (!preview.warnings.length && !preview.errors.length)
    result.push({ kind: 'ok', text: records(preview.record_count) })
  return result
}

export function toDecisions(state: WizardState): ImportDecisions {
  const geo: ImportDecisions['geo'] =
    state.geo.mode === 'geometry'
      ? { mode: 'geometry', crs: state.geo.crs }
      : state.geo.mode === 'xy'
        ? { mode: 'xy', x: state.geo.x, y: state.geo.y, crs: state.geo.crs ?? 0 }
        : state.geo
  const fields: FieldDecision[] = state.fields.map((f) => ({
    source_name: f.source_name,
    name: f.name,
    include: f.include,
    label: f.label.trim() || null,
    description: f.description,
    unit: f.unit.trim() || null,
    for_model: f.for_model,
  }))
  return {
    options: state.preview.options,
    geo,
    layer_name: state.replace ? null : state.layerName,
    replace: state.replace,
    title: state.title.trim(),
    description: '',
    for_model: state.forModel,
    fields,
  }
}

/** Field changes of a replace, for the summary of design D4. */
export function fieldChanges(before: string[], after: string[]): string {
  const added = after.filter((n) => !before.includes(n))
  const removed = before.filter((n) => !after.includes(n))
  const parts = [
    added.length ? `+ ${added.join(', ')}` : '',
    removed.length ? `− ${removed.join(', ')}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : t`unverändert`
}
