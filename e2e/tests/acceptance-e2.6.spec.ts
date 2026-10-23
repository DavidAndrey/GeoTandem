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

// Acceptance E2.6 (etappen.md 4, docs/plan-e2.3-e2.6.md WP83): "Eine vom
// Modell erzeugte Abfrage lässt sich von Hand weiterbearbeiten und umgekehrt."
//
// The design's demonstration (design/e2/README.md): prompt → answer →
// approval → applied → a value changed by hand in B2 → a follow-up prompt with
// the changed state as its reference (M1.1 → M2.1 → M5.1 → M2.2 → M15.1 →
// M15.2 → M11.2), at the level Prüfen; then ambiguity (assumptions, a
// clarification answered by an option, M12.2), the offer of the other
// approach (M13.1, D6), model errors that leave the workplace as it was
// (F-5.17, F-5.18, WP82), a stale answer (M11.3) and the dialogue gone after a
// reload (D8).
//
// Against the model stub (e2e/model-stub; its environment as in
// acceptance-e2.3.spec.ts). The fixture's follow-up cases share their prompt,
// and by prompt alone the stub answers the first (500 m), so the
// demonstration's connection forces a case of its own that this spec adds to
// the stub (PUT /_cases/<id>, the stub's doc): the reference answer to a
// fresh question, and to a request that goes on from an earlier answer (a
// follow-up, P6: the stub's ``replan``) the fixture's follow_up_hand_edited
// answer (300 m and more than one site). The clarification's connection does
// the same for its reply.
//
// Hits on the sample data (the stub never counts; the engine does):
//   reference question, ≤ 500 m          10 von 137 (fixture ``reference``)
//   the same with ≤ 300 m, by hand         4 von 137
//   300 m and standorte > 1 (follow-up)    3 von 137
//   schools ≤ 500 m from a stop          125 von 137 (the clarification's reply)

const STUB = process.env.E2E_STUB_URL
const CONTROL = process.env.E2E_STUB_CONTROL
const MODEL = 'stub-model'

const ANALYST = 'e2e.abnahme.e26'
const AREAS = 'gemeinden_steuern'
/** A copy of the tax layer that the stale test deletes; the shared one stays. */
const COPY = 'e26_steuern'
const SESSION = 'E26 ohne Dialog'

const DEMO_CASE = 'e26_demo'
const ASK_CASE = 'e26_rueckfrage'
const STALE_CASE = 'e26_veraltet'

const DEMO = 'E26 Vorführung'
const DIRECT = 'E26 direkt'
const ASK = 'E26 Rückfrage'
const STALE = 'E26 veraltet'
const UNREACHABLE = 'E26 unerreichbar'
const SLOW = 'E26 langsam'
const UNREADABLE = 'E26 unlesbar'

interface FixtureCase {
  id: string
  prompt: string
  answer?: Record<string, unknown> & { query?: unknown }
  analysis?: unknown
}
const fixtureFile = JSON.parse(
  readFileSync(new URL('../../schema/model-cases/v1.json', import.meta.url), 'utf-8'),
) as { cases: FixtureCase[] }
const fixture = (id: string) => fixtureFile.cases.find((c) => c.id === id)!
const PROMPT = fixture('reference').prompt
const FOLLOW_UP = fixture('follow_up_hand_edited').prompt

/** The stub with every request answered by case ``id`` (the stub's doc). */
const caseUrl = (id: string) => STUB!.replace(/\/v1\/?$/, `/case/${id}/v1`)

/** The scripted cases: a first answer, and the answer to what follows it. */
const CASES: Record<string, object> = {
  [DEMO_CASE]: {
    approach: 'direct',
    prompt: PROMPT,
    answer: fixture('reference').answer,
    replan: fixture('follow_up_hand_edited').answer,
  },
  [ASK_CASE]: {
    approach: 'direct',
    prompt: fixture('clarification').prompt,
    answer: fixture('clarification').answer,
    replan: {
      kind: 'query',
      explanation: 'Ich suche Schulen, die höchstens 500 m von einer Haltestelle entfernt liegen.',
      assumptions: [{ text: '„Schulen“ = alle Schulstufen' }],
      query: {
        schema_version: '2',
        source: 'schulen',
        output: 'map',
        where: { op: 'related', layer: 'haltestellen', predicate: 'dwithin', distance_m: 500 },
      },
    },
  },
  // The reference answer on the copy of the tax layer.
  [STALE_CASE]: {
    approach: 'direct',
    prompt: PROMPT,
    answer: JSON.parse(JSON.stringify(fixture('reference').answer).replaceAll(AREAS, COPY)),
  },
}

