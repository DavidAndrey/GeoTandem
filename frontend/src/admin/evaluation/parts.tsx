// Small parts of the case pages (design V1-V3): the status of a case in the
// status language of E2, the split as a two-way choice, and the tags.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { CaseStatus, Split } from '../../api/client'
import { StatusLabel } from '../../model/status'
import { MAX_TAGS, SPLITS, splitText, tagProblem, tagText } from './words'

/**
 * A case's status (V1.2): *veraltet* grey with the label struck through, as
 * E2's "veraltet"; *Datenstand geändert* a message, black. Nothing when ``ok``.
 */
export function CaseStatusLabel({ status }: { status: CaseStatus }) {
  if (status === 'stale') return <StatusLabel status="stale" />
  if (status === 'dataset_changed')
    return (
      <span
        data-status="dataset_changed"
        data-line="message"
        className="border-ink text-ink inline-flex items-center rounded-full border px-2 text-xs whitespace-nowrap"
      >
        <Trans>Datenstand geändert</Trans>
      </span>
    )
  return null
}

/** Abstimmung | Bestätigung as two pressed buttons (V2.1, V3.1). */
export function SplitChoice({
  value,
  onChange,
  label,
}: {
  value: Split
  onChange: (split: Split) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex">
      {SPLITS.map((split, i) => (
        <button
          key={split}
          type="button"
          aria-pressed={value === split}
          className={`btn ${i > 0 ? '-ml-px rounded-l-none' : 'rounded-r-none'} ${value === split ? 'border-accent text-accent-700 relative' : ''}`}
          onClick={() => onChange(split)}
        >
          {splitText(split)}
        </button>
      ))}
    </div>
  )
}

/** Tags as chips with ×, and "+ Stichwort" to add one (V2.1, V3.1). */
export function TagEditor({
  tags,
  onChange,
  known,
}: {
  tags: string[]
  onChange: (tags: string[]) => void
  /** Tags in use elsewhere, offered while typing. */
  known: string[]
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const list = useId()
  const add = () => {
    const tag = text.trim()
    if (!tag) {
      setAdding(false)
      return
    }
    const wrong = tagProblem(tag)
    if (wrong) {
      setProblem(wrong)
      return
    }
    if (!tags.includes(tag)) onChange([...tags, tag])
    setText('')
    setProblem(null)
    setAdding(false)
  }
  const keydown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      add()
    } else if (event.key === 'Escape') {
      // Only the field closes, not a dialog around it.
      event.stopPropagation()
      setText('')
      setProblem(null)
      setAdding(false)
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={t`Stichwörter`}>
        {tags.map((tag) => {
          const label = tagText(tag)
          return (
            <li key={tag} className="chip">
              {label}
              <button
                type="button"
                className="hover:text-accent-700"
                aria-label={t`Stichwort ${label} entfernen`}
                onClick={() => onChange(tags.filter((x) => x !== tag))}
              >
                ×
              </button>
            </li>
          )
        })}
        <li>
          {adding ? (
            <input
              className="input w-40 py-0 text-xs"
              aria-label={t`Neues Stichwort`}
              list={list}
              value={text}
              autoFocus
              onChange={(e) => {
                setText(e.target.value)
                setProblem(null)
              }}
              onKeyDown={keydown}
              onBlur={add}
            />
          ) : (
            tags.length < MAX_TAGS && (
              <button
                type="button"
                className="text-accent-700 text-sm"
                onClick={() => setAdding(true)}
              >
                <Trans>+ Stichwort</Trans>
              </button>
            )
          )}
        </li>
      </ul>
      <datalist id={list}>
        {known
          .filter((tag) => !tags.includes(tag))
          .map((tag) => (
            <option key={tag} value={tag}>
              {tagText(tag)}
            </option>
          ))}
      </datalist>
      {problem && (
        <p role="alert" className="text-danger text-xs">
          {problem}
        </p>
      )}
    </div>
  )
}

/** A row of a case: small caps label, value (design V2). */
export function Field({
  label,
  children,
  id,
}: {
  label: string
  children: ReactNode
  /** The control's id, so the label names it. */
  id?: string
}) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="label-caps pt-1">{id ? <label htmlFor={id}>{label}</label> : label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}
