// A case's reference (design V2.1, V2.3): each reading as the readable
// condition tree of E2 with the JSON only under "Technisch", its hits on the
// case's data state, and "Im Arbeitsplatz öffnen", which makes a reading the
// workplace's analysis as a saved query opens there (design B1).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { DropdownMenu } from 'radix-ui'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { QueryPart } from '../../analysis/model'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import type { DataState } from '../../api/client'
import { useLayers } from '../../api/queries'
import { ConfirmDialog } from '../../components/ui'
import { useCounts } from '../../editor/useCounts'
import { hitsOf } from '../../i18n/phrases'
import { QueryTree } from '../../model/tree'
import { wouldLose } from '../../queries/part'
import { useSession } from '../../session/store'
import { analysisOf, partOf } from './reference'
import { dataStateText, hitsText, readingName } from './words'

/** Replaces the workplace's query with ``part`` and goes there (the open session, if any). */
function useOpenInWorkplace() {
  const navigate = useNavigate()
  const [pending, setPending] = useState<QueryPart | null>(null)
  const go = (part: QueryPart) => {
    useAnalysis.getState().applyQuery(part, null)
    const session = useSession.getState().current
    navigate(session ? `/sitzung/${session.id}` : '/')
  }
  const open = (part: QueryPart) => {
    const s = useAnalysis.getState()
    // As a saved query opens (B1): unsaved conditions are not dropped without a question.
    if (wouldLose(currentAnalysis(s), s.queryRef)) setPending(part)
    else go(part)
  }
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(next) => !next && setPending(null)}
      title={t`Abfrage im Arbeitsplatz ersetzen?`}
      confirm={t`Ersetzen`}
      onConfirm={() => pending && go(pending)}
    >
      <Trans>
        Die Abfrage im Arbeitsplatz hat ungespeicherte Bedingungen. Sie wird durch die Referenz des
        Prüffalls ersetzt.
      </Trans>
    </ConfirmDialog>
  )
  return { open, dialog }
}

/** One reading: its tree with the hits per condition where they can be counted, and its hits. */
function Reading({
  reading,
  name,
  hits,
  dataState,
  part,
  onRemove,
  pending,
}: {
  reading: Record<string, unknown>
  name: string | null
  onRemove?: () => void
  /** The readings were changed and not yet saved: hits come with the save. */
  pending?: boolean
  hits: number | null
  dataState: DataState
  part: QueryPart | null
}) {
  // Per condition only on the live catalog: the counting route reads it, not the sample copy.
  const live = dataState === 'live'
  const analysis = useMemo(() => analysisOf(live ? part : null), [live, part])
  const counts = useCounts(analysis)
  const state = dataStateText(dataState)
  const total = counts.data?.total
  const found = pending
    ? t`Treffer neu nach dem Speichern`
    : hits === null
      ? t`Treffer nicht bestimmbar`
      : live && total !== undefined
        ? hitsOf(hits, total)
        : hitsText(hits)
  return (
    <div className="flex flex-col gap-1" role="group" aria-label={name ?? t`Referenz`}>
      {name && (
        <p className="label-caps flex items-center gap-2">
          {name}
          {onRemove && (
            <button
              type="button"
              className="text-accent-700 normal-case tracking-normal"
              onClick={onRemove}
            >
              {t`${name} entfernen`}
            </button>
          )}
        </p>
      )}
      <QueryTree query={reading} line="applied" counts={counts.data?.rows} />
      <p className="text-sm tabular-nums">
        <Trans>
          {found} · Datenstand {state}
        </Trans>
      </p>
    </div>
  )
}

/** The readings of a query case with their hits, and how to open one in the workplace. */
export function Reference({
  docs,
  hits,
  dataState,
  extra,
  onRemove,
  pending,
  guard = (go) => go(),
}: {
  docs: Record<string, unknown>[]
  /** The readings differ from the saved ones (V2.1 "Weitere Lesart"). */
  pending?: boolean
  /** Asks before leaving the page, e.g. while the case has unsaved edits. */
  guard?: (go: () => void) => void
  /** Removes a reading (an own case with several, V2.1). */
  onRemove?: (index: number) => void
  hits: number[] | null | undefined
  dataState: DataState
  /** More actions beside "Im Arbeitsplatz öffnen" (V2.1 "Weitere Lesart hinzufügen"). */
  extra?: ReactNode
}) {
  const catalog = useLayers().data
  const parts = useMemo(() => docs.map((doc) => partOf(doc, catalog)), [docs, catalog])
  const { open, dialog } = useOpenInWorkplace()
  const several = docs.length > 1
  const openable = parts.some((p) => p !== null)
  const why = t`Die Referenz lässt sich im Arbeitsplatz nicht darstellen: Ein Layer fehlt dort, oder sie nutzt mehr, als die Bedienelemente zeigen.`
  return (
    <div className="flex flex-col gap-3">
      {docs.map((doc, i) => (
        <Reading
          key={i}
          reading={doc}
          name={several ? readingName(i) : null}
          hits={pending ? null : (hits?.[i] ?? null)}
          pending={pending}
          dataState={dataState}
          part={parts[i] ?? null}
          onRemove={onRemove && (() => onRemove(i))}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {several ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="btn btn-primary" disabled={!openable}>
              <Trans>Im Arbeitsplatz öffnen ▾</Trans>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                className="card z-[1300] min-w-40 bg-neutral-100 py-1 shadow-[var(--shadow-md)]"
              >
                {parts.map((part, i) => (
                  <DropdownMenu.Item
                    key={i}
                    disabled={!part}
                    onSelect={() => part && guard(() => open(part))}
                    className="cursor-pointer px-3 py-1 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-200"
                  >
                    {readingName(i)}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!openable}
            title={openable ? undefined : why}
            onClick={() => {
              const part = parts[0]
              if (part) guard(() => open(part))
            }}
          >
            <Trans>Im Arbeitsplatz öffnen</Trans>
          </button>
        )}
        {extra}
      </div>
      {!openable && <p className="text-muted text-xs">{why}</p>}
      {dialog}
    </div>
  )
}
