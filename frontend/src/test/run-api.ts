// The fake backend of the run pages (plan E3, WP93): the design's runs #12-#14,
// the connections and levels they measured, the start set and its layers.
import { attribute, layer, signedIn } from './fixtures'
import { CONNECTIONS, COST_ESTIMATE, LEVELS, casePage, runPage, runView } from './eval-mocks'
import { fakeApi } from './render'

export const LAYERS = [
  layer({
    name: 'schulen',
    title: 'Schulen',
    geometry_type: 'Point',
    attributes: [
      attribute({ name: 'typ', data_type: 'text', label: 'Schulstufe' }),
      attribute({ name: 'name', data_type: 'text', label: 'Name' }),
    ],
  }),
  layer({
    name: 'haltestellen',
    title: 'Haltestellen',
    geometry_type: 'Point',
    attributes: [attribute({ name: 'name', data_type: 'text', label: 'Name' })],
  }),
  layer({
    name: 'gemeinden',
    title: 'Gemeinden',
    geometry_type: 'Polygon',
    attributes: [attribute({ name: 'name', data_type: 'text', label: 'Name' })],
  }),
]

export const RUNS_URL = '/api/admin/evaluation/runs'

export function runBackend(patch: Record<string, unknown> = {}) {
  return fakeApi({
    ...signedIn(),
    'GET /api/layers': LAYERS,
    'GET /api/admin/llm/connections': CONNECTIONS,
    'GET /api/admin/levels': LEVELS,
    'GET /api/admin/evaluation/cases': casePage(),
    [`GET ${RUNS_URL}`]: runPage(),
    [`GET ${RUNS_URL}/14`]: runView('running'),
    [`GET ${RUNS_URL}/13`]: runView('done'),
    [`GET ${RUNS_URL}/12`]: runView('done', 'quick'),
    [`POST ${RUNS_URL}/estimate`]: COST_ESTIMATE,
    'POST /api/query/count': { counts: [0] },
    ...patch,
  })
}

/** A refusal as the server sends it. */
export const refused = (status: number, code: string, details: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code, message: code, details }), { status })
