// Approval, auto execution, undo and the level display (plan WP72, design
// M5–M7) against the fake server of model-mocks.ts, which answers the
// enforcement routes as the record store does (WP63/WP70). Server-shaped
// data throughout: compact queries, naive UTC times.
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AttributeRow } from '../../analysis/model'
import { useAnalysis, type AnalysisSnapshot } from '../../analysis/store'
import { newAttributeRow, rows } from '../../analysis/tree'
import type { LLMOptions, ModelActionView } from '../../api/client'
import { activate } from '../../i18n/i18n'
import { messages as pseudo } from '../../locales/pseudo.po'
import {
  actionView,
  levelOption,
  modelServer,
  serverShape,
  thinkingView,
  type LevelName,
} from '../../test/model-mocks'
import {
  ask,
  backend,
  done,
  enforcement,
  fakeTimers,
  json,
  llmOptions,
  promptFlow,
  resetStores,
  thinking,
  tick,
} from '../../test/prompt-panel'
import { strays } from '../../test/pseudo'
import { renderAt } from '../../test/render'
import { ModelChoice } from '../../workplace/ModelChoice'
import { Workplace } from '../../workplace/Workplace'
import { useModel } from '../store'
import { startRejecting, useApproval } from './flow'

beforeEach(resetStores)
afterEach(done)

const LEVEL_ID: Record<LevelName, number> = {
  Assistenz: 1,
  Prüfen: 2,
  Teilautonom: 3,
  Automatisch: 4,
}

type Calls = { key: string; body: unknown }[]
const keys = (calls: Calls) =>
  calls.map((c) => c.key).filter((k) => /\/(approve|reject|execute|undo|touched|decide)$/.test(k))
const bodies = (calls: Calls, step: string) =>
  calls.filter((c) => c.key.endsWith(`/${step}`)).map((c) => c.body)

/**
 * Sends the reference question at ``level``; the first poll brings ``answer``
 * (the server's record for it). The fake server answers every enforcement route.
 */
async function answered(
  level: LevelName = 'Prüfen',
  answer: ModelActionView = actionView('reference', {}, level),
  options: { server?: ModelActionView; routes?: object; ui?: 'both' } = {},
) {
  const user = fakeTimers()
  const server = modelServer([options.server ?? answer])
  const calls = backend(
    {
      ...promptFlow(thinkingView('reference', level), answer),
      ...enforcement(server, answer.id),
      ...options.routes,
    },
    llmOptions(1, LEVEL_ID[level]),
  )
  useModel.getState().setOpen(true)
  renderAt(
    '/',
    options.ui ? (
      <>
        <ModelChoice />
        <Workplace />
      </>
    ) : (
      <Workplace />
    ),
  )
  await waitFor(() => expect(document.getElementById('prompt-panel')).not.toBeNull())
  await ask(user, answer.prompt)
  await thinking()
  await tick()
  // By its place, not its name: the pseudo locale renames it.
  const card = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('#prompt-panel article:not([aria-busy])')
    if (!found) throw new Error('no answer')
    return found
  })
  return { user, calls, card, answer, server }
}

/** A state of the analysis before the model's change: one hand row, one model row, "Nur in". */
function priorState(): AnalysisSnapshot {
  const analysis = useAnalysis.getState()
  const own: AttributeRow = { ...newAttributeRow('standorte'), operator: 'gt', value: 1 }
  const model: AttributeRow = { ...newAttributeRow('typ'), operator: 'eq', value: 'sekundar' }
  analysis.edit()
  analysis.addNode('root', own)
  analysis.addNode('root', model)
  useAnalysis.getState().apply()
  useAnalysis.getState().markOrigin([model.id])
  useAnalysis.getState().setRestriction({ kind: 'view', bbox: [7.8, 46.8, 8, 47] })
  return structuredClone(useAnalysis.getState().snapshot())
}

const marks = () => Object.keys(useAnalysis.getState().origin.marks)

