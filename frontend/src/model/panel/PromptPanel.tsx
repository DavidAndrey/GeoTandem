// The prompt panel (design M1, plan WP67): 460 px between sidebar and map,
// which both stay live. Notice of an external connection, intro and example
// prompts, the dialogue, and the input with its approach toggle and status
// line. Esc closes the panel and returns to the tab.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Globe } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { useAnalysis } from '../../analysis/store'
import { useLayers, useMe } from '../../api/queries'
import { useModel, type ModelState } from '../store'
import { useActiveModel } from './active'
import { Dialogue } from './Answer'
import { CHAIN_AVAILABLE } from './chain'
import { examplePrompts } from './examples'
import { clearHistory, focusPrompt, PROMPT_INPUT, PROMPT_TAB, send, usePanel } from './state'

export function PromptPanel() {
  const { connection } = useActiveModel()
  const empty = useModel((s) => s.dialogue.length === 0)
  const failure = usePanel((s) => s.failure)
  const setOpen = useModel((s) => s.setOpen)
  const close = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    setOpen(false)
    document.querySelector<HTMLElement>(PROMPT_TAB)?.focus()
  }
  return (
    <section
      id="prompt-panel"
      aria-label={t`Prompt`}
      className="card flex min-h-0 min-w-0 flex-col overflow-hidden"
      onKeyDown={close}
    >
      <div className="border-divider flex items-center gap-2 border-b px-4 py-2">
        <h2 className="flex-1 text-xl">
          <Trans>Prompt</Trans>
        </h2>
        <button
          type="button"
          className="text-muted text-sm"
          disabled={empty && !failure}
          onClick={clearHistory}
        >
          <Trans>Verlauf leeren</Trans>
        </button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto px-4 py-3 break-words">
        {connection?.locality === 'external' && <ExternalNotice host={connection.host} />}
        {empty && !failure && <Intro />}
        <Dialogue />
      </div>
      <Composer />
    </section>
  )
}

/** M1.2: the prompt text leaves the house; stays as long as the panel is open. */
function ExternalNotice({ host }: { host: string }) {
  return (
    <aside
      aria-label={t`Externe Anbindung`}
      className="card border-ink flex flex-col gap-1 border p-3 text-sm"
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <Globe size={14} aria-hidden /> <Trans>Der Prompt-Text verlässt das Haus</Trans>
      </p>
      <p>
        <Trans>
          Er geht an <code className="font-mono">{host}</code>.
        </Trans>{' '}
        <DataRelease />
      </p>
    </aside>
  )
}

/**
 * What the model sees (M1 data-release line). In E2.3 the model gets the layer
 * profile and the prompt and never rows, whatever the data-release flag says
 * (plan D9, D10: the flag starts to bite with a tool that returns row content).
 * The profile is more than names: it carries the code lists and value ranges an
 * administrator confirmed for the model (S2), so the line says so.
 */
function DataRelease() {
  return (
    <Trans>
      Das Modell sieht Layer- und Feldnamen sowie die freigegebenen Wertelisten und Wertebereiche,
      keine einzelnen Objekte oder Geometrien.
    </Trans>
  )
}

/** M1.1: what to ask, and examples from the visible layers. */
function Intro() {
  const layers = useAnalysis((s) => s.layers)
  const catalog = useLayers().data
  const setDraft = useModel((s) => s.setDraft)
  const examples = examplePrompts(layers, catalog)
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        <Trans>
          Fragen Sie in eigenen Worten nach den sichtbaren Layern. Das Modell schlägt eine Abfrage
          vor; die Analyse ändert sich erst, wenn Sie den Vorschlag im Editor übernehmen.
        </Trans>{' '}
        <DataRelease />
      </p>
      {examples.length > 0 ? (
        <section aria-labelledby="examples-title" className="flex flex-col items-start gap-1.5">
          <h3 id="examples-title" className="label-caps">
            <Trans>Beispiele aus den sichtbaren Layern</Trans>
          </h3>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="chip max-w-full text-left whitespace-normal"
              onClick={() => {
                setDraft(example)
                focusPrompt()
              }}
            >
              {example}
            </button>
          ))}
          <p className="text-muted text-xs">
            <Trans>Klick setzt den Text ins Feld, gesendet wird erst mit Senden.</Trans>
          </p>
        </section>
      ) : (
        <p className="text-muted text-xs">
          <Trans>Mit Layern auf der Karte erscheinen hier Beispiele.</Trans>
        </p>
      )}
    </div>
  )
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)

