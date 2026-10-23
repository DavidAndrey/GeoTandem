// The comparison dialog (design M10.2, M10.3; plan WP76, WP78): the same
// question, both ways side by side: how each came about (the direct query as
// its readable tree, the chain as its steps), the step count, the time and the
// hits, then the difference the server computed from feature ids: equal, or
// "2 nur links, 1 nur rechts" with the names and, where the two queries show
// it, the reason in the interface's words. *Diese übernehmen* on either side
// is that record's own approval (flow.ts ``take``). A modal dialog: the focus
// stays inside until it closes (design "Barrierefreiheit"), Esc closes it,
// the focus starts on × so that no key takes a side by accident.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DisplayLayer } from '../../analysis/model'
import {
  api,
  ApiRequestError,
  type Comparison,
  type ModelActionView,
  type StepView,
} from '../../api/client'
import { useLayers } from '../../api/queries'
import { ErrorNotice, Loading } from '../../components/ui'
import { labelsFor } from '../../editor/fields'
import { formatNumber } from '../../i18n/locale'
import { hitsOf } from '../../i18n/phrases'
import { useApproval } from '../approval/flow'
import { conditionCount } from '../approval/governance'
import { StepSummary } from '../chain/StepSummary'
import { isChain, planned, ranCount, ranMs, stepCount } from '../chain/steps'
import { approachText } from '../log/words'
import { seconds } from '../panel/time'
import { compactQuery, readQuery, type ReadNode } from '../readable'
import { StatusLabel } from '../status'
import { statusKey } from '../statusKey'
import { useModel } from '../store'
import { QueryTree } from '../tree'
import {
  closeComparison,
  compareErrorText,
  focusComparison,
  take,
  takeRefusal,
  useComparison,
} from './flow'
import { differenceTitle, featureNames, reasonLines, type Sides, type Words } from './words'

/**
 * The open comparison's two records, the record compared left (as the server
 * names them). The repeat is the dialogue's; the record compared is asked for
 * when it left the dialogue ("Verlauf leeren" while its repeat ran).
 */
function usePair(shown: number | null) {
  const { left, right } = useModel(
    useShallow((s) => {
      const right = shown !== null ? s.views[shown] : undefined
      const left = right?.compare_of != null ? s.views[right.compare_of] : undefined
      return { left, right }
    }),
  )
  const missing = right?.compare_of != null && left === undefined ? right.compare_of : null
  const fetched = useQuery({
    queryKey: ['model-action', missing],
    queryFn: () => api.model.action(missing ?? 0),
    enabled: missing !== null,
    retry: false,
  })
  return { left: left ?? (missing !== null ? fetched.data : undefined), right, fetched }
}

