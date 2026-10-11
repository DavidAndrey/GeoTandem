// A tool chain's record read for the panel (design M8, M9; plan P4, D9): which
// phase it is in, its steps counted, what the model saw of each, and the last
// complete result. Pure: the server decides every transition, the panel only
// reads the record. The tool names are the server's (WP74 pins them), so
// nothing here keys on one; a step shows its ``text`` and its ``tool`` as given.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type {
  ModelActionView,
  ModelAnswer,
  ModelView,
  StepStatus,
  StepView,
  StopReason,
} from '../../api/client'

export type PlanAnswer = Extract<ModelAnswer, { kind: 'plan' }>

/**
 * Steps of one chain, re-planned steps included (plan section 1, F-3.9):
 * ``MAX_STEPS`` of the backend's ``model/schemas.py``, held to the contract
 * fixture (``limits.steps``) by a test.
 */
export const MAX_STEPS = 8

/** Re-plans of one chain (P4): ``MAX_REPLANS`` of the backend, held to the fixture (``limits.replans``). */
export const MAX_REPLANS = 2

/**
 * Seconds of one tool-chain request (plan P4): ``CHAIN_TIME_LIMIT_S`` of the
 * backend, held to the fixture (``limits.chain_s``). The run's timer counts up
 * to it (M9.1).
 */
export const CHAIN_S = 300

/** Objects of one result (F-9.6), as the limit message of M9.5 names it (``limits.max_features``). */
export const MAX_FEATURES = 10_000

/** A record of the tool chain: its answer is a plan (P4). */
export const isChain = (view: ModelActionView): boolean => view.answer?.kind === 'plan'

/** Steps that ran, with or without a result. */
const FINISHED: readonly StepStatus[] = ['ok', 'empty', 'error']

/** The plan's steps, those removed by hand (M8.3) left out. */
export const planned = (view: ModelActionView): StepView[] =>
  view.steps.filter((s) => s.status !== 'removed')

/** Whether any step has run or runs: the plan has started. */
export const started = (view: ModelActionView): boolean =>
  view.steps.some((s) => s.status !== 'planned' && s.status !== 'removed')

export const finished = (step: StepView) => FINISHED.includes(step.status)

/**
 * What *Ergebnis übernehmen* / *Zwischenstand übernehmen* takes (M9.3–M9.5):
 * the server's choice once the run ended, never the client's. The record's
 * ``query`` is the last complete step that is no buffer and within the
 * result-size limit (WP75 ``last_complete``); ``null``: nothing to adopt.
 */
export const adoptable = (view: ModelActionView): boolean => view.query != null

/** The hits of the result to adopt: the record's stamp (``null`` when unstamped, e.g. interrupted). */
export const adoptedHits = (view: ModelActionView): number | null => view.stamp?.count ?? null

/** The step running, waiting for approval, or next to run; ``null`` once none is left. */
export const current = (view: ModelActionView): StepView | null =>
  view.steps.find((s) => s.status === 'running' || s.status === 'waiting') ??
  view.steps.find((s) => s.status === 'planned') ??
  null

/** "Schritt n von m": the place of ``step`` among the plan's steps (1-based). */
export const placeOf = (view: ModelActionView, step: StepView): number =>
  planned(view).indexOf(step) + 1

/** Milliseconds the steps that ran took (M9.3 "5 Schritte · 3,6 s"). */
export const ranMs = (view: ModelActionView): number =>
  view.steps.reduce((sum, s) => sum + (finished(s) ? (s.duration_ms ?? 0) : 0), 0)

/**
 * One approval for the whole chain (*Prüfen*), the server's rule (WP75,
 * ``one_approval``, store.py ``approve``): no step of the plan as it stands
 * (every step not removed, those that ran and a re-plan's included) is
 * ``auto``. Otherwise (*Teilautonom*) an approval clears the next step only
 * and the run halts before every further ``approve`` step. Never keyed on a
 * level's name.
 */
export const oneApproval = (view: ModelActionView): boolean =>
  !planned(view).some((s) => s.cell === 'auto')

/**
 * The steps the run will halt before (M8.2: "die Kette hält vor Schritt 2"),
 * as places: with one approval none; otherwise every ``approve`` step ahead
 * but the next one, which the approval at hand clears.
 */
