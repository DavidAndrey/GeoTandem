// Small parts of the run pages (design V4-V7): a two- or three-way choice,
// the verdict of an answer and the mark "still falsch" (design review 2:
// dashed frame, "!" and the text; never colour alone).
import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { AnswerView, Verdict } from '../../api/client'
import { isSilentlyWrong, verdictText } from './runWords'

/** Pressed buttons side by side, as the split choice of V2.1. */
export function Choice<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex">
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={`btn ${i > 0 ? '-ml-px rounded-l-none' : ''} ${i < options.length - 1 ? 'rounded-r-none' : ''} ${value === option.value ? 'border-accent text-accent-700 relative' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** "! still falsch", "! falsch · still": a dashed frame, the "!" and the words. */
export function StillWrong({ children }: { children: ReactNode }) {
  return (
    <span
      data-mark="silently-wrong"
      className="border-ink inline-flex items-center gap-1 border border-dashed px-1 text-xs whitespace-nowrap"
    >
      <span aria-hidden>!</span>
      {children}
    </span>
  )
}

/** The verdict of one answer (V7.1); a silently wrong one with its mark. */
export function VerdictLabel({ answer }: { answer: Pick<AnswerView, 'verdict' | 'flags'> }) {
  if (isSilentlyWrong(answer))
    return (
      <StillWrong>
        <Trans>falsch · still</Trans>
      </StillWrong>
    )
  return <VerdictWord verdict={answer.verdict} />
}

const LINE: Record<Verdict, string> = {
  pass: 'border-accent text-accent-700',
  wrong: 'border-ink',
  refused: 'border-neutral-400 text-muted line-through',
  kind: 'border-ink border-dashed',
  other_approach: 'border-ink border-dashed',
  forbidden: 'border-ink',
  error: 'border-ink',
}

export function VerdictWord({ verdict }: { verdict: Verdict }) {
  return (
    <span
      data-verdict={verdict}
      className={`inline-flex items-center rounded-full border px-2 text-xs whitespace-nowrap ${LINE[verdict]}`}
    >
      {verdictText(verdict)}
    </span>
  )
}
