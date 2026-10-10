// The hook for *Mit Direktabfrage vergleichen* (design M9.3 → M10.2; plan
// WP78). The comparison dialog is WP78's: it registers its opener here, and
// the finished chain shows the button only once one is registered, so nothing
// offers a comparison the workplace cannot make yet.
import { create } from 'zustand'
import type { ModelActionView } from '../../api/client'

interface CompareState {
  /** Opens the comparison of a finished chain with the direct query (M10). */
  open: ((view: ModelActionView) => void) | null
}

export const useCompare = create<CompareState>()(() => ({ open: null }))

/** Registers the comparison; returns the unregister (for an effect's cleanup). */
export function registerCompare(open: (view: ModelActionView) => void): () => void {
  useCompare.setState({ open })
  return () => useCompare.setState((s) => (s.open === open ? { open: null } : s))
}