const CONNECTIONS: [string, () => string, number][] = [
  [DEMO, () => caseUrl(DEMO_CASE), 120],
  [DIRECT, () => STUB!, 120],
  [ASK, () => caseUrl(ASK_CASE), 120],
  [STALE, () => caseUrl(STALE_CASE), 120],
  [UNREACHABLE, () => caseUrl('unreachable'), 120],
  // The stub holds the slow answer for 30 s; this connection waits 2 (llm_timeout).
  [SLOW, () => caseUrl('timeout'), 2],
  [UNREADABLE, () => caseUrl('unreadable'), 120],
]

interface Connection {
  id: number
  name: string
  is_default: boolean
}

interface View {
  id: number
  status: string
  decision: string | null
  parent_action_id: number | null
  reference: string
  touched_at: string | null
  query: unknown
  error: { code: string } | null
}

interface Sent {
  text: string
  approach: string
  parent_action_id?: number | null
  analysis?: unknown
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

async function connections(request: APIRequestContext) {
  return (await (await request.get('/api/admin/llm/connections')).json()) as Connection[]
}

async function ensureConnections(request: APIRequestContext): Promise<Record<string, number>> {
  const ids: Record<string, number> = {}
  const all = await connections(request)
  for (const [name, url, timeout_s] of CONNECTIONS) {
    const found = all.find((c) => c.name === name)
    if (found) {
      ids[name] = found.id
      continue
    }
    const made = await request.post('/api/admin/llm/connections', {
      data: { name, base_url: url(), model: MODEL, enabled: true, timeout_s },
    })
    expect(made.ok(), await made.text()).toBe(true)
    ids[name] = ((await made.json()) as Connection).id
  }
  return ids
}

/** Deletes ours, the default last: it may go only once no other is enabled (C18). */
async function removeConnections(request: APIRequestContext) {
  const names = CONNECTIONS.map(([name]) => name)
  const doomed = (await connections(request))
    .filter((c) => names.includes(c.name))
    .sort((a, b) => Number(a.is_default) - Number(b.is_default))
  for (const c of doomed) {
    const gone = await request.delete(`/api/admin/llm/connections/${c.id}`)
    expect(gone.ok(), `${c.name}: ${gone.status()} ${await gone.text()}`).toBe(true)
  }
}

/** The level whose classes all need approval: Prüfen, as shipped and in the fixture. */
async function checkingLevel(request: APIRequestContext): Promise<number> {
  const { levels } = (await (await request.get('/api/admin/levels')).json()) as {
    levels: { id: number; name: string; matrix: Record<string, string> }[]
  }
  const level = levels.find((l) => Object.values(l.matrix).every((m) => m === 'approve'))
  expect(level?.name).toBe('Prüfen')
  return level!.id
}

async function view(context: BrowserContext, id: number): Promise<View> {
  const response = await context.request.get(`/api/model/actions/${id}`)
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()) as View
}

// --- what reached the model (the stub's request log) --------------------------

interface Logged {
  path: string
  body: {
    messages?: { role: string; content: unknown }[]
    tools?: unknown[]
    response_format?: { json_schema?: { schema?: Record<string, unknown> } }
  }
}

/** The model calls made through the connection to ``base``; a connection test's probes left out. */
async function callsTo(base: string): Promise<Logged[]> {
  const log = await fetch(`${CONTROL}/_requests`)
  expect(log.ok).toBe(true)
  const path = new URL(base).pathname
  return ((await log.json()) as Logged[]).filter(
    (r) =>
      r.path.startsWith(`${path}/`) &&
      !r.body.tools &&
      JSON.stringify(r.body.response_format?.json_schema?.schema?.required) !== '["result"]',
  )
}

const said = (content: unknown) => (typeof content === 'string' ? content : JSON.stringify(content))

const messagesOf = (call: Logged) =>
  (call.body.messages ?? []).map((m) => ({ role: m.role, text: said(m.content) }))

/** The current analysis a follow-up's last turn carries (prompt.py ``_user``). */
function analysisIn(text: string): unknown {
  const found = /Aktuelle Analyse als Abfrageobjekt:\n([^\n]+)/.exec(text)
  expect(found, text).not.toBeNull()
  return JSON.parse(found![1])
}

