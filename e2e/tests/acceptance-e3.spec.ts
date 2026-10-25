import { readFileSync } from 'node:fs'
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from './test'
import { ensureAccount, signIn } from './accounts'

// Acceptance E3 (etappen.md 5, docs/plan-e3.md WP96). "Vorführung E3: Zwei
// Modellanbindungen werden über denselben Prüffallbestand gefahren; die
// Vergleichsmatrix trägt die Freigabeentscheidung (F-3.3, F-3.8). Ein zweiter
// Lauf stellt dieselbe Anbindung mit zwei System-Prompts gegenüber."
//
// Against the model stub (e2e/model-stub; its environment as in
// acceptance-e2.3.spec.ts). Every connection here points at the stub under a
// local host; they differ by their model name. This spec scripts the stub per
// model (PUT /_cases/<id> with a ``model``, the stub's doc): for the start
// cases tagged ``code`` (Codeliste: 2 Abstimmung, 4 Bestätigung, all with a
// gold query) the strong model answers each case's gold query, the weak one
// a query without any condition and without an assumption ("still falsch"),
// except for the seeds 1 to 3, where it answers the gold query too. A full
// run (2 × 5 seeds) thus gives
//
//   strong   10 von 10 on every case     rate Abstimmung 100.0 %
//   weak      3 von 10 on every case     rate Abstimmung  30.0 %, 7 still falsch
//
// and, the weak one the reference, the strong one is *besser* by 70 points
// on each of the 4 Bestätigung cases (interval +70 … +70, D7). A system prompt
// that carries ``MARKER`` makes the strong model answer as the weak one does
// without its lucky seeds (the stub's ``marked``): the second system prompt of
// one connection is *schlechter*.
//
// The cases of this spec (own cases, connections, a layer copy) carry its
// prefix and are removed after it; a second pass (after the gate's restart)
// starts the same way. The workplace's account is a fresh one per pass, so
// its first session is empty.

const STUB = process.env.E2E_STUB_URL
const CONTROL = process.env.E2E_STUB_CONTROL
const AFTER_RESTART = process.env.E2E_AFTER_RESTART === '1'

const STRONG = 'e3-stark'
const WEAK = 'e3-schwach'
const SLOW = 'e3-langsam'
const LOGGED = 'e3-protokoll'

const DEMO_A = 'E3 Modell A'
const DEMO_B = 'E3 Modell B'
const SYSTEM = 'E3 System-Prompt'
const PROFILE = 'E3 Promptprofil'
const STOPPED = 'E3 langsam'
const EXTERN = 'E3 extern markiert'
const LOG = 'E3 Protokoll'
const OURS = [DEMO_A, DEMO_B, SYSTEM, PROFILE, STOPPED, EXTERN, LOG]

/** A fresh account per pass: its workplace opens empty. */
const ANALYST = AFTER_RESTART ? 'e2e.abnahme.e3.b' : 'e2e.abnahme.e3'

const OWN_TAG = 'e3-eigen'
const STALE_TAG = 'e3-datenstand'
const AUTHORED_ID = 'e3-arbeitsplatz'
const LOGGED_ID = 'e3-protokoll'
const STALE_ID = 'e3-veraltet'
const FRESH_ID = 'e3-frisch'
const OUR_CASES = [AUTHORED_ID, LOGGED_ID, STALE_ID, FRESH_ID]
/** A copy of the school layer that the stale test deletes; the shared one stays. */
const COPY = 'e3_schulen'

/** In a system prompt, the strong model answers every case wrong (the stub's ``marked``). */
const MARKER = 'E3-MARKE-SCHLECHT'

const AUTHORED_PROMPT = 'Welche Schulen führen eine Primarstufe als höchste Stufe?'
const LOGGED_PROMPT = 'Welche Schulen haben eine Sekundarstufe I?'

// --- the start cases and the stub's script --------------------------------------