export function halts(view: ModelActionView): number[] {
  if (oneApproval(view)) return []
  const steps = planned(view)
  const next = steps.findIndex((s) => s.status === 'planned' || s.status === 'waiting')
  return steps
    .map((s, i) =>
      i > next && next >= 0 && s.cell === 'approve' && s.status === 'planned' ? i + 1 : 0,
    )
    .filter((n) => n > 0)
}

export type Phase =
  /** M8: proposed, not started; or approved and about to start. */
  | 'plan'
  /** M9.2: proposed again before a step that needs approval, or after a re-plan (P4). */
  | 'halt'
  /** M9.1. */
  | 'running'
  /** M9.3. */
  | 'done'
  /** M9.4, M9.5: ``limited``. */
  | 'stopped'
  /** Adopted, rejected, superseded, undone, failed: the record's end. */
  | 'closed'

export function phaseOf(view: ModelActionView): Phase {
  switch (view.status) {
    case 'proposed':
      return started(view) ? 'halt' : 'plan'
    case 'approved':
      // Approved and not yet running: the run request is on its way (``useChainRunner``).
      return started(view) ? 'running' : 'plan'
    case 'running':
      return 'running'
    case 'done':
      return 'done'
    case 'limited':
      return 'stopped'
    default:
      return 'closed'
  }
}

/** Stopped by the user (M9.4), not by a limit, a re-plan or a restart (M9.5). */
export const aborted = (reason: StopReason | null | undefined) => reason === 'aborted'

const SEES: Record<'ok' | 'error' | 'empty' | 'notEmpty', MessageDescriptor> = {
  ok: msg({ message: 'ok', context: 'model sees' }),
  error: msg({ message: 'Fehler', context: 'model sees' }),
  empty: msg({ message: 'leer', context: 'model sees' }),
  notEmpty: msg({ message: 'nicht leer', context: 'model sees' }),
}

/**
 * What the model saw of a step (D9, design M9.1 "Modell sieht: …"): ok or the
 * error with its code and the name it is about, empty or not, the count. Codes
 * and names stay as they are (technical, in monospace); never a value.
 */
export function modelSees(view: ModelView): string {
  const say = (key: keyof typeof SEES) => i18n._(SEES[key])
  const parts = [say(view.outcome)]
  if (view.code) parts.push(view.code)
  if (view.part) parts.push(view.part)
  if (view.empty === true) parts.push(say('empty'))
  if (view.empty === false) parts.push(say('notEmpty'))
  if (view.count !== null && view.count !== undefined) parts.push(String(view.count))
  return parts.join(' · ')
}

// --- Plan editing (M8.3): values only, never a new step -------------------------

/**
 * The keys of a query object's conditions that hold a value the user may
 * change (schema v2: ``compare.value``, ``in.values``, ``between.min``/``max``,
 * ``text_match.text``, a relation's or buffer's ``distance_m``). Names of
 * layers, attributes, operators and the references between steps are no
 * values: changing them is a new question, asked by prompt (design 17).
 */
const VALUE_KEYS = ['value', 'values', 'min', 'max', 'text', 'distance_m']

export type Path = (string | number)[]
export type Scalar = string | number | boolean

export interface ValueField {
  path: Path
  /** The key that holds it: what the field is called. */
  key: string
  value: Scalar
}

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** The values of a step's arguments the plan editor offers (M8.3), in document order. */
export function valueFields(args: unknown, path: Path = [], key = ''): ValueField[] {
  if (Array.isArray(args))
    return args.flatMap((item, i) =>
      key === 'values' && isScalar(item)
        ? [{ path: [...path, i], key, value: item }]
        : valueFields(item, [...path, i], key),
    )
  if (typeof args !== 'object' || args === null) return []
  return Object.entries(args).flatMap(([k, v]) =>
    VALUE_KEYS.includes(k) && isScalar(v)
      ? [{ path: [...path, k], key: k, value: v }]
      : valueFields(v, [...path, k], k),
  )
}

/** ``args`` with the value at ``path`` replaced; nothing else changes. */
export function withValue(args: unknown, path: Path, value: Scalar): unknown {
  const [head, ...rest] = path
  if (head === undefined) return value
  if (Array.isArray(args))
    return args.map((item, i) => (i === head ? withValue(item, rest, value) : item))
  if (typeof args !== 'object' || args === null) return args
  const json = args as Record<string, unknown>
  return { ...json, [head]: withValue(json[head], rest, value) }
}
