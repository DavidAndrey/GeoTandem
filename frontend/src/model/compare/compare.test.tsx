// The comparison of both approaches (plan WP78, design M10) against the fake
// server of model-mocks.ts, which answers WP76's routes as its server does
// (the rules and the server lines are listed there). Server-shaped data
// throughout: compact queries in the records, a full dump in the reason's
// conditions and the rows' query, naive UTC times with microseconds.
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { useAnalysis } from '../../analysis/store'
import { rows } from '../../analysis/tree'
import type { ModelActionView } from '../../api/client'
import { labelsFor } from '../../editor/fields'
import { activate } from '../../i18n/i18n'
import { messages as pseudo } from '../../locales/pseudo.po'
import {
  actionView,
  COMPARE_NAMES,
  compareReason,
  DIFFERS,
  differsFound,
  isFakeError,
  modelCase,
  modelServer,
  REFERENCE_IDS,
  REPEAT_ID,
  repeatView,
  thinkingView,
  type CaseId,
  type ChainScript,
  type FakeError,
  type LevelName,
  type ModelServer,
} from '../../test/model-mocks'
import {
  ask,
  backend,
  chainRoutes,
  compareRoutes,
  done,
  fakeTimers,
  json,
  LAYERS,
  llmOptions,
  resetStores,
  thinking as isThinking,
  tick,
} from '../../test/prompt-panel'
import { strays } from '../../test/pseudo'
import { renderAt } from '../../test/render'
import { Workplace } from '../../workplace/Workplace'
import { accept, undo, useApproval } from '../approval/flow'
import { approveChain } from '../chain/flow'
import { clearHistory } from '../panel/state'
import { compactQuery } from '../readable'
import { resumed, sent, useModel } from '../store'
import { openComparison, repeat, repeatRefusal, takeRefusal } from './flow'
import { conditionText, featureNames, reasonLines, type Words } from './words'

beforeEach(resetStores)
afterEach(done)

const LEVEL_ID: Record<LevelName, number> = {
  Assistenz: 1,
  Prüfen: 2,
  Teilautonom: 3,
  Automatisch: 4,
}

const DIRECT_ID = actionView('reference').id
const CHAIN_ID = actionView('chain_reference').id
const REFERENCE = modelCase('reference')

type Calls = { key: string; body: unknown }[]
const posted = (calls: Calls, id: number, step: string) =>
  calls.filter((c) => c.key === `POST /api/model/actions/${id}/${step}`)

/** The latest answer card, by its place (the pseudo locale renames its label). */
const latestCard = () =>
  waitFor(() => {
    const cards = document.querySelectorAll<HTMLElement>('#prompt-panel article')
    const last = cards[cards.length - 1]
    if (!last || last.getAttribute('aria-busy') === 'true') throw new Error('no answer yet')
    return last
  })

const dialog = () => screen.findByRole('dialog', { name: /Vergleich · gleiche Frage/ })

/**
 * Asks the reference question (``first``: its case) at ``level``; the first
 * poll brings the answer. Every route of the record, its repeats (the model
 * answers case ``repeat``) and the comparison is the fake server's.
 */
async function asked(
  first: CaseId,
  repeat: CaseId,
  level: LevelName = 'Prüfen',
  options: {
    script?: ChainScript
    records?: ModelActionView[]
    routes?: (server: ModelServer) => object
    /** The account's level when the repeat is asked (default ``level``). */
    repeatLevel?: LevelName
  } = {},
) {
  const user = fakeTimers()
  const answer = actionView(first, {}, level)
  const server = modelServer([answer, ...(options.records ?? [])], undefined, options.script)
  const calls = backend(
    {
      ...chainRoutes(server, thinkingView(first, level)),
      ...compareRoutes(server, [answer.id], repeat, options.repeatLevel ?? level),
      ...options.routes?.(server),
    },
    llmOptions(1, LEVEL_ID[level]),
  )
  useModel.getState().setApproach(answer.approach)
  useModel.getState().setOpen(true)
  const view = renderAt('/', <Workplace />)
  await waitFor(() => expect(document.getElementById('prompt-panel')).not.toBeNull())
  await ask(user, answer.prompt)
  await isThinking()
  await tick()
  return { user, calls, server, answer, view, card: await latestCard() }
}

/** The direct answer under *Prüfen*, accepted: applied (design M10.1's starting point). */
async function applied(repeat: CaseId = 'chain_reference', script: ChainScript = {}) {
  const started = await asked('reference', repeat, 'Prüfen', { script })
  await started.user.click(within(started.card).getByRole('button', { name: 'Annehmen' }))
  await waitFor(() => expect(started.server.record(DIRECT_ID)?.status).toBe('applied'))
  await waitFor(() => expect(useModel.getState().views[DIRECT_ID]?.status).toBe('applied'))
  return started
}

