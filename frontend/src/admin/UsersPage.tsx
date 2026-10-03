// Accounts (design D9, F-3.12): two roles, start passwords, lock, reset, delete.
// The rule "the last administrator stays" is the backend's; its answer is shown.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { api, type Account, type Role, type StartPassword } from '../api/client'
import { keys, useMe, useUpdateUser, useUsers } from '../api/queries'
import { ROLE_LABELS } from '../auth/rules'
import { ConfirmDialog, ErrorNotice, Loading, Menu, MenuItem } from '../components/ui'
import { formatDateTime } from './format'

export function UsersPage() {
  const users = useUsers()
  const me = useMe()
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: keys.users })
  const update = useUpdateUser()
  const [creating, setCreating] = useState(false)
  const [issued, setIssued] = useState<StartPassword>()
  const [deleting, setDeleting] = useState<Account>()
  const reset = useMutation({ mutationFn: api.admin.resetPassword, onSuccess: setIssued })
  const remove = useMutation({
    mutationFn: api.admin.deleteUser,
    onSuccess: async () => {
      setDeleting(undefined)
      await refresh()
    },
  })

  return (
    <section aria-labelledby="users-title" className="max-w-4xl">
      <div className="mb-3 flex items-center gap-3">
        <h2 id="users-title" className="text-2xl">
          Benutzer
        </h2>
        <button type="button" className="btn btn-primary ml-auto" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden /> Konto
        </button>
      </div>
      {creating && (
        <NewAccountForm
          onCreated={(result) => {
            setCreating(false)
            setIssued(result)
            void refresh()
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {issued && <IssuedPassword issued={issued} onClose={() => setIssued(undefined)} />}
      <ErrorNotice error={update.error ?? reset.error} />
      {users.isPending && <Loading />}
      <ErrorNotice error={users.error} />
      {users.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Benutzer</th>
              <th>Name</th>
              <th>Rolle</th>
              <th>Status</th>
              <th>Letzte Anmeldung</th>
              <th>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => {
              const locked = user.status === 'locked'
              const other: Role = user.role === 'admin' ? 'user' : 'admin'
              return (
                <tr key={user.username} className={locked ? 'opacity-60' : ''}>
                  <td>
                    {user.username}
                    {user.username === me.data?.username && (
                      <span className="text-muted text-xs"> (Sie)</span>
                    )}
                  </td>
                  <td>{user.display_name || '–'}</td>
                  <td>
                    <span className={`chip ${user.role === 'admin' ? 'chip-active' : ''}`}>
                      {ROLE_LABELS[user.role]}
                    </span>
                  </td>
                  <td>
                    {locked ? 'gesperrt' : 'aktiv'}
                    {user.must_change_password && (
                      <div className="text-muted text-xs">Startpasswort offen</div>
                    )}
                  </td>
                  <td>{formatDateTime(user.last_login_at)}</td>
                  <td className="text-right">
                    <Menu label={`Aktionen für ${user.username}`}>
                      <MenuItem
                        onSelect={() =>
                          update.mutate({ username: user.username, body: { role: other } })
                        }
                      >
                        Rolle: {ROLE_LABELS[other]}
                      </MenuItem>
                      <MenuItem onSelect={() => reset.mutate(user.username)}>
                        Passwort zurücksetzen
                      </MenuItem>
                      <MenuItem
                        onSelect={() =>
                          update.mutate({
                            username: user.username,
                            body: { status: locked ? 'active' : 'locked' },
                          })
                        }
                      >
                        {locked ? 'Entsperren' : 'Sperren'}
                      </MenuItem>
                      <MenuItem danger onSelect={() => setDeleting(user)}>
                        Löschen
                      </MenuItem>
                    </Menu>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="text-muted mt-2 text-xs">
        Der letzte aktive Administrator lässt sich weder sperren, herabstufen noch löschen.
      </p>
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(undefined)}
          title={`Konto „${deleting.username}" löschen?`}
          confirm="Löschen"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.username)}
        >
          <p>
            Das Konto und seine Anmeldungen werden entfernt. Das Importprotokoll behält den Namen.
          </p>
          <ErrorNotice error={remove.error} />
        </ConfirmDialog>
      )}
    </section>
  )
}

function NewAccountForm({
  onCreated,
  onCancel,
}: {
  onCreated: (result: StartPassword) => void
  onCancel: () => void
}) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<Role>('user')
  const create = useMutation({
    mutationFn: () => api.admin.createUser({ username, display_name: displayName, role }),
    onSuccess: onCreated,
  })
  return (
    <form
      aria-label="Neues Konto"
      className="card mb-4 max-w-md p-4"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <h3 className="mb-2 text-lg">Neues Konto</h3>
      <label className="mb-2 flex items-center gap-3 text-sm">
        <span className="w-24">Benutzer</span>
        <input
          className="input flex-1"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="mb-2 flex items-center gap-3 text-sm">
        <span className="w-24">Name</span>
        <input
          className="input flex-1"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      <fieldset className="mb-2 flex items-center gap-3 text-sm">
        <legend className="sr-only">Rolle</legend>
        <span className="w-24">Rolle</span>
        {(['admin', 'user'] as const).map((r) => (
          <label key={r} className="flex items-center gap-1">
            <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
            {ROLE_LABELS[r]}
          </label>
        ))}
      </fieldset>
      <p className="text-muted mb-3 text-xs">
        Das Startpasswort wird erzeugt und einmal angezeigt; es muss bei der ersten Anmeldung
        geändert werden.
      </p>
      <ErrorNotice error={create.error} />
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={onCancel}>
          Abbrechen
        </button>
        <button type="submit" className="btn btn-primary ml-auto" disabled={create.isPending}>
          Anlegen
        </button>
      </div>
    </form>
  )
}

function IssuedPassword({ issued, onClose }: { issued: StartPassword; onClose: () => void }) {
  return (
    <div role="status" className="card border-accent mb-4 max-w-md p-4 text-sm">
      <p>
        Startpasswort für <strong>{issued.account.username}</strong>:
      </p>
      <p className="my-2">
        <code aria-label="Startpasswort" className="bg-neutral-200 px-2 py-1 text-base">
          {issued.start_password}
        </code>
      </p>
      <p className="text-muted text-xs">
        Wird nur jetzt angezeigt. Bitte sicher weitergeben; es muss bei der ersten Anmeldung
        geändert werden.
      </p>
      <button type="button" className="btn mt-2" onClick={onClose}>
        Verstanden
      </button>
    </div>
  )
}