// --- the workplace --------------------------------------------------------------

const hits = (page: Page) => page.getByLabel('Trefferzahl', { exact: true })
const panelOf = (page: Page) => page.getByRole('region', { name: 'Prompt', exact: true })
const fieldOf = (page: Page) => panelOf(page).getByRole('textbox', { name: 'Prompt' })
const itemsOf = (page: Page) =>
  panelOf(page).getByRole('list', { name: 'Verlauf' }).locator(':scope > li')
/** The reference mark above the field (M11.1, M11.2). */
const markOf = (page: Page) => panelOf(page).getByText(/^Bezug:/)

/** The analyst signed in, with the connection and Prüfen chosen, the prompt panel open. */
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
  await expect(page.getByRole('button', { name: 'Modellunterstützung wählen' })).toContainText(
    'Stufe: Prüfen',
  )
  await page.getByRole('tab', { name: 'Prompt' }).click()
  await expect(panelOf(page)).toBeVisible()
  return [context, page]
}

/**
 * Sends ``text`` from the field: the answer card once the model has answered,
 * the record's id and what the page sent. ``status`` is the prompt route's
 * answer: 202, or the code of a request refused before any record.
 */
async function ask(
  page: Page,
  text: string,
  status = 202,
): Promise<{ card: Locator; id: number; sent: Sent; body: Record<string, unknown> }> {
  const items = itemsOf(page)
  const before = await items.count()
  await fieldOf(page).fill(text)
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/model/prompt'),
  )
  await panelOf(page).getByRole('button', { name: /Senden/ }).click()
  const response = await posted
  expect(response.status(), await response.text()).toBe(status)
  const body = (await response.json()) as Record<string, unknown>
  await expect(items).toHaveCount(before + 1)
  const card = items.last().getByRole('article', { name: 'Antwort' })
  await expect(card).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
  return { card, id: body.id as number, sent: response.request().postDataJSON() as Sent, body }
}

/** Annehmen in the approval (M5.1), after the preview has counted ``preview``. */
async function approve(card: Locator, preview: string) {
  const approval = card.getByRole('region', { name: 'Freigabe' })
  await expect(approval.getByLabel('Trefferzahl der Vorschau')).toContainText(preview)
  await approval.getByRole('button', { name: 'Annehmen' }).click()
}

/** A connection chosen in the header's menu (M7.2), the dialogue left as it is. */
async function chooseConnection(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Modellunterstützung wählen' })
  await menu.click()
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/llm/options') && r.request().method() === 'PUT',
  )
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click()
  expect((await saved).ok()).toBe(true)
  await expect(menu).toContainText(name)
}

/** The reference question asked and approved: 10 von 137 (M1.1 → M2.1 → M5.1 → M2.2). */
async function applyReference(context: BrowserContext, page: Page) {
  const first = await ask(page, PROMPT)
  await approve(first.card, 'Treffer: 137 → 10')
  await expect(hits(page)).toHaveText('10 von 137')
  await expect(first.card.getByLabel('Trefferzahl der Analyse')).toHaveText('10 von 137')
  await expect
    .poll(async () => {
      const record = await view(context, first.id)
      return [record.status, record.decision]
    })
    .toEqual(['applied', 'accepted'])
  return first
}