/** The clarification the latest answer asks (M12.2), or ``null``. */
function openQuestion(state: ModelState): number | null {
  const last = state.dialogue[state.dialogue.length - 1]
  const view = last === undefined ? undefined : state.views[last]
  return view?.status === 'answered' && view.answer?.kind === 'clarification' ? view.id : null
}

/** The input (M1): multi-line, sent with ⌘/Ctrl+Enter, locked while the model works. */
function Composer() {
  const { draft, approach, running, setDraft, setApproach } = useModel(
    useShallow((s) => ({
      draft: s.draft,
      approach: s.approach,
      running: s.running,
      setDraft: s.setDraft,
      setApproach: s.setApproach,
    })),
  )
  const sending = usePanel((s) => s.sending)
  const question = useModel(openQuestion)
  const { connection, level } = useActiveModel()
  const locked = running !== null || sending
  // While the latest answer asks back, the field gives the free answer (M12.2).
  const submit = () => void send(draft, approach, question)
  const levelName = level?.name ?? ''
  const name = connection?.name ?? ''
  const host = connection?.host ?? ''
  const where = !connection
    ? ''
    : connection.locality === 'external'
      ? t`${name} · extern · ${host}`
      : name
  return (
    <form
      aria-label={t`Prompt eingeben`}
      className="border-divider flex flex-col gap-2 border-t px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {question !== null && !locked && (
        <p id="prompt-answers" className="text-muted text-xs">
          <Trans>Ihre Eingabe beantwortet die Rückfrage.</Trans>
        </p>
      )}
      <textarea
        id={PROMPT_INPUT}
        aria-describedby={question !== null && !locked ? 'prompt-answers' : undefined}
        className="input min-h-16 w-full resize-y"
        rows={3}
        maxLength={4000}
        aria-label={t`Prompt`}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        placeholder={
          locked
            ? t`Eingabe gesperrt, solange das Modell arbeitet`
            : t`Frage zu den sichtbaren Layern …`
        }
        // Locked, the field is empty; the prompt comes back if nothing is answered (M14).
        // Read-only rather than disabled: the focus stays, so Esc still reaches the panel.
        value={locked ? '' : draft}
        readOnly={locked}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span id="approach-label" className="label-caps">
          <Trans>Arbeitsweise</Trans>
        </span>
        <div className="flex" role="radiogroup" aria-labelledby="approach-label">
          {(['direct', 'chain'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={approach === value}
              aria-describedby={value === 'chain' && !CHAIN_AVAILABLE ? 'chain-later' : undefined}
              disabled={locked || (value === 'chain' && !CHAIN_AVAILABLE)}
              // The chosen segment: 2 px accent underline (design pattern), not colour alone.
              className={`border px-2 first:rounded-l last:rounded-r disabled:opacity-45 ${approach === value ? 'border-accent text-accent-700 border-b-2 font-semibold' : 'border-neutral-400'}`}
              onClick={() => setApproach(value)}
            >
              {value === 'direct' ? t`Direktabfrage` : t`Werkzeugkette`}
            </button>
          ))}
        </div>
        {!CHAIN_AVAILABLE && (
          <span id="chain-later" className="text-muted text-xs">
            <Trans>ab E2.5</Trans>
          </span>
        )}
        <button
          type="submit"
          className="btn btn-primary ml-auto"
          disabled={locked || !draft.trim()}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          <Trans>Senden</Trans>{' '}
          <kbd className="text-xs" aria-hidden>
            {isMac() ? '⌘↵' : t({ message: 'Strg+↵', comment: 'Keyboard shortcut: Ctrl+Enter' })}
          </kbd>
        </button>
      </div>
      <p className="text-muted min-w-0 text-xs break-words">
        {where && `${where} · `}
        {levelName && `${t`Stufe ${levelName}`} · `}
        <Trans>Ihre Eingaben werden protokolliert</Trans>
      </p>
    </form>
  )
}

/** M1.3: no connection — the tab is disabled; Klassik stays fully usable. */
export function PromptUnavailable() {
  const me = useMe()
  return (
    <p className="text-muted mt-auto pt-4 text-xs">
      <Trans>Prompt nicht verfügbar: keine Modellanbindung aktiv. Klassik ist voll nutzbar.</Trans>
      {me.data?.role === 'admin' && (
        <>
          {' '}
          <Link to="/admin/modelle" className="text-accent-700">
            <Trans>Modellanbindungen ›</Trans>
          </Link>
        </>
      )}
    </p>
  )
}
