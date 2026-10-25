// The evaluation as the fake API answers it (plan E3, WP85): cases from the
// start set the backend ships (schema/eval-cases), runs and figures with the
// numbers of the design's run #13 (design/e3/fixture/bewertung.json, from
// docs/benchmarks.md). Every view here is valid against openapi.json
// (eval-mocks.test.ts).
import tuning from '../../../schema/eval-cases/start-tuning.json'
import confirm from '../../../schema/eval-cases/start-confirm.json'
import type {
  AnswerView,
  CasePage,
  CaseStatus,
  CaseView,
  Cell,
  CostEstimate,
  EvalCase,
  PointComparison,
  PointFigures,
  PointLabel,
  PointView,
  ProfileSummary,
  PromptProfile,
  RunComparison,
  RunCase,
  RunLabel,
  RunPage,
  RunStatus,
  RunView,
  Verdict,
} from '../api/client'

const STARTED = '2026-10-22T15:30:00'
const FINISHED = '2026-10-22T16:18:00'

/**
 * A case as the backend sends it: every field, the defaults filled in and an
 * unset optional field as ``null`` (a view dumps them all).
 */
function full(
  c: Omit<EvalCase, 'schema_version' | 'also' | 'forbid' | 'note' | 'layers'> & Partial<EvalCase>,
): EvalCase {
  return {
    schema_version: '2',
    origin_action: null,
    gold: null,
    gold_any: null,
    require: null,
    expect: null,
    also: [],
    forbid: [],
    other_approach: null,
    note: '',
    layers: [],
    ...c,
  }
}

/** The start set as the backend sends it (defaults filled in, as ``full``). */
export const START_CASES: EvalCase[] = [...tuning.cases, ...confirm.cases].map((c) =>
  full(c as unknown as Parameters<typeof full>[0]),
)

/**
 * Own cases as V1.2 shows them: authored, from the log and stale (its layer
 * Kitas deleted, design fixture), imported and re-imported; ``layers`` are the
 * ones behind the status (``status_layers``).
 */
export const OWN_CASES: { case: EvalCase; status: CaseStatus; layers?: string[] }[] = [
  {
    status: 'ok',
    case: full({
      id: 'e-turnhalle-ostermundigen',
      prompt: 'Schulanlagen mit Turnhalle in Ostermundigen',
      tags: ['attribute', 'in'],
      split: 'confirm',
      data_state: 'live',
      origin: 'authored',
      gold: {
        source: 'schulanlagen',
        where: { op: 'compare', attr: 'turnhalle', cmp: 'eq', value: true },
      },
      layers: [{ name: 'schulanlagen', dataset_version: 'imp-2026-10-20' }],
    }),
  },
  {
    status: 'stale',
    layers: ['kitas'],
    case: full({
      id: 'e-kitas-bahnhof',
      prompt: 'Kitas nahe an Bahnhöfen',
      tags: ['near'],
      split: 'confirm',
      data_state: 'live',
      origin: 'log',
      origin_action: 412,
      gold: {
        source: 'kitas',
        where: {
          op: 'related',
          layer: 'haltestellen',
          predicate: 'dwithin',
          distance_m: 300,
          where: { op: 'compare', attr: 'verkehrsmittel', cmp: 'eq', value: 'bahn' },
        },
      },
      layers: [{ name: 'kitas', dataset_version: 'imp-2026-09-30' }, { name: 'haltestellen' }],
    }),
  },
  {
    status: 'dataset_changed',
    layers: ['schulwege'],
    case: full({
      id: 'e-schulweg-import',
      prompt: 'Schulen mit Schulweg über 2 km',
      tags: ['attribute', 'range'],
      split: 'confirm',
      data_state: 'live',
      origin: 'import',
      gold: {
        source: 'schulwege',
        where: { op: 'compare', attr: 'laenge_km', cmp: 'gt', value: 2 },
      },
      layers: [{ name: 'schulwege', dataset_version: 'imp-2026-10-01' }],
    }),
  },
]

export function caseView(id: string, overrides: Partial<CaseView> = {}): CaseView {
  const start = START_CASES.find((c) => c.id === id)
  const own = OWN_CASES.find((c) => c.case.id === id)
  const found = start ?? own?.case
  if (!found) throw new Error(`no evaluation case '${id}'`)
  return {
    case: found,
    status: own?.status ?? 'ok',
    status_layers: own?.layers ?? [],
    read_only: start !== undefined,
    reference_hits: null,
    created_at: own ? '2026-10-20T09:12:00' : null,
    updated_at: null,
    ...overrides,
  }
}

