// M8.3 "Plan anpassen" (design decision 17): before the start, values of the
// steps can be changed and steps removed; a new step comes only by prompt, so
// there is no control to add one. Both go to the server at once
// (``PATCH .../plan``), which checks the plan again: removing a step a later
// one reads is refused there, naming the step (WP75); the refusal names it as
// the list shows it. The form takes the focus; Esc and *Abbrechen* close it,
// and the focus goes back to *Anpassen …* (PlanActions).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApiRequestError, type ModelActionView, type StepEdit } from '../../api/client'
import { errorText } from '../../i18n/errors'
import { formatNumber, parseNumber } from '../../i18n/locale'
import { useApproval } from '../approval/flow'
import { closePlanEditor, editPlan } from './flow'
import { MAX_STEPS, planned, valueFields, withValue, type Scalar, type ValueField } from './steps'

/** What a value field is called, by the key that holds it in the query object. */
function fieldName(key: string): string {
  switch (key) {
    case 'distance_m':
      return t`Distanz (m)`
    case 'min':
      return t`von`
    case 'max':
      return t`bis`
    case 'text':
      return t`Text`
    default:
      return t`Wert`
  }
}

const fieldId = (position: number, field: ValueField) => `${position}:${field.path.join('.')}`

/** Booleans are no value a field could change here (``valueFields`` keeps them for completeness). */
const editable = (field: ValueField) => typeof field.value !== 'boolean'

/** The typed text as the value it replaces: a number stays a number; ``undefined`` = not one. */
function parsed(field: ValueField, text: string): Scalar | undefined {
  if (typeof field.value !== 'number') return text
  return parseNumber(text) ?? undefined
}

/** "Geplante Schritte · 5 von höchstens 8" (M8): the step limit, re-planned steps included. */
export function StepLimit({ count }: { count: number }) {
  const n = formatNumber(count)
  const max = formatNumber(MAX_STEPS)
  return <p className="label-caps">{t`Geplante Schritte · ${n} von höchstens ${max}`}</p>
}

/**
 * A refused edit in words, the step named as the list shows it: the server's
 * ``details.step`` (and ``reads``) are positions, which a removed step leaves
 * standing (WP75).
 */
function refusal(error: unknown, view: ModelActionView): string {
  if (!(error instanceof ApiRequestError) || !error.body)
    return String((error as Error)?.message ?? error)
  const { code, details = {}, message } = error.body
  const steps = planned(view)
  const place = (position: unknown) => {
    const found = steps.findIndex((s) => s.position === position)
    return formatNumber(found >= 0 ? found + 1 : Number(position))
  }
  if (typeof details.step !== 'number') return errorText(code, details, message)
  const at = place(details.step)
  if (typeof details.reads === 'number') {
    const reads = place(details.reads)
    return t`Schritt ${at} braucht das Ergebnis von Schritt ${reads}; der lässt sich darum nicht entfernen.`
  }
  const why = errorText(code, details, message)
  return t`Schritt ${at}: ${why}`
}

export function PlanEditor({ view }: { view: ModelActionView }) {
  const steps = planned(view)
  const [removed, setRemoved] = useState<number[]>([])
  const [typed, setTyped] = useState<Record<string, string>>({})
  const busy = useApproval((s) => s.busy?.action === view.id)
  const failure = useApproval((s) =>
    s.failure?.action === view.id && s.failure.step === 'plan' ? s.failure.error : null,
  )
  const form = useRef<HTMLFormElement>(null)
  // The form takes the focus: its first field, else its first button.
  useEffect(() => {
    const first =
      form.current?.querySelector<HTMLElement>('input') ??
      form.current?.querySelector<HTMLElement>('button')
    first?.focus()
  }, [])

  const fieldsOf = (args: unknown) => valueFields(args).filter(editable)
  const invalid = steps.some(
    (step) =>
      !removed.includes(step.position) &&
      fieldsOf(step.arguments).some((field) => {
        const text = typed[fieldId(step.position, field)]
        return text !== undefined && parsed(field, text) === undefined
      }),
  )
  const change: StepEdit[] = steps.flatMap((step) => {
    if (removed.includes(step.position)) return []
    let args: unknown = step.arguments
    let changed = false
    for (const field of fieldsOf(step.arguments)) {
      const text = typed[fieldId(step.position, field)]
      const value = text === undefined ? undefined : parsed(field, text)
      if (value === undefined || value === field.value) continue
      args = withValue(args, field.path, value)
      changed = true
    }
    return changed ? [{ position: step.position, arguments: args as StepEdit['arguments'] }] : []
  })
  const left = steps.length - removed.length
  const toggle = (position: number) =>
    setRemoved((r) => (r.includes(position) ? r.filter((p) => p !== position) : [...r, position]))

  return (
    <form
      ref={form}
      aria-label={t`Plan anpassen`}
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        // Esc closes the editor, not the panel.
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        closePlanEditor()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void editPlan(view, { change, remove: removed })
      }}
    >
      <StepLimit count={left} />
      <ol className="flex flex-col gap-1.5">
        {steps.map((step, i) => {
          const gone = removed.includes(step.position)
          const n = formatNumber(i + 1)
          const text = step.text
          return (
            <li
              key={step.position}
              data-removed={gone || undefined}
              className={`border-divider flex flex-wrap items-center gap-2 rounded border p-2 text-sm ${gone ? 'text-muted' : ''}`}
            >
              <span
                aria-hidden
                className="flex size-5 shrink-0 items-center justify-center rounded-full border border-neutral-400 text-xs"
              >
                {n}
              </span>
              {/* Struck by style only: <del> would be read as "gelöscht". */}
              <span className={`min-w-0 flex-1 ${gone ? 'line-through' : ''}`}>
                {text}
                {gone && <span className="sr-only">{t` · wird entfernt`}</span>}
              </span>
              {!gone &&
                fieldsOf(step.arguments).map((field) => {
                  const id = fieldId(step.position, field)
                  const value = typed[id] ?? String(field.value)
                  const wrong = parsed(field, value) === undefined
                  const name = fieldName(field.key)
                  return (
                    <input
                      key={id}
                      className="input w-24 text-right tabular-nums"
                      aria-label={t`${name} in Schritt ${n}`}
                      aria-invalid={wrong || undefined}
                      inputMode={typeof field.value === 'number' ? 'decimal' : undefined}
                      value={value}
                      onChange={(e) => setTyped((s) => ({ ...s, [id]: e.target.value }))}
                    />
                  )
                })}
              <button
                type="button"
                className="btn px-1"
                aria-label={
                  gone ? t`Schritt ${n} behalten: ${text}` : t`Schritt ${n} entfernen: ${text}`
                }
                aria-pressed={gone}
                onClick={() => toggle(step.position)}
              >
                {gone ? <Undo2 size={13} aria-hidden /> : <X size={13} aria-hidden />}
              </button>
            </li>
          )
        })}
      </ol>
      <p className="text-muted text-xs">
        <Trans>
          Geänderte Werte verlieren das ≈ der Annahme. Neue Schritte kommen nur über einen neuen
          Prompt.
        </Trans>
      </p>
      {failure !== null && (
        <p role="alert" className="text-danger my-2 text-sm">
          {refusal(failure, view)}
        </p>
      )}
      <div className="border-divider flex flex-wrap items-center gap-2 border-t pt-2">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || invalid || left === 0 || (change.length === 0 && removed.length === 0)}
        >
          <Trans>Änderungen übernehmen</Trans>
        </button>
        <button type="button" className="btn" disabled={busy} onClick={closePlanEditor}>
          <Trans>Abbrechen</Trans>
        </button>
      </div>
    </form>
  )
}
