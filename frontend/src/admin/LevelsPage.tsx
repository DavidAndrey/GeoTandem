// Levels of model support (vision 8.1, plan E2.0): one column per level, a
// row per operation class. The set is edited here and saved as a whole; its
// rules (1–4 levels, one default, the default selectable) are the backend's,
// and its refusal is shown by code.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { CellMode, Level, OpClass } from '../api/client'
import { useLevels, useSaveLevels } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'

const MAX_LEVELS = 4
const MAX_PROMPT = 8000

const CLASSES: OpClass[] = ['catalog', 'query', 'spatial', 'derive', 'display']

const classLabel = (c: OpClass) =>
  ({
    catalog: t`Layer auflisten und beschreiben`,
    query: t`Abfragen und filtern`,
    spatial: t`Räumliche Beziehungen`,
    derive: t`Puffer, Join, Aggregation`,
    display: t`Darstellung`,
  })[c]

const modeLabel = (m: CellMode) =>
  ({ off: t`aus`, approve: t`mit Freigabe`, auto: t`automatisch` })[m]

type Column = Level & { key: string }

let counter = 0
const keyed = (level: Level): Column => ({ ...level, key: String(level.id ?? `neu-${++counter}`) })

const toLevel = (c: Column): Level => ({
  id: c.id,
  name: c.name,
  description: c.description,
  system_prompt: c.system_prompt,
  selectable: c.selectable,
  is_default: c.is_default,
  matrix: c.matrix,
})

const newLevel = (): Column =>
  keyed({
    name: t`Neue Stufe`,
    description: '',
    system_prompt: '',
    selectable: false,
    is_default: false,
    matrix: Object.fromEntries(CLASSES.map((c) => [c, 'off'])),
  })

const field = (label: string, level: string) => t`${label} – ${level}`
const moveLeft = (level: string) => t`„${level}" nach links`
const moveRight = (level: string) => t`„${level}" nach rechts`
const removeLevel = (level: string) => t`„${level}" entfernen`

