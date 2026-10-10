// The prompt panel against the fake API (plan WP67): the entry states M1, the
// 202 → poll flow and abort (P7), the answer M2/M4, refusals M3, errors M14,
// the hand-over to the editor with its decision (P1, P3), keyboard, pseudo
// locale and the 460 px column.
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { useAnalysis } from '../../analysis/store'
import { rows } from '../../analysis/tree'
import { activate } from '../../i18n/i18n'
import { messages as pseudo } from '../../locales/pseudo.po'
import { actionView, thinkingView, type CaseId } from '../../test/model-mocks'
import {
  ask as typeAndSend,
  backend,
  done,
  thinking,
  EXTERNAL,
  fakeTimers,
  json,
  llmOptions,
  openPanel,
  promptFlow,
  resetStores,
  tick,
} from '../../test/prompt-panel'
import { strays } from '../../test/pseudo'
import { renderAt } from '../../test/render'
import { Workplace } from '../../workplace/Workplace'
import { useModel } from '../store'

beforeEach(resetStores)
afterEach(done)

const REFERENCE = actionView('reference')
const PROMPT = REFERENCE.prompt

const posts = (calls: { key: string; body: unknown }[]) =>
  calls.filter((c) => c.key === 'POST /api/model/prompt')
const polls = (calls: { key: string }[], id: number) =>
  calls.filter((c) => c.key === `GET /api/model/actions/${id}`)

/** Types the prompt and sends it with Ctrl+Enter. */
const ask = (user: ReturnType<typeof userEvent.setup>, text = PROMPT) => typeAndSend(user, text)

/** Sends a case's prompt and lets the first poll bring its answer. */
async function answered(id: CaseId, patch = {}) {
  const user = fakeTimers()
  const answer = actionView(id, patch)
  const calls = backend(promptFlow(thinkingView(id), answer))
  await openPanel()
  await ask(user, answer.prompt)
  await thinking()
  await tick()
  return { user, calls, answer }
}

