// "Alle öffnen" (design C3): the account's own sessions (design decision 2).
import { actionsFor, deleteTitle } from '../i18n/phrases'
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api, type SessionSummary } from '../api/client'
import { useLayers } from '../api/queries'
import { ConfirmDialog, ErrorNotice, Loading, Menu, MenuItem, Modal } from '../components/ui'
import { newSession } from './actions'
import { useSession } from './store'
import { formatWhen, guarded, sessionKeys, useSessionUi } from './ui'
import { lowerText } from '../i18n/locale'

export function SessionsDialog() {
  const { dialog, close } = useSessionUi()
  return (
    <Modal
      open={dialog === 'list'}
      onOpenChange={(next) => !next && close()}
      title={t`Sitzungen`}
      description={t`Gespeicherte Sitzungen öffnen, umbenennen, duplizieren oder löschen`}
      wide
    >
      {dialog === 'list' && <SessionList onClose={close} />}
    </Modal>
  )
}

function SessionList({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const current = useSession((s) => s.current)
  const catalog = useLayers()
  const sessions = useQuery({ queryKey: sessionKeys.list, queryFn: api.sessions.list })
  const [search, setSearch] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: sessionKeys.list })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.sessions.rename(id, { name }),
    onSuccess: (summary) => {
      setRenaming(null)
      if (current?.id === summary.id)
        useSession.getState().setCurrent({ ...current, name: summary.name })
      return refresh()
    },
  })
  const duplicate = useMutation({ mutationFn: api.sessions.duplicate, onSuccess: refresh })
  const remove = useMutation({
    mutationFn: (id: string) => api.sessions.remove(id),
    onSuccess: (_, id) => {
      setDeleting(null)
      if (current?.id === id) {
        newSession()
        navigate('/')
      }
      return refresh()
    },
  })
  const open = (id: string) => {
    onClose()
    if (id !== current?.id) guarded('open', () => navigate(`/sitzung/${id}`))
  }
  const title = (layer: string | null) =>
    layer ? (catalog.data?.find((l) => l.name === layer)?.title ?? layer) : '–'
  const needle = lowerText(search.trim())
  const shown = (sessions.data ?? []).filter((s) => !needle || lowerText(s.name).includes(needle))

  return (
    <div className="flex flex-col gap-3 text-sm">
      <input
        className="input self-end"
        type="search"
        placeholder={t`Suchen`}
        aria-label={t`Sitzungen suchen`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {sessions.isPending ? (
        <Loading />
      ) : sessions.isError ? (
        <ErrorNotice error={sessions.error} />
      ) : shown.length === 0 ? (
        <p className="text-muted">
          {sessions.data.length ? t`Keine Sitzung passt.` : t`Noch keine Sitzung gespeichert.`}
        </p>
      ) : (
        <table className="data-table w-full" aria-label={t`Sitzungen`}>
          <thead>
            <tr>
              <th>
                <Trans>Name</Trans>
              </th>
              <th>
                <Trans>Ziel-Layer</Trans>
              </th>
              <th>
                <Trans>Treffer</Trans>
              </th>
              <th>
                <Trans>Geändert</Trans>
              </th>
              <th>
                <span className="sr-only">
                  <Trans>Aktionen</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id} className={s.id === current?.id ? 'bg-neutral-200' : ''}>
                <td>
                  {renaming?.id === s.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        rename.mutate(renaming)
                      }}
                    >
                      <input
                        className="input w-full"
                        aria-label={t`Neuer Name`}
                        value={renaming.name}
                        maxLength={120}
                        autoFocus
                        onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                        onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      className={`text-left hover:underline ${s.id === current?.id ? 'font-semibold' : ''}`}
                      onClick={() => open(s.id)}
                    >
                      {s.name}
                    </button>
                  )}
                </td>
                <td>{title(s.result_layer)}</td>
                <td>
                  {s.stamp?.count ?? '–'}
                  {s.data_changed && (
                    <span
                      className="chip chip-active ml-2 text-[11px]"
                      title={t`Ein beteiligter Layer hat seit dem Speichern eine neue Fassung oder fehlt.`}
                    >
                      <Trans>Daten neu</Trans>
                    </span>
                  )}
                </td>
                <td>{formatWhen(s.updated_at)}</td>
                <td className="text-right">
                  {s.id === current?.id ? (
                    <span className="text-muted">
                      <Trans>offen</Trans>
                    </span>
                  ) : null}
                  <Menu label={actionsFor(s.name)}>
                    <MenuItem onSelect={() => open(s.id)}>
                      <Trans>Öffnen</Trans>
                    </MenuItem>
                    <MenuItem onSelect={() => setRenaming({ id: s.id, name: s.name })}>
                      <Trans>Umbenennen</Trans>
                    </MenuItem>
                    <MenuItem onSelect={() => duplicate.mutate(s.id)}>
                      <Trans>Duplizieren</Trans>
                    </MenuItem>
                    <MenuItem danger onSelect={() => setDeleting(s)}>
                      <Trans>Löschen</Trans>
                    </MenuItem>
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(rename.isError || duplicate.isError) && (
        <ErrorNotice error={rename.error ?? duplicate.error} />
      )}
      <div className="flex items-end justify-between gap-4">
        <p className="text-muted text-xs">
          <Trans>
            „Daten neu": ein beteiligter Layer wurde seit dem Speichern aktualisiert. Sitzungen sind
            privat.
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
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
        >
          <p>
            <Trans>Die Sitzung wird endgültig gelöscht.</Trans>
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