export function LevelsPage() {
  const stored = useLevels()
  const save = useSaveLevels()
  const [draft, setDraft] = useState<Column[] | null>(null)
  const columns = draft ?? stored.data?.levels.map(keyed)
  // The stored default stays until another one is saved as the default (H7).
  const storedDefault = stored.data?.levels.find((l) => l.is_default)?.id

  const change = (next: Column[] | null) => {
    save.reset()
    setDraft(next)
  }
  const edit = (index: number, patch: Partial<Level>) =>
    columns && change(columns.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  const makeDefault = (index: number) =>
    columns && change(columns.map((c, i) => ({ ...c, is_default: i === index })))
  const move = (index: number, by: -1 | 1) => {
    if (!columns) return
    const next = [...columns]
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(index + by, 0, moved)
    change(next)
  }

  return (
    <section aria-labelledby="levels-title" className="max-w-6xl">
      <div className="mb-1 flex items-center gap-3">
        <h2 id="levels-title" className="text-2xl">
          <Trans>Stufen der Modellunterstützung</Trans>
        </h2>
        <button
          type="button"
          className="btn ml-auto"
          disabled={!columns || columns.length >= MAX_LEVELS}
          onClick={() => columns && change([...columns, newLevel()])}
        >
          <Plus size={14} aria-hidden /> <Trans>Stufe</Trans>
        </button>
      </div>
      <p className="text-muted mb-3 max-w-3xl text-sm">
        <Trans>
          Je Stufe und Art der Operation: aus (abgewiesen), mit Freigabe (der Anwender bestätigt
          vorher) oder automatisch (läuft sofort, sichtbar und rücknehmbar). Berührt eine Abfrage
          mehrere Arten, gilt die strengste. Administratoren dürfen jede Stufe verwenden.
        </Trans>
      </p>
      {stored.isPending && <Loading />}
      <ErrorNotice error={stored.error} />
      {columns && (
        <form
          aria-label={t`Stufen`}
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(columns.map(toLevel), { onSuccess: () => setDraft(null) })
          }}
        >
          <table className="data-table w-full table-fixed">
            <thead>
              <tr>
                <th className="w-48">
                  <span className="sr-only">
                    <Trans>Eigenschaft</Trans>
                  </span>
                </th>
                {columns.map((level, i) => (
                  <th key={level.key}>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="btn px-1"
                        aria-label={moveLeft(level.name)}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ChevronLeft size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="btn px-1"
                        aria-label={moveRight(level.name)}
                        disabled={i === columns.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ChevronRight size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="btn ml-auto px-1"
                        aria-label={removeLevel(level.name)}
                        disabled={
                          columns.length === 1 ||
                          level.is_default ||
                          (level.id != null && level.id === storedDefault)
                        }
                        onClick={() => change(columns.filter((_, j) => j !== i))}
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <Trans>Name</Trans>
                </th>
                {columns.map((level, i) => (
                  <td key={level.key}>
                    <input
                      className="input w-full"
                      required
                      maxLength={60}
                      aria-label={field(t`Name`, level.name)}
                      value={level.name}
                      onChange={(e) => edit(i, { name: e.target.value })}
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  <Trans>Beschreibung</Trans>
                </th>
                {columns.map((level, i) => (
                  <td key={level.key}>
                    <textarea
                      className="input w-full"
                      rows={3}
                      maxLength={500}
                      aria-label={field(t`Beschreibung`, level.name)}
                      value={level.description}
                      onChange={(e) => edit(i, { description: e.target.value })}
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  <Trans>Für Anwender wählbar</Trans>
                </th>
                {columns.map((level, i) => (
                  <td key={level.key}>
                    <input
                      type="checkbox"
                      aria-label={field(t`Für Anwender wählbar`, level.name)}
                      checked={level.selectable}
                      onChange={(e) => edit(i, { selectable: e.target.checked })}
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  <Trans>Voreingestellt</Trans>
                </th>
                {columns.map((level, i) => (
                  <td key={level.key}>
                    <input
                      type="radio"
                      name="default-level"
                      aria-label={field(t`Voreingestellt`, level.name)}
                      checked={level.is_default}
                      onChange={() => makeDefault(i)}
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <th colSpan={columns.length + 1} className="label-caps pt-3">
                  <Trans>Was das Modell darf</Trans>
                </th>
              </tr>
              {CLASSES.map((c) => (
                <tr key={c}>
                  <th scope="row">{classLabel(c)}</th>
                  {columns.map((level, i) => (
                    <td key={level.key}>
                      <select
                        className="input w-full"
                        aria-label={field(classLabel(c), level.name)}
                        value={level.matrix[c] ?? 'off'}
                        onChange={(e) =>
                          edit(i, { matrix: { ...level.matrix, [c]: e.target.value as CellMode } })
                        }
                      >
                        {(['off', 'approve', 'auto'] as const).map((m) => (
                          <option key={m} value={m}>
                            {modeLabel(m)}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row">
                  <Trans>System-Prompt</Trans>
                </th>
                {columns.map((level, i) => (
                  <td key={level.key}>
                    <textarea
                      className="input w-full font-mono text-xs"
                      rows={10}
                      maxLength={MAX_PROMPT}
                      aria-label={field(t`System-Prompt`, level.name)}
                      value={level.system_prompt}
                      onChange={(e) => edit(i, { system_prompt: e.target.value })}
                    />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <ErrorNotice error={save.error} />
          <div className="mt-3 flex items-center gap-2">
            <p className="text-muted text-xs">
              <Trans>
                Eine entfernte Stufe gilt für niemanden mehr: Wer sie gewählt hatte, arbeitet auf
                der voreingestellten.
              </Trans>
            </p>
            <button
              type="button"
              className="btn ml-auto"
              disabled={!draft || save.isPending}
              onClick={() => change(null)}
            >
              <Trans>Verwerfen</Trans>
            </button>
            <button type="submit" className="btn btn-primary" disabled={!draft || save.isPending}>
              <Trans>Speichern</Trans>
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