export function casePage(): CasePage {
  const items = [...START_CASES.map((c) => c.id), ...OWN_CASES.map((c) => c.case.id)].map((id) =>
    caseView(id),
  )
  return { items, total: items.length }
}

// --- measuring points and a run -------------------------------------------------

const P0: PromptProfile = { examples: 'standard', placement: 'P0', output: 'constrained' }

function point(
  name: string,
  model: string,
  host: string,
  profile: Partial<PromptProfile> = {},
): PointLabel {
  return {
    connection_id: { 'gemma4:12b': 1, 'claude-haiku-5-5': 2, 'gpt-6-luna': 3 }[model] ?? 9,
    connection_name: name,
    model,
    host,
    locality: host === 'ollama' ? 'local' : 'external',
    temperature: model === 'claude-haiku-5-5' ? 1 : 0.3,
    reasoning_effort: 'none',
    prompt_profile: { ...P0, ...profile },
    level_id: 2,
    level_name: 'Prüfen',
    system_prompt_hash: '41d941d941d941d941d941d941d941d941d941d941d941d941d941d941d941d9',
    system_prompt: null,
  }
}

/** The four columns of run #13 (V6.2); the reference is Luna with P0. */
export const POINTS: PointLabel[] = [
  point('gemma4:12b', 'gemma4:12b', 'ollama'),
  point('Claude Haiku 5.5', 'claude-haiku-5-5', 'api.anthropic.com', { output: 'text' }),
  point('gpt-6-luna', 'gpt-6-luna', 'api.openai.com'),
  point('gpt-6-luna', 'gpt-6-luna', 'api.openai.com', { placement: 'P9' }),
]
export const REFERENCE = 2

function figures(
  passed: number,
  silently: number,
  unreadable: number,
  behaviour: number,
  median: number,
  p90: number,
  cost: number | null,
): PointFigures {
  const confirm = Math.round(passed * 1.13)
  return {
    passed: passed + confirm,
    answers: 330 + 380,
    by_split: {
      tuning: { passed, answers: 330 },
      confirm: { passed: confirm, answers: 380 },
    },
    by_tag: { spatial: { passed: Math.round(passed / 3), answers: 110 } },
    rate_tuning: Math.round((passed / 330) * 1000) / 10,
    rate_confirm: Math.round((confirm / 380) * 1000) / 10,
    silently_wrong: silently,
    zero_hits: Math.round(silently * 0.6),
    unreadable,
    errors: unreadable ? { model_unreadable: unreadable } : {},
    behaviour_met: behaviour,
    behaviour_answers: 50,
    limited: 0,
    latency_median_ms: median,
    latency_p90_ms: p90,
    prompt_tokens: 1_900_000,
    completion_tokens: 31_000,
    cost: cost === null ? null : { amount: cost, currency: 'USD' },
  }
}

const FIGURES: PointFigures[] = [
  figures(272, 14, 6, 44, 1400, 3100, null),
  figures(318, 2, 0, 49, 3200, 5800, 0.92),
  figures(280, 9, 1, 46, 2000, 3600, 0.57),
  figures(291, 17, 1, 47, 2100, 3900, 0.59),
]

function comparison(mean: number, low: number, high: number): PointComparison {
  return {
    cases: 38,
    better: mean > 0 ? 7 : 3,
    worse: mean > 0 ? 1 : 5,
    same: 30,
    mean,
    low,
    high,
    p_sign: low > 0 || high < 0 ? 0.04 : 0.73,
    word: low > 0 ? 'better' : high < 0 ? 'worse' : 'not_proven',
  }
}

const COMPARISONS: (PointComparison | null)[] = [
  comparison(-3.7, -15.8, 7.6),
  comparison(13.7, 6.1, 21.0),
  null,
  comparison(6.6, 1.3, 13.2),
]

/** Cells of the cases the design shows (V6.2); the rest of the 71 pass alike. */
const CELLS: Record<string, [number, Partial<Record<Verdict, number>>, number][]> = {
  'doc1-primar-koeniz': [
    [9, { wrong: 1 }, 0],
    [10, {}, 0],
    [8, { wrong: 2 }, 0],
    [9, { wrong: 1 }, 0],
  ],
  'n13-bahnhof-bern': [
    [0, { wrong: 10 }, 2],
    [0, { wrong: 9, refused: 1 }, 0],
    [0, { wrong: 10 }, 1],
    [0, { wrong: 10 }, 1],
  ],
  'n03-einwohner-tabelle': [
    [7, { wrong: 3 }, 0],
    [10, {}, 0],
    [9, { wrong: 1 }, 0],
    [4, { wrong: 6 }, 6],
  ],
  'attr-franzoesisch': [
    [10, {}, 0],
    [10, {}, 0],
    [10, {}, 0],
    [10, {}, 0],
  ],
  'n15-je-gemeinde': [
    [8, { kind: 2 }, 0],
    [10, {}, 0],
    [6, { kind: 4 }, 0],
    [8, { kind: 2 }, 0],
  ],
}

