import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from './test'
import { ensureAccount, signIn } from './accounts'
import { ensureAreaLayer, reference, watchQueries } from './reference'

// Acceptance E2.3 (etappen.md 4, docs/plan-e2.3-e2.6.md WP69): "Ein Prompt
// erzeugt dasselbe Abfrageobjekt, das in E1 von Hand gebaut wurde; kein
// Schreibvorgang passiert auf diesem Weg."
//
// Against the model stub (e2e/model-stub), scripted from the contract fixture
// schema/model-cases/v1.json; the connections are made the way an
// administrator makes them. scripts/gate.sh starts the stub on the internal
// network beside the container and sets:
//   E2E_STUB_URL           the stub under a host listed as local
//   E2E_STUB_EXTERNAL_URL  the same stub under a host that is not (F-9.4)
//   E2E_STUB_CONTROL       the stub as this test reaches it (its request log)
//   E2E_OFFLINE=1          the container has no route out (the offline proof)
// Without them the tests skip. A connection whose address ends in
// /case/<id>/v1 gets the fixture case <id> for every prompt (the stub's doc).
//
// P1: in E2.3 every level only proposed; the user applied by hand. Since E2.4
// that is the behaviour of a level whose classes are off (D1), which the
// reference test chooses; the other levels are acceptance-e2.4.spec.ts's.

const STUB = process.env.E2E_STUB_URL
const EXTERNAL = process.env.E2E_STUB_EXTERNAL_URL
const CONTROL = process.env.E2E_STUB_CONTROL
const MODEL = 'stub-model'

// Fixed names: a test after a failed one runs in a fresh worker and finds them.
const LOCAL = 'Stub lokal'
const EXTERN = 'Stub extern'
const UNREACHABLE = 'Stub unerreichbar'
const SLOW = 'Stub langsam'
const OURS = [LOCAL, EXTERN, UNREACHABLE, SLOW]

const ANALYST = 'e2e.abnahme.e23'
const USER = 'm.keller'

interface Case {
  id: string
  prompt: string
  answer?: { explanation?: string; query?: unknown }
}
const cases = (
  JSON.parse(
    readFileSync(new URL('../../schema/model-cases/v1.json', import.meta.url), 'utf-8'),
  ) as { cases: Case[] }
).cases
const fixture = (id: string) => cases.find((c) => c.id === id)!

interface Connection {
  id: number
  name: string
  is_default: boolean
}

/** The stub with every prompt answered by fixture case ``id``. */
const caseUrl = (id: string) => STUB!.replace(/\/v1\/?$/, `/case/${id}/v1`)

async function connections(request: APIRequestContext) {
  return (await (await request.get('/api/admin/llm/connections')).json()) as Connection[]
}

/** The connection's id; made through the API, released for users, if it is missing. */
async function connectionId(
  request: APIRequestContext,
  name: string,
  base_url: string,
  timeout_s = 120,
): Promise<number> {
  const found = (await connections(request)).find((c) => c.name === name)
  if (found) return found.id
  const made = await request.post('/api/admin/llm/connections', {
    data: { name, base_url, model: MODEL, enabled: true, timeout_s },
  })
  expect(made.ok(), await made.text()).toBe(true)
  return ((await made.json()) as Connection).id
}

