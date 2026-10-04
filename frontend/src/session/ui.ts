// Which session dialog is open, and what waits behind the unsaved-changes
// question (design C2, C3, C5). One host renders them (SessionDialogs).
import { create } from 'zustand'
import { useAnalysis } from '../analysis/store'
import { newSession, saveSession } from './actions'
import { useSession } from './store'
import { dateTimeFormat } from '../i18n/locale'

export type Pending = { label: string; run: () => void }

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
export function guarded(label: string, run: () => void) {
  if (!isUnsaved(useAnalysis.getState())) run()
  else useSessionUi.getState().setGuard({ label, run })
}

/** "heute 14:02", "gestern", "28.09." (design C3). The server writes UTC without a zone. */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(date)) / 86_400_000)
  const time = dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(date)
  if (days === 0) return `heute ${time}`
  if (days === 1) return 'gestern'
  return dateTimeFormat({
    day: '2-digit',
    month: '2-digit',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date)
}

export const sessionKeys = { list: ['sessions'] as const }

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)

/** "Speichern" (⌘S): the current session, or "Speichern unter" for a new one. */
export async function saveOrAsk() {
  if (useSession.getState().current) await saveSession()
  else useSessionUi.getState().openDialog('saveAs')
}