function cells(answers: number): Cell[] {
  return Object.entries(CELLS).flatMap(([caseId, row]) =>
    row.map(([passed, rest, silently], index) => {
      const scale = answers / 10
      const verdicts: Partial<Record<Verdict, number>> = { pass: Math.round(passed * scale) }
      for (const [verdict, n] of Object.entries(rest))
        verdicts[verdict as Verdict] = Math.round(n * scale)
      return {
        case_id: caseId,
        point: index,
        passed: Math.round(passed * scale),
        answers,
        verdicts: verdicts as Cell['verdicts'],
        silently_wrong: Math.round(silently * scale),
      }
    }),
  )
}

export const PROFILE_COMPLETE: ProfileSummary = {
  profile_hash: 'b20ab20ab20ab20ab20ab20ab20ab20ab20ab20ab20ab20ab20ab20ab20ab20a',
  layers: 6,
  attributes: 27,
  labelled: 27,
  text_attributes: 9,
  text_with_codes: 6,
  described: 33,
  gaps: [],
}

/** A customer layer after a plain import (Phase 4, mode ``raw``): what V8.1 lists. */
export const PROFILE_RAW: ProfileSummary = {
  profile_hash: 'da58da58da58da58da58da58da58da58da58da58da58da58da58da58da58da58',
  layers: 7,
  attributes: 31,
  labelled: 27,
  text_attributes: 11,
  text_with_codes: 6,
  described: 33,
  gaps: [
    {
      layer: 'schulanlagen',
      title: 'schulanlagen',
      attributes: 4,
      text_attributes: 2,
      unconfirmed_codes: ['art', 'traeger'],
      unlabelled: ['art', 'traeger', 'turnhalle', 'baujahr'],
      undescribed: ['', 'art', 'traeger', 'turnhalle', 'baujahr'],
    },
  ],
}

/** The cases of a run as it asked them (H7): the whole start case at run time. */
const RUN_CASES: RunCase[] = START_CASES.map((c) => ({ case: c, status: 'ok' }))

function label(scope: RunView['label']['scope'] = 'full'): RunLabel {
  return {
    query_schema: '2',
    grading_version: 1,
    data_state: 'sample',
    sample_version: 'bern-mittelland-2026-10-03',
    dataset_versions: {},
    profile: PROFILE_COMPLETE,
    account: 'admin',
    scope,
    seeds: scope === 'full' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 2, 3, 4, 5],
    cases: 71,
    case_set_hash: 'c71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71a',
    started_at: STARTED,
    started_by: 'admin',
  }
}

/** Run #13 done (V6.2), #14 running (V6.1, no figures yet: design review 5), #12 a quick test (V6.5). */
export function runView(status: RunStatus = 'done', scope: 'full' | 'quick' = 'full'): RunView {
  const done = status === 'done'
  const points: PointView[] = POINTS.map((p, index) => ({
    label: p,
    figures: done ? FIGURES[index] : null,
    comparison: done && scope === 'full' ? COMPARISONS[index] : null,
  }))
  const total = 71 * POINTS.length * (scope === 'full' ? 10 : 5)
  return {
    id: status === 'running' ? 14 : scope === 'quick' ? 12 : 13,
    status,
    request: {
      points: POINTS.map((p) => ({
        connection_id: p.connection_id,
        prompt_profile: p.prompt_profile,
        level_id: p.level_id,
        system_prompt: null,
      })),
      reference: REFERENCE,
      cases: { origins: ['start'], split: null, tags: [] },
      data_state: 'sample',
      scope,
      confirm_external: [2, 3],
    },
    label: label(scope),
    cases: RUN_CASES,
    points,
    reference: REFERENCE,
    progress: { done: status === 'running' ? 1164 : total, total },
    cost_so_far: [{ amount: status === 'running' ? 0.84 : 2.08, currency: 'USD' }],
    cells: status === 'running' ? cells(10).slice(0, 6) : cells(scope === 'full' ? 10 : 5),
    error: null,
    finished_at: done ? FINISHED : null,
  }
}