describe('approval (M5)', () => {
  test('M5.1: change list, preview 137 → 10, the classes that need approval; Annehmen has the focus', async () => {
    const { card, calls } = await answered()
    expect(within(card).getAllByRole('status')[0]).toHaveTextContent('wartet auf Freigabe')
    const approval = within(card).getByRole('region', { name: 'Freigabe' })
    const changes = within(approval).getAllByRole('listitem')
    // Three conditions are new; result layer and restriction stay (Schulen, none).
    expect(changes).toHaveLength(3)
    for (const change of changes) expect(change).toHaveTextContent(/^\+ neu:/)
    expect(changes[0]).toHaveTextContent('Schulstufe ist eins von primar')
    expect(await within(approval).findByLabelText('Trefferzahl der Vorschau')).toHaveTextContent(
      'Treffer: 137 → 10 (Vorschau, gestrichelt auf der Karte)',
    )
    expect(approval).toHaveTextContent(
      'Braucht Freigabe: Attributfilter, Raumfilter (Stufe Prüfen)',
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Annehmen' })).toHaveFocus())
    expect(screen.getByText('Esc = Ablehnen')).toBeInTheDocument()
    // The map says the dashed layer is a preview, nothing is applied yet.
    expect(screen.getByText('Vorschau gestrichelt · noch nicht angewendet')).toBeInTheDocument()
    expect(calls.filter((c) => c.key.endsWith('/preview'))).toHaveLength(1)
    expect(keys(calls)).toEqual([])
    expect(useAnalysis.getState().tree.children).toEqual([])
    // No timeout: a minute later it still waits.
    await tick(60_000)
    expect(within(card).getByRole('button', { name: 'Annehmen' })).toBeEnabled()
    expect(keys(calls)).toEqual([])
  })

  test('Annehmen approves and executes; the stored query is the analysis, marked; Zurücknehmen restores it deep-equal, marks included', async () => {
    const before = priorState()
    const { user, card, calls, answer } = await answered()
    const approval = within(card).getByRole('region', { name: 'Freigabe' })
    // Against the state now: the hand row and the old model row go, "Nur in" goes.
    expect(within(approval).getByRole('list', { name: 'Änderungen' })).toHaveTextContent(
      /− entfällt: nur im Kartenausschnitt/,
    )
    await user.click(within(card).getByRole('button', { name: 'Annehmen' }))

    await waitFor(() =>
      expect(keys(calls)).toEqual([
        `POST /api/model/actions/${answer.id}/approve`,
        `POST /api/model/actions/${answer.id}/execute`,
      ]),
    )
    // ``execute`` takes no body: the server runs its stored query.
    expect(bodies(calls, 'execute')).toEqual([undefined])
    const applied = useAnalysis.getState()
    expect(rows(applied.tree)).toHaveLength(3)
    expect(applied.restriction).toBeNull()
    expect(marks().sort()).toEqual(
      rows(applied.tree)
        .map((r) => r.id)
        .sort(),
    )
    await waitFor(() =>
      expect(within(card).getAllByRole('status')[0]).toHaveTextContent('angewendet'),
    )
    expect(within(card).queryByRole('region', { name: 'Freigabe' })).toBeNull()

    await user.click(within(card).getByRole('button', { name: 'Zurücknehmen' }))
    await waitFor(() => expect(useModel.getState().views[answer.id]?.status).toBe('undone'))
    expect(useAnalysis.getState().snapshot()).toEqual(before)
    expect(marks()).toHaveLength(1)
    expect(within(card).getAllByRole('status')[0]).toHaveTextContent('zurückgenommen')
    expect(card).toHaveTextContent('kein „Wiederholen“')
    expect(within(card).queryByRole('button', { name: /Wiederholen|Zurücknehmen/ })).toBeNull()
  })

  test('M5.2: a hand edit meanwhile is named and the list recomputed; Klassik stays usable', async () => {
    const { card } = await answered()
    const approval = within(card).getByRole('region', { name: 'Freigabe' })
    expect(within(approval).queryByText(/Stand hat sich seit dem Vorschlag geändert/)).toBeNull()
    act(() => {
      const analysis = useAnalysis.getState()
      analysis.edit()
      analysis.addNode('root', { ...newAttributeRow('standorte'), operator: 'gt', value: 1 })
      useAnalysis.getState().apply()
    })
    const hint = await within(approval).findByText('Stand hat sich seit dem Vorschlag geändert')
    expect(hint.closest('[role="status"]')).not.toBeNull()
    const changes = within(approval).getAllByRole('listitem')
    expect(changes).toHaveLength(4)
    expect(changes[0]).toHaveTextContent('− entfällt: Standorte > 1')
    // The hit count before is the analysis's now (counted after the editor's debounce).
    await tick(500)
    await waitFor(() =>
      expect(within(approval).getByLabelText('Trefferzahl der Vorschau')).toHaveTextContent(
        'Treffer: 10 → 10',
      ),
    )
  })

  test('M5.3: Ablehnen asks for the optional reason; the chip goes with the rejection', async () => {
    const { user, card, calls } = await answered()
    await user.click(within(card).getByRole('button', { name: 'Ablehnen' }))
    const reasons = within(card).getByRole('radiogroup', { name: 'Grund (optional)' })
    expect(within(card).getByRole('button', { name: 'Ablehnen' })).toHaveFocus()
    await user.click(within(reasons).getByRole('radio', { name: 'falscher Wert' }))
    expect(within(reasons).getByRole('radio', { name: 'falscher Wert' })).toBeChecked()
    await user.click(within(card).getByRole('button', { name: 'Ablehnen' }))

    await waitFor(() => expect(bodies(calls, 'reject')).toEqual([{ reason: 'wrong_value' }]))
    await waitFor(() =>
      expect(within(card).getAllByRole('status')[0]).toHaveTextContent('abgelehnt'),
    )
    expect(card).toHaveTextContent('Grund:falscher Wert')
    expect(useAnalysis.getState().tree.children).toEqual([])
    expect(keys(calls)).toEqual([`POST /api/model/actions/${actionView('reference').id}/reject`])
  })

  test('Esc rejects at once, without a reason, and leaves the panel open', async () => {
    const { user, calls, card } = await answered()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Annehmen' })).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(bodies(calls, 'reject')).toEqual([{ reason: null }]))
    expect(screen.getByRole('region', { name: 'Prompt' })).toBeInTheDocument()
    await waitFor(() => expect(card).toHaveTextContent('Ohne Grund abgelehnt.'))
  })

  test('Anpassen … opens B2 with the draft; what it applies is reported as adjusted', async () => {
    const { user, card, calls } = await answered()
    await user.click(within(card).getByRole('button', { name: 'Anpassen …' }))
    const editor = await screen.findByRole('region', { name: 'Abfrage-Editor' })
    expect(within(editor).getAllByText('Modell')).toHaveLength(3)
    // Applied unchanged, it is still the user's adjustment: the level asked for a decision.
    await user.click(within(editor).getByRole('button', { name: 'Übernehmen' }))
    await waitFor(() => expect(bodies(calls, 'decide')).toHaveLength(1))
    expect(bodies(calls, 'decide')[0]).toMatchObject({ decision: 'adjusted' })
    expect(bodies(calls, 'decide')[0]).not.toHaveProperty('applied_by_hand')
    expect(keys(calls).filter((k) => /approve|execute/.test(k))).toEqual([])
    await waitFor(() =>
      expect(useModel.getState().views[actionView('reference').id]?.decision).toBe('adjusted'),
    )
  })

  test('a refused approval is an alert and changes nothing (class_not_allowed, 501 before WP70)', async () => {
    const answer = actionView('reference')
    // The server's record says a class is off (as at another level); the client's does not.
    const off = {
      classes: ['query' as const, 'spatial' as const],
      needs_approval: ['query' as const],
      off: ['spatial' as const],
      cell: 'off' as const,
    }
    const { user, card } = await answered('Prüfen', answer, {
      server: { ...answer, governance: off },
    })
    await user.click(within(card).getByRole('button', { name: 'Annehmen' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'Auf der Stufe „Prüfen" ist „spatial" nicht erlaubt.',
    )
    expect(useAnalysis.getState().tree.children).toEqual([])
    cleanup()

    resetStores()
    const stub = await answered('Prüfen', answer, {
      routes: {
        [`POST /api/model/actions/${answer.id}/approve`]: () =>
          json({ code: 'not_implemented', message: 'Not built yet (WP70).', details: {} }, 501),
      },
    })
    await stub.user.click(within(stub.card).getByRole('button', { name: 'Annehmen' }))
    expect(await within(stub.card).findByRole('alert')).toHaveTextContent(
      'Dieser Teil der Modellunterstützung ist noch nicht verfügbar.',
    )
    expect(useAnalysis.getState().tree.children).toEqual([])
  })

  test('a failed run after the approval says so and can be repeated; the state stays', async () => {
    let runs = 0
    const answer = actionView('reference')
    const server = modelServer([answer])
    const { user, card, calls } = await answered('Prüfen', answer, {
      routes: {
        ...enforcement(server, answer.id),
        [`POST /api/model/actions/${answer.id}/execute`]: () => {
          runs += 1
          if (runs === 1)
            return json({ code: 'result_too_large', message: 'too large', details: {} }, 400)
          const done = server.execute(answer.id)
          return json(done)
        },
      },
    })
    await user.click(within(card).getByRole('button', { name: 'Annehmen' }))
    expect(await within(card).findByRole('alert')).toBeInTheDocument()
    expect(card).toHaveTextContent('Ihr Stand ist unverändert.')
    expect(useAnalysis.getState().tree.children).toEqual([])
    expect(within(card).getAllByRole('status')[0]).toHaveTextContent('freigegeben')
    await user.click(within(card).getByRole('button', { name: 'Erneut versuchen' }))
    await waitFor(() => expect(rows(useAnalysis.getState().tree)).toHaveLength(3))
    expect(bodies(calls, 'approve')).toHaveLength(1)
  })

  test('a server-shaped query (full dump) applies as the editor writes it', async () => {
    const answer = actionView('reference', { query: serverShape(actionView('reference').query) })
    const { user, card } = await answered('Prüfen', answer)
    await user.click(within(card).getByRole('button', { name: 'Annehmen' }))
    await waitFor(() => expect(rows(useAnalysis.getState().tree)).toHaveLength(3))
  })
})

describe('auto (M6)', () => {
  const AUTO = () => actionView('reference', {}, 'Teilautonom')

  test('M6.1: an auto answer is executed at once; the bar names it; × hides only', async () => {
    const { user, calls, card } = await answered('Teilautonom', AUTO())
    await waitFor(() => expect(rows(useAnalysis.getState().tree)).toHaveLength(3))
    // No question asked: execute only, never approve.
    expect(keys(calls)).toEqual([`POST /api/model/actions/${AUTO().id}/execute`])
    expect(marks()).toHaveLength(3)
    await waitFor(() =>
      expect(within(card).getAllByRole('status')[0]).toHaveTextContent('automatisch angewendet'),
    )
    const bar = screen.getByRole('complementary', { name: 'Modell hat angewendet' })
    await tick(500)
    await waitFor(() =>
      expect(within(bar).getByRole('status')).toHaveTextContent(
        /^Modell hat angewendet: Schulstufe ist eins von primar, .* · 10 von 137$/,
      ),
    )
    await user.click(within(bar).getByRole('button', { name: 'Änderung ansehen' }))
    expect(within(bar).getAllByRole('listitem')).toHaveLength(3)
    await user.click(within(bar).getByRole('button', { name: 'Hinweis ausblenden' }))
    expect(screen.queryByRole('complementary', { name: 'Modell hat angewendet' })).toBeNull()
    // Hidden, not over: the answer keeps its undo.
    expect(within(card).getByRole('button', { name: 'Rückgängig' })).toBeEnabled()
  })

  test('M6.2: Rückgängig restores the analysis completely, origin marks included; no redo', async () => {
    const before = priorState()
    const { user, calls, card } = await answered('Teilautonom', AUTO())
    const bar = await screen.findByRole('complementary', { name: 'Modell hat angewendet' })
    expect(useAnalysis.getState().snapshot()).not.toEqual(before)
    await user.click(within(bar).getByRole('button', { name: 'Rückgängig' }))
    await waitFor(() => expect(bodies(calls, 'undo')).toHaveLength(1))
    await waitFor(() => expect(useAnalysis.getState().snapshot()).toEqual(before))
    expect(useAnalysis.getState().origin).toEqual(before.origin)
    expect(screen.queryByRole('complementary', { name: 'Modell hat angewendet' })).toBeNull()
    await waitFor(() =>
      expect(within(card).getAllByRole('status')[0]).toHaveTextContent('zurückgenommen'),
    )
    expect(card).toHaveTextContent('War automatisch angewendet.')
    expect(screen.queryByRole('button', { name: /Wiederholen|Rückgängig/ })).toBeNull()
  })

  test('a hand edit after the change ends its undo: reported once with touched, the button says why', async () => {
    const { calls, card, server, answer } = await answered('Teilautonom', AUTO())
    await screen.findByRole('complementary', { name: 'Modell hat angewendet' })
    act(() => useAnalysis.getState().setRestriction({ kind: 'view', bbox: [7.8, 46.8, 8, 47] }))
    act(() => useAnalysis.getState().setRestriction(null))
    await waitFor(() => expect(bodies(calls, 'touched')).toHaveLength(1))
    // The bar stays until the next change: this was one.
    expect(screen.queryByRole('complementary', { name: 'Modell hat angewendet' })).toBeNull()
    const undo = within(card).getByRole('button', { name: 'Rückgängig' })
    expect(undo).toBeDisabled()
    expect(undo).toHaveAccessibleDescription(
      'Seit der Modelländerung von Hand geändert. Bitte im Editor zurücksetzen.',
    )
    // The server holds the same rule past the surface.
    expect(server.undo(answer.id)).toMatchObject({ status: 409, body: { code: 'undo_blocked' } })
  })

  test('an auto answer waits while the editor holds a draft, then runs', async () => {
    useAnalysis.getState().edit()
    const user = fakeTimers()
    const answer = AUTO()
    const server = modelServer([answer])
    const calls = backend(
      {
        ...promptFlow(thinkingView('reference', 'Teilautonom'), answer),
        ...enforcement(server, answer.id),
      },
      llmOptions(1, 3),
    )
    renderAt('/', <Workplace />)
    act(() => useModel.getState().sent(thinkingView('reference', 'Teilautonom')))
    await tick()
    await screen.findByRole('region', { name: 'Abfrage-Editor' })
    expect(keys(calls)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Verwerfen' }))
    await waitFor(() =>
      expect(keys(calls)).toEqual([`POST /api/model/actions/${answer.id}/execute`]),
    )
    await waitFor(() => expect(rows(useAnalysis.getState().tree)).toHaveLength(3))
  })

  test('M6.3 mixed level: the strictest cell governs; the class list says why', async () => {
    const mixed = actionView(
      'reference',
      {
        status: 'proposed',
        governance: {
          classes: ['query', 'spatial', 'derive'],
          cell: 'approve',
          needs_approval: ['derive'],
          off: [],
        },
      },
      'Teilautonom',
    )
    const { card, calls } = await answered('Teilautonom', mixed)
    const classes = within(card).getByRole('region', { name: 'Klassen dieser Antwort' })
    const items = within(classes).getAllByRole('listitem')
    expect(items.map((i) => i.textContent)).toEqual([
      'Attributfilter · auto',
      'Raumfilter · auto',
      'Abgeleitete Layer · Freigabe',
    ])
    expect(items[2]).toHaveAttribute('data-strictest', 'true')
    expect(card).toHaveTextContent(
      'Braucht Freigabe: Abgeleitete Layer. Die strengste Festlegung gilt für die ganze Antwort.',
    )
    expect(within(card).getByRole('button', { name: 'Annehmen' })).toBeEnabled()
    expect(keys(calls)).toEqual([])
  })

  test('a level with off parts keeps the hand-over (M4): no approval, no preview, no run', async () => {
    const { card, calls } = await answered('Assistenz')
    expect(within(card).getByRole('button', { name: 'In Editor übernehmen' })).toBeEnabled()
    expect(within(card).queryByRole('region', { name: 'Freigabe' })).toBeNull()
    await tick(2000)
    expect(calls.filter((c) => /preview|approve|execute/.test(c.key))).toEqual([])
  })
})

describe('level display (M7)', () => {
  test('M7.1: ⓘ opens what the model may do here, read only', async () => {
    backend({}, llmOptions(1, 3))
    renderAt('/', <ModelChoice />)
    await userEvent.click(await screen.findByRole('button', { name: 'Was darf das Modell hier?' }))
    const popover = await screen.findByRole('dialog', { name: 'Was darf das Modell hier?' })
    expect(popover).toHaveTextContent('Stufe Teilautonom · nur lesbar')
    const cells = within(popover)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent)
    expect(cells).toEqual([
      'Katalog lesen catalogauto',
      'Attributfilter queryauto',
      'Raumfilter spatialauto',
      'Abgeleitete Layer deriveFreigabe',
      'Darstellung displayauto',
    ])
    expect(within(popover).queryByRole('button')).toBeNull()
    expect(within(popover).queryByRole('textbox')).toBeNull()
  })

  test('M7.2: each level shows its short column; the matrix decides, never the name', async () => {
    // Names are free admin text: "Automatisch" here is a level that may do nothing.
    const options: LLMOptions = {
      ...llmOptions(),
      levels: [
        { ...levelOption('Assistenz'), name: 'Automatisch' },
        levelOption('Prüfen'),
        levelOption('Teilautonom'),
      ],
    }
    backend({}, options)
    renderAt('/', <ModelChoice />)
    await userEvent.click(await screen.findByRole('button', { name: 'Modellunterstützung wählen' }))
    const item = (name: RegExp) => screen.getByRole('menuitemradio', { name })
    expect(item(/Automatisch/)).toHaveTextContent('– – – – –')
    expect(item(/Prüfen/)).toHaveTextContent('F F F F F')
    expect(item(/Teilautonom/)).toHaveTextContent('A A A F A')
    expect(
      screen.getByText(/A = auto · F = Freigabe · – = aus; Spalten: catalog · query/),
    ).toBeInTheDocument()
  })

  test('M7.3: a change with an open approval asks in a focus-trapped dialog; the proposal stays bound', async () => {
    const { user, calls, card } = await answered('Prüfen', undefined, {
      ui: 'both',
      routes: { 'PUT /api/llm/options': llmOptions(1, 3) },
    })
    const choose = async () => {
      await user.click(screen.getByRole('button', { name: 'Modellunterstützung wählen' }))
      await user.click(await screen.findByRole('menuitemradio', { name: /Teilautonom/ }))
      return screen.findByRole('alertdialog', { name: 'Stufe auf Teilautonom wechseln?' })
    }
    let dialog = await choose()
    expect(dialog).toHaveTextContent('Er bleibt an die Stufe Prüfen gebunden')
    // The focus stays in the dialog.
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
    for (let i = 0; i < 4; i++) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
    await user.tab({ shift: true })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    // Esc cancels: nothing changes.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(calls.filter((c) => c.key === 'PUT /api/llm/options')).toEqual([])

    dialog = await choose()
    await user.click(within(dialog).getByRole('button', { name: 'Wechseln' }))
    await waitFor(() =>
      expect(calls.filter((c) => c.key === 'PUT /api/llm/options').map((c) => c.body)).toEqual([
        { level_id: 3 },
      ]),
    )
    // Bound to its level: still waiting, never applied by the new level's "auto".
    expect(
      await within(card).findByText(
        /Gestellt unter Stufe Prüfen; dieser Vorschlag folgt weiter ihr/,
      ),
    ).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Annehmen' })).toBeEnabled()
    expect(keys(calls)).toEqual([])
  })

  test('without an open approval the level changes at once', async () => {
    const calls = backend({ 'PUT /api/llm/options': llmOptions(1, 3) })
    renderAt('/', <ModelChoice />)
    await userEvent.click(await screen.findByRole('button', { name: 'Modellunterstützung wählen' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Teilautonom/ }))
    await waitFor(() =>
      expect(calls.filter((c) => c.key === 'PUT /api/llm/options')).toHaveLength(1),
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('pseudo locale', () => {
  const DATA = [
    'Schulen',
    'Strassen',
    'Gemeinden · Steuern',
    'Schulstufe',
    'Strassenklasse',
    'Steueranlage',
    'Standorte',
    'primar',
    'kantonsstrasse_b',
    'Lokales Modell',
    'host.docker.internal',
    'Prüfen',
    'Teilautonom',
    'Assistenz',
    'catalog',
    'query',
    'spatial',
    'derive',
    'display',
  ]
  const said = (view: ModelActionView) => {
    const answer = view.answer?.kind === 'query' ? view.answer : null
    return [
      view.prompt,
      answer?.explanation ?? '',
      ...(answer?.assumptions.map((a) => a.text) ?? []),
      JSON.stringify(view.query, null, 2),
    ]
  }

  async function inPseudo(check: () => Promise<void>) {
    activate('pseudo', pseudo)
    try {
      await check()
    } finally {
      cleanup()
      activate('de')
    }
  }

  test('the approval and the level popover show no text outside the catalog', async () => {
    await inPseudo(async () => {
      const { user, answer, calls } = await answered('Prüfen', undefined, { ui: 'both' })
      await waitFor(() => expect(calls.some((c) => c.key.endsWith('/preview'))).toBe(true))
      await tick(1000)
      expect(strays([...DATA, ...said(answer)])).toEqual([])
      act(() => startRejecting(answer.id))
      expect(strays([...DATA, ...said(answer)])).toEqual([])
      // The level popover (M7.1), opened through its ⓘ.
      await user.click(document.querySelector('button[aria-haspopup="dialog"]') as HTMLElement)
      await screen.findByRole('dialog')
      expect(strays([...DATA, ...said(answer)])).toEqual([])
    })
  })

  test('the auto notice and the undone answer show no text outside the catalog', async () => {
    await inPseudo(async () => {
      const answer = actionView('reference', {}, 'Teilautonom')
      const { user } = await answered('Teilautonom', answer)
      const bar = await waitFor(() => {
        const found = document.getElementById('model-notice')
        if (!found) throw new Error('no notice bar')
        return found
      })
      await tick(1000)
      await user.click(within(bar).getAllByRole('button')[2] as HTMLElement)
      expect(strays([...DATA, ...said(answer)])).toEqual([])
      await user.click(within(bar).getAllByRole('button')[1] as HTMLElement)
      await waitFor(() => expect(useApproval.getState().last).toBeNull())
      expect(strays([...DATA, ...said(answer)])).toEqual([])
    })
  })
})
