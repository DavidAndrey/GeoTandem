// Opening a saved query from the menu or the list (design B1, C6).
import { useMutation } from '@tanstack/react-query'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { useLayers } from '../api/queries'
import { openQuery } from './actions'
import { wouldLose } from './part'
import { useQueryUi } from './ui'

/** Opens a query and reports what had to be left out on today's layers. */
export function useOpenQuery() {
  const catalog = useLayers()
  const { setPending, setMessage } = useQueryUi()
  return useMutation({
    mutationFn: (id: string) => openQuery(id, new Set(catalog.data?.map((l) => l.name) ?? [])),
    onSuccess: (removed) => {
      setPending(null)
      setMessage(
        removed.length
          ? `Ohne ${removed.map((r) => `„${r}"`).join(', ')}: ihr Layer ist nicht verfügbar.`
          : null,
      )
    },
    onError: (error) => {
      setPending(null)
      setMessage(error.message)
    },
  })
}

/** Opens at once, or asks first when the current query would be lost (design B1). */
export function useChooseQuery() {
  const open = useOpenQuery()
  const setPending = useQueryUi((s) => s.setPending)
  return (query: { id: string; name: string }) => {
    const s = useAnalysis.getState()
    if (wouldLose(currentAnalysis(s), s.queryRef)) setPending(query)
    else open.mutate(query.id)
  }
}
