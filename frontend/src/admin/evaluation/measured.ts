// The line of V8.1 from a layer's gaps to a run's result (plan D11, WP94 left
// it to WP93): in the newest complete run on the same data state, how the
// reference column did on the cases that use the layer.
import { plural, t } from '@lingui/core/macro'
import type { DataState, RunView } from '../../api/client'
import { formatNumber } from '../../i18n/locale'
import { useRun, useRuns } from './runs'
import { notRun, readings } from './words'
import { layersOf } from './words'
import { pointName, sumCells } from './runWords'

/** The layers a case asks about: those its readings name. */
const layersOfCase = (c: RunView['cases'][number]['case']) =>
  new Set(readings(c).flatMap((g) => layersOf(g)))

/** "Gemessen: gpt-6-luna P0 hatte auf diesem Layer 142 von 272 Antworten richtig (Lauf #11, 3 Fälle)." */
export function measuredText(run: RunView, layer: string): string | null {
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
  return t`Gemessen: ${point} hatte auf diesem Layer ${right} von ${total} Antworten richtig (Lauf #${id}, ${cases}).`
}

/** ``measuredText`` of the newest complete run on ``dataState``, once loaded. */
export function useMeasured(dataState: DataState): ((layer: string) => string | null) | undefined {
  const runs = useRuns().data?.items ?? []
  const last = runs.find((r) => r.status === 'done' && r.data_state === dataState)
  const run = useRun(last?.id ?? 0, last !== undefined).data
  return run ? (layer: string) => measuredText(run, layer) : undefined
}