/** Deletes these connections, the default last: it may go only once no other is enabled (C18). */
async function removeConnections(request: APIRequestContext, names: string[]) {
  const doomed = (await connections(request))
    .filter((c) => names.includes(c.name))
    .sort((a, b) => Number(a.is_default) - Number(b.is_default))
  for (const c of doomed) await request.delete(`/api/admin/llm/connections/${c.id}`)
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

/** Signed in through the login page, the workplace shown (so the session cookie is set). */
async function user(browser: Browser, username: string): Promise<[BrowserContext, Page]> {
  const [context, page] = await signIn(browser, username)
  await expect(page.getByRole('tab', { name: 'Klassik' })).toBeVisible()
  return [context, page]
}

async function choose(context: BrowserContext, connection: number) {
  const chosen = await context.request.put('/api/llm/options', {
    data: { connection_id: connection },
  })
  expect(chosen.ok(), await chosen.text()).toBe(true)
}

/** Creates a connection in the admin page, released for users. */
async function createInUi(page: Page, name: string, url: string) {
  await page.goto('/admin/modelle')
  await page.getByRole('button', { name: 'Anbindung', exact: true }).click()
  const form = page.getByRole('form', { name: 'Neue Anbindung' })
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Adresse').fill(url)
  await form.getByLabel('Modell').fill(MODEL)
  await form.getByLabel('Für Anwender freigegeben').check()
  await form.getByRole('button', { name: 'Speichern' }).click()
  return page.getByRole('row', { name: new RegExp(name) })
}

/** A user's workplace with the prompt panel open. */
async function openPanel(page: Page) {
  await page.goto('/')
  await page.getByRole('tab', { name: 'Prompt' }).click()
  return page.getByRole('region', { name: 'Prompt', exact: true })
}

/** Sends ``text``; the answer card once the model has answered, and the record's id. */
async function ask(page: Page, text: string) {
  const panel = page.getByRole('region', { name: 'Prompt', exact: true })
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

async function action(context: BrowserContext, id: number) {
  const response = await context.request.get(`/api/model/actions/${id}`)
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()) as {
    status: string
    decision: string | null
    applied_by_hand: boolean
    query: unknown
    refusal: { code: string; details: Record<string, unknown> } | null
    error: { code: string } | null
  }
}

/** Adds the school layer: an analysis whose state the failures must leave alone. */
async function addSchools(page: Page) {
  await page.getByRole('tab', { name: 'Klassik' }).click()
  await page.getByRole('button', { name: 'Layer', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Layer hinzufügen' })
  await picker.getByRole('checkbox', { name: /^Schulen/ }).first().check()
  await picker.getByRole('button', { name: 'Hinzufügen' }).click()
  await expect(page.getByLabel('Trefferzahl', { exact: true })).toHaveText('137 von 137')
}

test.describe('E2.3 against the model stub', { tag: '@stub' }, () => {
  test.skip(
    !STUB || !EXTERNAL || !CONTROL,
    'E2E_STUB_URL, E2E_STUB_EXTERNAL_URL and E2E_STUB_CONTROL name the model stub (scripts/gate.sh)',
  )

  test.afterAll(async ({ request }) => removeConnections(request, OURS))

  test('a local connection to the stub is made in the admin page; its test is green', async ({
    page,
    request,
  }) => {
    await removeConnections(request, [LOCAL])
    const row = await createInUi(page, LOCAL, STUB!)
    await expect(row.getByText('lokal', { exact: true })).toBeVisible()
    await row.getByRole('button', { name: `Aktionen für ${LOCAL}` }).click()
    await page.getByRole('menuitem', { name: 'Verbindung testen' }).click()
    const result = page.getByRole('region', { name: `Verbindungstest „${LOCAL}"` })
    await expect(result.getByText('Verbindungstest bestanden')).toBeVisible({ timeout: 30_000 })
  })

  test('the reference question: prompt → answer with assumptions → editor → 10 von 137', async ({
    browser,
    request,
  }) => {
    await ensureAreaLayer(request)
    await ensureAccount(request, browser, ANALYST, 'admin')
    const [context, page] = await user(browser, ANALYST)
    await choose(context, await connectionId(request, LOCAL, STUB!))
    // P1 ended with E2.4: the hand path of E2.3 (M4) is now the level whose
    // classes are all off (shipped as Assistenz); Prüfen asks for approval
    // (acceptance-e2.4.spec.ts).
    const { levels } = (await (await request.get('/api/admin/levels')).json()) as {
      levels: { id: number; matrix: Record<string, string> }[]
    }
    const handOnly = levels.find((l) => Object.values(l.matrix).every((m) => m === 'off'))!
    const level = await context.request.put('/api/llm/options', {
      data: { level_id: handOnly.id },
    })
    expect(level.ok(), await level.text()).toBe(true)
    const { sent, failures } = watchQueries(page)

    const panel = await openPanel(page)
    // A local connection: no notice that the prompt leaves the house.
    await expect(panel.getByText(new RegExp(`${LOCAL} · Stufe`))).toBeVisible()
    await expect(panel.getByRole('complementary', { name: 'Externe Anbindung' })).toHaveCount(0)

    const expected = fixture('reference')
    const { card, id } = await ask(page, expected.prompt)
    await expect(card.getByRole('status').first()).toContainText('von Hand übernehmen')
    await expect(card).toContainText(expected.answer!.explanation!)
    const assumptions = card.getByRole('region', { name: 'Annahmen' })
    await expect(assumptions).toContainText('Annahmen · 3')
    await expect(assumptions.getByRole('listitem')).toHaveCount(3)
    await expect(assumptions).toContainText('höchstens 500 m')
    // Proposed, nothing applied: the analysis has no result layer yet.
    await expect(page.getByLabel('Trefferzahl', { exact: true })).toHaveCount(0)
    // The record holds the model's query: the one built by hand in E1 (fields
    // the record fills with their defaults aside; what ran is compared strictly below).
    expect(given((await action(context, id)).query)).toEqual(reference)

    const takeOver = card.getByRole('button', { name: 'In Editor übernehmen' })
    await expect(takeOver).toBeEnabled()
    await takeOver.click()
    const editor = page.getByRole('region', { name: 'Abfrage-Editor' })
    await expect(editor.getByRole('note')).toContainText('Entwurf aus Vorschlag')
    await editor.getByRole('button', { name: 'Übernehmen' }).click()
    await expect(page.getByLabel('Trefferzahl', { exact: true })).toHaveText('10 von 137')

    // The query the application ran is the hand-built one of E1, deep-equal.
    await expect
      .poll(() => sent.some((q) => isDeepStrictEqual(q, reference)), {
        message: `sent: ${JSON.stringify(sent)}`,
      })
      .toBe(true)
    expect(failures).toEqual([])
    // Applied by hand, as proposed (D1).
    await expect
      .poll(async () => {
        const view = await action(context, id)
        return [view.status, view.decision, view.applied_by_hand]
      })
      .toEqual(['applied', 'proposal_only', true])
    await context.close()
  })

  test('refusals: a missing and a hidden layer alike, the limit, not representable, a write', async ({
    browser,
    request,
  }) => {
    await ensureAccount(request, browser, USER, 'user')
    const [context, page] = await user(browser, USER)
    await choose(context, await connectionId(request, LOCAL, STUB!))
    const matrix = (await (await request.get('/api/admin/visibility')).json()) as {
      layer: string
      roles: { user: boolean }
    }[]
    const wasVisible = matrix.find((r) => r.layer === 'haltestellen')!.roles.user
    const hide = await request.put('/api/admin/visibility', {
      data: { layer: 'haltestellen', role: 'user', visible: false },
    })
    expect(hide.ok(), await hide.text()).toBe(true)
    try {
      await openPanel(page)
      const refused = async (id: string, words: string | RegExp, code: string) => {
        const { card, id: actionId } = await ask(page, fixture(id).prompt)
        const alert = card.getByRole('alert')
        await expect(alert).toContainText('abgewiesen')
        await expect(alert).toContainText(words)
        await expect(card.getByText(`code: ${code}`)).toBeAttached()
        // Viewable, never applicable.
        await expect(card.getByRole('button', { name: 'In Editor übernehmen' })).toHaveCount(0)
        const view = await action(context, actionId)
        expect([view.status, view.refusal?.code]).toEqual(['refused', code])
        return view.refusal!
      }

      const missing = await refused(
        'unknown_layer',
        'Den Layer „kitas" gibt es nicht oder er ist nicht sichtbar.',
        'unknown_layer',
      )
      const hidden = await refused(
        'hidden_layer',
        'Den Layer „haltestellen" gibt es nicht oder er ist nicht sichtbar.',
        'unknown_layer',
      )
      // The same refusal: nothing tells that the hidden layer exists.
      expect(Object.keys(hidden.details).sort()).toEqual(Object.keys(missing.details).sort())
      expect(hidden.details.layer).toBe('haltestellen')

      await refused(
        'limit_exceeded',
        'Die Abfrage hat 10 Bedingungen; im Modus B sind höchstens 8 möglich.',
        'limit_exceeded',
      )
      await refused(
        'not_representable',
        'Diese Abfrage lässt sich in den Bedienelementen nicht vollständig darstellen.',
        'not_representable',
      )
      // F-9.5: the schema has no write; a write-shaped answer is refused, not ignored.
      await refused(
        'write_shaped',
        'Die Antwort des Modells ist keine gültige Abfrage.',
        'model_query_invalid',
      )
      // Nothing was written: the schools are all still there.
      const schools = await request.post('/api/query/count', {
        data: { queries: [{ schema_version: '2', source: 'schulen' }] },
      })
      expect(schools.ok(), await schools.text()).toBe(true)
      expect((await schools.json()).counts).toEqual([137])
    } finally {
      await request.put('/api/admin/visibility', {
        data: { layer: 'haltestellen', role: 'user', visible: wasVisible },
      })
      await context.close()
    }
  })

  test('failures: an unreachable or slow model leaves the analysis and the prompt as they were', async ({
    browser,
    request,
  }) => {
    // The stub holds the slow answer for 30 s; that connection waits 2 (llm_timeout).
    await connectionId(request, SLOW, caseUrl('timeout'), 2)
    await ensureAccount(request, browser, USER, 'user')
    const [context, page] = await user(browser, USER)
    await choose(context, await connectionId(request, UNREACHABLE, caseUrl('unreachable')))
    await page.goto('/')
    await addSchools(page)

    const prompt = fixture('unreachable').prompt
    await page.getByRole('tab', { name: 'Prompt' }).click()
    const { card, id } = await ask(page, prompt)
    const alert = card.getByRole('alert')
    await expect(alert).toContainText('Modell nicht erreichbar')
    await expect(alert).toContainText(`Die Anbindung „${UNREACHABLE}“ antwortet nicht.`)
    await expect(alert).toContainText('Ihr Stand ist unverändert.')
    const panel = page.getByRole('region', { name: 'Prompt', exact: true })
    await expect(panel.getByRole('textbox', { name: 'Prompt' })).toHaveValue(prompt)
    await expect(page.getByLabel('Trefferzahl', { exact: true })).toHaveText('137 von 137')
    expect((await action(context, id)).error?.code).toBe('llm_unreachable')

    // M14.1: another connection from the card, then the same prompt again.
    await card.getByRole('button', { name: 'Anbindung wechseln' }).click()
    await page.getByRole('menuitem', { name: SLOW }).click()
    await expect(panel.getByText(new RegExp(`${SLOW} · Stufe`))).toBeVisible()
    const slow = await ask(page, prompt)
    await expect(slow.card.getByRole('alert')).toContainText('Zeitüberschreitung')
    await expect(slow.card.getByRole('alert')).toContainText('Ihr Stand ist unverändert.')
    await expect(panel.getByRole('textbox', { name: 'Prompt' })).toHaveValue(prompt)
    await expect(page.getByLabel('Trefferzahl', { exact: true })).toHaveText('137 von 137')
    expect((await action(context, slow.id)).error?.code).toBe('llm_timeout')
    await context.close()
  })

  test('an external connection names its host and says that the prompt leaves the house', async ({
    browser,
    page,
    request,
  }) => {
    await removeConnections(request, [EXTERN])
    const row = await createInUi(page, EXTERN, EXTERNAL!)
    await expect(row).toContainText('extern')
    await expect(row).toContainText('nur Metadaten')

    await ensureAccount(request, browser, USER, 'user')
    const [context, userPage] = await user(browser, USER)
    await choose(context, await connectionId(request, EXTERN, EXTERNAL!))
    const panel = await openPanel(userPage)
    const host = new URL(EXTERNAL!).hostname
    const notice = panel.getByRole('complementary', { name: 'Externe Anbindung' })
    await expect(notice).toContainText('Der Prompt-Text verlässt das Haus')
    await expect(notice).toContainText(`Er geht an ${host}.`)
    await expect(panel.getByText(`${EXTERN} · extern · ${host}`, { exact: false })).toBeVisible()

    // It answers like any other: a clarification (M12.2), the analysis untouched.
    const { card } = await ask(userPage, fixture('clarification').prompt)
    await expect(card.getByRole('group', { name: 'Antworten' })).toContainText('500 m')
    await context.close()
  })

  test('privacy: no row value of the sample reaches the model', async ({ request }) => {
    const log = await fetch(`${CONTROL}/_requests`)
    expect(log.ok).toBe(true)
    const sentToModel = JSON.stringify(await log.json())
    // Positive control: the prompts and the layer profile did reach it.
    expect(sentToModel).toContain(fixture('unknown_layer').prompt)
    expect(sentToModel).toContain('schulen')

    const result = await request.post('/api/query', {
      data: { schema_version: '2', source: 'schulen', select: ['name'], limit: 200 },
    })
    expect(result.ok(), await result.text()).toBe(true)
    const names = ((await result.json()).features as { properties: { name: string } }[])
      .map((f) => f.properties.name)
      .filter((n) => n.length > 6)
    expect(names.length).toBeGreaterThan(50)
    expect(names.filter((n) => sentToModel.includes(n))).toEqual([])
  })

  test('offline: the stub is reachable, an address outside is not', async ({ request }) => {
    test.skip(process.env.E2E_OFFLINE !== '1', 'E2E_OFFLINE=1: the container has no route out')
    const check = async (base_url: string) => {
      const response = await request.post('/api/admin/llm/connections/test', {
        data: { base_url, model: MODEL },
        timeout: 90_000,
      })
      expect(response.ok(), await response.text()).toBe(true)
      return (await response.json()) as {
        ok: boolean
        steps: { name: string; status: string; code?: string }[]
      }
    }
    expect((await check(STUB!)).ok).toBe(true)
    const outside = await check('https://api.openai.com/v1')
    expect(outside.ok).toBe(false)
    const reachable = outside.steps.find((s) => s.name === 'reachable')
    expect(reachable?.status).toBe('failed')
  })
})
