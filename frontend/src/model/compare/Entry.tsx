// The way into the comparison (design M10.1): the answer's ⋯ with *Mit
// Werkzeugkette wiederholen* (or *Mit Direktabfrage wiederholen* for an
// adopted chain), the finished or stopped chain's *Mit Direktabfrage
// vergleichen* (registered as model/chain/compare.ts's entry), and *Vergleich
// ansehen* on a record that has been compared. Where the server would refuse,
// the entry says why: in the menu the item stays reachable (``aria-disabled``,
// its reason part of its name) and does nothing; a button is disabled with
// its reason beside it.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { MoreHorizontal } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ModelActionView } from '../../api/client'
import { usePanel } from '../panel/state'
import { useModel, type ModelState } from '../store'
import {
  compareErrorText,
  comparisonRefusal,
  focusComparison,
  openComparison,
  repeat,
  repeated,
  repeatOf,
  repeatRefusal,
  useComparison,
} from './flow'

/** What ``view``'s entry offers: its comparison (and why not yet), or a repeat (and why not). */
function entryOf(state: ModelState, view: ModelActionView, sending: boolean) {
  const compared = repeated(state, view) ? repeatOf(state, view) : null
  return {
    compared: compared?.id ?? null,
    waits: compared ? comparisonRefusal(state, compared) : null,
    refusal: repeatRefusal(state, view, sending),
  }
}

function useEntry(view: ModelActionView) {
  const sending = usePanel((s) => s.sending)
  const asking = useComparison((s) => s.asking)
  const busy = sending || asking !== null
  return {
    asking: asking === view.id,
    ...useModel(useShallow((s) => entryOf(s, view, busy))),
  }
}

/** A refused repeat, at the record it repeats: in words; the analysis is unchanged. */
function RepeatFailure({ view }: { view: ModelActionView }) {
  const failure = useComparison((s) => (s.failure?.action === view.id ? s.failure.error : null))
  if (!failure) return null
  return (
    <div role="alert" className="w-full text-sm">
      <p className="text-danger">{compareErrorText(failure)}</p>
      <p>
        <Trans>Ihr Stand ist unverändert.</Trans>
      </p>
    </div>
  )
}

/**
 * *Vergleich ansehen*: disabled while the comparison cannot be shown, with
 * the reason beside it ("läuft noch", a side with a class ``off``). The
 * dialog gives the focus back to it (``data-compare``).
 */
function OpenComparison({ repeat, waits }: { repeat: number; waits: string | null }) {
  const hint = `compare-wait-${repeat}`
  return (
    <>
      <button
        type="button"
        className="btn"
        data-compare={repeat}
        disabled={waits !== null}
        aria-describedby={waits ? hint : undefined}
        onClick={() => openComparison(repeat)}
      >
        <Trans>Vergleich ansehen</Trans>
      </button>
      {waits && (
        <span id={hint} className="text-muted text-xs">
          {waits}
        </span>
      )}
    </>
  )
}

/** Asks for the repeat; once it is in the dialogue its card has the focus (the menu's card is gone). */
async function repeatAndFocus(view: ModelActionView, back: () => void) {
  if (await repeat(view)) requestAnimationFrame(() => focusComparison(null))
  else back()
}

/**
 * The answer's ⋯ (design M10.1) and, once compared, *Vergleich ansehen*: for a
 * direct answer through its life, and for a chain once adopted (its finished
 * state has ``ChainCompareEntry``).
 */
export function CompareMenu({ view }: { view: ModelActionView }) {
  const { compared, waits, refusal, asking } = useEntry(view)
  const trigger = useRef<HTMLButtonElement>(null)
  const repeating = useRef(false)
  const label =
    view.approach === 'chain' ? t`Mit Direktabfrage wiederholen` : t`Mit Werkzeugkette wiederholen`
  const why =
    compared !== null && view.compare_of == null
      ? t`Schon wiederholt: Der Vergleich steht bei der Antwort.`
      : refusal
  const refused = why !== null || asking
  return (
    <>
      {compared !== null && <OpenComparison repeat={compared} waits={waits} />}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          ref={trigger}
          className="btn border-transparent px-1"
          aria-label={t`Weitere Aktionen`}
        >
          <MoreHorizontal size={16} aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="card z-[1300] min-w-40 bg-neutral-100 py-1 shadow-[var(--shadow-md)]"
            onCloseAutoFocus={(event) => {
              // The repeat's card takes the focus once it is there (``repeatAndFocus``).
              if (!repeating.current) return
              repeating.current = false
              event.preventDefault()
            }}
          >
            <DropdownMenu.Item
              aria-disabled={refused || undefined}
              onSelect={(event) => {
                // Refused: stays open, its reason readable; nothing is asked.
                if (refused) {
                  event.preventDefault()
                  return
                }
                repeating.current = true
                void repeatAndFocus(view, () => trigger.current?.focus())
              }}
              className="max-w-72 cursor-pointer px-3 py-1 text-sm outline-none aria-disabled:cursor-default aria-disabled:opacity-60 data-[highlighted]:bg-neutral-200"
            >
              <span className="block">{label}</span>
              {why && <span className="text-muted block text-xs">{why}</span>}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <RepeatFailure view={view} />
    </>
  )
}

/**
 * A finished or stopped chain's entry (design M9.3 *Mit Direktabfrage
 * vergleichen*): the repeat as a direct query, or, once there is one, its
 * comparison.
 */
export function ChainCompareEntry({ view }: { view: ModelActionView }) {
  const { compared, waits, refusal, asking } = useEntry(view)
  if (compared !== null) return <OpenComparison repeat={compared} waits={waits} />
  const hint = `compare-refusal-${view.id}`
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={refusal !== null || asking}
        aria-describedby={refusal ? hint : undefined}
        onClick={(event) => {
          const button = event.currentTarget
          void repeatAndFocus(view, () => button.focus())
        }}
      >
        <Trans>Mit Direktabfrage vergleichen</Trans>
      </button>
      {refusal && (
        <span id={hint} className="text-muted text-xs">
          {refusal}
        </span>
      )}
      <RepeatFailure view={view} />
    </>
  )
}
