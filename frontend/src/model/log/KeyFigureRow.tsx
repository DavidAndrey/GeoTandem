// The key-figure row of the model log (design M16.1, plan section 2): numbers
// with their share, no chart; what is not counted as a proposal below it.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import type { KeyFigures } from '../../api/client'
import { acceptanceRate, keyFigures, notCounted } from './words'

export function KeyFigureRow({ figures }: { figures: KeyFigures }) {
  const rate = acceptanceRate(figures)
  const rest = notCounted(figures)
  return (
    <section aria-label={t`Kennzahlen`} className="mb-4">
      <dl className="border-divider flex flex-wrap gap-x-8 gap-y-2 rounded-[var(--radius-md)] border px-3 py-2">
        {keyFigures(figures).map((figure) => (
          <div key={figure.key} data-figure={figure.key} className="flex flex-col">
            <dt className="text-muted text-xs">{figure.label}</dt>
            <dd className="tabular-nums">
              <span className="font-heading text-xl font-semibold">{figure.count}</span>
              {figure.share && (
                <span
                  className="text-muted ml-1.5 text-xs"
                  title={figure.of && `${figure.share} ${figure.of}`}
                >
                  {figure.share}
                </span>
              )}
            </dd>
          </div>
        ))}
        <div data-figure="acceptance_rate" className="flex flex-col">
          <dt
            className="text-muted text-xs"
            title={t`(angenommen + angepasst) / (angenommen + angepasst + abgelehnt + übergangen); auto angewendete zählen nicht mit`}
          >
            <Trans>Annahmequote</Trans>
          </dt>
          <dd className="font-heading text-xl font-semibold tabular-nums">{rate}</dd>
        </div>
      </dl>
      <p className="text-muted mt-1 text-xs">
        <Trans>
          Kennzahlen zu Vorschlägen im gewählten Zeitraum, aufschlüsselbar über die Filter. Nicht
          als Vorschlag gezählt: {rest}.
        </Trans>
      </p>
    </section>
  )
}
