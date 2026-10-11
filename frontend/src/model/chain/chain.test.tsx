// The tool chain's plan and run (plan WP77, design M8, M9) against the fake
// server of model-mocks.ts, which answers WP75's routes as its server does
// (the rules are listed there). Server-shaped data throughout: compact
// queries in the record and its steps, a full dump in the rows' query, naive
// UTC times with microseconds, every key of ``model_view``.
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { useAnalysis } from '../../analysis/store'
import { rows } from '../../analysis/tree'
import type { ModelActionView } from '../../api/client'
import { activate } from '../../i18n/i18n'
import { messages as pseudo } from '../../locales/pseudo.po'
import {
  actionView,
  CHAIN_DURATIONS_MS,
  CHAIN_HITS,
  isFakeError,
  MODEL_LIMITS,
  modelCase,
  modelServer,
  serverShape,
  thinkingView,
  type ChainScript,
  type FakeError,
  type LevelName,
  type PlannedStep,
  type ModelServer,
} from '../../test/model-mocks'
import {
  ask,
  backend,
  chainRoutes,
  done,
  fakeTimers,
  json,
  llmOptions,
  promptFlow,
  resetStores,
  thinking as isThinking,
  tick,
} from '../../test/prompt-panel'
import { strays } from '../../test/pseudo'
import { renderAt } from '../../test/render'
import { Workplace } from '../../workplace/Workplace'
import { useApproval } from '../approval/flow'
import { useModel } from '../store'
import { registerCompare } from './compare'
import {
  CHAIN_S,
  MAX_FEATURES,
  MAX_REPLANS,
  MAX_STEPS,
  modelSees,
  valueFields,
  withValue,
} from './steps'

beforeEach(resetStores)
afterEach(done)

const LEVEL_ID: Record<LevelName, number> = {
  Assistenz: 1,
  Prüfen: 2,
  Teilautonom: 3,
  Automatisch: 4,
}

const CASE = modelCase('chain_reference')
const PLAN = CASE.answer as unknown as Extract<
  NonNullable<ModelActionView['answer']>,
  { kind: 'plan' }
>

type Calls = { key: string; body: unknown }[]
const hits = (calls: Calls, step: string) => calls.filter((c) => c.key.endsWith(`/${step}`))
const polls = (calls: Calls, id: number) =>
  calls.filter((c) => c.key === `GET /api/model/actions/${id}`)

/** The chain's answer card, by its place (the pseudo locale renames its label). */
const findCard = () =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>('#prompt-panel article[data-phase]')
    if (!found) throw new Error('no chain answer')
    return found
  })

const phase = async (expected: string) =>
  waitFor(async () => expect((await findCard()).dataset.phase).toBe(expected))

/** A step of the list by its place: "Schritt 2: …". */
const stepItem = (n: number) =>
  screen.getByRole('listitem', { name: new RegExp(`^Schritt ${n}: `) })

/**
 * Sends the reference question as a chain at ``level``; the first poll brings
 * the plan. The fake server answers every route of the chain.
 */
async function planned(
  level: LevelName = 'Prüfen',
  options: { script?: ChainScript; routes?: (server: ModelServer) => object } = {},
) {
  const user = fakeTimers()
  const answer = actionView('chain_reference', {}, level)
  const server = modelServer([answer], undefined, options.script)
  const calls = backend(
    {
      ...chainRoutes(server, thinkingView('chain_reference', level)),
      ...options.routes?.(server),
    },
    llmOptions(1, LEVEL_ID[level]),
  )
  useModel.getState().setApproach('chain')
  useModel.getState().setOpen(true)
  const view = renderAt('/', <Workplace />)
  await waitFor(() => expect(document.getElementById('prompt-panel')).not.toBeNull())
  await ask(user, answer.prompt)
  await isThinking()
  await tick()
  return { user, calls, server, answer, view, card: await findCard() }
}

/** Plans under *Prüfen* and starts the run: approve, then run (202). */
async function running(options: Parameters<typeof planned>[1] = {}) {
  const started = await planned('Prüfen', options)
  await started.user.click(screen.getByRole('button', { name: 'Kette freigeben und starten' }))
  await phase('running')
  return started
}

const unchanged = () => {
  expect(useAnalysis.getState().tree.children).toEqual([])
  expect(Object.keys(useAnalysis.getState().origin.marks)).toEqual([])
}

describe('contract', () => {
  test('the limits are those of the fixture', () => {
    expect(MAX_STEPS).toBe(MODEL_LIMITS.steps)
    expect(MAX_REPLANS).toBe(MODEL_LIMITS.replans)
    expect(CHAIN_S).toBe(MODEL_LIMITS.chain_s)
    expect(MAX_FEATURES).toBe(MODEL_LIMITS.max_features)
  })

  test('"Modell sieht" says only what D9 allows: ok or the code, empty or not, the count', () => {
    expect(modelSees({ outcome: 'ok', empty: false, count: 24 })).toBe('ok · nicht leer · 24')
    expect(modelSees({ outcome: 'ok', empty: true, count: 0 })).toBe('ok · leer · 0')
    expect(
      modelSees({
        outcome: 'error',
        code: 'unknown_attribute',
        part: 'typ',
        empty: null,
        count: null,
      }),
    ).toBe('Fehler · unknown_attribute · typ')
    // As the server sends it: every key, null where unused.
    expect(modelSees({ outcome: 'ok', code: null, part: null, empty: false, count: 7 })).toBe(
      'ok · nicht leer · 7',
    )
  })

  test('the plan editor offers values only: never a layer, an attribute or a step reference', () => {
    const fields = PLAN.steps.map((s) => valueFields(s.arguments).map((f) => [f.key, f.value]))
    expect(fields).toEqual([
      [['values', 'primar']],
      [
        ['distance_m', 500],
        ['value', 'kantonsstrasse_b'],
      ],
      [],
      [['value', 1.6]],
      [],
    ])
    const buffer = PLAN.steps[1]?.arguments
    expect(withValue(buffer, ['distance_m'], 300)).toEqual({ ...buffer, distance_m: 300 })
  })
})

