// The state of the layer profile (plan E3, D11, design V8): the shares Phase 4
// found to matter as bar and number, per layer with a gap, and the gaps in the
// order of care — code lists, then labels, then descriptions that state a
// meaning — each with a link to the layer's fields (D3 › Felder). Complete:
// one row and a short confirmation (V8.2).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Check } from 'lucide-react'
import { Link } from 'react-router'
import type { LayerGaps, ProfileSummary } from '../api/client'
import { formatNumber } from '../i18n/locale'
import { percent } from './format'

function Share({ done, total }: { done: number; total: number }) {
  const value = percent(done, total)
  if (value === null) return <span className="text-muted">–</span>
  const shown = formatNumber(value)
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden className="inline-block h-1.5 w-24 border border-neutral-500">
        <span className="bg-ink block h-full" style={{ width: `${value}%` }} />
      </span>
      <span className="tabular-nums">{t`${shown} %`}</span>
    </span>
  )
}

const fieldsOf = (layer: string) => `/admin/daten/${encodeURIComponent(layer)}?reiter=felder`

/** A few names of a list, ``""`` as the layer's own description. */
function examples(names: string[], more: (shown: string) => string): string {
  const named = names.map((n) => (n === '' ? t`Layerbeschreibung` : n))
  const shown = named.slice(0, 3).join(', ') + (named.length > 3 ? ', …' : '')
  return more(shown)
}

/** The layers whose first gap matters most come first: code lists, then labels. */
function byCare(gaps: LayerGaps[]): LayerGaps[] {
  const rank = (g: LayerGaps) => (g.unconfirmed_codes.length ? 0 : g.unlabelled.length ? 1 : 2)
  return [...gaps].sort((a, b) => rank(a) - rank(b))
}

function Gaps({ gaps }: { gaps: LayerGaps }) {
  const title = gaps.title
  const texts = gaps.text_attributes
  const attributes = gaps.attributes
  const parts = attributes + 1
  const codesDone = formatNumber(texts - gaps.unconfirmed_codes.length)
  const labelsDone = formatNumber(attributes - gaps.unlabelled.length)
  const describedDone = formatNumber(parts - gaps.undescribed.length)
  const textCount = formatNumber(texts)
  const attributeCount = formatNumber(attributes)
  const partCount = formatNumber(parts)
  const fields = (
    <Link to={fieldsOf(gaps.layer)} className="text-accent-700 ml-auto whitespace-nowrap">
      <Trans>Felder ›</Trans>
    </Link>
  )
  return (
    <section aria-label={t`Lücken in ${title}`} className="card mb-3 border-neutral-500 p-3">
      <h4 className="mb-1 text-sm">
        <Trans>Lücken in {title} · in dieser Reihenfolge pflegen</Trans>
      </h4>
      <ol className="flex flex-col gap-1 text-sm">
        {gaps.unconfirmed_codes.length > 0 && (
          <li value={1} className="flex items-baseline gap-2">
            <span className="chip shrink-0">1</span>
            <span>
              <strong>
                <Trans>Codelisten bestätigen</Trans>
              </strong>{' '}
              ·{' '}
              {examples(
                gaps.unconfirmed_codes,
                (names) => t`${codesDone} von ${textCount} Textattributen (${names})`,
              )}{' '}
              · <Trans>stärkste Wirkung</Trans>
            </span>
            {fields}
          </li>
        )}
        {gaps.unlabelled.length > 0 && (
          <li value={2} className="flex items-baseline gap-2">
            <span className="chip shrink-0">2</span>
            <span>
              <strong>
                <Trans>Beschriftungen</Trans>
              </strong>{' '}
              ·{' '}
              {examples(
                gaps.unlabelled,
                (names) => t`${labelsDone} von ${attributeCount} Attributen (z. B. ${names})`,
              )}
            </span>
            {fields}
          </li>
        )}
        {gaps.undescribed.length > 0 && (
          <li value={3} className="flex items-baseline gap-2">
            <span className="chip shrink-0">3</span>
            <span>
              <strong>
                <Trans>Beschreibungen, die die Bedeutung nennen</Trans>
              </strong>
              , <Trans>nicht den Verbund</Trans> ·{' '}
              {examples(
                gaps.undescribed,
                (names) => t`${describedDone} von ${partCount} (fehlt: ${names})`,
              )}
            </span>
            {fields}
          </li>
        )}
      </ol>
    </section>
  )
}

export function ProfileCompleteness({
  summary,
  heading,
}: {
  summary: ProfileSummary
  heading: string
}) {
  const complete = summary.gaps.length === 0
  const rest = summary.layers - summary.gaps.length
  const others = formatNumber(rest)
  return (
    <section aria-label={t`Vollständigkeit`} className="mb-4 max-w-5xl">
      <p className="label-caps mb-1">{heading}</p>
      {summary.layers === 0 ? (
        <p className="text-muted text-sm">
          <Trans>Der Steckbrief enthält keinen Layer.</Trans>
        </p>
      ) : (
        <>
          <table className="data-table mb-2">
            <thead>
              <tr>
                <th scope="col">
                  <Trans>Layer</Trans>
                </th>
                <th scope="col">
                  <Trans>Attribute mit Beschriftung</Trans>
                </th>
                <th scope="col">
                  <Trans>Textattribute mit bestätigter Codeliste</Trans>
                </th>
                <th scope="col">
                  <Trans>Layer und Attribute mit Beschreibung</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="border-divider font-normal">
                  <Trans>Gesamt</Trans>
                </th>
                <td>
                  <Share done={summary.labelled} total={summary.attributes} />
                </td>
                <td>
                  <Share done={summary.text_with_codes} total={summary.text_attributes} />
                </td>
                <td>
                  <Share done={summary.described} total={summary.layers + summary.attributes} />
                </td>
              </tr>
              {summary.gaps.map((g) => (
                <tr key={g.layer}>
                  <th scope="row" className="border-divider font-normal">
                    {g.title}
                  </th>
                  <td>
                    <Share done={g.attributes - g.unlabelled.length} total={g.attributes} />
                  </td>
                  <td>
                    <Share
                      done={g.text_attributes - g.unconfirmed_codes.length}
                      total={g.text_attributes}
                    />
                  </td>
                  <td>
                    <Share
                      done={g.attributes + 1 - g.undescribed.length}
                      total={g.attributes + 1}
                    />
                  </td>
                </tr>
              ))}
              {!complete && rest > 0 && (
                <tr>
                  <th scope="row" className="text-muted border-divider font-normal" colSpan={4}>
                    {rest === 1
                      ? t`Ein weiterer Layer ist vollständig.`
                      : t`${others} weitere Layer sind vollständig.`}
                  </th>
                </tr>
              )}
            </tbody>
          </table>
          {complete ? (
            <p className="flex items-center gap-2 text-sm">
              <span className="chip chip-active">
                <Check size={12} aria-hidden />
                <Trans>vollständig</Trans>
              </span>
              <Trans>
                Alle Attribute beschriftet, alle Codelisten bestätigt, alle Beschreibungen
                vorhanden.
              </Trans>
            </p>
          ) : (
            byCare(summary.gaps).map((g) => <Gaps key={g.layer} gaps={g} />)
          )}
        </>
      )}
    </section>
  )
}
