// Screenshots of the examples in docs/filters.md, chapter 2, as the query editor
// shows them. Run by scripts/doc-screenshots.sh against a fresh instance:
//   node screenshots/filter-examples.mjs <baseURL> <outDir>
// Each example is saved as a session with the editor's own state, opened, and
// photographed with the editor open. The hit count shown must match the
// "**N von M**" of the document, or the run fails.
import { chromium, request } from '@playwright/test'
import { readFileSync } from 'node:fs'

const [baseURL, outDir] = process.argv.slice(2)
if (!baseURL || !outDir) throw new Error('usage: filter-examples.mjs <baseURL> <outDir>')

const DOC = new URL('../../docs/filters.md', import.meta.url)
const ADMIN = { username: 'admin', password: 'doku-admin-passwort' }
const REGION = [7.11, 46.7, 7.71, 47.12]

// --- the examples as the editor holds them (frontend/src/analysis/model.ts) ---------------

let counter = 0
const id = (prefix) => `${prefix}${++counter}`

const catalog = (layer) => ({
  id: id('l'),
  source: { kind: 'catalog', layer },
  visible: true,
  opacity: 1,
  symbology: null,
})
const attribute = (attr, operator, fields = {}) => ({
  id: id('a'),
  kind: 'attribute',
  not: false,
  attr,
  operator,
  value: null,
  min: null,
  max: null,
  values: [],
  ...fields,
})
const spatial = (operator, layer, fields = {}) => ({
  id: id('s'),
  kind: 'spatial',
  not: false,
  operator,
  layer,
  distance_m: null,
  filter: null,
  ...fields,
})
const reference = (layer, fid, label, distance_m) => ({
  id: id('r'),
  kind: 'reference',
  not: false,
  layer,
  fid,
  label,
  distance_m,
})
const group = (op, children) => ({ id: id('g'), kind: 'group', op, not: false, children })

/** One example: the displayed layers (result first), the tree, the map view. */
function example(layers, op, children, view = REGION) {
  return { layers, result: layers[0].id, tree: { ...group(op, children), id: 'root' }, view }
}

// Reference layers with many points (Haltestellen) stay hidden: they would cover
// the hits, and conditions refer to the catalog, not to displayed layers.
const EXAMPLES = {
  1: example(
    [catalog('schulen'), catalog('gemeinden')],
    'and',
    [
      attribute('typ', 'eq', { value: 'primar' }),
      spatial('in', 'gemeinden', { filter: attribute('name', 'eq', { value: 'Köniz' }) }),
    ],
    [7.33, 46.86, 7.49, 46.96],
  ),
  2: example([catalog('haltestellen')], 'or', [
    attribute('kategorie', 'in', { values: ['I', 'II'] }),
    attribute('verkehrsmittel', 'eq', { value: 'bahn' }),
  ]),
  3: example([catalog('schulen')], 'and', [
    spatial('far', 'haltestellen', {
      distance_m: 1000,
      filter: attribute('verkehrsmittel', 'eq', { value: 'bahn' }),
    }),
  ]),
  4: example([catalog('gemeinden'), catalog('schulen')], 'and', [
    spatial('contains', 'schulen', {
      not: true,
      filter: attribute('sekundarstufe', 'eq', { value: true }),
    }),
  ]),
  5: example([catalog('gemeinden'), catalog('gewaesser')], 'and', [
    spatial('intersects', 'gewaesser', { filter: attribute('name', 'eq', { value: 'Aare' }) }),
  ]),
  6: example([catalog('schulen')], 'and', [
    attribute('sprache', 'eq', { value: 'de' }),
    group('or', [
      attribute('sekundarstufe', 'eq', { value: true }),
      attribute('standorte', 'gt', { value: 1 }),
    ]),
    spatial('near', 'haltestellen', { distance_m: 300 }),
  ]),
  7: example(
    [catalog('schulen')],
    'and',
    [
      reference('haltestellen', 47, 'Bern', 1500),
      attribute('sekundarstufe', 'eq', { value: true }),
    ],
    [7.4, 46.93, 7.48, 46.97],
  ),
  8: example(
    [
      {
        id: id('l'),
        source: {
          kind: 'derived',
          name: 'Gemeinden + Gemeindedaten',
          recipe: {
            op: 'join',
            layer: 'gemeinden',
            keepUnmatched: true,
            join: {
              layer: 'gemeindedaten',
              left_key: 'gem_nr',
              right_key: 'gem_nr',
              fields: ['einwohner', 'steueranlage'],
            },
          },
        },
        visible: true,
        opacity: 1,
        symbology: null,
      },
    ],
    'and',
    [
      attribute('einwohner', 'gt', { value: 10000 }),
      attribute('steueranlage', 'lt', { value: 1.6 }),
    ],
  ),
}