describe('plan (M8)', () => {
  test('M8.1 Prüfen: steps with text, tool, class and cell, "5 von höchstens 8", one approval; the prompt went as a chain', async () => {
    const { calls, card, answer } = await planned()
    expect(hits(calls, 'prompt').map((c) => c.body)).toEqual([
      { text: answer.prompt, approach: 'chain' },
    ])
    expect(card.querySelector('[data-status="awaiting"]')).toHaveTextContent('wartet auf Freigabe')
    expect(card).toHaveTextContent(PLAN.explanation)
    expect(within(card).getByRole('region', { name: 'Annahmen' })).toHaveTextContent(
      '„nahe“ = höchstens 500 m',
    )
    expect(within(card).getByText('Geplante Schritte · 5 von höchstens 8')).toBeInTheDocument()
    const steps = within(card).getAllByRole('listitem', { name: /^Schritt \d: / })
    expect(steps).toHaveLength(PLAN.steps.length)
    PLAN.steps.forEach((step, i) => {
      expect(steps[i]).toHaveTextContent(step.text)
      expect(steps[i]).toHaveTextContent(step.tool)
    })
    // In words from the step's query object; the tool's name only in monospace.
    expect(steps[0]).toHaveTextContent('Schulen · Schulstufe ist eins von primar')
    expect(steps[1]).toHaveTextContent(/Strassen · .*Strassenklasse.* · Puffer 500 m/)
    expect(within(steps[0] as HTMLElement).getByText('filter').className).toMatch(/\bfont-mono\b/)
    expect(steps[0]).toHaveTextContent('Attributfilter · Freigabe')
    expect(steps[1]).toHaveTextContent('Attributfilter, Abgeleitete Layer · Freigabe')
    expect(steps[2]).toHaveTextContent('Raumfilter · Freigabe')
    expect(card).toHaveTextContent(
      'Eine Freigabe für die ganze Kette; danach läuft sie ohne weitere Halte durch.',
    )
    // The approval as E2.4's: the first button has the focus, Esc rejects.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Kette freigeben und starten' })).toHaveFocus(),
    )
    expect(within(card).getByRole('button', { name: 'Ablehnen' })).toHaveAccessibleDescription(
      'Esc = Ablehnen',
    )
    expect(hits(calls, 'approve')).toEqual([])
    expect(hits(calls, 'run')).toEqual([])
    unchanged()
  })

  test('M8.1: Esc rejects the plan; the analysis stays as it is', async () => {
    const { user, calls, card } = await planned()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Kette freigeben und starten' })).toHaveFocus(),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(card).toHaveTextContent('abgelehnt'))
    expect(hits(calls, 'reject').map((c) => c.body)).toEqual([{ reason: null }])
    expect(hits(calls, 'run')).toEqual([])
    // The panel stays open: Esc belonged to the approval.
    expect(document.getElementById('prompt-panel')).not.toBeNull()
    unchanged()
  })

  test('M8.2 Teilautonom: cell per step, "Starten", and the run halts before the step that needs approval (M9.2)', async () => {
    const { user, calls, card, answer } = await planned('Teilautonom')
    const steps = within(card).getAllByRole('listitem', { name: /^Schritt \d: / })
    expect(steps[0]).toHaveTextContent('Attributfilter · auto')
    expect(steps[1]).toHaveTextContent('Attributfilter, Abgeleitete Layer · Freigabe')
    expect(steps[2]).toHaveTextContent('Raumfilter · auto')
    expect(card).toHaveTextContent('die Kette hält vor Schritt 2 zur Freigabe')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Starten' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Starten' }))
    await phase('running')
    await tick()

    // M9.2: halted before the buffer; the step asks, the clock stands.
    await phase('halt')
    const halted = await findCard()
    expect(halted.querySelector('[data-status="awaiting"]')).toBeInTheDocument()
    expect(halted).toHaveTextContent('Schritt 2 von 5')
    const step = stepItem(2)
    expect(step).toHaveAttribute('data-status', 'waiting')
    expect(step).toHaveTextContent(
      'Braucht Freigabe: Attributfilter, Abgeleitete Layer (Stufe Teilautonom)',
    )
    expect(halted).toHaveTextContent('Die Laufzeit ist angehalten, solange die Freigabe offen ist.')
    await waitFor(() =>
      expect(within(step).getByRole('button', { name: 'Schritt freigeben' })).toHaveFocus(),
    )
    // No polling while it waits.
    const before = polls(calls, answer.id).length
    await tick(5000)
    expect(polls(calls, answer.id)).toHaveLength(before)
    unchanged()

    await user.click(within(step).getByRole('button', { name: 'Schritt freigeben' }))
    await phase('running')
    for (let i = 0; i < 4; i++) await tick()
    await phase('done')
    expect(hits(calls, 'approve')).toHaveLength(2)
    expect(hits(calls, 'run')).toHaveLength(2)
    unchanged()
  })

  test('M9.2: Esc stops the chain; the last complete result stays adoptable (M9.4)', async () => {
    const { user, calls } = await planned('Teilautonom')
    await user.click(await screen.findByRole('button', { name: 'Starten' }))
    await phase('running')
    await tick()
    await phase('halt')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Schritt freigeben' })).toHaveFocus(),
    )
    await user.keyboard('{Escape}')
    await phase('stopped')
    expect(hits(calls, 'abort')).toHaveLength(1)
    const first = formatted(CHAIN_HITS[0] ?? 0)
    expect(
      screen.getByRole('button', { name: `Zwischenstand übernehmen (${first})` }),
    ).toBeEnabled()
    expect(stepItem(2)).toHaveAttribute('data-status', 'skipped')
    unchanged()
  })

  test('Automatisch: the plan arrives approved and runs without a question', async () => {
    const { calls } = await planned('Automatisch')
    await phase('running')
    expect(hits(calls, 'approve')).toEqual([])
    expect(hits(calls, 'run')).toHaveLength(1)
    for (let i = 0; i < 5; i++) await tick()
    await phase('done')
    unchanged()
  })

  test('M8.3: values change and steps go through PATCH …/plan; no step can be added', async () => {
    const { user, calls, card } = await planned()
    await user.click(within(card).getByRole('button', { name: 'Anpassen …' }))
    const form = within(card).getByRole('form', { name: 'Plan anpassen' })
    expect(within(form).queryByRole('button', { name: /hinzufügen|neuer Schritt/i })).toBeNull()
    expect(form).toHaveTextContent('Neue Schritte kommen nur über einen neuen Prompt.')

    const distance = within(form).getByRole('textbox', { name: 'Distanz (m) in Schritt 2' })
    expect(distance).toHaveValue('500')
    await user.clear(distance)
    await user.type(distance, '300')
    // Step 3 is read by step 5: the server refuses to remove it and names the step.
    await user.click(within(form).getByRole('button', { name: /^Schritt 3 entfernen/ }))
    expect(within(form).getByText('Geplante Schritte · 4 von höchstens 8')).toBeInTheDocument()
    await user.click(within(form).getByRole('button', { name: 'Änderungen übernehmen' }))
    expect(await within(form).findByRole('alert')).toBeInTheDocument()
    expect(within(card).getByRole('form', { name: 'Plan anpassen' })).toBeInTheDocument()

    // Without steps 3 to 5 the plan would end in the buffer: refused (D3).
    await user.click(within(form).getByRole('button', { name: /^Schritt 4 entfernen/ }))
    await user.click(within(form).getByRole('button', { name: /^Schritt 5 entfernen/ }))
    await user.click(within(form).getByRole('button', { name: 'Änderungen übernehmen' }))
    await waitFor(() => expect(hits(calls, 'plan')).toHaveLength(2))
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Diese Abfrage lässt sich in den Bedienelementen nicht vollständig darstellen.',
    )
    await user.click(within(form).getByRole('button', { name: /^Schritt 4 behalten/ }))
    await user.click(within(form).getByRole('button', { name: /^Schritt 5 behalten/ }))

    // Keep step 3, remove step 5 (read by none).
    await user.click(within(form).getByRole('button', { name: /^Schritt 3 behalten/ }))
    await user.click(within(form).getByRole('button', { name: /^Schritt 5 entfernen/ }))
    await user.click(within(form).getByRole('button', { name: 'Änderungen übernehmen' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Plan anpassen' })).toBeNull())

    const patches = calls.filter((c) => c.key.endsWith('/plan')).map((c) => c.body)
    expect(patches[0]).toMatchObject({ remove: [3] })
    expect(patches[2]).toEqual({
      change: [{ position: 2, arguments: { ...PLAN.steps[1]?.arguments, distance_m: 300 } }],
      remove: [5],
    })
    const after = await findCard()
    expect(within(after).getByText('Geplante Schritte · 4 von höchstens 8')).toBeInTheDocument()
    expect(within(after).getAllByRole('listitem', { name: /^Schritt \d: / })).toHaveLength(4)
    // The server's answer: the buffer's query has the new distance.
    const view = useModel.getState().views[actionView('chain_reference').id]
    expect(view?.steps[1]?.query).toMatchObject({ buffer: { distance_m: 300 } })
    expect(view?.steps[4]?.status).toBe('removed')
    expect(hits(calls, 'run')).toEqual([])
    unchanged()
  })
})

