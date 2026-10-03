// "Alle öffnen" (design C3): the account's own sessions (design decision 2).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api, type SessionSummary } from '../api/client'
import { useLayers } from '../api/queries'
import { ConfirmDialog, ErrorNotice, Loading, Menu, MenuItem, Modal } from '../components/ui'
import { newSession } from './actions'
import { useSession } from './store'
import { formatWhen, guarded, sessionKeys, useSessionUi } from './ui'

export function SessionsDialog() {
  const { dialog, close } = useSessionUi()
  return (
    <Modal
      open={dialog === 'list'}
      onOpenChange={(next) => !next && close()}
      title="Sitzungen"
      description="Gespeicherte Sitzungen öffnen, umbenennen, duplizieren oder löschen"
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
    if (id !== current?.id) guarded('öffnen', () => navigate(`/sitzung/${id}`))
  }
  const title = (layer: string | null) =>
    layer ? (catalog.data?.find((l) => l.name === layer)?.title ?? layer) : '–'
  const needle = search.trim().toLocaleLowerCase('de-CH')
  const shown = (sessions.data ?? []).filter(
    (s) => !needle || s.name.toLocaleLowerCase('de-CH').includes(needle),
  )

  return (
    <div className="flex flex-col gap-3 text-sm">
      <input
        className="input self-end"
        type="search"
        placeholder="Suchen"
        aria-label="Sitzungen suchen"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {sessions.isPending ? (
        <Loading />
      ) : sessions.isError ? (
        <ErrorNotice error={sessions.error} />
      ) : shown.length === 0 ? (
        <p className="text-muted">
          {sessions.data.length ? 'Keine Sitzung passt.' : 'Noch keine Sitzung gespeichert.'}
        </p>
      ) : (
        <table className="data-table w-full" aria-label="Sitzungen">
          <thead>
            <tr>
              <th>Name</th>
              <th>Ziel-Layer</th>
              <th>Treffer</th>
              <th>Geändert</th>
              <th>
                <span className="sr-only">Aktionen</span>
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
                        aria-label="Neuer Name"
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
                      title="Ein beteiligter Layer hat seit dem Speichern eine neue Fassung oder fehlt."
                    >
                      Daten neu
                    </span>
                  )}
                </td>
                <td>{formatWhen(s.updated_at)}</td>
                <td className="text-right">
                  {s.id === current?.id ? <span className="text-muted">offen</span> : null}
                  <Menu label={`Aktionen für ${s.name}`}>
                    <MenuItem onSelect={() => open(s.id)}>Öffnen</MenuItem>
                    <MenuItem onSelect={() => setRenaming({ id: s.id, name: s.name })}>
                      Umbenennen
                    </MenuItem>
                    <MenuItem onSelect={() => duplicate.mutate(s.id)}>Duplizieren</MenuItem>
                    <MenuItem danger onSelect={() => setDeleting(s)}>
                      Löschen
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
          „Daten neu": ein beteiligter Layer wurde seit dem Speichern aktualisiert. Sitzungen sind
          privat.
        </p>
        <button type="button" className="btn" onClick={onClose}>
          Schliessen
        </button>
      </div>
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setDeleting(null)}
          title={`„${deleting.name}" löschen?`}
          confirm="Löschen"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
        >
          <p>Die Sitzung wird endgültig gelöscht.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