interface StartCase {
  id: string
  prompt: string
  tags: string[]
  split: 'tuning' | 'confirm'
  gold?: Record<string, unknown>
  gold_any?: Record<string, unknown>[]
}
const startFile = (name: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../../schema/eval-cases/${name}.json`, import.meta.url), 'utf-8'),
    ) as { cases: StartCase[] }
  ).cases
const START = [...startFile('start-tuning'), ...startFile('start-confirm')]
/** The demo's cases: the start set's ``code`` tag (Codeliste). */
const CODE_CASES = START.filter((c) => c.tags.includes('code'))
const CODE_TUNING = CODE_CASES.filter((c) => c.split === 'tuning').length
const CODE_CONFIRM = CODE_CASES.filter((c) => c.split === 'confirm').length

const asQuery = (gold: Record<string, unknown>) => ({ schema_version: '2', output: 'map', ...gold })

const right = (gold: Record<string, unknown>) => ({
  kind: 'query',
  explanation: 'Ich habe die Frage so verstanden, wie sie gestellt ist.',
  assumptions: [{ text: 'wie gefragt' }],
  query: asQuery(gold),
})

/** Every feature of the gold's layer, without any assumption: silently wrong (D6). */
const wrong = (gold: Record<string, unknown>) => ({
  kind: 'query',
  explanation: 'Alle Objekte des Layers.',
  assumptions: [],
  query: { schema_version: '2', output: 'map', source: gold.source },
})

const goldOf = (c: StartCase) => c.gold ?? c.gold_any![0]

const AUTHORED_QUERY = {
  source: 'schulen',
  where: { op: 'in', attr: 'typ', values: ['primar'] },
}
const LOGGED_QUERY = {
  source: 'schulen',
  where: { op: 'compare', attr: 'sekundarstufe', cmp: 'eq', value: true },
}

/** The stub's script, by case id: the answers per model (and seed). */
function script(): Record<string, object> {
  const cases: Record<string, object> = {}
  for (const c of CODE_CASES) {
    const gold = goldOf(c)
    cases[`e3s-${c.id}`] = {
      model: STRONG,
      prompt: c.prompt,
      answer: right(gold),
      marked: { text: MARKER, answer: wrong(gold) },
    }
    cases[`e3w-${c.id}`] = {
      model: WEAK,
      prompt: c.prompt,
      answer: wrong(gold),
      seeds: { 1: right(gold), 2: right(gold), 3: right(gold) },
    }
  }
  // The questions of the own cases, asked in the workplace and in a run.
  cases['e3-log-own'] = { model: LOGGED, prompt: LOGGED_PROMPT, answer: right(LOGGED_QUERY) }
  cases['e3-log-authored'] = {
    model: LOGGED,
    prompt: AUTHORED_PROMPT,
    answer: right(AUTHORED_QUERY),
  }
  // Every question held until the test releases it: a run that stays running.
  cases['e3-slow'] = { model: SLOW, hold_s: 60, answer: right({ source: 'schulen' }) }
  return cases
}

// --- the API ----------------------------------------------------------------------

interface Connection {
  id: number
  name: string
  enabled: boolean
  is_default: boolean
  prompt_profile: { examples: string; placement: string; output: string }
}

interface Level {
  id: number
  name: string
  is_default: boolean
  system_prompt: string
  matrix: Record<string, string>
}

interface RunView {
  id: number
  status: string
  cases: { case: { id: string }; status: string }[]
  cells: { case_id: string; point: number; passed: number; answers: number }[]
  label: { cases: number }
  points: { label: { system_prompt?: string | null; prompt_profile: { placement: string } } }[]
}

async function connections(request: APIRequestContext) {
  return (await (await request.get('/api/admin/llm/connections')).json()) as Connection[]
}

/** A connection to the stub as ``model``, not released for users, made anew. */
async function freshConnection(
  request: APIRequestContext,
  name: string,
  model: string,
): Promise<number> {
  await removeConnections(request, [name])
  const made = await request.post('/api/admin/llm/connections', {
    data: { name, base_url: STUB, model, enabled: false },
  })
  expect(made.ok(), await made.text()).toBe(true)
  return ((await made.json()) as Connection).id
}

/** Deletes these connections, the default last: it may go only once no other is enabled (C18). */
async function removeConnections(request: APIRequestContext, names: string[]) {
  const doomed = (await connections(request))
    .filter((c) => names.includes(c.name))
    .sort((a, b) => Number(a.is_default) - Number(b.is_default))
  for (const c of doomed) {
    const gone = await request.delete(`/api/admin/llm/connections/${c.id}`)
    expect(gone.ok(), `${c.name}: ${gone.status()} ${await gone.text()}`).toBe(true)
  }
}

async function levels(request: APIRequestContext): Promise<Level[]> {
  return ((await (await request.get('/api/admin/levels')).json()) as { levels: Level[] }).levels
}

async function runView(request: APIRequestContext, id: number): Promise<RunView> {
  const response = await request.get(`/api/admin/evaluation/runs/${id}`)
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()) as RunView
}

/** Aborts a run left running (a failed test), so the next one may start (one at a time, D8). */
async function abortRunning(request: APIRequestContext) {
  const page = (await (await request.get('/api/admin/evaluation/runs')).json()) as {
    items: { id: number; status: string }[]
  }
  for (const run of page.items.filter((r) => r.status === 'running'))
    await request.post(`/api/admin/evaluation/runs/${run.id}/abort`)
  await fetch(`${CONTROL}/_release`, { method: 'POST' })
}

async function removeCases(request: APIRequestContext, ids: string[]) {
  for (const id of ids) await request.delete(`/api/admin/evaluation/cases/${id}`)
}

interface Call {
  model?: string
  seed?: number
  messages?: { role: string; content: unknown }[]
  tools?: unknown
}

/** What reached the stub so far: the model calls for ``model``, oldest first. */
async function callsFor(model: string): Promise<Call[]> {
  const log = await fetch(`${CONTROL}/_requests`)
  expect(log.ok).toBe(true)
  return ((await log.json()) as { body: Call }[])
    .map((r) => r.body)
    .filter((b) => b?.model === model && b.messages && !b.tools)
}

// --- the pages --------------------------------------------------------------------

/** Creates a connection in the admin page, not released for users. */
async function createInUi(page: Page, name: string, model: string, external = false) {
  await page.goto('/admin/modelle')
  await page.getByRole('button', { name: 'Anbindung', exact: true }).click()
  const form = page.getByRole('form', { name: 'Neue Anbindung' })
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Adresse').fill(STUB!)
  await form.getByLabel('Modell').fill(model)
  if (external) await form.getByLabel('Als extern behandeln, obwohl der Host lokal ist').check()
  await form.getByRole('button', { name: 'Speichern' }).click()
  const row = page.getByRole('row', { name: new RegExp(name) })
  await expect(row).toBeVisible()
  return row
}

const RUN_URL = /\/admin\/bewertung\/lauf\/(\d+)$/

interface PointChoice {
  connection: string
  /** The option's text: "<name> · lokal" or "<name> · <host>". */
  option?: string
}

/**
 * Bewertung › Läufe › Neuer Lauf (V4) with these points, the start set or own
 * cases, the cases of one tag, a scope. Returns the page's start buttons (two:
 * top and bottom), not yet pressed.
 */
async function newRun(
  page: Page,
  points: PointChoice[],
  cases: { own?: boolean; tag: string; count: number },
  scope: 'full' | 'quick' = 'full',
) {
  await page.goto('/admin/bewertung/lauf/neu')
  await expect(page.getByRole('heading', { name: 'Neuer Lauf' })).toBeVisible()
  for (const [i, point] of points.entries()) {
    if (i > 0) await page.getByRole('button', { name: '+ Messpunkt' }).click()
    await page
      .getByLabel(`Anbindung von Messpunkt ${i + 1}`)
      .selectOption({ label: point.option ?? `${point.connection} · lokal` })
  }
  if (cases.own) {
    await page.getByRole('checkbox', { name: /^Startbestand/ }).uncheck()
    await page.getByRole('checkbox', { name: /^Eigene/ }).check()
    const state = page.getByRole('group', { name: 'Datenstand' })
    if (await state.isVisible()) await state.getByRole('button', { name: 'Betriebsdaten' }).click()
  }
  await page.getByLabel('Stichwort').selectOption({ label: cases.tag })
  await page
    .getByRole('group', { name: 'Umfang' })
    .getByRole('button', { name: scope === 'full' ? /^Vollständig/ : /^Schnelltest/ })
    .click()
  const steps = page.getByRole('region', { name: '2 · Prüffälle' })
  await expect(steps.getByText(`${cases.count} Prüffälle`, { exact: true })).toBeVisible()
  // The estimate: requests = cases × repeats × points (D12).
  const requests = cases.count * (scope === 'full' ? 10 : 5) * points.length
  await expect(
    page
      .getByRole('table', { name: 'Abschätzung' })
      .getByRole('row', { name: /^Zusammen/ })
      .getByRole('cell')
      .first(),
  ).toHaveText(String(requests))
  return page.getByRole('button', { name: 'Lauf starten' })
}

/** Presses Lauf starten; the run page (V6) once it shows ``fertig``. Its id. */
async function startAndFinish(page: Page, start: Locator): Promise<number> {
  await expect(start.first()).toBeEnabled()
  await start.first().click()
  await expect(page).toHaveURL(RUN_URL)
  const id = Number(RUN_URL.exec(page.url())![1])
  await expect(page.getByRole('heading', { name: `Lauf #${id}` })).toBeVisible()
  await expect(runStatus(page)).toHaveAttribute('data-status', 'done', { timeout: 90_000 })
  return id
}

