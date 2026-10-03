// Which query dialog is open, and a choice waiting for "Ersetzen?" (design B1, C6).
import { create } from 'zustand'

interface QueryUi {
  dialog: 'saveAs' | 'manage' | null
  /** A query to open once the user agreed to replace the current one. */
  pending: { id: string; name: string } | null
  /** What opening left out, or why it failed. */
  message: string | null
  open: (dialog: 'saveAs' | 'manage') => void
  close: () => void
  setPending: (pending: { id: string; name: string } | null) => void
  setMessage: (message: string | null) => void
}

export const useQueryUi = create<QueryUi>()((set) => ({
  dialog: null,
  pending: null,
  message: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
  setPending: (pending) => set({ pending }),
  setMessage: (message) => set({ message }),
}))

export const queryKeys = { list: ['saved-queries'] as const }
