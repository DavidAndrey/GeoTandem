// Which cases a run takes (design V4 step 2), shared by the new run and the case
// list: the list hands its filter over as a run's choice when the two describe
// the same cases. Pure, so it is unit-tested.
import type { CaseView, DataState, Split } from '../../api/client'
import { notRun } from './words'

/** A run's cases: start set and/or own cases, one data state, a split, a tag. */
export interface CaseChoice {
  start: boolean
  own: boolean
  /** Only when own cases run alone: the data state they run on. */
  ownState: DataState
  split: Split | null
  tag: string | null
}

/** One data state per run (D1): the start set runs on sample data. */
export const choiceState = (c: CaseChoice): DataState => (c.start ? 'sample' : c.ownState)

/** The cases a run with this choice takes; stale and invalid cases never run. */
export function chosenCases(cases: CaseView[], c: CaseChoice): CaseView[] {
  const state = choiceState(c)
  return cases.filter((v) => {
    if (notRun(v.status)) return false
    if (v.read_only ? !c.start : !c.own) return false
    if ((v.case.data_state ?? 'sample') !== state) return false
    if (c.split && v.case.split !== c.split) return false
    if (c.tag && !v.case.tags.includes(c.tag)) return false
    return true
  })
}

// --- the handover in the address -----------------------------------------------------

const CASES = { start: 'start', own: 'eigene', both: 'alle' } as const

/** The choice as the new run's address parameters: ``?faelle=eigene&datenstand=live&teil=…``. */
export function choiceParams(c: CaseChoice): URLSearchParams {
  const p = new URLSearchParams()
  p.set('faelle', c.start && c.own ? CASES.both : c.start ? CASES.start : CASES.own)
  if (!c.start) p.set('datenstand', c.ownState)
  if (c.split) p.set('teil', c.split)
  if (c.tag) p.set('stichwort', c.tag)
  return p
}

/** The choice an address names, or ``null`` when it names none (``faelle`` missing). */
export function choiceFromParams(p: URLSearchParams): CaseChoice | null {
  const cases = p.get('faelle')
  if (cases !== CASES.start && cases !== CASES.own && cases !== CASES.both) return null
  const split = p.get('teil')
  const state = p.get('datenstand')
  return {
    start: cases !== CASES.own,
    own: cases !== CASES.start,
    ownState: state === 'sample' ? 'sample' : 'live',
    split: split === 'tuning' || split === 'confirm' ? split : null,
    tag: p.get('stichwort') || null,
  }
}

/**
 * The case list's filter as a run's choice: origin, data state, split and tag
 * carry over; the search and the kind do not. ``null`` when there is nothing
 * to run or the run would not take exactly the listed cases (those that run).
 */
export function choiceForList(
  all: CaseView[],
  listed: CaseView[],
  filter: { origin?: string; dataState?: DataState; split?: Split; tag?: string },
): CaseChoice | null {
  const start = filter.origin === undefined || filter.origin === 'start'
  const choice: CaseChoice = {
    // The start set runs on sample data only; "live" leaves it out.
    start: start && filter.dataState !== 'live',
    own: filter.origin !== 'start',
    ownState: filter.dataState ?? 'live',
    split: filter.split ?? null,
    tag: filter.tag ?? null,
  }
  const wanted = listed.filter((v) => !notRun(v.status))
  const taken = chosenCases(all, choice)
  if (!taken.length || taken.length !== wanted.length) return null
  const keys = new Set(wanted.map((v) => `${v.case.origin}|${v.case.id}`))
  return taken.every((v) => keys.has(`${v.case.origin}|${v.case.id}`)) ? choice : null
}