/** ⋯ of the latest card, then *Mit Werkzeugkette wiederholen*. */
async function repeatFromMenu(user: Awaited<ReturnType<typeof asked>>['user']) {
  const card = await latestCard()
  await user.click(within(card).getByRole('button', { name: 'Weitere Aktionen' }))
  await user.click(await screen.findByRole('menuitem', { name: /Mit Werkzeugkette wiederholen/ }))
}

/** The repeated chain's plan approved and run to its end (polls one step each tick). */
async function runRepeat(user: Awaited<ReturnType<typeof asked>>['user'], approve: string) {
  await user.click(await screen.findByRole('button', { name: approve }))
  for (let i = 0; i < 4; i++) await tick()
}

describe('M10.1: the way in', () => {
  test('⋯ repeats an applied direct answer as a chain: a new record, nothing closed, the field kept', async () => {
    const { user, calls, server } = await applied()
    const field = document.getElementById('prompt-input') as HTMLTextAreaElement
    await user.click(field)
    await user.paste('Nächste Frage')

    await repeatFromMenu(user)

    expect(posted(calls, DIRECT_ID, 'compare')).toHaveLength(1)
    const thinking = useModel.getState().views[REPEAT_ID]
    expect(thinking).toMatchObject({ status: 'thinking', approach: 'chain', compare_of: DIRECT_ID })
    // The record compared stays as it was: applied, not overtaken.
    expect(useModel.getState().views[DIRECT_ID]?.status).toBe('applied')
    expect(server.record(DIRECT_ID)?.status).toBe('applied')
    expect(screen.getByText(/wiederholt mit Werkzeugkette/)).toBeInTheDocument()
    // The menu's card became an earlier answer: the focus is on the repeat's card.
    await tick(50)
    const cards = document.querySelectorAll('#prompt-panel article')
    expect(cards[cards.length - 1]?.contains(document.activeElement)).toBe(true)
    await tick()
    // A plan as every chain's, waiting for its approval (never run unasked).
    const plan = await latestCard()
    expect(within(plan).getByRole('button', { name: 'Kette freigeben und starten' })).toBeEnabled()
    expect(posted(calls, REPEAT_ID, 'run')).toHaveLength(0)
    expect(field.value).toBe('Nächste Frage')
    expect(useAnalysis.getState().origin.marks).not.toEqual({})
  })

  test('where the server would refuse, the item stays reachable by keyboard and says why', async () => {
    // Assistenz: proposal only, a class ``off`` (D1).
    const { user, calls } = await asked('reference', 'chain_reference', 'Assistenz')
    const trigger = within(await latestCard()).getByRole('button', { name: 'Weitere Aktionen' })
    act(() => trigger.focus())
    await user.keyboard('{Enter}')
    const item = await screen.findByRole('menuitem', { name: /Mit Werkzeugkette wiederholen/ })
    await waitFor(() => expect(document.activeElement).toBe(item))
    expect(item).toHaveAttribute('aria-disabled', 'true')
    // The reason is part of the item's name: read with it, not hidden.
    expect(item).toHaveAccessibleName(
      /Stufe Assistenz: Das Modell darf hier nur vorschlagen \(aus: Attributfilter, Raumfilter\)/,
    )
    await user.keyboard('{Enter}')
    expect(posted(calls, DIRECT_ID, 'compare')).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: /Mit Werkzeugkette wiederholen/ })).toBe(item)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  test('the reasons, as the server checks them', () => {
    const state = useModel.getState()
    const direct = actionView('reference')
    const withRecord = (view: ModelActionView) => sent(state, { ...view, id: 999 })
    expect(repeatRefusal(state, direct, false)).toBeNull()
    expect(
      repeatRefusal(state, { ...direct, status: 'rejected', decision: 'rejected' }, false),
    ).toMatch(/^Nicht mehr offen \(abgelehnt\)/)
    expect(repeatRefusal(state, actionView('reference', {}, 'Assistenz'), false)).toMatch(
      /nur vorschlagen \(aus: Attributfilter, Raumfilter\)/,
    )
    expect(repeatRefusal(state, { ...direct, compare_of: 5 }, false)).toBe(
      'Diese Antwort ist schon die Wiederholung mit der anderen Arbeitsweise.',
    )
    // A plan not run yet has no result.
    expect(repeatRefusal(state, actionView('chain_reference'), false)).toBe(
      'Ohne Ergebnis gibt es nichts zu vergleichen.',
    )
    // One request at a time (``busy``): the dialogue's, or one on its way.
    expect(repeatRefusal(withRecord(thinkingView('clarification')), direct, false)).toMatch(
      /Eine Anfrage läuft noch/,
    )
    expect(repeatRefusal(state, direct, true)).toMatch(/Eine Anfrage läuft noch/)
  })

  test("a side with a class off: no dialog by itself, the reason at 'Vergleich ansehen'", async () => {
    // The chain under Prüfen; the account's level is Assistenz when it asks the repeat.
    const { user, calls, server } = await asked('chain_reference', 'reference', 'Prüfen', {
      repeatLevel: 'Assistenz',
    })
    await user.click(await screen.findByRole('button', { name: 'Kette freigeben und starten' }))
    for (let i = 0; i < 4; i++) await tick()
    await user.click(
      within(await latestCard()).getByRole('button', { name: 'Mit Direktabfrage vergleichen' }),
    )
    await tick()
    expect(server.record(REPEAT_ID)).toMatchObject({ status: 'proposed', proposal_only: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    const open = within(await latestCard()).getByRole('button', { name: 'Vergleich ansehen' })
    expect(open).toBeDisabled()
    expect(open).toHaveAccessibleDescription(
      /Stufe Assistenz: Das Modell darf hier nur vorschlagen \(aus: Attributfilter, Raumfilter\)/,
    )
    expect(calls.filter((c) => c.key.endsWith('/comparison'))).toEqual([])
  })

  test('a refused repeat says why in words; the analysis is unchanged', async () => {
    const { user } = await applied('chain_reference', { quota: 1 })
    const before = useAnalysis.getState().tree
    await repeatFromMenu(user)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Die 1 Anfragen pro Tag an diese Anbindung sind aufgebraucht.')
    expect(alert).toHaveTextContent('Ihr Stand ist unverändert.')
    expect(useAnalysis.getState().tree).toBe(before)
    expect(useModel.getState().views[REPEAT_ID]).toBeUndefined()
  })

  test("another tab's request still running: busy, in words", async () => {
    // A prompt of the account this workplace does not know (sent elsewhere).
    const elsewhere = actionView('clarification', { id: 77, status: 'thinking', answer: null })
    const started = await asked('reference', 'chain_reference', 'Prüfen', { records: [elsewhere] })
    await started.user.click(within(started.card).getByRole('button', { name: 'Annehmen' }))
    await waitFor(() => expect(useModel.getState().views[DIRECT_ID]?.status).toBe('applied'))
    await repeatFromMenu(started.user)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ihre vorige Anfrage ist beim Modell noch nicht zu Ende.',
    )
  })
})

