// The tool chain's plan and run (plan WP77, design M8, M9) against the fake
// server of model-mocks.ts, which answers WP75's routes as P4 and the 1.2
// diagram say (what it assumes beyond them is listed there). Server-shaped
// data throughout: compact queries in the record, a full dump in the rows'
// query, naive UTC times with microseconds.
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
  type LevelName,
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
import { useChain } from './flow'
import { CHAIN_S, MAX_FEATURES, MAX_STEPS, modelSees, valueFields, withValue } from './steps'

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
    expect(CHAIN_S).toBe(MODEL_LIMITS.chain_s)
    expect(MAX_FEATURES).toBe(MODEL_LIMITS.max_features)
  })

  test('"Modell sieht" says only what D9 allows: ok or the code, empty or not, the count', () => {
    expect(modelSees({ outcome: 'ok', empty: false, count: 24 })).toBe('ok · nicht leer · 24')
    expect(modelSees({ outcome: 'ok', empty: true, count: 0 })).toBe('ok · leer · 0')
    expect(modelSees({ outcome: 'error', code: 'unknown_attribute', part: 'typ' })).toBe(
      'Fehler · unknown_attribute · typ',
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
    expect(steps[0]).toHaveTextContent('Attributfilter · Freigabe')
    expect(steps[1]).toHaveTextContent('Abgeleitete Layer · Freigabe')
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
    expect(steps[1]).toHaveTextContent('Abgeleitete Layer · Freigabe')
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
    expect(step).toHaveTextContent('Braucht Freigabe: Abgeleitete Layer (Stufe Teilautonom)')
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

    // Keep step 3, remove step 5 (read by none).
    await user.click(within(form).getByRole('button', { name: /^Schritt 3 behalten/ }))
    await user.click(within(form).getByRole('button', { name: /^Schritt 5 entfernen/ }))
    await user.click(within(form).getByRole('button', { name: 'Änderungen übernehmen' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Plan anpassen' })).toBeNull())

    const patches = calls.filter((c) => c.key.endsWith('/plan')).map((c) => c.body)
    expect(patches[1]).toEqual({
      change: [{ position: 2, arguments: { ...PLAN.steps[1]?.arguments, distance_m: 300 } }],
      remove: [5],
    })
    const after = await findCard()
    expect(within(after).getByText('Geplante Schritte · 4 von höchstens 8')).toBeInTheDocument()
    expect(within(after).getAllByRole('listitem', { name: /^Schritt \d: / })).toHaveLength(4)
    expect(hits(calls, 'run')).toEqual([])
    unchanged()
  })
})

const formatted = (n: number) => new Intl.NumberFormat('de-CH').format(n)
const secondsText = (ms: number) =>
  `${new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000)} s`

describe('run (M9)', () => {
  test('M9.1: step n of m, elapsed against the 5:00 cap, results and "Modell sieht" per step, dimmed on the map', async () => {
    const { calls, server, answer } = await running()
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
    // Elapsed: the two finished steps (0.4 s + 1.8 s, fixture) and the third so far.
    const clock = screen.getByLabelText('Laufzeit der Kette')
    expect(clock).toHaveTextContent(/^0:0[2-4] \/ max\. 5:00$/)
    await tick(3000)
    expect(screen.getByLabelText('Laufzeit der Kette')).toHaveTextContent(
      /^0:0[5-7] \/ max\. 5:00$/,
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

    // The intermediate layers, dimmed, with the caption that they are not applied.
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.key === 'POST /api/query')
          .map((c) => (c.body as { source: string }).source),
      ).toEqual(expect.arrayContaining([`chain_${answer.id}_1`, `chain_${answer.id}_2`])),
    )
    const caption = screen.getByRole('note', { name: 'Zwischenstand der Kette' })
    expect(caption).toHaveTextContent('Zwischenstand gedämpft · nicht angewendet')
    expect(caption).toHaveTextContent(`Schritt 1 · ${formatted(CHAIN_HITS[0] ?? 0)}`)
  })

  test('the status region speaks per step change, at most once every 3 s', async () => {
    const { server } = await running()
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
    expect(within(end).getByRole('button', { name: 'Ergebnis übernehmen' })).toBeEnabled()
    // No comparison until WP78 registers one.
    expect(within(end).queryByRole('button', { name: 'Mit Direktabfrage vergleichen' })).toBeNull()
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
    const { user, calls, answer } = await running()
    await tick()
    await user.click(within(await findCard()).getByRole('button', { name: 'Abbrechen' }))
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
    const second = formatted(CHAIN_HITS[1] ?? 0)
    await user.click(screen.getByRole('button', { name: `Zwischenstand übernehmen (${second})` }))
    await phase('closed')
    expect(rows(useAnalysis.getState().tree)).toHaveLength(1)
    expect(Object.keys(useAnalysis.getState().origin.marks)).toHaveLength(1)
  })

  const REVISED = Array.from({ length: 7 }, (_, i) => ({
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
      script: { limit: { position: 2, reason: 'result_too_large', value: 12400 } },
      title: 'Ergebnisgrösse überschritten',
      text: /Schritt 2 hätte 12.400 Objekte erzeugt \(höchstens 10.000\)\./,
      adoptable: CHAIN_HITS[0],
    },
    {
      reason: 'step_limit',
      // Step 2 empty: the re-plan would bring 2 + 7 = 9 steps (P4: re-planned ones count).
      script: {
        hits: { 2: 0 },
        replans: [{ steps: REVISED, classes: REVISED.map(() => 'query') }],
      },
      title: 'Schrittzahl erreicht',
      text: /mehr als 8 Schritte, neu geplante eingeschlossen \(höchstens 8\)\./,
      // The empty step 2 is complete: its 0 hits are the last result.
      adoptable: 0,
    },
    {
      reason: 'time_limit',
      script: { limit: { position: 2, reason: 'time_limit' } },
      title: 'Laufzeit überschritten',
      text: /höchstens 5:00 je Anfrage/,
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

  test('M9.5 result_too_large: the step says what the model saw', async () => {
    await running({ script: { limit: { position: 2, reason: 'result_too_large' } } })
    await tick()
    await phase('stopped')
    expect(within(stepItem(2)).getByText(/^Modell sieht:/)).toHaveTextContent(
      'Modell sieht: Fehler · result_too_large',
    )
  })

  test('a re-plan under Prüfen asks again for the rest; revised steps are marked', async () => {
    const revised = REVISED.slice(0, 3)
    const { user, calls } = await running({
      script: {
        hits: { 2: 0 },
        replans: [{ steps: revised, classes: ['query', 'spatial', 'query'] }],
      },
    })
    await tick()
    await tick()
    await phase('halt')
    expect(stepItem(3)).toHaveTextContent('neu geplant')
    expect(
      within(await findCard()).getByText('Geplante Schritte · 5 von höchstens 8'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Freigeben und fortsetzen' }))
    await phase('running')
    for (let i = 0; i < 3; i++) await tick()
    await phase('done')
    expect(hits(calls, 'approve')).toHaveLength(2)
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
    await tick(3000)
    expect(hits(calls, 'run')).toHaveLength(1)
    fails = false
    await user.click(retry)
    await phase('running')
    expect(useChain.getState().failure).toBeNull()
  })

  test('the comparison hook: WP78 registers the dialog, the finished chain offers it', async () => {
    const opened: number[] = []
    const off = registerCompare((view) => opened.push(view.id))
    try {
      const { user, answer } = await running()
      for (let i = 0; i < 5; i++) await tick()
      await phase('done')
      await user.click(screen.getByRole('button', { name: 'Mit Direktabfrage vergleichen' }))
      expect(opened).toEqual([answer.id])
    } finally {
      off()
    }
  })
})

describe('entry', () => {
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
      script: { limit: { position: 4, reason: 'result_too_large' } },
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