/** The run's status label in the header (E2's status language, ``role=status``). */
const runStatus = (page: Page) => page.locator('h2 ~ span[data-status]').first()

const matrixOf = (page: Page) => page.getByRole('table', { name: 'Matrix: Prüffälle × Messpunkte' })

/** A column head of the matrix by its connection's name. */
const head = (page: Page, name: string, nth = 0) =>
  matrixOf(page).getByRole('columnheader').filter({ hasText: name }).nth(nth)

// --- the workplace ------------------------------------------------------------------

const hits = (page: Page) => page.getByLabel('Trefferzahl', { exact: true })
const panelOf = (page: Page) => page.getByRole('region', { name: 'Prompt', exact: true })

/** The level whose classes all need approval: Prüfen, as shipped. */
async function checkingLevel(request: APIRequestContext): Promise<number> {
  const level = (await levels(request)).find((l) =>
    Object.values(l.matrix).every((m) => m === 'approve'),
  )
  expect(level?.name).toBe('Prüfen')
  return level!.id
}

async function workplace(
  browser: Browser,
  connection: number,
  level: number,
): Promise<[BrowserContext, Page]> {
  const [context, page] = await signIn(browser, ANALYST)
  await expect(page.getByRole('tab', { name: 'Klassik' })).toBeVisible()
  const chosen = await context.request.put('/api/llm/options', {
    data: { connection_id: connection, level_id: level },
  })
  expect(chosen.ok(), await chosen.text()).toBe(true)
  await page.goto('/')
  await expect(page.getByRole('tab', { name: 'Klassik' })).toBeVisible()
  return [context, page]
}

/** Schulen with "Höchste Schulstufe ist eins von primar", built by hand and applied (Modus A). */
async function buildPrimarySchools(page: Page) {
  await page.getByRole('tab', { name: 'Klassik' }).click()
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  await picker
    .getByRole('checkbox', { name: /^Schulen/ })
    .first()
    .check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
  await expect(hits(page)).toHaveText('137 von 137')
  await page.getByRole('button', { name: '+ Bedingung' }).click()
  const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
  const kind = editor.getByRole('group', { name: 'Bedingung Attribut' })
  await kind.getByLabel('Feld').selectOption({ label: 'Höchste Schulstufe' })
  await kind.getByLabel('Operator').selectOption({ label: 'ist eins von' })
  await kind.getByLabel('Wert hinzufügen').fill('primar')
  await kind.getByLabel('Wert hinzufügen').press('Enter')
  await editor.getByRole('button', { name: 'Übernehmen' }).click()
  await expect(hits(page)).not.toHaveText('137 von 137')
}

/** Adds a tag in a tag editor (V2.1, V3.1). */
async function addTag(scope: Locator | Page, tag: string) {
  await scope.getByRole('button', { name: '+ Stichwort' }).click()
  const field = scope.getByLabel('Neues Stichwort', { exact: true })
  await field.fill(tag)
  await field.press('Enter')
  await expect(scope.getByRole('list', { name: 'Stichwörter' })).toContainText(tag)
}