test.describe('E2.6 against the model stub', { tag: '@stub' }, () => {
  test.skip(!STUB || !CONTROL, 'E2E_STUB_URL and E2E_STUB_CONTROL name the model stub (scripts/gate.sh)')
  test.describe.configure({ timeout: 120_000 })

  let ids: Record<string, number> = {}
  let level = 0

  test.beforeAll(async ({ browser, request }) => {
    for (const [id, scripted] of Object.entries(CASES)) {
      const put = await fetch(`${CONTROL}/_cases/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scripted),
      })
      expect(put.status, id).toBe(204)
    }
    await ensureAreaLayer(request)
    ids = await ensureConnections(request)
    level = await checkingLevel(request)
    await ensureAccount(request, browser, ANALYST, 'admin')
  })

  test.afterAll(async ({ request }) => {
    await removeConnections(request)
    await request.delete(`/api/admin/layers/${COPY}`)
  })

  test('Vorführung: answer, approval, applied, 500 → 300 m in B2, a follow-up on the changed state', async ({
    browser,
  }) => {
    const [context, page] = await workplace(browser, ids[DEMO], level)
    const { sent: ran, failures } = watchQueries(page)
    const calls = (await callsTo(caseUrl(DEMO_CASE))).length

    // M1.1: a fresh question, nothing to refer to yet.
    await expect(markOf(page)).toHaveCount(0)
    const first = await applyReference(context, page)
    expect(first.sent.parent_action_id ?? null).toBeNull()
    expect(first.sent.analysis ?? null).toBeNull()
    const assumptions = first.card.getByRole('region', { name: 'Annahmen' })
    await expect(assumptions.getByRole('listitem')).toHaveCount(3)
    await expect(assumptions).toContainText('„nahe“ = höchstens 500 m')
    // M11.1: the next prompt follows the answer, with the analysis's hits.
    await expect(markOf(page)).toContainText('Bezug: letzte Antwort · 10 von 137')

    // M15.1: "Im Editor öffnen" switches to Klassik and opens B2, every
    // condition the model set marked "Modell".
    await first.card.getByRole('button', { name: 'Im Editor öffnen' }).click()
    await expect(page.getByRole('tab', { name: 'Klassik' })).toHaveAttribute('aria-selected', 'true')
    const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
    const marks = editor.getByTitle(/^Vom Modell gesetzt/)
    await expect(marks).toHaveCount(3)
    const road = editor.getByRole('group', { name: 'Bedingung Raum' }).first()
    const distance = road.getByLabel('Distanz in Metern')
    await expect(distance).toHaveValue('500')
    await expect(road.getByTitle(/^Vom Modell gesetzt/)).toHaveCount(1)

    // M15.2: 500 → 300 m by hand clears that row's mark only.
    await distance.fill('300')
    await expect(road.getByTitle(/^Vom Modell gesetzt/)).toHaveCount(0)
    await expect(marks).toHaveCount(2)
    await editor.getByRole('button', { name: 'Übernehmen' }).click()
    await expect(hits(page)).toHaveText('4 von 137')
    // Applied, the overview keeps the marks of the two rows the hand left alone.
    const overview = page.getByLabel('Bedingungen (Übersicht)')
    await expect(overview.getByTitle(/^Vom Modell gesetzt/)).toHaveCount(2)
    const edited = overview.getByRole('listitem').filter({ hasText: '≤ 300 m zu Strassen' })
    await expect(edited).toHaveCount(1)
    await expect(edited.getByTitle(/^Vom Modell gesetzt/)).toHaveCount(0)

    // M11.2: back in the panel, the reference is the analysis as changed by hand.
    await page.getByRole('tab', { name: 'Prompt' }).click()
    await expect(markOf(page)).toContainText('Bezug: aktuelle Analyse · 4 von 137')
    // The hand edit ends the undo of the model's change (WP70), and is reported.
    await expect(first.card).toContainText(
      'Seit der Modelländerung von Hand geändert. Bitte im Editor zurücksetzen.',
    )
    await expect(first.card.getByRole('button', { name: 'Zurücknehmen' })).toBeDisabled()
    await expect.poll(async () => (await view(context, first.id)).touched_at).not.toBeNull()

    // The follow-up: the page sends the parent and the current analysis, no turns (P6).
    const follow = await ask(page, FOLLOW_UP)
    expect(follow.sent.parent_action_id).toBe(first.id)
    expect(given(follow.sent.analysis)).toEqual(given(fixture('follow_up_hand_edited').analysis))
    expect(Object.keys(follow.sent).sort()).toEqual(['analysis', 'approach', 'parent_action_id', 'text'])
    const record = await view(context, follow.id)
    expect([record.parent_action_id, record.reference]).toEqual([first.id, 'hand_edited'])
    expect(record.status).toBe('proposed')

    // What the model got: the earlier turn built from the record, then the
    // analysis with 300 m and the word that it was changed by hand.
    const made = (await callsTo(caseUrl(DEMO_CASE))).slice(calls)
    expect(made).toHaveLength(2)
    const messages = messagesOf(made[1])
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(messages[1].text).toBe(PROMPT)
    expect(messages[2].text).toContain(String(fixture('reference').answer!.explanation))
    const last = messages[3].text
    expect(last.endsWith(`Frage: ${FOLLOW_UP}`)).toBe(true)
    expect(last).toContain('Der Anwender hat sie von Hand geändert')
    const sentAnalysis = analysisIn(last)
    expect(given(sentAnalysis)).toEqual(given(fixture('follow_up_hand_edited').analysis))
    expect(JSON.stringify(sentAnalysis)).toContain('"distance_m":300')
    expect(JSON.stringify(sentAnalysis)).not.toContain('"distance_m":500')

    // The model's answer builds on 300 m; approved, it gives 3 von 137.
    await approve(follow.card, 'Treffer: 4 → 3')
    await expect(hits(page)).toHaveText('3 von 137')
    await expect.poll(async () => (await view(context, follow.id)).decision).toBe('accepted')
    // The earlier answer folds into one line with its status (M11.1).
    await expect(itemsOf(page).first()).toContainText('angewendet')
    await expect(markOf(page)).toContainText('Bezug: letzte Antwort · 3 von 137')

    // × asks without the reference: no parent, no analysis, a fresh question.
    await panelOf(page).getByRole('button', { name: 'Ohne Bezug fragen' }).click()
    await expect(markOf(page)).toHaveCount(0)
    const fresh = await ask(page, PROMPT)
    expect(fresh.sent.parent_action_id ?? null).toBeNull()
    expect(fresh.sent.analysis ?? null).toBeNull()
    const freshRecord = await view(context, fresh.id)
    expect([freshRecord.parent_action_id, freshRecord.reference]).toEqual([null, 'none'])
    const freshCall = (await callsTo(caseUrl(DEMO_CASE))).slice(calls).at(-1)!
    expect(messagesOf(freshCall).map((m) => m.role)).toEqual(['system', 'user'])
    // Left waiting for approval: the analysis is still the follow-up's.
    await expect(hits(page)).toHaveText('3 von 137')
    expect(failures).toEqual([])
    expect(ran.length).toBeGreaterThan(0)
    await context.close()
  })

  test('ambiguity: assumptions stated; a clarification answered by an option follows it (M12.2)', async ({
    browser,
  }) => {
    const [context, page] = await workplace(browser, ids[ASK], level)
    const calls = (await callsTo(caseUrl(ASK_CASE))).length
    const question = await ask(page, fixture('clarification').prompt)
    await expect(question.card).toContainText('Rückfrage')
    await expect(question.card).toContainText('Wie nahe ist „in der Nähe“?')
    await expect(question.card).toContainText('Analyse unverändert')
    const options = question.card.getByRole('group', { name: 'Antworten' })
    await expect(options.getByRole('button')).toHaveText(['250 m', '500 m', '1 km', 'anderes …'])
    // Nothing applied, nothing proposed: the analysis is untouched.
    await expect(hits(page)).toHaveCount(0)
    const asked = await view(context, question.id)
    expect([asked.status, asked.query]).toEqual(['answered', null])
    await expect(panelOf(page).getByText('Ihre Eingabe beantwortet die Rückfrage.')).toBeVisible()

    // An option is sent at once as the answer to that question (its record the parent).
    const items = itemsOf(page)
    const posted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/model/prompt'),
    )
    await options.getByRole('button', { name: '500 m' }).click()
    const response = await posted
    expect(response.status(), await response.text()).toBe(202)
    const sent = response.request().postDataJSON() as Sent
    expect([sent.text, sent.parent_action_id]).toEqual(['500 m', question.id])
    const replyId = ((await response.json()) as { id: number }).id
    await expect(items).toHaveCount(2)
    const reply = items.last().getByRole('article', { name: 'Antwort' })
    await expect(reply).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
    const record = await view(context, replyId)
    expect([record.parent_action_id, record.status]).toEqual([question.id, 'proposed'])

    // The model got its own question back as the turn before the answer.
    const made = (await callsTo(caseUrl(ASK_CASE))).slice(calls)
    expect(made).toHaveLength(2)
    const messages = messagesOf(made[1])
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(messages[2].text).toContain('Wie nahe ist „in der Nähe“? (250 m · 500 m · 1 km)')
    // No analysis to send (nothing applied): the reply alone, as the user gave it.
    expect(messages[3].text).toBe('500 m')

    // The answer states what it assumed (F-5.12), and waits for approval.
    const assumptions = reply.getByRole('region', { name: 'Annahmen' })
    await expect(assumptions).toContainText('Annahmen · 1')
    await expect(assumptions).toContainText('„Schulen“ = alle Schulstufen')
    await approve(reply, 'Treffer: 137 → 125')
    await expect(hits(page)).toHaveText('125 von 137')
    await expect(itemsOf(page).first()).toContainText('Rückfrage')
    await context.close()
  })

  test('the wrong approach: the offer switches to Werkzeugkette and fills the field, never sends (M13.1)', async ({
    browser,
  }) => {
    const [context, page] = await workplace(browser, ids[DIRECT], level)
    const prompt = fixture('other_approach').prompt
    const { card, id } = await ask(page, prompt)
    await expect(card).toContainText('Arbeitsweise passt nicht')
    await expect(card).toContainText(String(fixture('other_approach').answer!.explanation))
    expect((await view(context, id)).status).toBe('answered')
    await expect(fieldOf(page)).toHaveValue('')
    const chain = panelOf(page).getByRole('radio', { name: 'Werkzeugkette' })
    await expect(chain).toHaveAttribute('aria-checked', 'false')

    let posts = 0
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/model/prompt')) posts++
    })
    await card.getByRole('button', { name: 'Mit Werkzeugkette versuchen' }).click()
    await expect(chain).toHaveAttribute('aria-checked', 'true')
    await expect(panelOf(page).getByRole('radio', { name: 'Direktabfrage' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(fieldOf(page)).toHaveValue(prompt)
    await expect(panelOf(page).getByRole('button', { name: /Senden/ })).toBeEnabled()
    // Nothing went out: one answer in the dialogue, no request (D6).
    await page.waitForTimeout(1_000)
    expect(posts).toBe(0)
    await expect(itemsOf(page)).toHaveCount(1)
    await expect(hits(page)).toHaveCount(0)
    await context.close()
  })

  test('model errors: unreachable, too slow, unreadable leave the analysis, the dialogue and the prompt', async ({
    browser,
  }) => {
    const [context, page] = await workplace(browser, ids[DEMO], level)
    const first = await applyReference(context, page)
    const mark = 'Bezug: letzte Antwort · 10 von 137'
    await expect(markOf(page)).toContainText(mark)

    const failures: [string, string, string][] = [
      [UNREACHABLE, 'Modell nicht erreichbar', 'llm_unreachable'],
      [SLOW, 'Zeitüberschreitung', 'llm_timeout'],
      [UNREADABLE, 'Antwort nicht lesbar', 'model_unreadable'],
    ]
    for (const [connection, title, code] of failures) {
      await chooseConnection(page, connection)
      const { card, id, sent } = await ask(page, FOLLOW_UP)
      // A follow-up of the applied answer, which stays the reference.
      expect(sent.parent_action_id).toBe(first.id)
      const alert = card.getByRole('alert')
      await expect(alert).toContainText(title)
      await expect(alert).toContainText('Ihr Stand ist unverändert.')
      await expect(fieldOf(page), connection).toHaveValue(FOLLOW_UP)
      await expect(hits(page)).toHaveText('10 von 137')
      await expect(markOf(page)).toContainText(mark)
      await expect(itemsOf(page).first()).toContainText('angewendet')
      const record = await view(context, id)
      expect([record.status, record.error?.code, record.parent_action_id]).toEqual([
        'failed',
        code,
        first.id,
      ])
    }
    // The applied answer is as it was: applied, accepted, not touched.
    const kept = await view(context, first.id)
    expect([kept.status, kept.decision, kept.touched_at]).toEqual(['applied', 'accepted', null])
    expect(given(kept.query)).toEqual(reference)
    await context.close()
  })

  test('a stale answer: its layer gone, a follow-up is refused, the answer marked veraltet (M11.3)', async ({
    browser,
    request,
  }) => {
    await request.delete(`/api/admin/layers/${COPY}`)
    const copied = await request.post(`/api/admin/layers/${AREAS}/duplicate`, {
      data: { name: COPY, title: 'E26 Steuern' },
    })
    expect(copied.status(), await copied.text()).toBe(201)
    try {
      const [context, page] = await workplace(browser, ids[STALE], level)
      const first = await applyReference(context, page)
      await expect(markOf(page)).toContainText('Bezug: letzte Antwort · 10 von 137')
      const calls = (await callsTo(caseUrl(STALE_CASE))).length

      // The administrator deletes the layer the answer relies on.
      const deleted = await request.delete(`/api/admin/layers/${COPY}`)
      expect(deleted.status()).toBe(204)

      // Not yet known to the page: the follow-up goes out and is refused before
      // any model call; analysis, dialogue and prompt stay.
      const refused = await ask(page, FOLLOW_UP, 409)
      expect(refused.body.code).toBe('stale_reference')
      expect(refused.sent.parent_action_id).toBe(first.id)
      await expect(refused.card.getByRole('alert')).toContainText(
        `Die frühere Antwort nutzt den Layer „${COPY}", den es nicht mehr gibt.`,
      )
      await expect(fieldOf(page)).toHaveValue(FOLLOW_UP)
      await expect(hits(page)).toHaveText('10 von 137')
      expect(await callsTo(caseUrl(STALE_CASE))).toHaveLength(calls)

      // Past the surface: the browser's own request is refused the same way.
      const direct = await page.evaluate(
        async ([parent, analysis]) => {
          const response = await fetch('/api/model/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Und dann?', parent_action_id: parent, analysis }),
          })
          return { status: response.status, code: ((await response.json()) as { code?: string }).code }
        },
        [first.id, (await view(context, first.id)).query] as const,
      )
      expect(direct).toEqual({ status: 409, code: 'stale_reference' })

      // Once the catalog is read again (here: the layer picker), the answer says so
      // and is no reference any more.
      await page.getByRole('tab', { name: 'Klassik' }).click()
      await page.getByRole('button', { name: 'Layer', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
      await expect(picker.getByRole('checkbox', { name: /^Schulen/ }).first()).toBeVisible()
      await expect(picker.getByRole('checkbox', { name: /^E26 Steuern/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.getByRole('tab', { name: 'Prompt' }).click()
      const stale = itemsOf(page).first()
      await expect(stale).toContainText('veraltet')
      await expect(markOf(page)).toHaveCount(0)
      // The dialogue as it was: the stale answer and, below it, the refused follow-up.
      await expect(itemsOf(page)).toHaveCount(2)
      await context.close()
    } finally {
      await request.delete(`/api/admin/layers/${COPY}`)
    }
  })

  test('the dialogue is not saved: after saving and a reload the analysis is back, the dialogue is not (D8)', async ({
    browser,
  }) => {
    const [context, page] = await workplace(browser, ids[DEMO], level)
    const sessions = async () =>
      (await (await context.request.get('/api/sessions')).json()) as { id: string; name: string }[]
    for (const s of (await sessions()).filter((s) => s.name === SESSION))
      await context.request.delete(`/api/sessions/${s.id}`)
    // Signed in, the workplace may have landed in a session: start empty.
    await page.goto('/')
    await page.getByRole('tab', { name: 'Prompt' }).click()
    let saved: string | undefined
    try {
      const first = await applyReference(context, page)
      await expect(itemsOf(page)).toHaveCount(1)
      await expect(markOf(page)).toBeVisible()

      await page.keyboard.press('Control+s')
      const dialog = page.getByRole('dialog', { name: 'Sitzung speichern' })
      await dialog.getByLabel('Name').fill(SESSION)
      await dialog.getByRole('button', { name: 'Speichern' }).click()
      await expect(page).toHaveURL(/\/sitzung\//)
      saved = (await sessions()).find((s) => s.name === SESSION)?.id
      expect(saved).toBeDefined()
      // Nothing of the dialogue in what was stored.
      const stored = JSON.stringify(await (await context.request.get(`/api/sessions/${saved}`)).json())
      expect(stored).not.toContain(PROMPT)
      expect(stored).not.toContain(String(fixture('reference').answer!.explanation))

      await page.reload()
      await expect(hits(page)).toHaveText('10 von 137')
      await page.getByRole('tab', { name: 'Prompt' }).click()
      await expect(panelOf(page)).toBeVisible()
      await expect(panelOf(page).getByRole('list', { name: 'Verlauf' })).toHaveCount(0)
      await expect(markOf(page)).toHaveCount(0)
      await expect(fieldOf(page)).toHaveValue('')

      // The next prompt is a fresh question: no reference survived.
      const again = await ask(page, PROMPT)
      expect(again.sent.parent_action_id ?? null).toBeNull()
      const record = await view(context, again.id)
      expect([record.parent_action_id, record.reference]).toEqual([null, 'none'])
      // The earlier answer is in the log (D4), only the dialogue is gone.
      expect((await view(context, first.id)).status).toBe('applied')
    } finally {
      if (saved) await context.request.delete(`/api/sessions/${saved}`)
      await context.close()
    }
  })
})
