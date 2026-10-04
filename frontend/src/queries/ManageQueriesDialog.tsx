// "Abfragen verwalten" (design C6): own and shared queries. Only the owner
// renames, shares or deletes; anyone opens or copies (plan E1.7b, Q3).
import { actionsFor, deleteTitle } from '../i18n/phrases'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAnalysis } from '../analysis/store'
import { api, type SavedQuerySummary } from '../api/client'
import { useLayers } from '../api/queries'
import { ConfirmDialog, ErrorNotice, Loading, Menu, MenuItem, Modal } from '../components/ui'
import { formatWhen } from '../session/ui'
import { conditionLabel } from './part'
import { useChooseQuery } from './useChooseQuery'
import { queryKeys, useQueryUi } from './ui'
import { lowerText } from '../i18n/locale'

export function ManageQueriesDialog() {
  const { dialog, close } = useQueryUi()
  return (
    <Modal
      open={dialog === 'manage'}
      onOpenChange={(next) => !next && close()}
      title={t`Gespeicherte Abfragen`}
      description={t`Eigene und geteilte Abfragen öffnen, umbenennen, teilen, kopieren oder löschen`}
      wide
    >
      {dialog === 'manage' && <QueryList onClose={close} />}
    </Modal>
  )
}

function QueryList({ onClose }: { onClose: () => void }) {
  const client = useQueryClient()
  const catalog = useLayers()
  const choose = useChooseQuery()
  const current = useAnalysis((s) => s.queryRef)
  const list = useQuery({ queryKey: queryKeys.list, queryFn: api.queries.list })
  const [search, setSearch] = useState('')
  const [layer, setLayer] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<SavedQuerySummary | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.list })
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; shared?: boolean }) =>
      api.queries.patch(id, body),
    onSuccess: (summary) => {
      setRenaming(null)
      const ref = useAnalysis.getState().queryRef
      if (ref?.id === summary.id)
        useAnalysis.getState().setQueryRef({ ...ref, name: summary.name, shared: summary.shared })
      return refresh()
    },
  })
  const duplicate = useMutation({ mutationFn: api.queries.duplicate, onSuccess: refresh })
  const usage = useQuery({
    queryKey: ['saved-query-usage', deleting?.id],
    queryFn: () => api.queries.usage(deleting?.id ?? ''),
    enabled: deleting !== null,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.queries.remove(id),
    onSuccess: (_, id) => {
      setDeleting(null)
      if (useAnalysis.getState().queryRef?.id === id) useAnalysis.getState().setQueryRef(null)
      return refresh()
    },
  })
  const title = (name: string) => catalog.data?.find((l) => l.name === name)?.title ?? name
  const needle = lowerText(search.trim())
  const layers = [...new Set((list.data ?? []).map((q) => q.result_layer))]
  const shown = (list.data ?? []).filter(
    (q) => (!needle || lowerText(q.name).includes(needle)) && (!layer || q.result_layer === layer),
  )
  const open = (q: SavedQuerySummary) => {
    onClose()
    choose({ id: q.id, name: q.name })
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex justify-end gap-2">
        <input
          className="input"
          type="search"
          placeholder={t`Suchen`}
          aria-label={t`Abfragen suchen`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input"
          aria-label={t`Ziel-Layer`}
          value={layer}
          onChange={(e) => setLayer(e.target.value)}
        >
          <option value="">
            <Trans>Alle Ziel-Layer</Trans>
          </option>
          {layers.map((name) => (
            <option key={name} value={name}>
              {title(name)}
            </option>
          ))}
        </select>
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorNotice error={list.error} />
      ) : shown.length === 0 ? (
        <p className="text-muted">
          {list.data.length ? t`Keine Abfrage passt.` : t`Noch keine Abfrage gespeichert.`}
        </p>
      ) : (
        <table className="data-table w-full" aria-label={t`Gespeicherte Abfragen`}>
          <thead>
            <tr>
              <th>
                <Trans>Name</Trans>
              </th>
              <th>
                <Trans>Ziel-Layer</Trans>
              </th>
              <th>
                <Trans>Bedingungen</Trans>
              </th>
              <th>
                <Trans>Geändert</Trans>
              </th>
              <th>
                <Trans>Geteilt</Trans>
              </th>
              <th>
                <span className="sr-only">
                  <Trans>Aktionen</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((q) => (
              <tr key={q.id} className={q.id === current?.id ? 'bg-neutral-200' : ''}>
                <td>
                  {renaming?.id === q.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        patch.mutate({ id: q.id, name: renaming.name })
                      }}
                    >
                      <input
                        className="input w-full"
                        aria-label={t`Neuer Name`}
                        value={renaming.name}
                        maxLength={120}
                        autoFocus
                        onChange={(e) => setRenaming({ id: q.id, name: e.target.value })}
                        onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      className={`text-left hover:underline ${q.id === current?.id ? 'font-semibold' : ''}`}
                      onClick={() => open(q)}
                    >
                      {q.name}
                    </button>
                  )}
                  {!q.mine && <div className="text-muted text-xs">von {q.owner}</div>}
                </td>
                <td>{title(q.result_layer)}</td>
                <td>{conditionLabel(q.conditions)}</td>
                <td>{formatWhen(q.updated_at)}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${q.name} teilen`}
                    checked={q.shared}
                    disabled={!q.mine || patch.isPending}
                    title={q.mine ? undefined : t`Nur wer sie gespeichert hat, teilt sie.`}
                    onChange={(e) => patch.mutate({ id: q.id, shared: e.target.checked })}
                  />
                </td>
                <td className="text-right">
                  <Menu label={actionsFor(q.name)}>
                    <MenuItem onSelect={() => open(q)}>
                      <Trans>Öffnen</Trans>
                    </MenuItem>
                    {q.mine && (
                      <MenuItem onSelect={() => setRenaming({ id: q.id, name: q.name })}>
                        <Trans>Umbenennen</Trans>
                      </MenuItem>
                    )}
                    <MenuItem onSelect={() => duplicate.mutate(q.id)}>
                      {q.mine ? t`Duplizieren` : t`Als eigene Kopie speichern`}
                    </MenuItem>
                    {q.mine && (
                      <MenuItem danger onSelect={() => setDeleting(q)}>
                        <Trans>Löschen</Trans>
                      </MenuItem>
                    )}
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(patch.isError || duplicate.isError) && (
        <ErrorNotice error={patch.error ?? duplicate.error} />
      )}
      <div className="flex items-end justify-between gap-4">
        <p className="text-muted text-xs">
          <Trans>
            Geteilt: für alle Anwender sichtbar, die ihre Layer sehen — nur lesend, Ändern erzeugt
            eine Kopie.
          </Trans>
        </p>
        <button type="button" className="btn" onClick={onClose}>
          <Trans>Schliessen</Trans>
        </button>
      </div>
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setDeleting(null)}
          title={deleteTitle(deleting.name)}
          confirm={t`Löschen`}
          busy={remove.isPending || usage.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
        >
          <p>
            {usage.data?.sessions
              ? plural(usage.data.sessions, {
                  one: 'Die Abfrage wird in # Sitzung verwendet. Diese behält ihre Bedingungen; nur der Name geht verloren.',
                  other:
                    'Die Abfrage wird in # Sitzungen verwendet. Diese behalten ihre Bedingungen; nur der Name geht verloren.',
                })
              : t`Die Abfrage wird endgültig gelöscht.`}
            {deleting.shared && ' ' + t`Sie ist geteilt und verschwindet auch für alle anderen.`}
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
