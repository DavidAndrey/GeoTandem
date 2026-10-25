// The line of V8.1 from a layer's gaps to a run's result (plan D11, WP94 left
// it to WP93): in the newest complete full run on the same data state (a live
// one as the same account saw it), how the reference column did on the cases
// that use the layer, and whether the profile was another then.
import { plural, t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { api, type DataState, type RunView } from '../../api/client'
import { formatNumber } from '../../i18n/locale'
import { pointName, sumCells } from './runWords'
import { layersOf, notRun, readings } from './words'

/** Runs looked at for one of the account's view; older ones say little about today's profile. */
const LOOK_AT = 10

/** The layers a case asks about: those its readings name. */
const layersOfCase = (c: RunView['cases'][number]['case']) =>
  new Set(readings(c).flatMap((g) => layersOf(g)))

/**
 * "Gemessen: gpt-6-luna P0 hatte auf diesem Layer 142 von 272 Antworten
 * richtig (Lauf #11, 3 Fälle)." and, when the run's profile is not the one
 * shown, "Steckbrief damals #da58, heute anders."
 */
export function measuredText(run: RunView, layer: string, profileHash?: string): string | null {
  const ids = new Set(
    run.cases
      .filter((rc) => !notRun(rc.status) && layersOfCase(rc.case).has(layer))
      .map((rc) => rc.case.id),
  )
  if (ids.size === 0) return null
  const { passed, answers } = sumCells(run.cells, ids, run.reference)
  if (answers === 0) return null
  const point = pointName(run.points[run.reference].label)
  const right = formatNumber(passed)
  const total = formatNumber(answers)
  const id = run.id
  const cases = plural(ids.size, { one: '# Fall', other: '# Fälle' })
  const line = t`Gemessen: ${point} hatte auf diesem Layer ${right} von ${total} Antworten richtig (Lauf #${id}, ${cases}).`
  const then = run.label.profile.profile_hash
  if (!profileHash || then === profileHash) return line
  const short = `#${then.slice(0, 4)}`
  const note = t`Steckbrief damals ${short}, heute anders.`
  return `${line} ${note}`
}

/** The newest done full run on ``dataState``; for live, one that saw ``account``'s view. */
async function lastRun(dataState: DataState, account: string): Promise<RunView | null> {
  const page = await api.evaluation.runs()
  const candidates = page.items
    .filter((r) => r.status === 'done' && r.scope === 'full' && r.data_state === dataState)
    .slice(0, LOOK_AT)
  for (const summary of candidates) {
    const run = await api.evaluation.run(summary.id)
    if (dataState === 'sample' || run.label.account === account) return run
  }
  return null
}

/**
 * ``measuredText`` of that run, once loaded; read once, not polled. ``account``:
 * whose view the summary shows (live), ``profileHash`` the summary's.
 */
export function useMeasured(
  dataState: DataState,
  account: string,
  profileHash: string | undefined,
): ((layer: string) => string | null) | undefined {
  const run = useQuery({
    queryKey: ['eval-runs', 'measured', dataState, account],
    queryFn: () => lastRun(dataState, account),
    enabled: dataState === 'sample' || account !== '',
  }).data
  return run ? (layer: string) => measuredText(run, layer, profileHash) : undefined
}