describe('entry (M1)', () => {
  test('M1.1: intro, examples from the visible layers, status line; a click only fills', async () => {
    const calls = backend()
    useAnalysis.getState().setVisible('gemeinden_steuern', false)
    await userEventOpen()
    const panel = screen.getByRole('region', { name: 'Prompt' })
    expect(within(panel).getByText(/Fragen Sie in eigenen Worten/)).toBeInTheDocument()
    expect(within(panel).getByText(/keine Geodaten-Inhalte/)).toBeInTheDocument()
    const examples = within(panel).getByRole('region', {
      name: 'Beispiele aus den sichtbaren Layern',
    })
    const buttons = within(examples).getAllByRole('button')
    // Only visible layers: the hidden "Gemeinden · Steuern" gives no example.
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Welche Schulen liegen nahe an Strassen?',
      'Schulen mit Standorte über …',
    ])
    await userEvent.click(buttons[0] as HTMLElement)
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(
      'Welche Schulen liegen nahe an Strassen?',
    )
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus()
    expect(posts(calls)).toEqual([])

    // The approach: Direktabfrage chosen, the chain disabled until E2.5.
    expect(screen.getByRole('radio', { name: 'Direktabfrage' })).toBeChecked()
    const chain = screen.getByRole('radio', { name: 'Werkzeugkette' })
    expect(chain).toBeDisabled()
    expect(chain).toHaveAccessibleDescription('ab E2.5')
    expect(
      screen.getByText(/Lokales Modell · Stufe Prüfen · Ihre Eingaben werden protokolliert/),
    ).toBeInTheDocument()
    // Sidebar and map stay (design M1.1).
    expect(screen.getByRole('region', { name: 'Karte' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Layer' })).toBeInTheDocument()
  })

  test('M1.2: an external connection names its host in the notice and the status line', async () => {
    backend({}, { ...llmOptions(), active_connection_id: EXTERNAL.id })
    const { panel } = await openPanel()
    const notice = await within(panel).findByRole('complementary', { name: 'Externe Anbindung' })
    expect(notice).toHaveTextContent('Der Prompt-Text verlässt das Haus')
    expect(notice).toHaveTextContent('Er geht an api.anbieter.example.')
    expect(notice).toHaveTextContent('keine Geodaten-Inhalte')
    expect(
      screen.getByText(/Extern · extern · api\.anbieter\.example · Stufe Prüfen/),
    ).toBeInTheDocument()
  })

  test('M1.3: without a connection the tab is disabled; the admin gets the link', async () => {
    backend({}, llmOptions(null))
    useModel.getState().setOpen(true)
    renderAt('/', <Workplace />)
    expect(await screen.findByText(/Prompt nicht verfügbar/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Prompt' })).toBeDisabled()
    expect(screen.queryByRole('region', { name: 'Prompt' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Modellanbindungen ›' })).toHaveAttribute(
      'href',
      '/admin/modelle',
    )
  })
})

/** Opens the panel through its tab, as a user would. */
async function userEventOpen() {
  renderAt('/', <Workplace />)
  const tab = await screen.findByRole('tab', { name: 'Prompt' })
  await waitFor(() => expect(tab).toBeEnabled())
  await userEvent.click(tab)
  return screen.findByRole('region', { name: 'Prompt' })
}

describe('request (P7)', () => {
  test('202 → thinking, locked, timer; the poll brings the answer and stops', async () => {
    const user = fakeTimers()
    const thinking = thinkingView('reference')
    const calls = backend(promptFlow(thinking, thinking, REFERENCE))
    await openPanel()
    await ask(user)

    expect(posts(calls).map((c) => c.body)).toEqual([{ text: PROMPT, approach: 'direct' }])
    const card = await screen.findByRole('article', { name: 'Antwort' })
    expect(within(card).getByRole('status')).toHaveTextContent('Modell arbeitet …')
    expect(card).toHaveTextContent('0:00 / max. 2:00')
    const field = screen.getByRole('textbox', { name: 'Prompt' })
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveValue('')
    expect(field).toHaveAttribute('placeholder', 'Eingabe gesperrt, solange das Modell arbeitet')
    expect(screen.getByRole('button', { name: /Senden/ })).toBeDisabled()

    await tick() // first poll: still thinking
    expect(polls(calls, thinking.id)).toHaveLength(1)
    expect(await screen.findByText(/0:01 \/ max\. 2:00/)).toBeInTheDocument()
    await tick() // second poll: the answer
    expect(
      await screen.findByText(
        REFERENCE.answer?.kind === 'query' ? REFERENCE.answer.explanation : '',
      ),
    ).toBeInTheDocument()
    expect(polls(calls, thinking.id)).toHaveLength(2)
    await tick(5000)
    expect(polls(calls, thinking.id)).toHaveLength(2)
    // The answer took the prompt out of the field.
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('')
  })

  test('Abbrechen aborts the request; no poll after it, the prompt is back in the field', async () => {
    const user = fakeTimers()
    const thinking = thinkingView('aborted')
    const calls = backend({
      ...promptFlow(thinking, thinking),
      [`POST /api/model/actions/${thinking.id}/abort`]: actionView('aborted'),
    })
    await openPanel()
    await ask(user, thinking.prompt)
    await user.click(await screen.findByRole('button', { name: 'Abbrechen' }))

    expect(calls.filter((c) => c.key.endsWith('/abort'))).toHaveLength(1)
    expect(await screen.findByText('abgebrochen')).toBeInTheDocument()
    expect(screen.getByText(/Die Anfrage wurde abgebrochen/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(thinking.prompt)
    const before = polls(calls, thinking.id).length
    await tick(5000)
    expect(polls(calls, thinking.id)).toHaveLength(before)
  })

  test('no polling after unmount', async () => {
    const user = fakeTimers()
    const thinking = thinkingView('reference')
    const calls = backend(promptFlow(thinking, thinking))
    const { view } = await openPanel()
    await ask(user)
    await screen.findByText('Modell arbeitet …')
    view.unmount()
    await tick(5000)
    expect(polls(calls, thinking.id)).toEqual([])
  })
})

describe('answer (M2, M4)', () => {
  test('explanation, assumptions with ≈, the readable query, the status; no undo yet', async () => {
    await answered('reference')
    const card = await screen.findByRole('article', { name: 'Antwort' })
    expect(within(card).getByRole('status')).toHaveTextContent('Vorschlag')
    const assumptions = within(card).getByRole('region', { name: 'Annahmen' })
    expect(assumptions).toHaveTextContent('Annahmen · 3')
    expect(
      within(assumptions)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      // Each with "ändern" for the condition it names (M12.1, WP68).
      '≈„nahe“ = höchstens 500 mändern',
      '≈„Kantonsstrassen“ = Strassenklasse Kantonsstrasse Bändern',
      '≈„hohe Steueranlage“ = über 1.6ändern',
    ])
    expect(within(card).getByText('Abfrage · Ergebnis Schulen')).toBeInTheDocument()
    expect(within(card).getByRole('group', { name: 'Bedingungen' })).toBeInTheDocument()
    expect(within(card).getByText('Technisch (Abfrageobjekt JSON)')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'In Editor übernehmen' })).toBeEnabled()
    // The log arrives with WP73, undo with E2.4 (P1).
    expect(within(card).getByRole('button', { name: 'Protokoll' })).toBeDisabled()
    expect(within(card).queryByRole('button', { name: 'Zurücknehmen' })).toBeNull()
    expect(card).toHaveTextContent(/Stufe Prüfen: Das Modell wendet in dieser Ausbaustufe nichts/)
    // The analysis is untouched until the user applies the proposal.
    expect(useAnalysis.getState().tree.children).toEqual([])
  })

  test('In Editor übernehmen → B2 with marks; only Übernehmen applies, reported as proposal_only', async () => {
    const applied = actionView('reference', {
      status: 'applied',
      decision: 'proposal_only',
      applied_by_hand: true,
      decided_at: '2026-10-10T14:07:00Z',
    })
    const user = fakeTimers()
    const calls = backend({
      ...promptFlow(thinkingView('reference'), REFERENCE),
      [`POST /api/model/actions/${REFERENCE.id}/decide`]: applied,
    })
    await openPanel()
    await ask(user)
    await tick()
    await user.click(await screen.findByRole('button', { name: 'In Editor übernehmen' }))

    // B2 in place of the panel, Klassik chosen (design M4.2).
    const editor = await screen.findByRole('region', { name: 'Abfrage-Editor' })
    expect(screen.queryByRole('region', { name: 'Prompt' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Klassik' })).toHaveAttribute('aria-selected', 'true')
    expect(within(editor).getByRole('note')).toHaveTextContent(
      /Entwurf aus Vorschlag .*Noch nicht in der Analyse/,
    )
    expect(within(editor).getAllByText('Modell')).toHaveLength(3)
    expect(useAnalysis.getState().tree.children).toEqual([])
    expect(calls.filter((c) => c.key.endsWith('/decide'))).toEqual([])

    await user.click(within(editor).getByRole('button', { name: 'Übernehmen' }))
    expect(rows(useAnalysis.getState().tree)).toHaveLength(3)
    await waitFor(() =>
      expect(calls.filter((c) => c.key.endsWith('/decide')).map((c) => c.body)).toEqual([
        { decision: 'proposal_only', applied_by_hand: true },
      ]),
    )
    // The sidebar's compact tree carries the mark per condition (M2.2, P3).
    const overview = screen.getByLabelText('Bedingungen (Übersicht)')
    expect(within(overview).getAllByText('Modell')).toHaveLength(3)

    await user.click(screen.getByRole('tab', { name: 'Prompt' }))
    const card = await screen.findByRole('article', { name: 'Antwort' })
    expect(within(card).getByRole('status')).toHaveTextContent('von Hand übernommen')
    expect(within(card).getByRole('button', { name: 'Im Editor öffnen' })).toBeEnabled()
  })

  test('an edited draft is reported as adjusted with the applied query', async () => {
    const user = fakeTimers()
    const calls = backend({
      ...promptFlow(thinkingView('reference'), REFERENCE),
      [`POST /api/model/actions/${REFERENCE.id}/decide`]: actionView('reference', {
        status: 'applied',
        decision: 'adjusted',
        applied_by_hand: true,
      }),
    })
    await openPanel()
    await ask(user)
    await tick()
    await user.click(await screen.findByRole('button', { name: 'In Editor übernehmen' }))
    const editor = await screen.findByRole('region', { name: 'Abfrage-Editor' })
    const distance = within(editor).getByRole('spinbutton', { name: 'Distanz in Metern' })
    await user.clear(distance)
    await user.type(distance, '300')
    // The edited row lost its mark at once (M15.2).
    expect(within(editor).getAllByText('Modell')).toHaveLength(2)
    await user.click(within(editor).getByRole('button', { name: 'Übernehmen' }))

    await waitFor(() => expect(calls.filter((c) => c.key.endsWith('/decide'))).toHaveLength(1))
    const body = calls.find((c) => c.key.endsWith('/decide'))?.body as {
      decision: string
      query: { where: { args: { distance_m?: number }[] } }
    }
    expect(body.decision).toBe('adjusted')
    expect(body.query.where.args[1]?.distance_m).toBe(300)
  })

  test('Verwerfen leaves the analysis as it was and reports nothing', async () => {
    const user = fakeTimers()
    const calls = backend(promptFlow(thinkingView('reference'), REFERENCE))
    useAnalysis.setState({ result: 'strassen' })
    await openPanel()
    await ask(user)
    await tick()
    await user.click(await screen.findByRole('button', { name: 'In Editor übernehmen' }))
    expect(useAnalysis.getState().result).toBe('schulen')
    const editor = await screen.findByRole('region', { name: 'Abfrage-Editor' })
    await user.click(within(editor).getByRole('button', { name: 'Verwerfen' }))

    expect(useAnalysis.getState().result).toBe('strassen')
    expect(useAnalysis.getState().tree.children).toEqual([])
    expect(useAnalysis.getState().origin.marks).toEqual({})
    await tick(2000)
    expect(calls.filter((c) => c.key.endsWith('/decide'))).toEqual([])
  })
})

describe('refusal (M3)', () => {
  test('M3.1: reason in words as an alert, code under Details, query viewable but not applicable', async () => {
    const { user, calls, answer } = await answered('unknown_layer')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('abgewiesen')
    expect(alert).toHaveTextContent('Ein Layer fehlt oder ist nicht sichtbar.')
    expect(alert).not.toHaveTextContent('unknown_layer')
    const card = screen.getByRole('article', { name: 'Antwort' })
    expect(within(card).getByText(/code: unknown_layer/)).not.toBeVisible()
    await user.click(within(card).getByText('Details'))
    expect(within(card).getByText(/code: unknown_layer/)).toBeVisible()
    await user.click(within(card).getByText('Abgewiesene Abfrage ansehen'))
    expect(within(card).getByRole('group', { name: 'Bedingungen' })).toBeVisible()
    expect(within(card).queryByRole('button', { name: 'In Editor übernehmen' })).toBeNull()

    // Prompt ändern: the text back in the field, nothing sent.
    await user.click(within(card).getByRole('button', { name: 'Prompt ändern' }))
    const field = screen.getByRole('textbox', { name: 'Prompt' })
    expect(field).toHaveValue(answer.prompt)
    expect(field).toHaveFocus()
    expect(posts(calls)).toHaveLength(1)
    // Erneut versuchen sends the same prompt again.
    await user.click(within(card).getByRole('button', { name: 'Erneut versuchen' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
    expect(posts(calls)[1]?.body).toEqual({ text: answer.prompt, approach: 'direct' })
  })

  test('M3.2: the limit names the counts', async () => {
    await answered('limit_exceeded')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Die Abfrage hat 10 Bedingungen; im Modus B sind höchstens 8 möglich.',
    )
  })

  test('M3.3: not representable, without the chain offer before E2.5', async () => {
    await answered('not_representable')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Diese Abfrage lässt sich in den Bedienelementen nicht vollständig darstellen.',
    )
    expect(screen.queryByRole('button', { name: /Werkzeugkette versuchen/ })).toBeNull()
  })
})

describe('errors (M14)', () => {
  test('M14.1: unreachable — what happened, state unchanged, retry, switch, admin link', async () => {
    const { user, calls, answer } = await answered('unreachable')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Modell nicht erreichbar')
    expect(alert).toHaveTextContent('Die Anbindung „Lokales Modell“ antwortet nicht.')
    expect(alert).toHaveTextContent('Ihr Stand ist unverändert.')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(answer.prompt)
    expect(screen.getByRole('button', { name: 'Anbindung wechseln' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Modellanbindungen ›' })).toHaveAttribute(
      'href',
      '/admin/modelle',
    )
    await user.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
  })

  test('M14.2: a timeout at an external connection keeps the host', async () => {
    await answered('timeout', {
      connection: { ...EXTERNAL, locality: 'external' },
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Zeitüberschreitung')
    expect(alert).toHaveTextContent('Nach 2:00 kam keine Antwort.')
    expect(alert).toHaveTextContent('api.anbieter.example')
  })

  test('M14.3: an unreadable answer, its code under Details', async () => {
    await answered('unreadable')
    expect(await screen.findByRole('alert')).toHaveTextContent('Antwort nicht lesbar')
    expect(screen.getByText(/code: model_unreadable/)).toBeInTheDocument()
  })

  test('M14.4: the request limit is named, no retry, the prompt stays in the field', async () => {
    const user = fakeTimers()
    backend({
      'POST /api/model/prompt': () =>
        json({ code: 'quota_exceeded', message: 'limit', details: { limit: 50 } }, 429),
    })
    await openPanel()
    await ask(user)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Grenzwert erreicht')
    expect(alert).toHaveTextContent('Die 50 Anfragen pro Tag an diese Anbindung sind aufgebraucht.')
    expect(alert).toHaveTextContent('Ihr Stand ist unverändert.')
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(PROMPT)
  })
})

describe('keyboard', () => {
  test('focus order in the input, Ctrl+Enter sends, Esc closes and returns to the tab', async () => {
    const user = fakeTimers()
    const calls = backend(promptFlow(thinkingView('reference'), REFERENCE))
    await openPanel()
    const field = screen.getByRole('textbox', { name: 'Prompt' })
    await user.click(field)
    await user.paste('Schulen')
    // Plain Enter is a new line, not a send.
    await user.keyboard('{Enter}')
    expect(field).toHaveValue('Schulen\n')
    expect(posts(calls)).toEqual([])
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Direktabfrage' })).toHaveFocus()
    // The disabled chain is skipped.
    await user.tab()
    expect(screen.getByRole('button', { name: /Senden/ })).toHaveFocus()
    await user.tab({ shift: true })
    await user.tab({ shift: true })
    expect(field).toHaveFocus()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(posts(calls).map((c) => c.body)).toEqual([{ text: 'Schulen', approach: 'direct' }])
    // Locked while the model works, the field keeps the focus.
    expect(field).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Prompt' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Prompt' })).toHaveFocus()
    // The request goes on while the panel is closed.
    await tick()
    expect(useModel.getState().running).toBeNull()
  })
})

describe('pseudo locale and layout', () => {
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
  ]

  async function inPseudo(check: () => Promise<void>) {
    activate('pseudo', pseudo)
    try {
      await check()
    } finally {
      cleanup()
      activate('de')
    }
  }

  test('the entry and an answer show no text outside the catalog', async () => {
    await inPseudo(async () => {
      const user = fakeTimers()
      backend(promptFlow(thinkingView('reference'), REFERENCE))
      await openPanel()
      const query = JSON.stringify(REFERENCE.query, null, 2)
      expect(strays([...DATA, PROMPT, query])).toEqual([])
      await ask(user)
      await tick()
      const answer = REFERENCE.answer?.kind === 'query' ? REFERENCE.answer : null
      await screen.findByText(answer?.explanation ?? '')
      const said = [answer?.explanation ?? '', ...(answer?.assumptions.map((a) => a.text) ?? [])]
      expect(strays([...DATA, PROMPT, query, ...said])).toEqual([])
    })
  })

  test('a refusal and an error show no text outside the catalog', async () => {
    await inPseudo(async () => {
      await answered('unknown_layer')
      await screen.findByRole('alert')
      const answer = actionView('unknown_layer')
      const query =
        answer.answer?.kind === 'query' ? JSON.stringify(answer.answer.query, null, 2) : ''
      expect(strays([...DATA, answer.prompt, query, 'kitas', 'code: unknown_layer'])).toEqual([])
    })
  })

  test('the panel is the 460 px column and lets nothing out of it', async () => {
    // jsdom has no layout: this checks the CSS that holds the width, not pixels.
    backend()
    const { panel, view } = await openPanel()
    const grid = view.container.querySelector('.grid') as HTMLElement
    expect(grid.className).toContain('grid-cols-[250px_460px_minmax(0,1fr)]')
    // The column may shrink its content but never grow: min-w-0 and clipping.
    expect(panel.className).toMatch(/\bmin-w-0\b/)
    expect(panel.className).toMatch(/\boverflow-hidden\b/)
    const body = panel.children[1] as HTMLElement
    expect(body.className).toMatch(/\bbreak-words\b/)
    expect(body.className).toMatch(/\boverflow-auto\b/)
    // No element inside asks for more than the column.
    for (const element of Array.from(panel.querySelectorAll<HTMLElement>('*'))) {
      for (const width of element.className.toString().matchAll(/\bw-\[(\d+)px\]/g))
        expect(Number(width[1])).toBeLessThanOrEqual(460)
      expect(element.className.toString()).not.toMatch(/\bwhitespace-nowrap\b/)
    }
  })
})

test('a running request survives switching to Klassik and back', async () => {
  const user = fakeTimers()
  const thinking = thinkingView('reference')
  backend(promptFlow(thinking, thinking, REFERENCE))
  await openPanel()
  await ask(user)
  await user.click(screen.getByRole('tab', { name: 'Klassik' }))
  await tick()
  await tick()
  await act(async () => useModel.getState().setOpen(true))
  expect(await screen.findByRole('article', { name: 'Antwort' })).toHaveTextContent('Vorschlag')
})
