import { isDeepStrictEqual } from 'node:util'
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
import { ensureAreaLayer, reference, watchQueries } from './reference'

// Acceptance E2.4 (etappen.md 4, docs/plan-e2.3-e2.6.md WP73b): "Eine Stufe
// ohne Freigabepflicht und eine mit Freigabepflicht verhalten sich
// nachweislich unterschiedlich, und die Regel greift auch an der Oberfläche
// vorbei."
//
// Against the model stub (e2e/model-stub, see acceptance-e2.3.spec.ts for its
// environment), with the levels of the contract fixture
// schema/model-cases/v1.json set up through the admin API and put back after.
// One prompt, the fixture's reference question, under each level:
//
// - Assistenz (all off): a proposal the user applies by hand (M4, D1);
// - Prüfen (all approve): approval with preview, Annehmen, Zurücknehmen (M5, M2.2);
// - Automatisch (all auto): applied at once, notice bar, Rückgängig (M6.1, M6.2);
// - Teilautonom (derive approve, the rest auto): see the test for what the
//   direct path reaches of it.
//
// "Past the surface": the browser's own fetch against the transition routes of
// records the level does not let through. The log (M16) shows each entry with
// the level as it was, also after the administrator has changed that level.

const STUB = process.env.E2E_STUB_URL
const CONTROL = process.env.E2E_STUB_CONTROL
const MODEL = 'stub-model'

const CONNECTION = 'Stub E2.4'
const AREAS = 'gemeinden_steuern'
const ANALYST = 'e2e.abnahme.e24'
const USER = 'e2e.abnahme.e24.user'

interface FixtureLevel {
  name: string
  selectable: boolean
  is_default?: boolean
  matrix: Record<string, string>
}
const fixtureFile = JSON.parse(
  readFileSync(new URL('../../schema/model-cases/v1.json', import.meta.url), 'utf-8'),
) as { levels: FixtureLevel[]; cases: { id: string; prompt: string }[] }
const PROMPT = fixtureFile.cases.find((c) => c.id === 'reference')!.prompt

interface StoredLevel {
  id?: number | null
  name: string
  selectable: boolean
  is_default: boolean
  matrix: Record<string, string>
  [field: string]: unknown
}

interface View {
  id: number
  account: string
  status: string
  decision: string | null
  reject_reason: string | null
  undone_at: string | null
  previewed_at: string | null
  query: unknown
  level: { id: number; name: string; matrix: Record<string, string> }
  governance: { classes: string[]; cell: string; needs_approval: string[]; off: string[] } | null
  stamp: { count: number } | null
}

interface Summary {
  id: number
  account: string
  decision: string | null
  status: string
}

interface Figures {
  proposals: number
  accepted: number
  adjusted: number
  rejected: number
  superseded: number
  proposal_only: number
  auto: number
  undone: number
  undone_after_approval: number
  acceptance_rate: number | null
}

/** A query object without the fields left at their default (null, []). */
function given(query: unknown): unknown {
  if (Array.isArray(query)) return query.map(given)
  if (query === null || typeof query !== 'object') return query
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => [k, given(v)]),
  )
}

async function levels(request: APIRequestContext) {
  const response = await request.get('/api/admin/levels')
  expect(response.ok(), await response.text()).toBe(true)
  return ((await response.json()) as { levels: StoredLevel[] }).levels
}

async function putLevels(request: APIRequestContext, set: StoredLevel[]) {
  const response = await request.put('/api/admin/levels', { data: { levels: set } })
  expect(response.ok(), await response.text()).toBe(true)
  return ((await response.json()) as { levels: StoredLevel[] }).levels
}

/** The fixture's four levels; a stored level of the same name keeps its id, texts and prompt. */
function fixtureLevels(stored: StoredLevel[]): StoredLevel[] {
  return fixtureFile.levels.map((wanted) => {
    const found = stored.find((l) => l.name.toLowerCase() === wanted.name.toLowerCase())
    return {
      ...(found ?? { description: '', system_prompt: '' }),
      name: wanted.name,
      selectable: wanted.selectable,
      is_default: wanted.is_default === true,
      matrix: { ...wanted.matrix },
    }
  })
}

interface Connection {
  id: number
  name: string
  is_default: boolean
}