const formatted = (n: number) => new Intl.NumberFormat('de-CH').format(n)
const secondsText = (ms: number) =>
  `${new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000)} s`

test('M8.3: the editor takes the focus; Esc and a change give it back to "Anpassen …"', async () => {
  const { user, card } = await planned()
  await user.click(within(card).getByRole('button', { name: 'Anpassen …' }))
  const form = screen.getByRole('form', { name: 'Plan anpassen' })
  expect(form).toContainElement(document.activeElement as HTMLElement)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('form', { name: 'Plan anpassen' })).toBeNull()
  // Esc closed the editor, not the panel.
  expect(document.getElementById('prompt-panel')).not.toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Anpassen …' })).toHaveFocus())
  await user.click(screen.getByRole('button', { name: 'Anpassen …' }))
  await user.click(screen.getByRole('button', { name: /^Schritt 5 entfernen/ }))
  await user.click(screen.getByRole('button', { name: 'Änderungen übernehmen' }))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Plan anpassen' })).toBeNull())
  await waitFor(() => expect(screen.getByRole('button', { name: 'Anpassen …' })).toHaveFocus())
})

describe('run (M9)', () => {
  test('M9.1: step n of m, elapsed against the 5:00 cap, results and "Modell sieht" per step, dimmed on the map', async () => {
    const { calls, server, answer } = await running({ script: { pace: 1 } })
    expect(hits(calls, 'approve')).toHaveLength(1)
    expect(hits(calls, 'run')).toHaveLength(1)
    const live = await findCard()
    expect(live.querySelector('[data-status="running"]')).toHaveTextContent(
      'läuft· Schritt 1 von 5',
    )
    await tick()
    await tick()
    server.hold(true)
    await waitFor(async () =>
      expect((await findCard()).querySelector('[data-status="running"]')).toHaveTextContent(
        'läuft· Schritt 3 von 5',
      ),
    )
    // The request so far as the server counts it: the planning call (6 s), the two
    // steps that ran (0.4 s + 1.8 s, ``run_ms``), and the third on this clock.
    expect(useModel.getState().views[answer.id]?.run_ms).toBe(2200)
    const clock = screen.getByLabelText('Laufzeit der Kette')
    expect(clock).toHaveTextContent(/^0:0[89] \/ max\. 5:00$/)
    await tick(3000)
    expect(screen.getByLabelText('Laufzeit der Kette')).toHaveTextContent(
      /^0:1[0-2] \/ max\. 5:00$/,
    )

    const first = stepItem(1)
    expect(first).toHaveAttribute('data-status', 'ok')
    expect(within(first).getByLabelText('Treffer')).toHaveTextContent(formatted(CHAIN_HITS[0] ?? 0))
    expect(within(first).getByLabelText('Dauer')).toHaveTextContent(
      secondsText(CHAIN_DURATIONS_MS[0] ?? 0),
    )
    const sees = within(first).getByText(/^Modell sieht:/)
    expect(sees).toHaveTextContent(`Modell sieht: ok · nicht leer · ${CHAIN_HITS[0]}`)
    expect(sees.className).toMatch(/\bfont-mono\b/)
    expect(stepItem(3)).toHaveAttribute('data-status', 'running')
    expect(stepItem(3)).toHaveTextContent('läuft …')
    // Input locked while the chain runs; the analysis untouched.
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveAttribute('readonly')
    unchanged()

    // The steps' results, run as the user through Modus A (ids), dimmed, with the
    // caption that they are not applied.
    const steps = useModel.getState().views[answer.id]?.steps ?? []
    await waitFor(() =>
      expect(calls.filter((c) => c.key === 'POST /api/query/ids').map((c) => c.body)).toEqual(
        expect.arrayContaining([steps[0]?.query, steps[1]?.query]),
      ),
    )
    expect(steps[0]?.query).toEqual({
      schema_version: '2',
      source: 'schulen',
      output: 'map',
      where: { op: 'in', attr: 'typ', values: ['primar'] },
    })
    const caption = screen.getByRole('note', { name: 'Zwischenstand der Kette' })
    expect(caption).toHaveTextContent('Zwischenstand gedämpft · nicht angewendet')
    expect(caption).toHaveTextContent(`Schritt 1 · ${formatted(CHAIN_HITS[0] ?? 0)}`)
    // Not by colour alone: the latest step says so.
    expect(caption).toHaveTextContent('(zuletzt)')
    // The sidebar names the chain's state beside the analysis (M9.1).
    const side = screen.getByRole('note', { name: 'Zwischenstand · Kette' })
    expect(side).toHaveTextContent(`Schritt 2 von 5 · ${formatted(CHAIN_HITS[1] ?? 0)}`)
    expect(side).toHaveTextContent('nicht angewendet')
  })

  test('the status region speaks per step change, at most once every 3 s', async () => {
    const { server } = await running({ script: { pace: 1 } })
    const region = async () => (await findCard()).querySelector('p[role="status"].sr-only')
    await waitFor(async () => expect(await region()).toHaveTextContent('Schritt 1 von 5 läuft'))
    await tick() // step 2 runs: within 3 s of the last announcement, not yet said
    server.hold(true)
    expect(await region()).toHaveTextContent('Schritt 1 von 5 läuft')
    await tick(2100)
    await waitFor(async () => expect(await region()).toHaveTextContent('Schritt 2 von 5 läuft'))
  })

  test('M9.3: done; "5 Schritte · 3,6 s", 10 von 137, the result marked, not applied', async () => {
    const { calls, answer } = await running()
    for (let i = 0; i < 5; i++) await tick()
    await phase('done')
    const end = await findCard()
    expect(end.querySelector('[data-status="done"]')).toHaveTextContent(
      'fertig· Ergebnis nicht angewendet',
    )
    const total = CHAIN_DURATIONS_MS.reduce((a, b) => a + b, 0)
    expect(end).toHaveTextContent(`5 Schritte · ${secondsText(total)}`)
    expect(total).toBe(3600)
    expect(within(end).getByLabelText('Trefferzahl der Kette')).toHaveTextContent('10 von 137')
    // Only the result to adopt carries a stamp, the last step here.
    const steps = useModel.getState().views[answer.id]?.steps ?? []
    expect(steps.map((s) => s.stamp?.count ?? null)).toEqual([null, null, null, null, 10])
    expect(within(end).getByRole('button', { name: 'Ergebnis übernehmen' })).toBeEnabled()
    // The result marked on the map, dashed, and in the sidebar (M9.3).
    const record = useModel.getState().views[answer.id]
    await waitFor(() =>
      expect(
        calls.filter((c) => c.key === 'POST /api/query/ids').map((c) => c.body),
      ).toContainEqual(record?.query),
    )
    expect(screen.getByRole('note', { name: 'Zwischenstand der Kette' })).toHaveTextContent(
      'Ergebnis gestrichelt · vorgemerkt, nicht angewendet',
    )
    expect(screen.getByRole('note', { name: 'Zwischenstand · Kette' })).toHaveTextContent(
      'Ergebnis 10 von 137 · vorgemerkt',
    )
    // The comparison's entry (WP78), registered by the dialogue.
    expect(within(end).getByRole('button', { name: 'Mit Direktabfrage vergleichen' })).toBeEnabled()
    // "Als Abfrage ansehen": the result as the query it becomes, nothing applied.
    await act(async () => within(end).getByRole('button', { name: 'Als Abfrage ansehen' }).click())
    expect(within(end).getByRole('group', { name: 'Bedingungen' })).toBeInTheDocument()
    const before = polls(calls, answer.id).length
    await tick(5000)
    expect(polls(calls, answer.id)).toHaveLength(before)
    unchanged()
  })

  test('Ergebnis übernehmen adopts: the stored query is the analysis, marked "Modell", undoable', async () => {
    const { user, calls } = await running()
    for (let i = 0; i < 5; i++) await tick()
    await phase('done')
    await user.click(screen.getByRole('button', { name: 'Ergebnis übernehmen' }))
    await phase('closed')
    expect(hits(calls, 'adopt')).toHaveLength(1)
    const analysis = useAnalysis.getState()
    expect(rows(analysis.tree)).toHaveLength(3)
    expect(Object.keys(analysis.origin.marks).sort()).toEqual(
      rows(analysis.tree)
        .map((r) => r.id)
        .sort(),
    )
    const end = await findCard()
    expect(end.querySelector('[data-status="applied"]')).toBeInTheDocument()
    expect(end).toHaveTextContent('Kette übernommen · 10 Treffer')
    // Applied like an executed answer: the last model change, undone as one.
    expect(useApproval.getState().last?.auto).toBe(false)
    await user.click(within(end).getByRole('button', { name: 'Zurücknehmen' }))
    await waitFor(() => expect(useAnalysis.getState().tree.children).toEqual([]))
  })

  test('adopt reads a server-shaped record too: the query as a full dump, times with microseconds', async () => {
    const { user } = await running({
      routes: (server) => ({
        [`POST /api/model/actions/${actionView('chain_reference').id}/adopt`]: () => {
          const response = server.adopt(actionView('chain_reference').id)
          if (isFakeError(response)) return json(response.body, response.status)
          return json({
            ...response,
            action: { ...response.action, query: serverShape(response.action.query) },
          })
        },
      }),
    })
    for (let i = 0; i < 5; i++) await tick()
    await phase('done')
    await user.click(screen.getByRole('button', { name: 'Ergebnis übernehmen' }))
    await phase('closed')
    expect(rows(useAnalysis.getState().tree)).toHaveLength(3)
    const decided = useModel.getState().views[actionView('chain_reference').id]?.decided_at
    expect(decided).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/)
  })

  test('M9.4: Abbrechen stops before the next step; the analysis stays until the intermediate result is adopted', async () => {
    const { user, calls, answer } = await running({ script: { pace: 1 } })
    await tick()
    await user.click(within(await findCard()).getByRole('button', { name: 'Abbrechen' }))
    // Answered at once, still running: the step that runs ends, the poll brings the stop.
    await waitFor(async () =>
      expect((await findCard()).querySelector('[data-status="running"]')).toHaveTextContent(
        'läuft· wird abgebrochen',
      ),
    )
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeDisabled()
    await tick()
    await phase('stopped')
    expect(hits(calls, 'abort')).toHaveLength(1)
    const end = await findCard()
    // The step running when aborted finishes (P4): stopped after step 2.
    expect(end.querySelector('[data-status="aborted"]')).toHaveTextContent(
      'abgebrochen· nach Schritt 2',
    )
    expect(end).toHaveTextContent('Analyse unverändert')
    expect(stepItem(3)).toHaveAttribute('data-status', 'skipped')
    const before = polls(calls, answer.id).length
    await tick(5000)
    expect(polls(calls, answer.id)).toHaveLength(before)
    unchanged()
    // M9.4: the account's log beside the adoption.
    expect(within(end).getByRole('button', { name: 'Protokoll' })).toBeEnabled()
    // Step 2 is a buffer: the result to adopt is step 1 (the server's choice, ``query``).
    const first = formatted(CHAIN_HITS[0] ?? 0)
    await user.click(screen.getByRole('button', { name: `Zwischenstand übernehmen (${first})` }))
    await phase('closed')
    expect(rows(useAnalysis.getState().tree)).toHaveLength(1)
    expect(Object.keys(useAnalysis.getState().origin.marks)).toHaveLength(1)
  })

  const REVISED: PlannedStep[] = Array.from({ length: 7 }, (_, i) => ({
    text: `Neuer Schritt ${i + 1}`,
    tool: 'filter',
    arguments: {
      layer: 'schulen',
      where: { op: 'compare', attr: 'standorte', cmp: 'ge', value: i },
    },
  }))

  test.each([
    {
      reason: 'result_too_large',
      // Only the last step is held to the result size; step 4 is then the result.
      script: { hits: { 5: 12400 } },
      title: 'Ergebnisgrösse überschritten',
      text: /Schritt 5 hätte 12.400 Objekte erzeugt \(höchstens 10.000\)\./,
      adoptable: CHAIN_HITS[3],
    },
    {
      reason: 'step_limit',
      // Step 2 empty: the re-plan would bring 2 + 7 = 9 steps (P4: re-planned ones count).
      script: { hits: { 2: 0 }, replans: [REVISED] },
      title: 'Schrittzahl erreicht',
      text: /Die Kette bräuchte 9 Schritte, neu geplante eingeschlossen \(höchstens 8\)\./,
      adoptable: CHAIN_HITS[0],
    },
    {
      reason: 'time_limit',
      script: { timeLimit: 2 },
      title: 'Laufzeit überschritten',
      text: /hielt vor Schritt 2 \(höchstens 5:00 je Anfrage\)/,
      adoptable: CHAIN_HITS[0],
    },
    {
      reason: 'replan_limit (no plan)',
      // Step 3 fails; the model answers the re-plan with something else than a plan.
      script: { errors: { 3: { code: 'unknown_attribute', part: 'typ' } } },
      title: 'Keine weitere Neuplanung',
      text: /Das Modell antwortete auf die Neuplanung nicht mit einem Plan\./,
      adoptable: CHAIN_HITS[0],
    },
    {
      reason: 'replan_limit (failed)',
      script: {
        errors: { 3: { code: 'unknown_attribute' } },
        replanError: { code: 'connection_not_available', details: { reason: 'changed' } },
      },
      title: 'Keine weitere Neuplanung',
      text: /Die Neuplanung brachte keinen brauchbaren Plan: /,
      adoptable: CHAIN_HITS[0],
    },
  ] as {
    reason: string
    script: ChainScript
    title: string
    text: RegExp
    adoptable: number
  }[])(
    'M9.5 $reason: the same shape for steps, time and size; the prompt can go back, the last complete result is adoptable',
    async ({ script, title, text, adoptable }) => {
      const { user } = await running({ script })
      for (let i = 0; i < 3; i++) await tick()
      await phase('stopped')
      const end = await findCard()
      expect(end.querySelector('[data-status="limited"]')).toHaveTextContent(
        'angehalten · Begrenzung',
      )
      expect(end).toHaveTextContent('Analyse unverändert')
      expect(end).toHaveTextContent(title)
      expect(end).toHaveTextContent(text)
      unchanged()
      const last = formatted(adoptable)
      expect(
        within(end).getByRole('button', { name: `Zwischenstand übernehmen (${last})` }),
      ).toBeEnabled()
      await user.click(within(end).getByRole('button', { name: 'Prompt ändern' }))
      expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(CASE.prompt)
      expect(screen.getByRole('radio', { name: 'Werkzeugkette' })).toBeChecked()
    },
  )

  test('M9.5 result_too_large: only the last step is held to the size; it says what the model saw', async () => {
    await running({ script: { hits: { 2: 12400, 5: 12400 } } })
    await tick()
    await phase('stopped')
    // An earlier step beyond the limit is counted as any other.
    expect(stepItem(2)).toHaveAttribute('data-status', 'ok')
    expect(stepItem(5)).toHaveAttribute('data-status', 'error')
    expect(within(stepItem(5)).getByText(/^Modell sieht:/)).toHaveTextContent(
      'Modell sieht: Fehler · result_too_large',
    )
  })

  test('nothing to adopt when the last complete step is beyond the size limit', async () => {
    await running({ script: { hits: { 4: 10001, 5: 12400 } } })
    await tick()
    await phase('stopped')
    const end = await findCard()
    expect(within(end).queryByRole('button', { name: /Zwischenstand übernehmen/ })).toBeNull()
    expect(end).toHaveTextContent(
      'Nichts zu übernehmen: Der letzte vollständige Zwischenstand hat mehr Objekte, als ein Ergebnis haben darf.',
    )
  })

  test('interrupted (a restart or a failed run): its own label; the result adoptable, unstamped', async () => {
    const { answer } = await running({ script: { interrupt: 3 } })
    await tick()
    await phase('stopped')
    const end = await findCard()
    expect(end.querySelector('[data-status="interrupted"]')).toHaveTextContent('unterbrochen')
    expect(end).toHaveTextContent('Lauf unterbrochen')
    expect(end).toHaveTextContent(
      'Die Anwendung wurde neu gestartet, oder der Lauf selbst ist fehlgeschlagen.',
    )
    const record = useModel.getState().views[answer.id]
    expect(record?.query).not.toBeNull()
    expect(record?.stamp).toBeNull()
    expect(within(end).getByRole('button', { name: 'Zwischenstand übernehmen' })).toBeEnabled()
  })

  test('replan_limit with the re-plans used up', async () => {
    const one = REVISED.slice(0, 1)
    await planned('Automatisch', {
      script: {
        errors: {
          3: { code: 'unknown_attribute' },
          4: { code: 'unknown_attribute' },
          5: { code: 'unknown_attribute' },
        },
        replans: [one, one],
      },
    })
    await phase('running')
    await tick()
    await phase('stopped')
    const end = await findCard()
    expect(end).toHaveTextContent('Keine weitere Neuplanung')
    expect(end).toHaveTextContent(
      'Ein Schritt brachte einen Fehler oder kein Ergebnis, und die Neuplanungen sind aufgebraucht (höchstens 2).',
    )
  })

  test('a re-plan under Prüfen asks again for the rest; revised steps are marked', async () => {
    const { user, calls, answer } = await running({
      script: { hits: { 2: 0 }, replans: [REVISED.slice(0, 3)] },
    })
    await tick()
    await tick()
    await phase('halt')
    expect(stepItem(3)).toHaveTextContent('neu geplant')
    expect(
      within(await findCard()).getByText('Geplante Schritte · 5 von höchstens 8'),
    ).toBeInTheDocument()
    expect(await findCard()).toHaveTextContent(
      'Schritt 2 brachte kein Ergebnis; die Kette wurde neu geplant',
    )
    // The record keeps its plan: a re-plan changes the steps, never the answer.
    expect(useModel.getState().views[answer.id]?.answer).toEqual(CASE.answer)
    await user.click(screen.getByRole('button', { name: 'Freigeben und fortsetzen' }))
    await phase('running')
    for (let i = 0; i < 3; i++) await tick()
    await phase('done')
    expect(hits(calls, 'approve')).toHaveLength(2)
  })

  test('a re-plan after a failed step keeps it as it failed; the new steps follow it', async () => {
    const { answer } = await running({
      script: {
        errors: { 3: { code: 'unknown_attribute', part: 'typ' } },
        replans: [REVISED.slice(0, 1)],
      },
    })
    await tick()
    await phase('halt')
    const steps = useModel.getState().views[answer.id]?.steps ?? []
    expect(steps.map((s) => [s.position, s.status, s.revised])).toEqual([
      [1, 'ok', false],
      [2, 'ok', false],
      [3, 'error', false],
      [4, 'planned', true],
    ])
    expect(within(stepItem(3)).getByText(/^Modell sieht:/)).toHaveTextContent(
      'Modell sieht: Fehler · unknown_attribute · typ',
    )
    expect(await findCard()).toHaveTextContent(
      'Schritt 3 brachte einen Fehler; die Kette wurde neu geplant',
    )
    expect(steps[2]?.model_view).toEqual({
      outcome: 'error',
      code: 'unknown_attribute',
      part: 'typ',
      empty: null,
      count: null,
    })
  })

  test.each([
    ["409, the account's call (right after a halt)", { busy: 1 }],
    ['503, every model call', { busyCalls: 1 }],
  ] as [string, ChainScript][])('run answering busy (%s) is tried again', async (_, script) => {
    const { calls } = await planned('Prüfen', { script })
    await act(async () =>
      screen.getByRole('button', { name: 'Kette freigeben und starten' }).click(),
    )
    await waitFor(() => expect(hits(calls, 'run')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: 'Erneut starten' })).toBeNull()
    await tick(2000)
    await waitFor(() => expect(hits(calls, 'run')).toHaveLength(2))
    await phase('running')
  })

  test('no polling after unmount', async () => {
    const { view, calls, answer } = await running()
    const before = polls(calls, answer.id).length
    view.unmount()
    await tick(5000)
    expect(polls(calls, answer.id)).toHaveLength(before)
  })

  test('a failed run request says so and can be started again', async () => {
    let fails = true
    const { user, calls } = await planned('Prüfen', {
      routes: (server) => ({
        [`POST /api/model/actions/${actionView('chain_reference').id}/run`]: () => {
          if (fails) return json({ code: 'internal_error', message: 'down', details: {} }, 500)
          const answer = server.run(actionView('chain_reference').id)
          return isFakeError(answer) ? json(answer.body, answer.status) : json(answer, 202)
        },
      }),
    })
    await user.click(screen.getByRole('button', { name: 'Kette freigeben und starten' }))
    const retry = await screen.findByRole('button', { name: 'Erneut starten' })
    expect(hits(calls, 'run')).toHaveLength(1)
    // The record is asked for again: a run the server started all the same is polled on.
    await waitFor(() =>
      expect(polls(calls, actionView('chain_reference').id).length).toBeGreaterThan(1),
    )
    await tick(3000)
    expect(hits(calls, 'run')).toHaveLength(1)
    fails = false
    await user.click(retry)
    await phase('running')
    expect(useApproval.getState().failure).toBeNull()
  })

  test('a halt approved whose run fails can still be stopped; it ends at once', async () => {
    let runs = 0
    const { user, calls } = await planned('Teilautonom', {
      routes: (server) => ({
        [`POST /api/model/actions/${actionView('chain_reference').id}/run`]: () => {
          if (runs++ > 0) return json({ code: 'internal_error', message: 'down', details: {} }, 500)
          const answer = server.run(actionView('chain_reference').id)
          return isFakeError(answer) ? json(answer.body, answer.status) : json(answer, 202)
        },
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Starten' }))
    await phase('running')
    await tick()
    await phase('halt')
    await user.click(screen.getByRole('button', { name: 'Schritt freigeben' }))
    await screen.findByRole('button', { name: 'Erneut starten' })
    // Approved at a halt, not running: the server stops it at once (M9.4).
    const stop = screen.getByRole('button', { name: 'Abbrechen' })
    expect(stop).toBeEnabled()
    await user.click(stop)
    await phase('stopped')
    expect(hits(calls, 'abort')).toHaveLength(1)
  })

  test('a refused stop at a halt is said, as an alert', async () => {
    const { user } = await planned('Teilautonom', {
      routes: () => ({
        [`POST /api/model/actions/${actionView('chain_reference').id}/abort`]: () =>
          json({ code: 'already_decided', message: 'decided', details: {} }, 409),
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Starten' }))
    await phase('running')
    await tick()
    await phase('halt')
    await user.click(screen.getByRole('button', { name: 'Kette abbrechen' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await phase('halt')
  })

  test('the comparison hook: the finished chain shows the entry registered last', async () => {
    const opened: number[] = []
    const Entry = (view: ModelActionView) => (
      <button type="button" onClick={() => opened.push(view.id)}>
        Eintrag
      </button>
    )
    const { user, answer } = await running()
    for (let i = 0; i < 5; i++) await tick()
    await phase('done')
    // The dialogue registered the comparison's own entry (model/compare/).
    expect(screen.getByRole('button', { name: 'Mit Direktabfrage vergleichen' })).toBeEnabled()
    let off = () => {}
    act(() => {
      off = registerCompare(Entry)
    })
    try {
      await user.click(await screen.findByRole('button', { name: 'Eintrag' }))
      expect(opened).toEqual([answer.id])
      expect(screen.queryByRole('button', { name: 'Mit Direktabfrage vergleichen' })).toBeNull()
    } finally {
      act(() => off())
    }
    // Unregistered, the entry registered before (the dialogue's) is back.
    expect(screen.queryByRole('button', { name: 'Eintrag' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Mit Direktabfrage vergleichen' })).toBeEnabled()
  })
})

describe('the fake server as WP75 answers', () => {
  const ID = actionView('chain_reference').id
  const server = (level: LevelName = 'Prüfen', script: ChainScript = {}) =>
    modelServer([actionView('chain_reference', {}, level)], undefined, script)
  const ok = <T,>(value: T): Exclude<T, FakeError> => {
    if (isFakeError(value)) throw new Error(JSON.stringify(value.body))
    return value as Exclude<T, FakeError>
  }

  test('a plan that never started is not aborted (409); a token may neither adopt nor edit', () => {
    const fake = server()
    const refused = fake.abort(ID)
    expect(isFakeError(refused) && [refused.status, refused.body.code]).toEqual([
      409,
      'not_approved',
    ])
    const adopt = fake.adopt(ID, true)
    const edit = fake.plan(ID, { change: [], remove: [5] }, true)
    for (const answer of [adopt, edit])
      expect(isFakeError(answer) && [answer.status, answer.body.code]).toEqual([
        403,
        'session_required',
      ])
  })

  test('approve turns a waiting step back into planned; reject skips the steps ahead', () => {
    const fake = server('Teilautonom')
    ok(fake.approve(ID))
    ok(fake.run(ID))
    const halted = ok(fake.poll(ID))
    expect(halted.status).toBe('proposed')
    expect(halted.steps[1]?.status).toBe('waiting')
    expect(ok(fake.approve(ID)).steps[1]?.status).toBe('planned')
    const other = server('Teilautonom')
    ok(other.approve(ID))
    ok(other.run(ID))
    ok(other.poll(ID))
    const rejected = ok(other.reject(ID, null))
    expect(rejected.steps.map((s) => s.status)).toEqual([
      'ok',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ])
  })

  const code = (answer: unknown) =>
    isFakeError(answer) ? [answer.status, answer.body.code, answer.body.details] : answer

  test('run answers running with the steps unchanged; only the last step is held to the size', () => {
    const over = MODEL_LIMITS.max_features + 1
    const fake = server('Prüfen', { hits: { 4: over } })
    ok(fake.approve(ID))
    const running = ok(fake.run(ID))
    expect(running.status).toBe('running')
    expect(running.steps.every((s) => s.status === 'planned')).toBe(true)
    // Step 4 beyond the limit is counted; the last, within it, is the result.
    const done = ok(fake.poll(ID))
    expect(done.status).toBe('done')
    expect(done.steps[3]?.status).toBe('ok')
    expect(done.stamp?.count).toBe(CHAIN_HITS[4])
    // The last beyond it fails; the step before it is beyond too: nothing to adopt.
    const both = server('Prüfen', { hits: { 4: over, 5: over } })
    ok(both.approve(ID))
    ok(both.run(ID))
    const stopped = ok(both.poll(ID))
    expect([stopped.status, stopped.stop_reason]).toEqual(['limited', 'result_too_large'])
    expect(stopped.error?.details).toEqual({ step: 5, value: over, max: MODEL_LIMITS.max_features })
    expect([stopped.query, stopped.stamp]).toEqual([null, null])
    expect(code(both.adopt(ID))).toEqual([409, 'not_approved', { id: ID, status: 'limited' }])
  })

  test('busy names the call in flight; abort without a run in flight ends at once', () => {
    const fake = server('Prüfen', { busy: 1 })
    ok(fake.approve(ID))
    expect(code(fake.run(ID))).toEqual([409, 'busy', { reason: 'running', id: ID }])
    ok(fake.run(ID))
    fake.lose(ID)
    const stopped = ok(fake.abort(ID))
    expect([stopped.status, stopped.stop_reason]).toEqual(['limited', 'aborted'])
    const calls = server('Prüfen', { busyCalls: 1 })
    ok(calls.approve(ID))
    expect(code(calls.run(ID))).toEqual([503, 'busy', { reason: 'model_calls' }])
  })

  test('a re-plan: a lost connection counts none; a buffer at the end or a class off stops it', () => {
    const error = { 3: { code: 'unknown_attribute' as const } }
    const lost = server('Automatisch', {
      errors: error,
      replanError: { code: 'connection_not_available', details: { reason: 'changed' } },
    })
    ok(lost.run(ID))
    const gone = ok(lost.poll(ID))
    expect([gone.stop_reason, gone.replans, gone.error?.code]).toEqual([
      'replan_limit',
      0,
      'connection_not_available',
    ])
    const buffer = PLAN.steps[1] as PlannedStep
    const ends = server('Automatisch', { errors: error, replans: [[buffer]] })
    ok(ends.run(ID))
    const refused = ok(ends.poll(ID))
    expect([refused.stop_reason, refused.replans, refused.error?.code]).toEqual([
      'replan_limit',
      1,
      'not_representable',
    ])
    // A level that forbids derived layers by now (as it was: the record's snapshot).
    const view = actionView('chain_reference', {}, 'Automatisch')
    const off = modelServer(
      [{ ...view, level: { ...view.level, matrix: { ...view.level.matrix, derive: 'off' } } }],
      undefined,
      {
        errors: error,
        replans: [[buffer, { ...(PLAN.steps[2] as PlannedStep), arguments: { of: 1, in: 4 } }]],
      },
    )
    ok(off.run(ID))
    const forbidden = ok(off.poll(ID))
    expect([forbidden.stop_reason, forbidden.error?.code, forbidden.error?.details]).toEqual([
      'replan_limit',
      'class_not_allowed',
      { part: 'derive', step: 4 },
    ])
  })

  test('adopt: claimed already ⇒ 409; every query slot taken ⇒ 503', () => {
    const fake = server('Automatisch')
    ok(fake.run(ID))
    ok(fake.poll(ID))
    fake.queriesBusy(true)
    expect((code(fake.adopt(ID)) as unknown[])[0]).toBe(503)
    fake.queriesBusy(false)
    fake.claim(ID)
    expect((code(fake.adopt(ID)) as unknown[]).slice(0, 2)).toEqual([409, 'already_decided'])
  })
})

describe('entry', () => {
  test('a chain refused as not representable does not offer the chain again', async () => {
    const user = fakeTimers()
    const refused = actionView('not_representable', { approach: 'chain' })
    backend(promptFlow(thinkingView('not_representable'), refused))
    useModel.getState().setApproach('chain')
    useModel.getState().setOpen(true)
    renderAt('/', <Workplace />)
    await waitFor(() => expect(document.getElementById('prompt-panel')).not.toBeNull())
    await ask(user, refused.prompt)
    await isThinking()
    await tick()
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: /Werkzeugkette versuchen/ })).toBeNull()
  })

  test('the chain can be chosen; M3.3 offers it on not_representable, filling the field, never sending', async () => {
    const user = fakeTimers()
    const refused = actionView('not_representable')
    const calls = backend(promptFlow(thinkingView('not_representable'), refused))
    useModel.getState().setOpen(true)
    renderAt('/', <Workplace />)
    await waitFor(() => expect(document.getElementById('prompt-panel')).not.toBeNull())
    const chain = screen.getByRole('radio', { name: 'Werkzeugkette' })
    expect(chain).toBeEnabled()
    expect(screen.queryByText('ab E2.5')).toBeNull()
    await ask(user, refused.prompt)
    await isThinking()
    await tick()
    await user.click(await screen.findByRole('button', { name: 'Mit Werkzeugkette versuchen ›' }))
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(refused.prompt)
    expect(chain).toBeChecked()
    await tick(3000)
    expect(hits(calls, 'prompt')).toHaveLength(1)
  })
})

test('in pseudo, plan, run and stop show no text outside the catalog', async () => {
  activate('pseudo', pseudo)
  try {
    const { server } = await planned('Teilautonom', {
      script: { hits: { 5: 12400 } },
    })
    const data = [
      CASE.prompt,
      PLAN.explanation,
      ...PLAN.assumptions.map((a) => a.text),
      ...PLAN.steps.flatMap((s) => [s.text, s.tool]),
      'Schulen',
      'Strassen',
      'Gemeinden · Steuern',
      'Lokales Modell',
      'Teilautonom',
      'result_too_large',
      // The steps in words: field names and values are data (editor/describe.ts).
      'Schulstufe',
      'Strassenklasse',
      'Steueranlage',
      'primar',
      'kantonsstrasse_b',
      '1.6',
    ]
    expect(strays(data)).toEqual([])
    // Starten: the first button of the approval.
    const start = (await findCard()).querySelector<HTMLButtonElement>('section button.btn-primary')
    await act(async () => start?.click())
    await tick()
    await phase('halt')
    expect(strays(data)).toEqual([])
    server.hold(false)
    const free = (await findCard()).querySelector<HTMLButtonElement>('li button.btn-primary')
    await act(async () => free?.click())
    await phase('running')
    expect(strays(data)).toEqual([])
    for (let i = 0; i < 3; i++) await tick()
    await phase('stopped')
    expect(strays(data)).toEqual([])
  } finally {
    cleanup()
    activate('de')
  }
})
