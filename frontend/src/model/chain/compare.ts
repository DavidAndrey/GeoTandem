// The hook for *Mit Direktabfrage vergleichen* (design M9.3 → M10; plan WP77,
// WP78). The comparison is model/compare/'s, which builds on the chain's
// steps: it registers its entry here (the workplace's dialogue does, panel/
// Answer.tsx), so model/chain/ does not import it back. The finished chain
// shows the entry only once one is registered, so nothing offers a
// comparison the workplace cannot make.
import type { ReactNode } from 'react'
import { create } from 'zustand'
import type { ModelActionView } from '../../api/client'

/** The entry of a finished chain: its button and what it says when refused. */
export type CompareEntry = (view: ModelActionView) => ReactNode

interface CompareState {
  entry: CompareEntry | null
}

export const useCompare = create<CompareState>()(() => ({ entry: null }))

/** Registers the comparison's entry; returns the unregister (for an effect's cleanup). */
export function registerCompare(entry: CompareEntry): () => void {
  useCompare.setState({ entry })
  return () => useCompare.setState((s) => (s.entry === entry ? { entry: null } : s))
}