async function removeConnection(request: APIRequestContext) {
  const all = (await (await request.get('/api/admin/llm/connections')).json()) as Connection[]
  for (const c of all.filter((c) => c.name === CONNECTION))
    await request.delete(`/api/admin/llm/connections/${c.id}`)
}

async function connectionId(request: APIRequestContext): Promise<number> {
  const all = (await (await request.get('/api/admin/llm/connections')).json()) as Connection[]
  const found = all.find((c) => c.name === CONNECTION)
  if (found) return found.id
  const made = await request.post('/api/admin/llm/connections', {
    data: { name: CONNECTION, base_url: STUB, model: MODEL, enabled: true, timeout_s: 120 },
  })
  expect(made.ok(), await made.text()).toBe(true)
  return ((await made.json()) as Connection).id
}

async function choose(
  context: BrowserContext,
  data: { connection_id?: number; level_id?: number },
) {
  const chosen = await context.request.put('/api/llm/options', { data })
  expect(chosen.ok(), await chosen.text()).toBe(true)
}

async function view(context: BrowserContext, id: number): Promise<View> {
  const response = await context.request.get(`/api/model/actions/${id}`)
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()) as View
}

/** The browser's own request, past the interface: status and error code. */
async function direct(page: Page, method: 'GET' | 'POST', path: string) {
  return page.evaluate(
    async ([method, path]) => {
      const response = await fetch(path, { method })
      const body = (await response.json().catch(() => ({}))) as { code?: string }
      return { status: response.status, code: body.code ?? null }
    },
    [method, path] as const,
  )
}

/** Signed in through the login page, the workplace shown. */
async function user(browser: Browser, username: string): Promise<[BrowserContext, Page]> {
  const [context, page] = await signIn(browser, username)
  await expect(page.getByRole('tab', { name: 'Klassik' })).toBeVisible()
  return [context, page]
}

/** The level chosen in the header's menu (M7.2), as a user does. */
async function chooseLevel(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Modellunterstützung wählen' })
  await menu.click()
  const item = page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) })
  if ((await item.getAttribute('aria-checked')) === 'true') {
    await page.keyboard.press('Escape') // chosen already (a pass on the data of the first)
  } else {
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/llm/options') && r.request().method() === 'PUT',
    )
    await item.click()
    expect((await saved).ok()).toBe(true)
  }
  await expect(menu).toContainText(`Stufe: ${name}`)
}

const hits = (page: Page) => page.getByLabel('Trefferzahl', { exact: true })
const panelOf = (page: Page) => page.getByRole('region', { name: 'Prompt', exact: true })

/** Sends ``text``; the answer card once the model has answered, and the record's id. */
async function ask(page: Page, text: string): Promise<{ card: Locator; id: number }> {
  const panel = panelOf(page)
  const items = panel.getByRole('list', { name: 'Verlauf' }).locator(':scope > li')
  const before = await items.count()
  await panel.getByRole('textbox', { name: 'Prompt' }).fill(text)
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/model/prompt'),
  )
  await panel.getByRole('button', { name: /Senden/ }).click()
  const response = await posted
  expect(response.status(), await response.text()).toBe(202)
  const { id } = (await response.json()) as { id: number }
  await expect(items).toHaveCount(before + 1)
  const card = items.last().getByRole('article', { name: 'Antwort' })
  await expect(card).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
  return { card, id }
}

/** "Stufe damals" of a log entry (M16.2). */
const levelThen = (page: Page) => page.locator('div:has(> dt:text-is("Stufe damals")) > dd')
const decisionThen = (page: Page) => page.locator('div:has(> dt:text-is("Entscheidung")) > dd')

/** The matrix as the entry page writes it: "catalog aus · query aus · …". */
const matrixText = (matrix: Record<string, string>) =>
  ['catalog', 'query', 'spatial', 'derive', 'display']
    .map((c) => `${c} ${{ off: 'aus', approve: 'Freigabe', auto: 'automatisch' }[matrix[c]]}`)
    .join(' · ')

/** Every log entry of the filter, through the admin API, all pages. */
async function entries(request: APIRequestContext, filter: string): Promise<Summary[]> {
  const all: Summary[] = []
  for (;;) {
    const response = await request.get(
      `/api/admin/model-actions?${filter}&limit=200&offset=${all.length}`,
    )
    expect(response.ok(), await response.text()).toBe(true)
    const page = (await response.json()) as { items: Summary[]; total: number }
    all.push(...page.items)
    if (page.items.length === 0 || all.length >= page.total) return all
  }
}

