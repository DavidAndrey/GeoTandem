// The session the workplace shows (F-4.10): which one it is and what opening
// it found. The analysis itself stays in the analysis store.
import { create } from 'zustand'
import type { SessionCheck, SessionStamp } from '../api/client'
import type { Removed } from './format'

export interface CurrentSession {
  id: string
  name: string
  note: string
  savedAt: string
  stamp: SessionStamp | null
}

/** What opening found (design C4, C8). */
export interface OpenReport {
  name: string
  check: SessionCheck | null
  removed: Removed
  /** Opening failed before the check, e.g. an unknown format. */
  error: string | null
}

interface SessionStore {
  current: CurrentSession | null
  report: OpenReport | null
  setCurrent: (current: CurrentSession | null) => void
  setReport: (report: OpenReport | null) => void
}

export const useSession = create<SessionStore>()((set) => ({
  current: null,
  report: null,
  setCurrent: (current) => set({ current }),
  setReport: (report) => set({ report }),
}))