export function CompareDialog() {
  const shown = useComparison((s) => s.shown)
  const { left, right, fetched } = usePair(shown)
  const close = useRef<HTMLButtonElement>(null)
  const open = shown !== null && right !== undefined
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && closeComparison()}>
      <Dialog.Portal>
        <Dialog.Overlay className="bg-ink/30 fixed inset-0 z-[1200]" />
        <Dialog.Content
          className="card fixed top-[6%] left-1/2 z-[1200] flex max-h-[88vh] w-[54rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-3 overflow-auto p-5 shadow-[var(--shadow-md)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            close.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            // Where it was opened from may be gone (an auto-opened dialog, a
            // card that became an earlier answer): the repeat's card.
            event.preventDefault()
            focusComparison(useComparison.getState().last)
          }}
        >
          <div className="flex items-start gap-2">
            <Dialog.Title className="flex-1 text-xl">
              <Trans>Vergleich · gleiche Frage, zwei Arbeitsweisen</Trans>
            </Dialog.Title>
            <Dialog.Close
              ref={close}
              className="btn border-transparent px-1"
              aria-label={t`Vergleich schliessen`}
            >
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          {open && (
            <>
              <Dialog.Description className="text-muted text-sm">{right.prompt}</Dialog.Description>
              {left ? (
                <Body left={left} right={right} />
              ) : fetched.error ? (
                <ErrorNotice error={fetched.error} />
              ) : (
                <Loading />
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const catalogLayer = (layer: string): DisplayLayer => ({
  id: layer,
  source: { kind: 'catalog', layer },
  visible: true,
  opacity: 1,
  symbology: null,
})

/** The layer whose objects a query finds: an aggregate's area layer, else the source (``result_layer``). */
function resultLayerOf(query: unknown): string | null {
  const compact = compactQuery(query) as
    { source?: unknown; aggregate?: { by_layer?: unknown } } | null | undefined
  const layer = compact?.aggregate?.by_layer ?? compact?.source
  return typeof layer === 'string' ? layer : null
}

function Body({ left, right }: { left: ModelActionView; right: ModelActionView }) {
  const catalog = useLayers().data
  // Asked each time the dialog opens: the sides may have changed meanwhile.
  const comparison = useQuery({
    queryKey: ['model-comparison', right.id],
    queryFn: () => api.model.comparison(right.id),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  const layer = resultLayerOf(left.query)
  const { labels, filterLabels } = labelsFor(layer ? catalogLayer(layer) : undefined, catalog)
  const sides: Sides = { left: approachText(left.approach), right: approachText(right.approach) }
  const data = comparison.data
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Side view={left} hits={data?.left.count ?? null} />
        <Side view={right} hits={data?.right.count ?? null} />
      </div>
      {comparison.isPending && <Loading />}
      {comparison.error && <ComparisonError error={comparison.error} />}
      {data && <Difference comparison={data} words={{ labels, filterLabels }} sides={sides} />}
      <p className="text-muted text-xs">
        <Trans>
          „Diese übernehmen“ ersetzt die aktuelle Analyse und gilt als Freigabe der gewählten
          Fassung. Die andere Seite bleibt, wie sie ist.
        </Trans>
      </p>
    </>
  )
}

/** "läuft noch" is a state, not a failure: announced politely; anything else as an alert. */
function ComparisonError({ error }: { error: unknown }) {
  const waiting = error instanceof ApiRequestError && error.body?.code === 'not_approved'
  return (
    <p role={waiting ? 'status' : 'alert'} className={waiting ? 'text-sm' : 'text-danger text-sm'}>
      {compareErrorText(error)}
    </p>
  )
}

/** The conditions a hit meets, leaves only. */
const leaves = (nodes: readonly ReadNode[]): number =>
  nodes.reduce((n, node) => n + (node.kind === 'group' ? leaves(node.children) : 1), 0)

/** One way: its derivation, step count, time and hits, and *Diese übernehmen*. */
function Side({ view, hits }: { view: ModelActionView; hits: number | null }) {
  const catalog = useLayers().data
  const chain = isChain(view)
  const steps = chain ? planned(view) : []
  const layer = resultLayerOf(view.query)
  const total = catalog?.find((l) => l.name === layer)?.feature_count
  const heading = `compare-side-${view.id}`
  // The steps that ran (M9.3, M10), never one planned or skipped.
  const ran = chain ? ranCount(view) : 1
  const count = chain ? stepCount(ran) : conditionCount(leaves(readQuery(view.query).tree.children))
  const derivation = chain ? t`${count}, Ergebnis als eine Abfrage` : t`eine Abfrage, ${count}`
  const plan = seconds(view.latency_ms)
  const run = seconds(ranMs(view), 1)
  const took = chain ? (run && plan ? t`${run} + ${plan} Planung` : run) : plan
  return (
    <section aria-labelledby={heading} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={heading} className="text-lg">
          {approachText(view.approach)}
        </h3>
        <span className="ml-auto">
          <StatusLabel status={statusKey(view)} />
        </span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
        <dt className="label-caps">
          <Trans>Herleitung</Trans>
        </dt>
        <dd>{derivation}</dd>
        <dt className="label-caps">
          <Trans>Schritte</Trans>
        </dt>
        <dd className="tabular-nums">{formatNumber(ran)}</dd>
        <dt className="label-caps">
          <Trans>Dauer</Trans>
        </dt>
        <dd className="tabular-nums">{took ?? '–'}</dd>
        <dt className="label-caps">
          <Trans>Ergebnis</Trans>
        </dt>
        <dd className="font-semibold tabular-nums">
          {hits === null ? '…' : total != null ? hitsOf(hits, total) : formatNumber(hits)}
        </dd>
      </dl>
      {chain ? <ChainSteps view={view} steps={steps} /> : <QueryTree query={view.query} />}
      <Take view={view} />
    </section>
  )
}

/** The chain's derivation: its steps with their summaries and hits; its query on request. */
function ChainSteps({ view, steps }: { view: ModelActionView; steps: StepView[] }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      <ol className="flex flex-col gap-1 text-sm" aria-label={t`Schritte`}>
        {steps.map((step, i) => {
          const n = formatNumber(i + 1)
          return (
            <li key={step.position} className="border-divider rounded border p-1.5">
              <p className="flex gap-2">
                <span className="text-muted tabular-nums">{`${n}.`}</span>
                <span className="min-w-0 flex-1">{step.text}</span>
                {step.hits != null && (
                  <span className="tabular-nums" aria-label={t`Treffer`}>
                    {formatNumber(step.hits)}
                  </span>
                )}
              </p>
              {step.query && <StepSummary query={step.query} />}
            </li>
          )
        })}
      </ol>
      <button
        type="button"
        className="btn self-start"
        aria-expanded={shown}
        disabled={!view.query}
        onClick={() => setShown(!shown)}
      >
        <Trans>Als Abfrage ansehen</Trans>
      </button>
      {shown && view.query && <QueryTree query={view.query} />}
    </div>
  )
}

/**
 * *Diese übernehmen*: the record's own approval and run (``take``); closes the
 * dialog once the analysis is that side's. Disabled where its governance or
 * state does not allow it, with the reason; a refusal stays here, in words.
 */
function Take({ view }: { view: ModelActionView }) {
  const busy = useApproval((s) => s.busy !== null)
  const mine = useApproval((s) => s.busy?.action === view.id)
  const failure = useApproval((s) => (s.failure?.action === view.id ? s.failure.error : null))
  const inDialogue = useModel((s) => s.dialogue.includes(view.id))
  // ``takeRefusal`` reads the layer list from the cache: this renders again when it arrives.
  useLayers()
  const refusal = takeRefusal(view, inDialogue)
  const hint = `take-refusal-${view.id}`
  const name = approachText(view.approach)
  return (
    <div className="mt-auto flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || refusal !== null}
          aria-label={t`Diese übernehmen: ${name}`}
          aria-describedby={refusal ? hint : undefined}
          onClick={() => {
            void take(view).then((taken) => taken && closeComparison())
          }}
        >
          <Trans>Diese übernehmen</Trans>
        </button>
        {mine && (
          <span role="status" className="text-muted text-xs">
            <Trans>Wird übernommen …</Trans>
          </span>
        )}
      </p>
      {refusal && (
        <p id={hint} className="text-muted text-xs">
          {refusal}
        </p>
      )}
      {failure !== null && (
        <div className="text-sm">
          <ErrorNotice error={failure} />
          <p>
            <Trans>Ihr Stand ist unverändert.</Trans>
          </p>
        </div>
      )}
    </div>
  )
}

/** M10.2 equal hits, M10.3 the difference by name and, where the queries show it, why. */
function Difference({
  comparison,
  words,
  sides,
}: {
  comparison: Comparison
  words: Words
  sides: Sides
}) {
  const { only_left: onlyLeft, only_right: onlyRight } = comparison
  const leftHits = formatNumber(comparison.left.count)
  const rightHits = formatNumber(comparison.right.count)
  const { left: leftName, right: rightName } = sides
  if (onlyLeft.length === 0 && onlyRight.length === 0)
    return (
      <section aria-label={t`Unterschied`} className="border-ink rounded border p-2 text-sm">
        <p>
          <span className="font-semibold">
            <Trans>Treffermengen gleich</Trans>
          </span>{' '}
          <span className="text-muted">{t`${leftHits} = ${rightHits}, dieselben Objekte`}</span>
        </p>
      </section>
    )
  const reasons = reasonLines(comparison.reason, words, sides)
  const leftNames = featureNames(onlyLeft)
  const rightNames = featureNames(onlyRight)
  return (
    <section
      aria-label={t`Unterschied`}
      className="border-ink flex flex-col gap-1 rounded border p-2 text-sm"
    >
      <p className="font-semibold">{differenceTitle(onlyLeft.length, onlyRight.length)}</p>
      {onlyLeft.length > 0 && <p>{t`Nur ${leftName}: ${leftNames}`}</p>}
      {onlyRight.length > 0 && <p>{t`Nur ${rightName}: ${rightNames}`}</p>}
      {reasons.length > 0 && (
        <div className="text-muted">
          <p>
            <Trans>Grund, aus den beiden Abfragen gelesen:</Trans>
          </p>
          <ul className="list-disc pl-5">
            {reasons.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
