// "Gespeicherte Abfragen" in the sidebar (design B1): the query's name, and a
// menu to save it, start anew or choose another — own or shared (plan E1.7b).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useShallow } from 'zustand/react/shallow'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { api, type SavedQuerySummary } from '../api/client'
import { useLayers } from '../api/queries'
import { ConfirmDialog } from '../components/ui'
import { newQuery, saveQuery } from './actions'
import { ManageQueriesDialog } from './ManageQueriesDialog'
import { isChanged, queryPart } from './part'
import { SaveQueryDialog } from './SaveQueryDialog'
import { queryKeys, useQueryUi } from './ui'
import { useChooseQuery, useOpenQuery } from './useChooseQuery'

const item =
  'flex cursor-pointer items-center justify-between gap-4 px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200 data-[disabled]:cursor-default data-[disabled]:text-muted'

export function SavedQueries() {
  const client = useQueryClient()
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const queryRef = useAnalysis((s) => s.queryRef)
  const catalog = useLayers()
  const ui = useQueryUi()
  const choose = useChooseQuery()
  const list = useQuery({ queryKey: queryKeys.list, queryFn: api.queries.list })
  const counts = useQuery({
    queryKey: ['saved-query-counts', list.data?.map((q) => q.query)],
    queryFn: () => api.count((list.data ?? []).slice(0, 50).map((q) => q.query)),
    enabled: Boolean(list.data?.length),
  })
  const save = useMutation({
    mutationFn: async () => {
      if (!(await saveQuery())) ui.open('saveAs')
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.list }),
    onError: (error) => ui.setMessage(error.message),
  })
  const part = queryPart(analysis)
  const changed = isChanged(analysis, queryRef)
  const title = (layer: string) => catalog.data?.find((l) => l.name === layer)?.title ?? layer
  const countOf = (q: SavedQuerySummary) => {
    const index = list.data?.indexOf(q) ?? -1
    return index >= 0 ? counts.data?.counts[index] : undefined
  }
  const same = (list.data ?? []).filter((q) => q.result_layer === part?.result)
  const other = (list.data ?? []).filter((q) => q.result_layer !== part?.result)
  const cannotSave = part
    ? undefined
    : 'Gespeichert werden Abfragen auf Katalog-Layern, nicht auf abgeleiteten.'

  const entry = (q: SavedQuerySummary, withLayer: boolean) => (
    <DropdownMenu.Item
      key={q.id}
      className={item}
      onSelect={() => choose({ id: q.id, name: q.name })}
    >
      <span className="flex flex-col">
        <span>
          {q.id === queryRef?.id && '✓ '}
          {q.name}
        </span>
        {!q.mine && <span className="text-muted text-xs">geteilt von {q.owner}</span>}
      </span>
      <span className="flex items-center gap-2">
        {withLayer && <span className="chip text-[11px]">{title(q.result_layer)}</span>}
        <span className="text-muted text-xs">{countOf(q) ?? ''}</span>
      </span>
    </DropdownMenu.Item>
  )

  return (
    <section aria-labelledby="saved-queries-title">
      <h2 id="saved-queries-title" className="label-caps mb-1">
        Gespeicherte Abfragen
      </h2>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="btn btn-primary w-full justify-between"
          aria-label="Gespeicherte Abfragen"
        >
          <span className="truncate">
            {queryRef ? queryRef.name : 'Nicht gespeichert'}
            {changed && <span className="text-muted"> · geändert</span>}
          </span>
          <ChevronDown size={14} aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            className="card z-[1100] max-h-[70vh] w-72 overflow-auto py-1 shadow-[var(--shadow-md)]"
          >
            <DropdownMenu.Item
              className={item}
              disabled={Boolean(cannotSave)}
              title={cannotSave}
              onSelect={() => save.mutate()}
            >
              Speichern
              {queryRef && !queryRef.mine && <span className="text-muted text-xs">als Kopie</span>}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={item}
              disabled={Boolean(cannotSave)}
              title={cannotSave}
              onSelect={() => ui.open('saveAs')}
            >
              Speichern unter …
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-divider)]" />
            <DropdownMenu.Item className={item} disabled={!part} onSelect={newQuery}>
              Neue Abfrage (leer)
            </DropdownMenu.Item>
            {same.length > 0 && part && (
              <DropdownMenu.Label className="label-caps px-3 pt-2">
                Gespeichert · {title(part.result)}
              </DropdownMenu.Label>
            )}
            {same.map((q) => entry(q, false))}
            {other.length > 0 && (
              <DropdownMenu.Label className="label-caps px-3 pt-2">
                {part ? 'Andere Ziel-Layer' : 'Gespeichert'}
              </DropdownMenu.Label>
            )}
            {other.map((q) => entry(q, true))}
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-divider)]" />
            <DropdownMenu.Item className={item} onSelect={() => ui.open('manage')}>
              Verwalten …
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <p className="text-muted mt-1 text-xs">
        Auswählen ersetzt die aktuelle Abfrage (bei Änderungen mit Rückfrage).
      </p>
      {ui.message && (
        <p role="alert" className="mt-1 text-xs">
          {ui.message}{' '}
          <button type="button" className="text-accent-700" onClick={() => ui.setMessage(null)}>
            OK
          </button>
        </p>
      )}
      <ReplaceQuestion />
      <SaveQueryDialog />
      <ManageQueriesDialog />
    </section>
  )
}

function ReplaceQuestion() {
  const { pending, setPending } = useQueryUi()
  const open = useOpenQuery()
  if (!pending) return null
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && setPending(null)}
      title="Aktuelle Abfrage ersetzen?"
      confirm="Ersetzen"
      busy={open.isPending}
      onConfirm={() => open.mutate(pending.id)}
    >
      <p>
        Die aktuelle Abfrage hat Änderungen, die in keiner gespeicherten Abfrage stehen. „
        {pending.name}" ersetzt sie.
      </p>
    </ConfirmDialog>
  )
}