export function runPage(): RunPage {
  const summary = (
    id: number,
    status: RunStatus,
    scope: 'full' | 'quick',
    rate: number | null,
    cost: number,
  ) => ({
    id,
    status,
    scope,
    data_state: 'sample' as const,
    started_at: STARTED,
    started_by: 'admin',
    points: 4,
    connection_ids: [1, 2, 3],
    cases: 71,
    case_set_hash: 'c71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71ac71a',
    reference_rate: rate,
    cost: [{ amount: cost, currency: 'USD' }],
  })
  const items = [
    summary(14, 'running', 'full', null, 0.84),
    summary(13, 'done', 'full', 84.8, 2.08),
    summary(12, 'done', 'quick', 85.1, 0.51),
    summary(10, 'interrupted', 'full', null, 0.77),
    summary(9, 'aborted', 'full', null, 0.12),
  ]
  return { items, total: items.length }
}

/** V4.1: the estimate of run #13 before its start. */
export const COST_ESTIMATE: CostEstimate = {
  cases: 71,
  connections: [
    {
      connection_id: 1,
      name: 'gemma4:12b',
      host: 'ollama',
      locality: 'local',
      points: 1,
      requests: 710,
      tokens: 1_900_000,
      cost: null,
      duration_s: 17 * 60,
    },
    {
      connection_id: 2,
      name: 'Claude Haiku 5.5',
      host: 'api.anthropic.com',
      locality: 'external',
      points: 1,
      requests: 710,
      tokens: 2_300_000,
      cost: { amount: 0.92, currency: 'USD' },
      duration_s: 38 * 60,
    },
    {
      connection_id: 3,
      name: 'gpt-6-luna',
      host: 'api.openai.com',
      locality: 'external',
      points: 2,
      requests: 1420,
      tokens: 4_300_000,
      cost: { amount: 1.16, currency: 'USD' },
      duration_s: 48 * 60,
    },
  ],
  requests: 2840,
  tokens: 8_500_000,
  cost: [{ amount: 2.08, currency: 'USD' }],
  duration_s: 48 * 60,
  external_hosts: ['api.anthropic.com', 'api.openai.com'],
}

/** V7.2: Luna with P9 on ``n03``, silently wrong: no filter, the explanation claims one. */
export function answerViews(): AnswerView[] {
  const wrong = (block: number, seed: number): AnswerView => ({
    case_id: 'n03-einwohner-tabelle',
    point: 3,
    block,
    seed,
    verdict: 'wrong',
    code: null,
    flags: ['no_assumption'],
    latency_ms: 2100,
    prompt_tokens: 7162,
    completion_tokens: 94,
    answer: {
      kind: 'query',
      explanation: 'Ich habe Gemeinden mit mehr als 10 000 Einwohnern gewählt.',
      assumptions: [],
      query: { source: 'gemeinden', output: 'map' },
    },
    refusal: null,
    raw: null,
    reading: 0,
    diff: [
      {
        kind: 'missing',
        path: 'where',
        reference: { op: 'compare', attr: 'einwohner', cmp: 'gt', value: 10000 },
        answer: null,
      },
    ],
    hits: 102,
    reference_hits: 13,
    only_answer: Array.from({ length: 89 }, (_, i) => i + 14),
    only_answer_count: 89,
    only_reference: [],
    only_reference_count: 0,
  })
  const right = (block: number, seed: number): AnswerView => ({
    ...wrong(block, seed),
    verdict: 'pass',
    flags: [],
    diff: [],
    hits: 13,
    only_answer: [],
    only_answer_count: 0,
  })
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) =>
    [2, 3, 5, 7, 8, 10].includes(seed)
      ? wrong(seed > 5 ? 2 : 1, seed)
      : right(seed > 5 ? 2 : 1, seed),
  )
}

/** V6.6: run #13 against #8. */
export const RUN_COMPARISON: RunComparison = {
  run: 13,
  against: 8,
  points: POINTS.map((p, index) => ({
    label: p,
    rate: FIGURES[index].rate_tuning,
    rate_against: [81.8, 96.1, 78.2, 87.9][index],
    comparison: comparison(
      ...([
        [0.6, -5.9, 7.2],
        [0.3, -2.4, 3.0],
        [6.6, 0.9, 12.4],
        [0.3, -4.8, 5.4],
      ][index] as [number, number, number]),
    ),
  })),
}