describe('M10.2: equal hits', () => {
  test('the dialog opens once both have a result: counts, derivation and steps side by side', async () => {
    const { user, calls } = await applied()
    await repeatFromMenu(user)
    await tick()
    // While the repeat waits for its approval, the comparison waits too.
    const wait = within(await latestCard())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(wait.queryByRole('button', { name: 'Vergleich ansehen' })).toBeNull()
    await runRepeat(user, 'Kette freigeben und starten')

    const shown = within(await dialog())
    expect(
      calls.filter((c) => c.key === `GET /api/model/actions/${REPEAT_ID}/comparison`),
    ).toHaveLength(1)
    const difference = await shown.findByRole('region', { name: 'Unterschied' })
    expect(difference).toHaveTextContent('Treffermengen gleich 10 = 10, dieselben Objekte')
    const direct = shown.getByRole('region', { name: 'Direktabfrage' })
    const chain = shown.getByRole('region', { name: 'Werkzeugkette' })
    expect(direct).toHaveTextContent('Herleitungeine Abfrage, 3 Bedingungen')
    expect(direct).toHaveTextContent('Schritte1')
    expect(direct).toHaveTextContent('Ergebnis10 von 137')
    expect(chain).toHaveTextContent('Herleitung5 Schritte, Ergebnis als eine Abfrage')
    expect(chain).toHaveTextContent('Schritte5')
    expect(chain).toHaveTextContent('Ergebnis10 von 137')
    // The direct query as its readable tree, the chain as its steps with their summaries.
    expect(within(direct).getByRole('group', { name: 'Bedingungen' })).toHaveTextContent(
      '≤ 500 m zu Strassen (Strassenklasse = kantonsstrasse_b)',
    )
    expect(within(chain).getAllByRole('listitem')).toHaveLength(5)
    expect(within(chain).getByText('Schulen · Schulstufe ist eins von primar')).toBeInTheDocument()
    // The applied side is applied already; the chain can be taken.
    expect(
      within(direct).getByRole('button', { name: 'Diese übernehmen: Direktabfrage' }),
    ).toBeDisabled()
    expect(direct).toHaveTextContent('Schon angewendet.')
    expect(
      within(chain).getByRole('button', { name: 'Diese übernehmen: Werkzeugkette' }),
    ).toBeEnabled()
  })

  test('a focus trap: the focus starts on ×, Tab stays inside, Esc closes, reopened from the card', async () => {
    const { user } = await applied()
    await repeatFromMenu(user)
    await tick()
    await runRepeat(user, 'Kette freigeben und starten')
    const box = await dialog()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(box).getByRole('button', { name: 'Vergleich schliessen' }),
      ),
    )
    for (let i = 0; i < 12; i++) {
      await user.tab()
      expect(box.contains(document.activeElement)).toBe(true)
    }
    await user.tab({ shift: true })
    expect(box.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The focus is back at the repeat's card, on its *Vergleich ansehen*; the panel stays open.
    const again = within(await latestCard()).getByRole('button', { name: 'Vergleich ansehen' })
    await waitFor(() => expect(document.activeElement).toBe(again))
    expect(document.getElementById('prompt-panel')).not.toBeNull()
    // Not opened again by itself; the finished chain's card offers it.
    await tick()
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(again)
    expect(await dialog()).toBeInTheDocument()
  })

  test('an undone record compared is compared by its query; it cannot be taken', async () => {
    const { user } = await applied()
    await repeatFromMenu(user)
    await tick()
    // Taken back meanwhile (its card is an earlier answer: the flow's undo).
    await act(() => undo(DIRECT_ID))
    expect(useModel.getState().views[DIRECT_ID]?.status).toBe('undone')
    await runRepeat(user, 'Kette freigeben und starten')
    const shown = within(await dialog())
    expect(await shown.findByRole('region', { name: 'Unterschied' })).toHaveTextContent(
      'Treffermengen gleich',
    )
    const direct = shown.getByRole('region', { name: 'Direktabfrage' })
    expect(
      within(direct).getByRole('button', { name: 'Diese übernehmen: Direktabfrage' }),
    ).toBeDisabled()
    expect(direct).toHaveTextContent('Nicht mehr offen (zurückgenommen).')
  })

  test('after "Verlauf leeren" the record compared is asked for; it cannot be taken from there', async () => {
    const { user, calls } = await applied()
    await repeatFromMenu(user)
    // While the repeat is thinking: it stays, the record compared goes.
    act(() => clearHistory())
    expect(useModel.getState().dialogue).toEqual([REPEAT_ID])
    await tick()
    const before = calls.filter((c) => c.key === `GET /api/model/actions/${DIRECT_ID}`).length
    await runRepeat(user, 'Kette freigeben und starten')
    const shown = within(await dialog())
    const direct = await shown.findByRole('region', { name: 'Direktabfrage' })
    expect(calls.filter((c) => c.key === `GET /api/model/actions/${DIRECT_ID}`).length).toBe(
      before + 1,
    )
    expect(await shown.findByRole('region', { name: 'Unterschied' })).toHaveTextContent(
      'Treffermengen gleich',
    )
    expect(
      within(direct).getByRole('button', { name: 'Diese übernehmen: Direktabfrage' }),
    ).toBeDisabled()
    expect(direct).toHaveTextContent('Schon angewendet.')
    expect(shown.getByRole('button', { name: 'Diese übernehmen: Werkzeugkette' })).toBeEnabled()
  })
})