// ------------------------------------------------------------------------------------

test.describe('E3 against the model stub', { tag: '@stub' }, () => {
  test.skip(
    !STUB || !CONTROL,
    'E2E_STUB_URL and E2E_STUB_CONTROL name the model stub (scripts/gate.sh)',
  )
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(async ({ request }) => {
    expect(CODE_TUNING).toBe(2)
    expect(CODE_CONFIRM).toBe(4)
    for (const [id, scripted] of Object.entries(script())) {
      const put = await fetch(`${CONTROL}/_cases/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scripted),
      })
      expect(put.status, id).toBe(204)
    }
    await abortRunning(request)
  })

  test.afterEach(async ({ request }) => abortRunning(request))

  test.afterAll(async ({ request }) => {
    await abortRunning(request)
    await removeCases(request, OUR_CASES)
    await request.delete(`/api/admin/layers/${COPY}`)
    await removeConnections(request, OURS)
  })

  test('Vorführung: two connections over the same cases, the matrix carries the release decision', async ({
    page,
    request,
  }) => {
    // The default before: given back after the demo, so ours can go (C18).
    const before = (await connections(request)).find((c) => c.is_default && !OURS.includes(c.name))
    await removeConnections(request, [DEMO_A, DEMO_B])
    try {
      // Two connections as an administrator makes them, neither released yet.
      for (const [name, model] of [
        [DEMO_A, STRONG],
        [DEMO_B, WEAK],
      ]) {
        const row = await createInUi(page, name, model)
        await expect(row.getByText('lokal', { exact: true })).toBeVisible()
        await expect(
          row.getByRole('cell', { name: 'nicht freigegeben', exact: true }),
        ).toBeVisible()
      }

      // V4: B is the reference (point 1), A the second column; full scope.
      const start = await newRun(page, [{ connection: DEMO_B }, { connection: DEMO_A }], {
        tag: 'Codeliste',
        count: CODE_CASES.length,
      })
      await expect(page.getByLabel('Messpunkt 1 als Vergleichsbasis')).toBeChecked()
      const id = await startAndFinish(page, start)

      // V6.2: both columns, the rate on Abstimmung, the word on Bestätigung.
      const matrix = matrixOf(page)
      const a = head(page, DEMO_A)
      const b = head(page, DEMO_B)
      await expect(b).toContainText('30.0 %')
      await expect(b).toContainText(`${3 * CODE_TUNING} von ${10 * CODE_TUNING}`)
      await expect(b).toContainText(`still falsch ${7 * CODE_CASES.length}`)
      await expect(b).toContainText('Vergleichsbasis')
      await expect(a).toContainText('100.0 %')
      await expect(a).toContainText(`${10 * CODE_TUNING} von ${10 * CODE_TUNING}`)
      await expect(a).toContainText('still falsch 0')
      await expect(a).toContainText('besser')
      await expect(a).toContainText('+70.0 Punkte (+70.0 … +70.0)')
      // The rows are the Abstimmung cases; each cell passes of 10, B's marked "still falsch".
      const row = matrix.getByRole('row').filter({ hasText: CODE_CASES[0].prompt })
      await expect(row.getByRole('link')).toHaveCount(2)
      await expect(row.getByRole('link').nth(0)).toContainText('3 von 10 · 7 f')
      await expect(row.getByRole('link').nth(0)).toContainText('7 still falsch')
      await expect(row.getByRole('link').nth(1)).toContainText('10 von 10')
      // Bestätigung: the cases the comparison words stand on.
      await page
        .getByRole('group', { name: 'Teil' })
        .getByRole('button', { name: 'Bestätigung' })
        .click()
      for (const more of await matrix.getByRole('button', { name: /weitere$/ }).all())
        await more.click()
      for (const c of CODE_CASES.filter((c) => c.split === 'confirm'))
        await expect(matrix.getByRole('row').filter({ hasText: c.prompt })).toContainText(
          '10 von 10',
        )
      await expect(matrix).not.toContainText(CODE_CASES[0].prompt)

      // The release decision: from the matrix to the connection (design review 6).
      const ids = Object.fromEntries((await connections(request)).map((c) => [c.name, c.id]))
      await page.getByRole('button', { name: 'Zur Anbindung ▾' }).click()
      await page.getByRole('menuitem', { name: DEMO_A }).click()
      await expect(page).toHaveURL(new RegExp(`/admin/modelle#anbindung-${ids[DEMO_A]}$`))
      const target = page.locator(`#anbindung-${ids[DEMO_A]}`)
      await expect(target).toHaveAttribute('aria-current', 'location')
      // "zuletzt bewertet" (O7) names this run.
      await expect(target.getByRole('link', { name: `Lauf #${id}` })).toBeVisible()
      await target.getByRole('button', { name: `Aktionen für ${DEMO_A}` }).click()
      await page.getByRole('menuitem', { name: 'Bearbeiten' }).click()
      const form = page.getByRole('form', { name: 'Anbindung bearbeiten' })
      await form.getByLabel('Für Anwender freigegeben').check()
      await form.getByLabel('Voreingestellt').check()
      await form.getByRole('button', { name: 'Speichern' }).click()
      await expect(form).toHaveCount(0)
      await expect(target.getByRole('cell', { name: 'freigegeben', exact: true })).toBeVisible()
      await expect(target.getByText('voreingestellt', { exact: true })).toBeVisible()
      const after = await connections(request)
      expect(after.find((c) => c.name === DEMO_A)).toMatchObject({
        enabled: true,
        is_default: true,
      })
      expect(after.find((c) => c.name === DEMO_B)).toMatchObject({
        enabled: false,
        is_default: false,
      })
    } finally {
      if (before) {
        const back = await request.patch(`/api/admin/llm/connections/${before.id}`, {
          data: { is_default: true },
        })
        expect(back.ok(), await back.text()).toBe(true)
      }
      await removeConnections(request, [DEMO_A, DEMO_B])
    }
  })

  test('a second run compares two system prompts on one connection; operation keeps its own', async ({
    page,
    request,
  }) => {
    await freshConnection(request, SYSTEM, STRONG)
    const level = (await levels(request)).find((l) => l.is_default)!
    const marker = `${MARKER} ${Date.now()}`
    const calls = (await callsFor(STRONG)).length

    const start = await newRun(page, [{ connection: SYSTEM }, { connection: SYSTEM }], {
      tag: 'Codeliste',
      count: CODE_CASES.length,
    })
    // D10: an edited copy of the level's system prompt, for point 2 and this run only.
    const rows = page.getByRole('region', { name: '1 · Messpunkte' }).getByRole('row')
    await rows.nth(2).getByRole('button', { name: 'System-Prompt ändern' }).click()
    const copy = page.getByLabel(/^System-Prompt für diesen Lauf/)
    await expect(copy).toHaveValue(level.system_prompt)
    await copy.fill(`${level.system_prompt}\n${marker}`)
    await expect(
      page.getByText('Gilt nur für diesen Lauf; ändert den Betrieb nicht.', { exact: false }),
    ).toBeVisible()
    const id = await startAndFinish(page, start)

    // Both columns of one connection; the second says its system prompt is another.
    await expect(head(page, SYSTEM, 0)).not.toContainText('System-Prompt geändert')
    await expect(head(page, SYSTEM, 0)).toContainText('Vergleichsbasis')
    await expect(head(page, SYSTEM, 1)).toContainText('System-Prompt geändert')
    // Under the marked system prompt the stub answers every case wrong: worse by
    // 100 points on each Bestätigung case.
    await expect(head(page, SYSTEM, 0)).toContainText(`${10 * CODE_TUNING} von ${10 * CODE_TUNING}`)
    await expect(head(page, SYSTEM, 1)).toContainText(`0 von ${10 * CODE_TUNING}`)
    await expect(head(page, SYSTEM, 1)).toContainText('schlechter')
    await expect(head(page, SYSTEM, 1)).toContainText('-100.0 Punkte (-100.0 … -100.0)')
    const run = await runView(request, id)
    expect(run.points[0].label.system_prompt ?? null).toBeNull()
    expect(run.points[1].label.system_prompt).toContain(marker)

    // The copy reached the model for point 2 only: 6 cases × 10 repeats.
    const sent = (await callsFor(STRONG)).slice(calls)
    const marked = sent.filter((b) => b.messages!.some((m) => String(m.content).includes(marker)))
    expect(sent).toHaveLength(2 * 10 * CODE_CASES.length)
    expect(marked).toHaveLength(10 * CODE_CASES.length)
    // Operation is untouched: the level's system prompt is as it was.
    const now = (await levels(request)).find((l) => l.id === level.id)!
    expect(now.system_prompt).toBe(level.system_prompt)
    await removeConnections(request, [SYSTEM])
  })

  test('an authored case and a case from the log are listed and run', async ({
    browser,
    page,
    request,
  }) => {
    await removeCases(request, [AUTHORED_ID, LOGGED_ID])
    await ensureAccount(request, browser, ANALYST, 'admin')
    await removeConnections(request, [LOG])
    const made = await request.post('/api/admin/llm/connections', {
      data: { name: LOG, base_url: STUB, model: LOGGED, enabled: true },
    })
    expect(made.ok(), await made.text()).toBe(true)
    const log = ((await made.json()) as Connection).id
    const [context, work] = await workplace(browser, log, await checkingLevel(request))
    let actionId = 0
    try {
      // V3: "Als Prüffall speichern" takes the analysis built by hand.
      await buildPrimarySchools(work)
      await work.getByRole('button', { name: 'Als Prüffall speichern' }).click()
      const dialog = work.getByRole('dialog', { name: 'Als Prüffall speichern' })
      await dialog.getByLabel('Frage', { exact: true }).fill(AUTHORED_PROMPT)
      await dialog.getByLabel('Kennung', { exact: true }).fill(AUTHORED_ID)
      // New own cases default to Bestätigung (design review 3).
      await expect(dialog.getByRole('button', { name: 'Bestätigung' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await addTag(dialog, OWN_TAG)
      await dialog.getByRole('button', { name: 'Speichern' }).click()
      await expect(dialog.getByRole('status')).toContainText(`${AUTHORED_ID}`)
      await expect(dialog.getByRole('status')).toContainText('gespeichert')
      await dialog.getByRole('button', { name: 'Schliessen' }).click()

      // M16.2 → V2: an accepted direct query becomes a case without typing its query.
      await work.getByRole('tab', { name: 'Prompt' }).click()
      const panel = panelOf(work)
      const items = panel.getByRole('list', { name: 'Verlauf' }).locator(':scope > li')
      const before = await items.count()
      await panel.getByRole('textbox', { name: 'Prompt' }).fill(LOGGED_PROMPT)
      const posted = work.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/api/model/prompt'),
      )
      await panel.getByRole('button', { name: /Senden/ }).click()
      const response = await posted
      expect(response.status(), await response.text()).toBe(202)
      actionId = ((await response.json()) as { id: number }).id
      await expect(items).toHaveCount(before + 1)
      const card = items.last().getByRole('article', { name: 'Antwort' })
      await expect(card).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
      await card
        .getByRole('region', { name: 'Freigabe' })
        .getByRole('button', { name: 'Annehmen' })
        .click()
      await expect
        .poll(async () => {
          const record = (await (
            await context.request.get(`/api/model/actions/${actionId}`)
          ).json()) as {
            decision: string | null
          }
          return record.decision
        })
        .toBe('accepted')
    } finally {
      await context.close()
    }

    await page.goto(`/admin/modellprotokoll/${actionId}`)
    await page.getByRole('link', { name: 'Als Prüffall übernehmen' }).click()
    await expect(page.getByRole('heading', { name: 'Neuer Prüffall' })).toBeVisible()
    await expect(page.getByLabel('Frage', { exact: true })).toHaveValue(LOGGED_PROMPT)
    await page.getByLabel('Kennung', { exact: true }).fill(LOGGED_ID)
    await addTag(page, OWN_TAG)
    await page.getByRole('button', { name: 'Speichern' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/bewertung/faelle/${LOGGED_ID}$`))

    // V1.1: both in the list, with their origin.
    await page.goto('/admin/bewertung/faelle')
    const rowOf = (id: string) =>
      page.getByRole('row').filter({ has: page.getByRole('link', { name: id, exact: true }) })
    const authoredRow = rowOf(AUTHORED_ID)
    const loggedRow = rowOf(LOGGED_ID)
    await expect(authoredRow).toContainText('Arbeitsplatz')
    await expect(authoredRow).toContainText('Betriebsdaten')
    await expect(authoredRow).toContainText('Bestätigung')
    await expect(loggedRow).toContainText('Protokoll')
    await expect(loggedRow).toContainText('Betriebsdaten')

    // Both run on the live data and pass against their own reference.
    const start = await newRun(
      page,
      [{ connection: LOG }],
      { own: true, tag: OWN_TAG, count: 2 },
      'quick',
    )
    const id = await startAndFinish(page, start)
    const matrix = matrixOf(page)
    for (const prompt of [AUTHORED_PROMPT, LOGGED_PROMPT])
      await expect(
        matrix.getByRole('row').filter({ hasText: prompt }).getByRole('link'),
      ).toContainText('5 von 5')
    const run = await runView(request, id)
    expect(run.cells.map((c) => [c.case_id, c.passed, c.answers]).sort()).toEqual([
      [AUTHORED_ID, 5, 5],
      [LOGGED_ID, 5, 5],
    ])
    await removeCases(request, [AUTHORED_ID, LOGGED_ID])
    await removeConnections(request, [LOG])
  })

  test('a running run is aborted and shows so', async ({ page, request }) => {
    await freshConnection(request, STOPPED, SLOW)
    const calls = (await callsFor(SLOW)).length
    const start = await newRun(page, [{ connection: STOPPED }], {
      tag: 'Codeliste',
      count: CODE_CASES.length,
    })
    await start.first().click()
    await expect(page).toHaveURL(RUN_URL)
    const id = Number(RUN_URL.exec(page.url())![1])
    // V6.1: running, its first question held by the stub.
    await expect(runStatus(page)).toHaveAttribute('data-status', 'running')
    await expect(page.getByText(`0 von ${10 * CODE_CASES.length} Antworten`)).toBeVisible()
    await expect.poll(async () => (await callsFor(SLOW)).length - calls).toBe(1)

    await page.getByRole('button', { name: 'Abbrechen' }).click()
    const confirm = page.getByRole('alertdialog', { name: `Lauf #${id} abbrechen?` })
    await confirm.getByRole('button', { name: 'Lauf abbrechen' }).click()
    await expect(runStatus(page)).toHaveAttribute('data-status', 'aborted')
    await expect(runStatus(page)).toHaveText('abgebrochen')
    await expect(
      page.getByText('Abgebrochen. Die bisherigen Antworten bleiben;', { exact: false }),
    ).toBeVisible()
    // The held answer comes after the abort: dropped, and no further question goes out.
    await fetch(`${CONTROL}/_release`, { method: 'POST' })
    await expect.poll(async () => (await runView(request, id)).status).toBe('aborted')
    // The aborted run's thread has ended once the server accepts another run
    // (until then it answers run_busy, "finishing"). That run asks seed 1 of the
    // first case and is held; the aborted one would have gone on with seed 2.
    const level = (await levels(request)).find((l) => l.is_default)!.id
    const connection = (await connections(request)).find((c) => c.name === STOPPED)!.id
    let next = 0
    await expect
      .poll(async () => {
        const again = await request.post('/api/admin/evaluation/runs', {
          data: {
            points: [{ connection_id: connection, level_id: level }],
            cases: { origins: ['start'], tags: ['code'] },
            data_state: 'sample',
            scope: 'quick',
          },
        })
        if (again.status() === 202) next = ((await again.json()) as { id: number }).id
        return again.status()
      })
      .toBe(202)
    await expect.poll(async () => (await callsFor(SLOW)).length - calls).toBe(2)
    expect((await callsFor(SLOW)).slice(calls).map((b) => b.seed)).toEqual([1, 1])
    expect((await runView(request, id)).cells).toEqual([])
    await request.post(`/api/admin/evaluation/runs/${next}/abort`)
    await fetch(`${CONTROL}/_release`, { method: 'POST' })
    // Another run may start: no run is running (one at a time, D8). The notice
    // reads the list of runs: asserted once the list has come.
    const listed = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname === '/api/admin/evaluation/runs',
    )
    await page.goto('/admin/bewertung/lauf/neu')
    expect((await listed).ok()).toBe(true)
    await expect(page.getByRole('heading', { name: 'Neuer Lauf' })).toBeVisible()
    await expect(page.getByText('Ein Lauf läuft schon')).toHaveCount(0)
    await removeConnections(request, [STOPPED])
  })

  test('an external connection: the start stays locked until the host is confirmed', async ({
    page,
    request,
  }) => {
    await removeConnections(request, [EXTERN])
    // Marked external on the stub's local host (C5): nothing leaves the machine.
    const row = await createInUi(page, EXTERN, STRONG, true)
    await expect(row).toContainText('extern')
    const host = new URL(STUB!).hostname
    const start = await newRun(
      page,
      [{ connection: EXTERN, option: `${EXTERN} · ${host}` }],
      { tag: 'Codeliste', count: CODE_CASES.length },
      'quick',
    )
    // F-9.4, D12: the notice names the host; without the tick the start is locked.
    const notice = page.getByText('Steckbrief und Fragen gehen an', { exact: false })
    await expect(notice).toContainText(host)
    await expect(notice).toContainText('keine Geodaten-Inhalte')
    await expect(page.getByText('Ohne Haken bleibt „Lauf starten“ gesperrt.')).toBeVisible()
    await expect(start.first()).toBeDisabled()
    await expect(start.last()).toBeDisabled()
    await page.getByLabel('Verstanden, extern senden').check()
    await expect(start.first()).toBeEnabled()
    await expect(start.last()).toBeEnabled()
    await page.getByLabel('Verstanden, extern senden').uncheck()
    await expect(start.first()).toBeDisabled()
    await page.getByLabel('Verstanden, extern senden').check()
    // Confirmed in this request, the run is accepted (WP90) and goes through.
    const id = await startAndFinish(page, start.last())
    const run = await runView(request, id)
    expect(run.cells.every((c) => c.passed === c.answers && c.answers === 5)).toBe(true)
    // Without the confirmation the server refuses the same request (external_not_confirmed).
    const refused = await request.post('/api/admin/evaluation/runs', {
      data: {
        points: [
          {
            connection_id: (await connections(request)).find((c) => c.name === EXTERN)!.id,
            level_id: (await levels(request)).find((l) => l.is_default)!.id,
          },
        ],
        cases: { origins: ['start'], tags: ['code'] },
        data_state: 'sample',
        scope: 'quick',
        confirm_external: [],
      },
    })
    expect(refused.status(), await refused.text()).toBe(400)
    expect(((await refused.json()) as { code: string }).code).toBe('external_not_confirmed')
    // The dialog sent the host it showed (security review #49).
    const started = (await runView(request, id)) as unknown as {
      request: { confirm_external_hosts: string[] }
    }
    expect(started.request.confirm_external_hosts).toEqual([host])
    await removeConnections(request, [EXTERN])
  })

  test('a stale live case is marked and left out of a run', async ({ page, request }) => {
    await removeCases(request, [STALE_ID, FRESH_ID])
    await request.delete(`/api/admin/layers/${COPY}`)
    const copied = await request.post('/api/admin/layers/schulen/duplicate', {
      data: { name: COPY, title: 'E3 Schulen' },
    })
    expect(copied.ok(), await copied.text()).toBe(true)
    const own = (id: string, layer: string, prompt: string) => ({
      id,
      prompt,
      tags: [STALE_TAG],
      split: 'confirm',
      origin: 'authored',
      data_state: 'live',
      schema_version: '2',
      gold: { source: layer, where: AUTHORED_QUERY.where },
      layers: [{ name: layer }],
    })
    for (const body of [
      own(STALE_ID, COPY, 'Primarschulen in der Kopie'),
      own(FRESH_ID, 'schulen', AUTHORED_PROMPT),
    ]) {
      const made = await request.post('/api/admin/evaluation/cases', { data: body })
      expect(made.ok(), await made.text()).toBe(true)
    }
    // The case's layer goes (D3): the case is stale from now on.
    const deleted = await request.delete(`/api/admin/layers/${COPY}`)
    expect(deleted.ok(), await deleted.text()).toBe(true)

    // V1.2: grey with the word, and why.
    await page.goto('/admin/bewertung/faelle')
    const rowOf = (id: string) =>
      page.getByRole('row').filter({ has: page.getByRole('link', { name: id, exact: true }) })
    const staleRow = rowOf(STALE_ID)
    await expect(staleRow).toHaveAttribute('data-status', 'stale')
    await expect(staleRow).toContainText('veraltet')
    await expect(rowOf(FRESH_ID)).toHaveAttribute('data-status', 'ok')
    await expect(
      page.getByText(`(${STALE_ID}): Der Layer „${COPY}" ist gelöscht`, { exact: false }),
    ).toBeVisible()

    // V4: the tag selects both, the stale one is not counted; the run asks the other only.
    await freshConnection(request, LOG, LOGGED)
    const start = await newRun(
      page,
      [{ connection: LOG }],
      { own: true, tag: STALE_TAG, count: 1 },
      'quick',
    )
    const id = await startAndFinish(page, start)
    const matrix = matrixOf(page)
    // One case row (its group's head aside).
    await expect(matrix.locator('th[scope="row"]')).toHaveCount(1)
    await expect(matrix).toContainText(FRESH_ID)
    await expect(matrix).not.toContainText(STALE_ID)
    const run = await runView(request, id)
    expect(run.label.cases).toBe(1)
    expect(run.cases.map((rc) => [rc.case.id, rc.status]).sort()).toEqual([
      [FRESH_ID, 'ok'],
      [STALE_ID, 'stale'],
    ])
    expect(run.cells.map((c) => c.case_id)).toEqual([FRESH_ID])
    await removeCases(request, [STALE_ID, FRESH_ID])
    await removeConnections(request, [LOG])
  })

  test('Promptprofil übernehmen from the matrix sets the connection; the profile page shows V8', async ({
    page,
    request,
  }) => {
    const connection = await freshConnection(request, PROFILE, STRONG)
    const calls = (await callsFor(STRONG)).length
    const start = await newRun(page, [{ connection: PROFILE }, { connection: PROFILE }], {
      tag: 'Codeliste',
      count: CODE_CASES.length,
    })
    // Point 2 measures P9 without changing the connection (D9).
    await page.getByLabel('Platzierung von Messpunkt 2').selectOption({ label: 'P9' })
    const id = await startAndFinish(page, start)
    await expect(head(page, PROFILE, 1)).toContainText('P9')
    expect(
      (await connections(request)).find((c) => c.id === connection)!.prompt_profile.placement,
    ).toBe('P0')
    // At the stub: point 1 (P0) sent two messages, point 2 (P9) three, the
    // first-question note as a system message of its own; the user message is
    // the question alone (E-8).
    const roles = (b: Call) => b.messages!.map((m) => m.role).join(' ')
    const sent = (await callsFor(STRONG)).slice(calls)
    expect(sent).toHaveLength(2 * 10 * CODE_CASES.length)
    expect(sent.filter((b) => roles(b) === 'system user')).toHaveLength(10 * CODE_CASES.length)
    const p9 = sent.filter((b) => roles(b) === 'system system user')
    expect(p9).toHaveLength(10 * CODE_CASES.length)
    expect(p9.every((b) => CODE_CASES.some((c) => b.messages![2].content === c.prompt))).toBe(true)
    const levelsBefore = await levels(request)

    // V6.4: the dialog lists what changes in operation; then it is set.
    await page.getByRole('button', { name: 'Promptprofil übernehmen ▾' }).click()
    await expect(page.getByRole('menuitem', { name: /P0 · schon im Betrieb/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await page.getByRole('menuitem', { name: `${PROFILE} P9` }).click()
    const dialog = page.getByRole('dialog', { name: 'Promptprofil übernehmen?' })
    await expect(dialog.getByRole('list', { name: 'Änderungen' })).toContainText(
      '~ Platzierung: P0 → P9',
    )
    await expect(dialog.getByRole('list', { name: 'Änderungen' })).toContainText(
      'Beispiele: Standard (unverändert)',
    )
    await dialog.getByRole('button', { name: 'Übernehmen' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(
        async () => (await connections(request)).find((c) => c.id === connection)!.prompt_profile,
      )
      .toEqual({ examples: 'standard', placement: 'P9', output: 'constrained' })
    // "System-Prompt und Stufen bleiben unverändert": the levels as before.
    expect(await levels(request)).toEqual(levelsBefore)
    // Now the P9 column is the one in operation.
    await page.getByRole('button', { name: 'Promptprofil übernehmen ▾' }).click()
    await expect(page.getByRole('menuitem', { name: /P9 · schon im Betrieb/ })).toBeVisible()
    await page.keyboard.press('Escape')

    // Operation sends P9 now: one direct query on the connection, seen at the stub.
    const enabled = await request.patch(`/api/admin/llm/connections/${connection}`, {
      data: { enabled: true },
    })
    expect(enabled.ok(), await enabled.text()).toBe(true)
    // The connection only: the administrator's level stays as other specs find it.
    const chosen = await request.put('/api/llm/options', { data: { connection_id: connection } })
    expect(chosen.ok(), await chosen.text()).toBe(true)
    const before = (await callsFor(STRONG)).length
    const question = CODE_CASES[0].prompt
    const asked = await request.post('/api/model/prompt', { data: { text: question } })
    expect(asked.status(), await asked.text()).toBe(202)
    const action = ((await asked.json()) as { id: number }).id
    await expect.poll(async () => (await callsFor(STRONG)).length - before).toBe(1)
    const [operation] = (await callsFor(STRONG)).slice(before)
    expect(roles(operation)).toBe('system system user')
    expect(operation.messages![2].content).toBe(question)
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/model/actions/${action}`)).json()) as { status: string })
            .status,
      )
      .not.toBe('thinking')

    // V8: the summary of the layer profile, and the line to this run's result.
    await page.goto('/admin/steckbrief')
    await page.getByLabel('Beispieldaten').check()
    const summary = page.getByRole('region', { name: 'Vollständigkeit' })
    await expect(summary.getByText('Vollständigkeit · Beispieldaten')).toBeVisible()
    await expect(summary.getByText('Textattribute mit bestätigter Codeliste')).toBeVisible()
    await expect(summary.getByText(`(Lauf #${id},`, { exact: false }).first()).toBeVisible()
    await removeConnections(request, [PROFILE])
  })
})
