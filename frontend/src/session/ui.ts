// Which session dialog is open, and what waits behind the unsaved-changes
// question (design C2, C3, C5). One host renders them (SessionDialogs).
import { t } from '@lingui/core/macro'
import { create } from 'zustand'
import { useAnalysis } from '../analysis/store'
import { newSession, saveSession } from './actions'
import { useSession } from './store'
import { dateTimeFormat } from '../i18n/locale'

/** What waits behind the C5 question; the dialog words it ("Speichern und öffnen"). */
export type GuardedAction = 'open' | 'new' | 'logout'
export type Pending = { action: GuardedAction; run: () => void }

interface SessionUi {
  dialog: 'saveAs' | 'list' | null
  /** Runs after a successful "Speichern unter", e.g. the open that C5 interrupted. */
  afterSave: (() => void) | null
  /** An action waiting for the C5 answer. */
  guard: Pending | null
  /** Landed once in the last session after sign-in (design A2, plan D7). */
  landed: boolean
  /** The account the analysis in memory belongs to. */
  owner: number | null
  openDialog: (dialog: 'saveAs' | 'list', afterSave?: () => void) => void
  close: () => void
  setGuard: (guard: Pending | null) => void
  setLanded: (landed: boolean) => void
  setOwner: (owner: number | null) => void
}

export const useSessionUi = create<SessionUi>()((set) => ({
  dialog: null,
  afterSave: null,
  guard: null,
  landed: false,
  owner: null,
  openDialog: (dialog, afterSave) => set({ dialog, afterSave: afterSave ?? null }),
  close: () => set({ dialog: null, afterSave: null }),
  setGuard: (guard) => set({ guard }),
  setLanded: (landed) => set({ landed }),
  setOwner: (owner) => set({ owner }),
}))

/**
 * The analysis in memory belongs to one account: another one signing in (e.g.
 * after the session ran out on a shared PC) starts empty and lands in its own
 * last session (design A2); the same one keeps its unsaved work.
 */
export function signedInAs(account: number) {
  const ui = useSessionUi.getState()
  if (ui.owner === account) return
  if (ui.owner !== null) {
    newSession()
    ui.setLanded(false)
  }
  ui.setOwner(account)
}

/** Unsaved: any change except moving the map, and an open editor draft (plan D8). */
export const isUnsaved = (s: { dirty: boolean; draft: unknown }) => s.dirty || s.draft !== null

export const useUnsaved = () => useAnalysis(isUnsaved)

/**
 * Runs ``run`` now, or after the C5 question when there are unsaved changes:
 * "Speichern und …", "Verwerfen", "Abbrechen".
 */
export function guarded(action: GuardedAction, run: () => void) {
  if (!isUnsaved(useAnalysis.getState())) run()
  else useSessionUi.getState().setGuard({ action, run })
}

/** "heute 14:02", "gestern", "28.09." (design C3). The server writes UTC without a zone. */
function when(iso: string, now: Date) {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(date)) / 86_400_000)
  const time = dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(date)
  const dated = dateTimeFormat({
    day: '2-digit',
    month: '2-digit',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date)
  return { days, time, dated }
}

export function formatWhen(iso: string, now = new Date()): string {
  const { days, time, dated } = when(iso, now)
  if (days === 0) return t`heute ${time}`
  if (days === 1) return t`gestern`
  return dated
}

/** The header's "gespeichert 14:02" (design C1): today by the time alone. */
export function formatSaved(iso: string, now = new Date()): string {
  const { days, time, dated } = when(iso, now)
  if (days === 0) return t`gespeichert ${time}`
  if (days === 1) return t`gespeichert gestern`
  return t`gespeichert ${dated}`
}

export const sessionKeys = { list: ['sessions'] as const }

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)

/** "Speichern" (⌘S): the current session, or "Speichern unter" for a new one. */
export async function saveOrAsk() {
  if (useSession.getState().current) await saveSession()
  else useSessionUi.getState().openDialog('saveAs')
}