async function keyFigures(request: APIRequestContext, filter: string): Promise<Figures> {
  const response = await request.get(`/api/admin/model-actions/key-figures?${filter}`)
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()) as Figures
}

/** The count a figure of the key-figure row shows, as a number. */
async function shownFigure(page: Page, key: string): Promise<number> {
  const row = page.getByRole('region', { name: 'Kennzahlen' })
  const cell = row.locator(`[data-figure="${key}"] dd`)
  if ((await cell.count()) === 0) return 0 // shown only when there are any
  const text = (await cell.locator('span').first().textContent()) ?? ''
  return Number(text.replace(/\D/g, ''))
}

test.describe('E2.4 against the model stub', { tag: '@stub' }, () => {
  test.skip(
    !STUB || !CONTROL,
    'E2E_STUB_URL and E2E_STUB_CONTROL name the model stub (scripts/gate.sh)',
  )
  test.describe.configure({ mode: 'serial', timeout: 120_000 })

  // Shared by the tests, in order: the analyst's workplace keeps its dialogue.
  let original: StoredLevel[] = []
  let ids: Record<string, number> = {}
  let connection = 0
  let filter = ''
  let before: Figures
  let analyst: BrowserContext
  let workplace: Page
  const records: Record<string, number> = {}

  test.beforeAll(async ({ browser, request }) => {
    original = await levels(request)
    const set = await putLevels(request, fixtureLevels(original))
    ids = Object.fromEntries(set.map((l) => [l.name, l.id!]))
    await ensureAreaLayer(request)
    connection = await connectionId(request)
    filter = `connection_id=${connection}`
    // The connection's id may be one a deleted connection had (an earlier pass):
    // what changes is measured from here.
    before = await keyFigures(request, filter)
    await ensureAccount(request, browser, ANALYST, 'admin')
    await ensureAccount(request, browser, USER, 'user')
    ;[analyst, workplace] = await user(browser, ANALYST)
    await choose(analyst, { connection_id: connection })
  })

  test.afterAll(async ({ request }) => {
    await analyst?.close()
    // The shipped set back; a level of it deleted meanwhile comes back as new.
    const now = new Set((await levels(request)).map((l) => l.id))
    if (original.length > 0)
      await putLevels(
        request,
        original.map((l) => (now.has(l.id) ? l : { ...l, id: undefined })),
      )
    await removeConnection(request)
  })

  test('Assistenz: a proposal only, applied by hand; no approval, no preview', async () => {
    const page = workplace
    await page.goto('/')
    // An analysis to watch: the schools, all 137 of them.
    await page.getByRole('button', { name: 'Layer', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
    await picker
      .getByRole('checkbox', { name: /^Schulen/ })
      .first()
      .check()
    await picker.getByRole('button', { name: 'Hinzufügen' }).click()
    await expect(hits(page)).toHaveText('137 von 137')
    await chooseLevel(page, 'Assistenz')

    await page.getByRole('tab', { name: 'Prompt' }).click()
    const { card, id } = await ask(page, PROMPT)
    records.assistenz = id
    await expect(card.getByRole('status').first()).toContainText('von Hand übernehmen')
    await expect(card).toContainText('Stufe Assistenz: Das Modell darf hier nur vorschlagen')
    await expect(card.getByRole('button', { name: 'In Editor übernehmen' })).toBeEnabled()
    await expect(card.getByRole('region', { name: 'Freigabe' })).toHaveCount(0)
    await expect(card.getByLabel('Trefferzahl der Vorschau')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Annehmen' })).toHaveCount(0)
    await expect(hits(page)).toHaveText('137 von 137')

    // Past the surface: no preview, no approval, no run for an off class.
    expect(await direct(page, 'GET', `/api/model/actions/${id}/preview`)).toMatchObject({
      code: 'class_not_allowed',
    })
    expect(await direct(page, 'POST', `/api/model/actions/${id}/approve`)).toMatchObject({
      code: 'class_not_allowed',
    })
    expect(await direct(page, 'POST', `/api/model/actions/${id}/execute`)).toEqual({
      status: 409,
      code: 'not_approved',
    })
    const record = await view(analyst, id)
    expect([record.status, record.decision, record.previewed_at]).toEqual(['proposed', null, null])
    expect(record.governance).toEqual({
      classes: ['query', 'spatial'],
      cell: 'off',
      needs_approval: [],
      off: ['query', 'spatial'],
    })
    await expect(hits(page)).toHaveText('137 von 137')
  })

  test('Prüfen: approval with the preview 137 → 10; a direct execute fails; Annehmen, Zurücknehmen', async () => {
    const page = workplace
    await chooseLevel(page, 'Prüfen')
    const { sent, failures } = watchQueries(page)
    const { card, id } = await ask(page, PROMPT)
    records.pruefen = id
    const approval = card.getByRole('region', { name: 'Freigabe' })
    await expect(approval).toBeVisible()
    await expect(approval.getByLabel('Trefferzahl der Vorschau')).toContainText('Treffer: 137 → 10')
    await expect(approval).toContainText(
      'Braucht Freigabe: Attributfilter, Raumfilter (Stufe Prüfen)',
    )
    await expect(approval.getByRole('button', { name: 'Annehmen' })).toBeFocused()
    await expect(card.getByRole('button', { name: 'In Editor übernehmen' })).toHaveCount(0)

    // "Die Regel greift auch an der Oberfläche vorbei": the proposal waits, so
    // the browser's own request to run it is refused and nothing changes.
    expect(await direct(page, 'POST', `/api/model/actions/${id}/execute`)).toEqual({
      status: 409,
      code: 'not_approved',
    })
    await expect(hits(page)).toHaveText('137 von 137')
    let record = await view(analyst, id)
    expect([record.status, record.decision, record.stamp]).toEqual(['proposed', null, null])
    expect(record.previewed_at).not.toBeNull()

    await approval.getByRole('button', { name: 'Annehmen' }).click()
    await expect(hits(page)).toHaveText('10 von 137')
    await expect(card.getByLabel('Trefferzahl der Analyse')).toHaveText('10 von 137')
    // The query that ran and the one the analysis now holds: the hand-built one of E1.
    await expect
      .poll(() => sent.some((q) => isDeepStrictEqual(q, reference)), {
        message: `sent: ${JSON.stringify(sent)}`,
      })
      .toBe(true)
    expect(failures).toEqual([])
    record = await view(analyst, id)
    expect([record.status, record.decision, record.stamp?.count]).toEqual([
      'applied',
      'accepted',
      10,
    ])
    expect(given(record.query)).toEqual(reference)
    // The Assistenz proposal was overtaken without a decision: only a proposal (section 2).
    const assistenz = await view(analyst, records.assistenz)
    expect([assistenz.status, assistenz.decision]).toEqual(['superseded', 'proposal_only'])

    await card.getByRole('button', { name: 'Zurücknehmen' }).click()
    await expect(hits(page)).toHaveText('137 von 137')
    await expect(card).toContainText('vorher: keine Abfrage · 137')
    record = await view(analyst, id)
    expect([record.status, record.decision]).toEqual(['undone', 'accepted'])
    expect(record.undone_at).not.toBeNull()
  })

  test('Automatisch: applied at once with the notice bar; Rückgängig restores the analysis', async () => {
    const page = workplace
    await chooseLevel(page, 'Automatisch')
    const { card, id } = await ask(page, PROMPT)
    records.automatisch = id
    const notice = page.getByRole('complementary', { name: 'Modell hat angewendet' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Modell hat angewendet:')
    await expect(notice).toContainText('10 von 137')
    await expect(hits(page)).toHaveText('10 von 137')
    // Nobody was asked.
    await expect(card.getByRole('region', { name: 'Freigabe' })).toHaveCount(0)
    await expect(card.getByLabel('Trefferzahl der Vorschau')).toHaveCount(0)
    let record = await view(analyst, id)
    expect([record.status, record.decision, record.previewed_at]).toEqual(['applied', 'auto', null])
    expect(given(record.query)).toEqual(reference)

    await notice.getByRole('button', { name: 'Rückgängig' }).click()
    await expect(notice).toHaveCount(0)
    await expect(hits(page)).toHaveText('137 von 137')
    record = await view(analyst, id)
    expect([record.status, record.decision]).toEqual(['undone', 'auto'])
  })

  // Teilautonom has derive on Freigabe and every other class on auto. The stop
  // at derive cannot be reached with a direct query: derive is buffer,
  // attribute_join and aggregate (levels/classify.py), and a direct answer may
  // set only schema_version, source, where and output (model/represent.py,
  // D3); one with a derive part is refused as not_representable before any
  // level is asked. The stop at derive belongs to the chain (E2.5, fixture
  // case chain_reference). What the direct path shows of this level: the
  // reference answer (query + spatial) runs at once, and the level's matrix
  // names derive as Freigabe. The mixed state of M6.3 (class list, "Braucht
  // Freigabe", the strictest cell governs) is shown after the administrator
  // has put spatial on Freigabe too; that change also proves the log keeps
  // the level as it was (next test).
  test('Teilautonom: query and spatial run at once; with spatial on Freigabe the strictest cell stops the answer', async ({
    page: admin,
  }) => {
    const page = workplace
    await chooseLevel(page, 'Teilautonom')
    await page.getByRole('button', { name: 'Was darf das Modell hier?' }).click()
    const matrix = page.getByRole('dialog', { name: 'Was darf das Modell hier?' })
    await expect(matrix.getByRole('row', { name: /Abgeleitete Layer/ })).toContainText('Freigabe')
    await expect(matrix.getByRole('row', { name: /Raumfilter/ })).toContainText('auto')
    await page.keyboard.press('Escape')
    await expect(matrix).toHaveCount(0)

    const first = await ask(page, PROMPT)
    records.teilautonom = first.id
    await expect(page.getByRole('complementary', { name: 'Modell hat angewendet' })).toBeVisible()
    await expect(hits(page)).toHaveText('10 von 137')
    await expect(first.card.getByRole('region', { name: 'Freigabe' })).toHaveCount(0)
    const auto = await view(analyst, first.id)
    expect([auto.status, auto.decision]).toEqual(['applied', 'auto'])
    expect(auto.governance).toEqual({
      classes: ['query', 'spatial'],
      cell: 'auto',
      needs_approval: [],
      off: [],
    })
    expect(auto.level.matrix.derive).toBe('approve')

    // The administrator puts spatial relations on Freigabe for this level.
    await admin.goto('/admin/stufen')
    await admin.getByLabel('Räumliche Beziehungen – Teilautonom').selectOption('approve')
    const saved = admin.waitForResponse(
      (r) => r.url().endsWith('/api/admin/levels') && r.request().method() === 'PUT',
    )
    await admin.getByRole('button', { name: 'Speichern' }).click()
    expect((await saved).ok()).toBe(true)

    // The same prompt again: query is auto, spatial now Freigabe; the strictest wins.
    const mixed = await ask(page, PROMPT)
    records.gemischt = mixed.id
    const approval = mixed.card.getByRole('region', { name: 'Freigabe' })
    await expect(approval).toBeVisible()
    const classes = approval.getByRole('region', { name: 'Klassen dieser Antwort' })
    await expect(classes.getByRole('listitem')).toHaveText([
      'Attributfilter · auto',
      'Raumfilter · Freigabe',
    ])
    await expect(approval).toContainText(
      'Braucht Freigabe: Raumfilter. Die strengste Festlegung gilt für die ganze Antwort.',
    )
    await expect(approval.getByLabel('Trefferzahl der Vorschau')).toContainText('→ 10')
    expect(await direct(page, 'POST', `/api/model/actions/${mixed.id}/execute`)).toEqual({
      status: 409,
      code: 'not_approved',
    })
    const waiting = await view(analyst, mixed.id)
    expect([waiting.status, waiting.governance?.cell, waiting.governance?.needs_approval]).toEqual([
      'proposed',
      'approve',
      ['spatial'],
    ])

    // Declined with a reason (M5.3); the analysis stays as the auto answer left it.
    await approval.getByRole('button', { name: 'Ablehnen', exact: true }).click()
    await approval.getByRole('button', { name: 'falscher Wert' }).click()
    await approval.getByRole('button', { name: 'Ablehnen', exact: true }).click()
    await expect(mixed.card.getByText('Ohne Grund abgelehnt.')).toHaveCount(0)
    await expect(mixed.card).toContainText('falscher Wert')
    await expect(hits(page)).toHaveText('10 von 137')
    const rejected = await view(analyst, mixed.id)
    expect([rejected.status, rejected.decision, rejected.reject_reason]).toEqual([
      'rejected',
      'rejected',
      'wrong_value',
    ])
  })

  test('a user: Automatisch is not open to them; Meine Modellaktionen shows their entries only', async ({
    browser,
    request,
  }) => {
    // The imported tax layer is for administrators until it is released to
    // users; the reference question needs it (else: unknown_layer, as E2.3 shows).
    const visibility = (await (await request.get('/api/admin/visibility')).json()) as {
      layer: string
      roles: { user: boolean }
    }[]
    const wasVisible = visibility.find((r) => r.layer === AREAS)?.roles.user ?? false
    const shown = await request.put('/api/admin/visibility', {
      data: { layer: AREAS, role: 'user', visible: true },
    })
    expect(shown.ok(), await shown.text()).toBe(true)
    const [context, page] = await user(browser, USER)
    try {
      await choose(context, { connection_id: connection, level_id: ids['Prüfen'] })
      // Selectable for administrators only (fixture): the backend refuses it too.
      const refused = await context.request.put('/api/llm/options', {
        data: { level_id: ids['Automatisch'] },
      })
      expect(refused.status()).toBe(400)
      expect((await refused.json()).code).toBe('level_not_available')
      await page.reload()
      await page.getByRole('button', { name: 'Modellunterstützung wählen' }).click()
      await expect(page.getByRole('menuitemradio', { name: /^Prüfen/ })).toBeVisible()
      await expect(page.getByRole('menuitemradio', { name: /^Automatisch/ })).toHaveCount(0)
      await page.keyboard.press('Escape')

      await page.getByRole('tab', { name: 'Prompt' }).click()
      const overtaken = await ask(page, PROMPT)
      await expect(overtaken.card.getByRole('region', { name: 'Freigabe' })).toBeVisible()
      // A new prompt without a decision: the first is superseded (section 2).
      const declined = await ask(page, PROMPT)
      const approval = declined.card.getByRole('region', { name: 'Freigabe' })
      await approval.getByRole('button', { name: 'Ablehnen', exact: true }).click()
      await approval.getByRole('button', { name: 'Ablehnen', exact: true }).click()
      await expect(declined.card).toContainText('Ohne Grund abgelehnt.')
      records.userSuperseded = overtaken.id
      records.userRejected = declined.id
      expect((await view(context, overtaken.id)).decision).toBe('superseded')
      expect((await view(context, declined.id)).decision).toBe('rejected')
      // Another account's record does not exist for this one (D4).
      expect(await direct(page, 'POST', `/api/model/actions/${records.gemischt}/execute`)).toEqual({
        status: 404,
        code: 'not_found',
      })

      const mine = (await (
        await context.request.get('/api/model/my-actions?limit=200')
      ).json()) as {
        items: Summary[]
        total: number
      }
      expect(mine.items.every((e) => e.account === USER)).toBe(true)
      expect(mine.items.map((e) => e.id)).not.toContain(records.gemischt)
      const theirs = await entries(request, `account=${encodeURIComponent(USER)}`)
      expect(mine.total).toBe(theirs.length)

      await page.getByRole('button', { name: 'Benutzermenü' }).click()
      await page.getByRole('menuitem', { name: 'Meine Modellaktionen' }).click()
      const dialog = page.getByRole('dialog', { name: 'Meine Modellaktionen' })
      const rows = dialog.locator('tbody > tr')
      await expect(rows).toHaveCount(Math.min(mine.total, 50))
      await expect(rows.nth(0)).toContainText('abgelehnt')
      await expect(rows.nth(1)).toContainText('übergangen')
      // None of the analyst's entries: the auto one would read "auto angewendet".
      await expect(dialog.getByText('auto angewendet')).toHaveCount(0)
      await expect(dialog.getByText('nur Vorschlag')).toHaveCount(0)
    } finally {
      await request.put('/api/admin/visibility', {
        data: { layer: AREAS, role: 'user', visible: wasVisible },
      })
      await context.close()
    }
  })

  test('the log: each entry with its level as it was, the key figures, the acceptance rate by hand', async ({
    page,
    request,
  }) => {
    const stored = await levels(request)
    const now = Object.fromEntries(stored.map((l) => [l.name, l.matrix]))
    expect(now['Teilautonom'].spatial).toBe('approve') // changed after the first prompt

    await page.goto(`/admin/modellprotokoll?anbindung=${connection}&zeitraum=alle`)
    await expect(page.getByRole('heading', { name: 'Modellprotokoll' })).toBeVisible()
    const row = (id: number) =>
      page.locator('tbody > tr', { has: page.locator(`a[href="/admin/modellprotokoll/${id}"]`) })
    const listed: [string, string, string][] = [
      ['assistenz', 'Assistenz', 'nur Vorschlag'],
      ['pruefen', 'Prüfen', 'angenommen · zurückgenommen'],
      ['automatisch', 'Automatisch', 'auto angewendet · zurückgenommen'],
      ['teilautonom', 'Teilautonom', 'auto angewendet'],
      ['gemischt', 'Teilautonom', 'abgelehnt · falscher Wert'],
    ]
    for (const [key, level, outcome] of listed) {
      await expect(row(records[key])).toContainText(ANALYST)
      await expect(row(records[key]).locator('td').nth(3)).toHaveText(level)
      await expect(row(records[key]).locator('td').nth(5)).toHaveText(outcome)
    }

    // Each entry page: the level's name and matrix as they were when it was asked.
    const fixture = Object.fromEntries(fixtureFile.levels.map((l) => [l.name, l.matrix]))
    const pages: [string, string, Record<string, string>, RegExp][] = [
      ['assistenz', 'Assistenz', fixture['Assistenz'], /nur Vorschlag/],
      ['pruefen', 'Prüfen', fixture['Prüfen'], /angenommen[\s\S]*zurückgenommen[\s\S]*Vorschau/],
      [
        'automatisch',
        'Automatisch',
        fixture['Automatisch'],
        /auto angewendet[\s\S]*zurückgenommen/,
      ],
      ['teilautonom', 'Teilautonom', fixture['Teilautonom'], /auto angewendet/],
      ['gemischt', 'Teilautonom', now['Teilautonom'], /abgelehnt.*falscher Wert/],
    ]
    for (const [key, level, matrix, decision] of pages) {
      await page.goto(`/admin/modellprotokoll/${records[key]}`)
      await expect(levelThen(page)).toContainText(`${level} · ${matrixText(matrix)}`)
      await expect(decisionThen(page)).toContainText(decision)
    }
    // The same level, two matrices: the first Teilautonom entry keeps spatial auto.
    expect(matrixText(fixture['Teilautonom'])).toContain('spatial automatisch')
    expect(matrixText(now['Teilautonom'])).toContain('spatial Freigabe')

    // The key figures moved by exactly what this run decided.
    await page.goto(`/admin/modellprotokoll?anbindung=${connection}&zeitraum=alle`)
    const figures = page.getByRole('region', { name: 'Kennzahlen' })
    await expect(figures).toBeVisible()
    const expected: Record<string, number> = {
      proposals: before.proposals + 7,
      accepted: before.accepted + 1,
      undone_after_approval: before.undone_after_approval + 1,
      adjusted: before.adjusted,
      rejected: before.rejected + 2,
      superseded: before.superseded + 1,
      proposal_only: before.proposal_only + 1,
      auto: before.auto + 2,
      undone: before.undone + 1,
    }
    for (const [key, count] of Object.entries(expected))
      expect(await shownFigure(page, key), key).toBe(count)

    // The acceptance rate by hand, from the entries themselves (plan section 2).
    const all = await entries(request, filter)
    const count = (decision: string) => all.filter((e) => e.decision === decision).length
    const [accepted, adjusted, rejected, superseded] = [
      'accepted',
      'adjusted',
      'rejected',
      'superseded',
    ].map(count)
    expect([accepted, adjusted, rejected, superseded]).toEqual([
      expected.accepted,
      expected.adjusted,
      expected.rejected,
      expected.superseded,
    ])
    const rate = (accepted + adjusted) / (accepted + adjusted + rejected + superseded)
    const api = await keyFigures(request, filter)
    expect(api.acceptance_rate).toBeCloseTo(rate, 4)
    const shown = (await figures.locator('[data-figure="acceptance_rate"] dd').textContent()) ?? ''
    expect(Number(shown.replace(/[^\d]/g, '')), `Annahmequote "${shown}"`).toBe(
      Math.round(rate * 100),
    )
  })
})
