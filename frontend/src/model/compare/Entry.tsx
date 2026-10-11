// The way into the comparison (design M10.1): the answer's ⋯ with *Mit
// Werkzeugkette wiederholen* (or *Mit Direktabfrage wiederholen* for an
// adopted chain), the finished chain's *Mit Direktabfrage vergleichen*
// (registered as model/chain/compare.ts's entry), and *Vergleich ansehen* on
// a record that has been compared. Where the server would refuse a repeat the
// entry is disabled and says why (``repeatRefusal``).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { DropdownMenu } from 'radix-ui'
import { useShallow } from 'zustand/react/shallow'
import type { ModelActionView } from '../../api/client'
import { Menu } from '../../components/ui'
import { usePanel } from '../panel/state'
import { useModel } from '../store'
import {
  compareErrorText,
  hasResult,
  openComparison,
  repeat,
  repeated,
  repeatOf,
  repeatRefusal,
  useComparison,
} from './flow'

/** What ``view``'s entry offers now: its comparison, or a repeat (and why not). */
function useEntry(view: ModelActionView) {
  // Re-read when a request starts or ends: ``repeatRefusal`` asks both.
  usePanel((s) => s.sending)
  const asking = useComparison((s) => s.asking === view.id)
  return {
    asking,
    ...useModel(
      useShallow((s) => {
        const compared = repeated(s, view) ? repeatOf(s, view) : null
        const original = compared?.compare_of != null ? s.views[compared.compare_of] : undefined
        return {
          compared: compared?.id ?? null,
          ready: !!compared && !!original && hasResult(compared) && hasResult(original),
          refusal: repeatRefusal(s, view),
        }
      }),
    ),
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

/** *Vergleich ansehen*: disabled, with the reason, while a side has no result yet. */
function OpenComparison({ repeat, ready }: { repeat: number; ready: boolean }) {
  const hint = `compare-wait-${repeat}`
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={!ready}
        aria-describedby={ready ? undefined : hint}
        onClick={() => openComparison(repeat)}
      >
        <Trans>Vergleich ansehen</Trans>
      </button>
      {!ready && (
        <span id={hint} className="text-muted text-xs">
          <Trans>Läuft noch: Verglichen wird, sobald beide Wege ein Ergebnis haben.</Trans>
        </span>
      )}
    </>
  )
}

/**
 * The answer's ⋯ (design M10.1) and, once compared, *Vergleich ansehen*: for a
 * direct answer through its life, and for a chain once adopted (its finished
 * state has ``ChainCompareEntry``).
 */
export function CompareMenu({ view }: { view: ModelActionView }) {
  const { compared, ready, refusal, asking } = useEntry(view)
  const label =
    view.approach === 'chain' ? t`Mit Direktabfrage wiederholen` : t`Mit Werkzeugkette wiederholen`
  const why =
    compared !== null && view.compare_of == null
      ? t`Schon wiederholt: Der Vergleich steht bei der Antwort.`
      : refusal
  return (
    <>
      {compared !== null && <OpenComparison repeat={compared} ready={ready} />}
      <Menu label={t`Weitere Aktionen`}>
        <DropdownMenu.Item
          disabled={why !== null || asking}
          onSelect={() => void repeat(view)}
          className="max-w-72 cursor-pointer px-3 py-1 text-sm outline-none data-[disabled]:cursor-default data-[disabled]:opacity-60 data-[highlighted]:bg-neutral-200"
        >
          <span className="block">{label}</span>
          {why && <span className="text-muted block text-xs">{why}</span>}
        </DropdownMenu.Item>
      </Menu>
      <RepeatFailure view={view} />
    </>
  )
}

/**
 * A finished chain's entry (design M9.3 *Mit Direktabfrage vergleichen*): the
 * repeat as a direct query, or, once there is one, its comparison.
 */
export function ChainCompareEntry({ view }: { view: ModelActionView }) {
  const { compared, ready, refusal, asking } = useEntry(view)
  if (compared !== null) return <OpenComparison repeat={compared} ready={ready} />
  const hint = `compare-refusal-${view.id}`
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={refusal !== null || asking}
        aria-describedby={refusal ? hint : undefined}
        onClick={() => void repeat(view)}
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