describe('M10.3: differing hits', () => {
  test('"1 nur links, 2 nur rechts" with the names and the reason; taking the chain', async () => {
    const { user, calls, server } = await applied('compare_differs', {
      found: differsFound(DIRECT_ID, REPEAT_ID),
    })
    await repeatFromMenu(user)
    await tick()
    await runRepeat(user, 'Kette freigeben und starten')

    const shown = within(await dialog())
    const difference = await shown.findByRole('region', { name: 'Unterschied' })
    expect(difference).toHaveTextContent('1 nur links, 2 nur rechts')
    expect(difference).toHaveTextContent('Nur Direktabfrage: Primarstufe Wichtrach')
    expect(difference).toHaveTextContent(
      'Nur Werkzeugkette: Schule Bernstrasse Ostermundigen, Schule Rüeggisberg',
    )
    const reasons = within(difference)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(reasons).toEqual([
      'Direktabfrage „≤ 500 m zu Strassen (Strassenklasse = kantonsstrasse_b)“, Werkzeugkette „≤ 800 m zu Strassen (Strassenklasse = kantonsstrasse_b)“',
      'Direktabfrage „liegt in Gemeinden · Steuern (Steueranlage > 1.6)“, Werkzeugkette „liegt in Gemeinden · Steuern (Steueranlage > 1.65)“',
    ])
    expect(shown.getByRole('region', { name: 'Direktabfrage' })).toHaveTextContent(
      'Ergebnis10 von 137',
    )
    expect(shown.getByRole('region', { name: 'Werkzeugkette' })).toHaveTextContent(
      'Ergebnis11 von 137',
    )

    // *Diese übernehmen* (chain): adopt; the analysis is the chain's, the direct side left as it is.
    await user.click(shown.getByRole('button', { name: 'Diese übernehmen: Werkzeugkette' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posted(calls, REPEAT_ID, 'adopt')).toHaveLength(1)
    expect(posted(calls, REPEAT_ID, 'approve')).toHaveLength(1) // the plan's, before the run
    expect(server.record(REPEAT_ID)).toMatchObject({ status: 'applied', decision: 'accepted' })
    expect(server.record(DIRECT_ID)).toMatchObject({ status: 'applied', decision: 'accepted' })
    const conditions = rows(useAnalysis.getState().tree)
    expect(conditions).toHaveLength(3)
    expect(Object.keys(useAnalysis.getState().origin.marks)).toHaveLength(3)
    expect(useApproval.getState().last?.action).toBe(REPEAT_ID)
  })

  test('the chain first, its direct repeat taken under Automatisch: approved and executed, accepted', async () => {
    const { user, calls, server } = await asked('chain_reference', 'reference', 'Automatisch')
    // Automatisch: the chain runs unasked.
    for (let i = 0; i < 4; i++) await tick()
    await user.click(
      within(await latestCard()).getByRole('button', { name: 'Mit Direktabfrage vergleichen' }),
    )
    expect(posted(calls, CHAIN_ID, 'compare')).toHaveLength(1)
    await tick()
    // The repeat waits for the person: proposed, never executed unasked.
    expect(useModel.getState().views[REPEAT_ID]).toMatchObject({
      status: 'proposed',
      compare_of: CHAIN_ID,
    })
    expect(posted(calls, REPEAT_ID, 'execute')).toHaveLength(0)
    const shown = within(await dialog())
    expect(await shown.findByRole('region', { name: 'Unterschied' })).toHaveTextContent(
      'Treffermengen gleich',
    )
    // The left side is the record compared (the chain), as the server names it.
    const [first] = shown.getAllByRole('heading', { level: 3 })
    expect(first).toHaveTextContent('Werkzeugkette')
    // The waiting side was shown: logged as a preview (P2 rule 4).
    expect(server.record(REPEAT_ID)?.previewed_at).toMatch(/^2026-10-10T14:\d\d:00\.\d{6}$/)

    await user.click(shown.getByRole('button', { name: 'Diese übernehmen: Direktabfrage' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(
      calls.map((c) => c.key).filter((k) => k.startsWith(`POST /api/model/actions/${REPEAT_ID}/`)),
    ).toEqual([
      `POST /api/model/actions/${REPEAT_ID}/approve`,
      `POST /api/model/actions/${REPEAT_ID}/execute`,
    ])
    expect(server.record(REPEAT_ID)).toMatchObject({ status: 'applied', decision: 'accepted' })
    // The chain is left as it is: done, not adopted.
    expect(server.record(CHAIN_ID)?.status).toBe('done')
    expect(rows(useAnalysis.getState().tree)).toHaveLength(3)
  })

  test("the chain's own governance holds: under Teilautonom it halts before the buffer, no comparison until done", async () => {
    // The direct answer arrives approved (auto) and is executed at once.
    const started = await asked('reference', 'chain_reference', 'Teilautonom')
    await waitFor(() => expect(useModel.getState().views[DIRECT_ID]?.decision).toBe('auto'))
    await repeatFromMenu(started.user)
    await tick()
    await started.user.click(await screen.findByRole('button', { name: 'Starten' }))
    await tick()
    await tick()
    expect(await screen.findByRole('button', { name: 'Schritt freigeben' })).toBeInTheDocument()
    expect(useModel.getState().views[REPEAT_ID]?.status).toBe('proposed')
    expect(screen.queryByRole('dialog')).toBeNull()
    await runRepeat(started.user, 'Schritt freigeben')
    expect(await dialog()).toBeInTheDocument()
  })
})

describe('the comparison refused, in words', () => {
  test('while a side has no result yet: "läuft noch", as a status', async () => {
    const { user } = await applied()
    await repeatFromMenu(user)
    await tick()
    // Opened before the plan ran (the card does not offer it; a stale view could).
    act(() => openComparison(REPEAT_ID))
    const shown = within(await dialog())
    expect(
      await shown.findByText(
        'Eine Seite läuft noch: Verglichen wird, sobald beide ein Ergebnis haben.',
      ),
    ).toHaveAttribute('role', 'status')
    expect(
      within(shown.getByRole('region', { name: 'Werkzeugkette' })).getByRole('button', {
        name: 'Diese übernehmen: Werkzeugkette',
      }),
    ).toBeDisabled()
  })

  test('session_required, as an alert; the sides stay', async () => {
    // Asked with a token, not the login session (api/model.py: an InteractiveAccount).
    const started = await asked('reference', 'chain_reference', 'Prüfen', {
      routes: (server) => ({
        [`GET /api/model/actions/${REPEAT_ID}/comparison`]: () => {
          const refused = server.comparison(REPEAT_ID, true) as FakeError
          return json(refused.body, refused.status)
        },
      }),
    })
    await started.user.click(within(started.card).getByRole('button', { name: 'Annehmen' }))
    await waitFor(() => expect(useModel.getState().views[DIRECT_ID]?.status).toBe('applied'))
    await repeatFromMenu(started.user)
    await tick()
    await runRepeat(started.user, 'Kette freigeben und starten')
    const shown = within(await dialog())
    expect(await shown.findByRole('alert')).toHaveTextContent(
      'Das geht nur in einer angemeldeten Sitzung im Browser, nicht mit einem Zugangsschlüssel.',
    )
    expect(shown.getByRole('region', { name: 'Werkzeugkette' })).toHaveTextContent('Schritte5')
  })
})

describe('the reason in words (structured, WP76)', () => {
  const words: Words = labelsFor(
    {
      id: 'schulen',
      source: { kind: 'catalog', layer: 'schulen' },
      visible: true,
      opacity: 1,
      symbology: null,
    },
    LAYERS,
  )
  const sides = { left: 'Direktabfrage', right: 'Werkzeugkette' }

  test('"source": the two layers by their titles', () => {
    expect(
      reasonLines({ kind: 'source', left: 'schulen', right: 'gemeinden_steuern' }, words, sides),
    ).toEqual([
      'Die Treffer sind Objekte verschiedener Layer: Direktabfrage liefert „Schulen“, Werkzeugkette „Gemeinden · Steuern“.',
    ])
  })

  test('"conditions": changed, added and removed, as the server dumps them', () => {
    // The server's dump: ``where: null`` on a relation without filter, a text match's defaults.
    const reason = {
      kind: 'conditions' as const,
      changes: [
        {
          left: { op: 'related', layer: 'gemeinden_steuern', predicate: 'within', where: null },
          right: {
            op: 'related',
            layer: 'gemeinden_steuern',
            predicate: 'intersects',
            where: null,
          },
        },
        {
          left: null,
          right: { op: 'compare', attr: 'standorte', cmp: 'ge', value: 2 },
        },
        {
          left: {
            op: 'text_match',
            attr: 'typ',
            text: 'prim',
            mode: 'starts_with',
            case_sensitive: false,
          },
          right: null,
        },
        {
          left: { op: 'not', arg: { op: 'not', arg: { op: 'is_null', attr: 'typ' } } },
          right: null,
        },
      ],
    } as unknown as Parameters<typeof reasonLines>[0]
    expect(reasonLines(reason, words, sides)).toEqual([
      'Direktabfrage „liegt in Gemeinden · Steuern“, Werkzeugkette „schneidet Gemeinden · Steuern“',
      'Nur Werkzeugkette: „Standorte ≥ 2“',
      'Nur Direktabfrage: „Schulstufe beginnt mit prim“',
      // Beyond the controls: JSON, never guessed.
      'Nur Direktabfrage: „ohne Klartext: {"op":"not","arg":{"op":"not","arg":{"op":"is_null","attr":"typ"}}}“',
    ])
  })

  test('no reason, no words', () => {
    expect(reasonLines(null, words, sides)).toEqual([])
    expect(reasonLines(undefined, words, sides)).toEqual([])
  })

  test('a condition of the fixture as the editor says it', () => {
    const [change] = DIFFERS.reason.kind === 'conditions' ? DIFFERS.reason.changes : []
    expect(conditionText(change?.right, words)).toBe(
      '≤ 800 m zu Strassen (Strassenklasse = kantonsstrasse_b)',
    )
  })

  test('names: a feature without one by its id; long lists counted', () => {
    expect(
      featureNames([
        { id: 18, name: 'Primarstufe Wichtrach' },
        { id: 7, name: null },
      ]),
    ).toBe('Primarstufe Wichtrach, Objekt 7')
    const many = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, name: `S${i + 1}` }))
    expect(featureNames(many)).toBe(
      'S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12 und 3 weitere',
    )
  })
})

describe('taking a side honours its governance', () => {
  test('an off side, an applied one, a chain without a result', () => {
    expect(takeRefusal(actionView('reference', {}, 'Assistenz'))).toMatch(
      /^Stufe Assistenz: Das Modell darf hier nur vorschlagen/,
    )
    expect(takeRefusal(actionView('reference', { status: 'applied', decision: 'accepted' }))).toBe(
      'Schon angewendet.',
    )
    expect(takeRefusal(actionView('chain_reference'))).toBe(
      'Läuft noch: Die Kette hat noch kein Ergebnis.',
    )
    expect(takeRefusal(actionView('reference'))).toBeNull()
    expect(
      takeRefusal(actionView('reference', { status: 'superseded', decision: 'superseded' })),
    ).toBe('Nicht mehr offen (übergangen).')
  })
})

test('a new prompt overtakes every open record, the record compared and its repeat', () => {
  const original = actionView('reference')
  const repeat = repeatView(original, 'chain_reference', 'Prüfen', { id: REPEAT_ID })
  let state = sent(useModel.getState(), original)
  state = {
    ...state,
    dialogue: [...state.dialogue, REPEAT_ID],
    views: { ...state.views, [REPEAT_ID]: repeat },
  }
  const next = sent(state, thinkingView('clarification'))
  expect(next.views[DIRECT_ID]?.status).toBe('superseded')
  expect(next.views[REPEAT_ID]?.status).toBe('superseded')
  expect(next.views[REPEAT_ID]?.steps.every((s) => s.status === 'skipped')).toBe(true)
})

test('a repeat supersedes nothing, also when picked up again (resumed after busy)', () => {
  const original = actionView('reference')
  const state = sent(useModel.getState(), original)
  const thinking = { ...thinkingView('chain_reference'), id: REPEAT_ID, compare_of: DIRECT_ID }
  for (const next of [sent(state, thinking), resumed(state, thinking)]) {
    expect(next.views[DIRECT_ID]?.status).toBe('proposed')
    expect(next.pending).toBe(DIRECT_ID)
    expect(next.running?.id).toBe(REPEAT_ID)
  }
})

test('in pseudo, the differing dialog shows no text outside the catalog', async () => {
  activate('pseudo', pseudo)
  try {
    // Driven through the flows, not by the buttons' names (pseudo renames them).
    const { view } = await asked('reference', 'compare_differs', 'Prüfen', {
      script: { found: differsFound(DIRECT_ID, REPEAT_ID) },
    })
    await act(() => accept(useModel.getState().views[DIRECT_ID] as ModelActionView))
    await act(() => repeat(useModel.getState().views[DIRECT_ID] as ModelActionView))
    await tick()
    await act(() => approveChain(useModel.getState().views[REPEAT_ID] as ModelActionView))
    for (let i = 0; i < 4; i++) await tick()
    const box = await screen.findByRole('dialog')
    await waitFor(() => expect(box.querySelector('section[aria-label] ul')).not.toBeNull())
    const plan = modelCase('compare_differs').answer as { steps: { text: string }[] }
    const data = [
      REFERENCE.prompt,
      ...plan.steps.map((s) => s.text),
      ...Object.values(COMPARE_NAMES).filter((n): n is string => n !== null),
      JSON.stringify(compactQuery(useModel.getState().views[DIRECT_ID]?.query), null, 2),
      'Schulen',
      'Strassen',
      'Gemeinden · Steuern',
      'Schulstufe',
      'Strassenklasse',
      'Steueranlage',
      'primar',
      'kantonsstrasse_b',
      '1.6',
      '1.65',
      'Lokales Modell',
      'Prüfen',
    ]
    // The dialog's own text: the workplace behind it is the other tests' (chain,
    // approval), so it leaves the page while the dialog is checked.
    const workplace = view.container
    workplace.remove()
    try {
      expect(box.isConnected).toBe(true)
      expect(strays(data)).toEqual([])
    } finally {
      document.body.appendChild(workplace)
    }
  } finally {
    activate('de')
  }
})

describe('the fake server as WP76 answers', () => {
  const ok = <T,>(value: T): Exclude<T, FakeError> => {
    if (isFakeError(value)) throw new Error(`refused: ${value.body.code}`)
    return value as Exclude<T, FakeError>
  }
  const code = (value: unknown) => (isFakeError(value) ? [value.status, value.body.code] : null)

  test('compare: a new thinking record, the next poll brings it proposed whatever the level', () => {
    const server = modelServer([actionView('reference', {}, 'Automatisch')])
    const thinking = ok(server.compare(DIRECT_ID, 'chain_reference', 'Automatisch'))
    expect(thinking).toMatchObject({
      id: REPEAT_ID,
      status: 'thinking',
      approach: 'chain',
      compare_of: DIRECT_ID,
      prompt: REFERENCE.prompt,
      query: null,
    })
    expect(thinking.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/)
    expect(ok(server.poll(REPEAT_ID)).status).toBe('proposed')
    // Its approve and execute are ``accepted``, never ``auto`` (store.py ``_unasked``).
    const direct = modelServer([
      actionView(
        'chain_reference',
        { status: 'done', query: actionView('reference').query },
        'Automatisch',
      ),
    ])
    ok(direct.compare(CHAIN_ID, 'reference', 'Automatisch'))
    expect(ok(direct.poll(REPEAT_ID))).toMatchObject({ status: 'proposed', approach: 'direct' })
    ok(direct.approve(REPEAT_ID))
    expect(ok(direct.execute(REPEAT_ID)).action.decision).toBe('accepted')
  })

  test('compare refused: nothing to compare, a repeat, no result yet, off, busy, quota, not found', () => {
    const server = modelServer([
      actionView('clarification'),
      actionView('reference', {}, 'Assistenz'),
      actionView('chain_reference'),
      repeatView(actionView('chain_reference', { status: 'done' }), 'reference', 'Prüfen', {
        id: 60,
      }),
    ])
    expect(code(server.compare(actionView('clarification').id, 'chain_reference'))).toEqual([
      409,
      'nothing_to_compare',
    ])
    expect(code(server.compare(DIRECT_ID, 'chain_reference'))).toEqual([409, 'class_not_allowed'])
    expect(code(server.compare(CHAIN_ID, 'reference'))).toEqual([409, 'not_approved'])
    expect(code(server.compare(60, 'chain_reference'))).toEqual([409, 'repeat_of_repeat'])
    expect(code(server.compare(9999, 'chain_reference'))).toEqual([404, 'not_found'])
    const busy = modelServer([
      actionView('reference'),
      actionView('unreachable', { id: 77, status: 'thinking' }),
    ])
    expect(code(busy.compare(DIRECT_ID, 'chain_reference'))).toEqual([409, 'busy'])
    const quota = modelServer([actionView('reference')], undefined, { quota: 1 })
    expect(code(quota.compare(DIRECT_ID, 'chain_reference'))).toEqual([429, 'quota_exceeded'])
  })

  test('comparison: not compared, no result yet (thinking, a plan waiting), a token', () => {
    const server = modelServer([
      actionView('reference', { status: 'applied', decision: 'accepted' }),
    ])
    expect(code(server.comparison(DIRECT_ID))).toEqual([404, 'not_found'])
    ok(server.compare(DIRECT_ID, 'chain_reference'))
    expect(code(server.comparison(REPEAT_ID))).toEqual([409, 'not_approved'])
    expect(code(server.comparison(DIRECT_ID))).toEqual([409, 'not_approved'])
    expect(ok(server.poll(REPEAT_ID)).status).toBe('proposed')
    expect(code(server.comparison(REPEAT_ID))).toEqual([409, 'not_approved'])
    expect(code(server.comparison(REPEAT_ID, true))).toEqual([403, 'session_required'])
  })

  /** The reference applied, its repeat (case ``repeat``) run to its end; the comparison by ``id``. */
  function compared(repeat: CaseId, script: ChainScript = {}) {
    const original = actionView('reference', { status: 'applied', decision: 'accepted' })
    const server = modelServer([original], undefined, script)
    ok(server.compare(DIRECT_ID, repeat))
    ok(server.poll(REPEAT_ID))
    ok(server.approve(REPEAT_ID))
    ok(server.run(REPEAT_ID))
    expect(ok(server.poll(REPEAT_ID)).status).toBe('done')
    return server
  }

  test("comparison of the differing case: the fixture's counts, names and reason, by either side", () => {
    const server = compared('compare_differs', { found: differsFound(DIRECT_ID, REPEAT_ID) })
    const body = ok(server.comparison(DIRECT_ID))
    expect([body.left_action_id, body.right_action_id]).toEqual([DIRECT_ID, REPEAT_ID])
    expect([body.left.count, body.right.count]).toEqual([DIFFERS.left_hits, DIFFERS.right_hits])
    expect(body.only_left).toEqual(DIFFERS.only_left)
    expect(body.only_right).toEqual(DIFFERS.only_right)
    expect(body.reason).toEqual(DIFFERS.reason)
    expect(ok(server.comparison(REPEAT_ID))).toEqual(body)
    expect(compareReason(actionView('reference').query, actionView('reference').query)).toBeNull()
  })

  test('comparison of equal ids: nothing only on one side, no reason, even where the queries differ', () => {
    const server = compared('compare_differs')
    const body = ok(server.comparison(REPEAT_ID))
    expect(body).toMatchObject({ only_left: [], only_right: [], reason: null })
    expect(body.left.count).toBe(REFERENCE_IDS.length)
    expect(body.left.ids_hash).toBe(body.right.ids_hash)
  })

  test('names: none on a layer without a name attribute (compare.py name_attribute)', () => {
    const server = compared('compare_differs', {
      found: differsFound(DIRECT_ID, REPEAT_ID),
      names: {},
    })
    const body = ok(server.comparison(DIRECT_ID))
    expect([...body.only_left, ...body.only_right].map((f) => f.name)).toEqual([null, null, null])
  })

  test('the reason keys on full dumps: a default written out is the same as one left out', () => {
    const query = (match: object) => ({
      schema_version: '2',
      source: 'schulen',
      where: { op: 'and', args: [{ op: 'text_match', attr: 'typ', text: 'prim', ...match }] },
    })
    expect(compareReason(query({ mode: 'contains' }), query({}))).toBeNull()
    expect(compareReason({ ...query({}), columns: [] }, query({}))).toBeNull()
    expect(compareReason(query({ mode: 'starts_with' }), query({}))).toMatchObject({
      kind: 'conditions',
    })
  })

  test('comparison: every query slot taken is 503 before a token is 403', () => {
    const server = compared('chain_reference')
    server.queriesBusy(true)
    expect(code(server.comparison(REPEAT_ID, true))).toEqual([503, 'busy'])
    server.queriesBusy(false)
    expect(code(server.comparison(REPEAT_ID, true))).toEqual([403, 'session_required'])
  })
})