// --- the document: title and "**N von M**" per example ----------------------------------

function documented() {
  const text = readFileSync(DOC, 'utf-8')
  const found = {}
  for (const section of text.split(/^### /m).slice(1)) {
    const head = /^Beispiel (\d+) — (.*)$/m.exec(section)
    const count = /\*\*(\d+ von \d+)\*\*/.exec(section)
    if (head && count) found[head[1]] = { title: head[2].trim(), count: count[1] }
  }
  return found
}

// --- run ---------------------------------------------------------------------------------

const doc = documented()
const missing = Object.keys(EXAMPLES).filter((n) => !doc[n])
const extra = Object.keys(doc).filter((n) => !EXAMPLES[n])
if (missing.length || extra.length)
  throw new Error(`examples out of step with ${DOC.pathname}: missing ${missing}, extra ${extra}`)

const api = await request.newContext({ baseURL })
const setup = await (await api.get('/api/auth/setup')).json()
const login = setup.needs_setup
  ? await api.post('/api/auth/setup', { data: { ...ADMIN, load_sample: true } })
  : await api.post('/api/auth/login', { data: ADMIN })
if (!login.ok()) throw new Error(`cannot sign in: ${await login.text()}`)

const browser = await chromium.launch()
const context = await browser.newContext({
  baseURL,
  storageState: await api.storageState(),
  viewport: { width: 1440, height: 860 },
  deviceScaleFactor: 2,
  locale: 'de-CH',
})
const page = await context.newPage()
const failures = []

for (const [number, { layers, result, tree, view }] of Object.entries(EXAMPLES)) {
  const { title, count } = doc[number]
  const session = await api.post('/api/sessions', {
    data: {
      name: `Beispiel ${number} — ${title}`,
      state_version: 1,
      query: null,
      state: {
        layers,
        result,
        tree,
        restriction: null,
        table: { tab: null, mode: 'hits', onlyView: false, columns: {}, sort: {} },
        view,
        query: null,
      },
    },
  })
  if (!session.ok()) throw new Error(`Beispiel ${number}: ${await session.text()}`)

  await page.goto(`/sitzung/${(await session.json()).id}`)
  await page.getByLabel('Trefferzahl').waitFor()
  await page.getByRole('button', { name: 'Bearbeiten ›' }).click()
  await page.getByRole('region', { name: 'Abfrage-Editor' }).waitFor()
  // Saved without a result stamp, so the check reports a difference: not part of the picture.
  const notice = page.getByRole('button', { name: 'Hinweis schliessen' })
  if (await notice.isVisible()) await notice.click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500) // map tiles and per-row counts settle

  const shown = (await page.getByLabel('Trefferzahl').textContent())?.trim()
  console.log(`Beispiel ${number}: ${shown}`)
  if (shown !== count) failures.push(`Beispiel ${number}: shows "${shown}", document says "${count}"`)
  await page.locator('main').screenshot({ path: `${outDir}/beispiel-${number}.png` })
}

await browser.close()
await api.dispose()
if (failures.length) throw new Error(failures.join('\n'))
