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
  /** Registered entries, the latest last: the one shown. */
  entries: CompareEntry[]
  entry: CompareEntry | null
}

export const useCompare = create<CompareState>()(() => ({ entries: [], entry: null }))

/**
 * Registers the comparison's entry; returns the unregister (for an effect's
 * cleanup), which brings back the one registered before.
 */
export function registerCompare(entry: CompareEntry): () => void {
  useCompare.setState((s) => {
    const entries = [...s.entries, entry]
    return { entries, entry }
  })
  return () =>
    useCompare.setState((s) => {
      const entries = s.entries.filter((e) => e !== entry)
      return { entries, entry: entries[entries.length - 1] ?? null }
    })
}
