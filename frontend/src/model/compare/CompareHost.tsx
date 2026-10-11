// The comparison in the prompt panel (plan WP78): registers the finished
// chain's entry (model/chain/compare.ts), opens the dialog once when a repeat
// this workplace asked for and the record it repeats both have a result
// (flow.ts ``due``), and holds the dialog. Mounted with the dialogue, so only
// while the panel is shown, which is never beside the open editor.
import { useEffect } from 'react'
import type { ModelActionView } from '../../api/client'
import { registerCompare } from '../chain/compare'
import { useModel } from '../store'
import { CompareDialog } from './CompareDialog'
import { ChainCompareEntry } from './Entry'
import { due, openComparison, useComparison } from './flow'

/** The finished chain's entry, as model/chain/ draws it. */
const chainEntry = (view: ModelActionView) => <ChainCompareEntry view={view} />

export function CompareHost() {
  useEffect(() => registerCompare(chainEntry), [])
  const asked = useComparison((s) => s.asked)
  const shown = useComparison((s) => s.shown)
  const next = useModel((s) => due(s, asked))
  useEffect(() => {
    if (next !== null && shown === null) openComparison(next)
  }, [next, shown])
  return <CompareDialog />
}
