// Accounts (design D9, F-3.12): two roles, start passwords, lock, reset, delete.
// The rule "the last administrator stays" is the backend's; its answer is shown.
import { actionsFor } from '../i18n/phrases'
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { api, type Account, type Role, type StartPassword } from '../api/client'
import { keys, useMe, useUpdateUser, useUsers } from '../api/queries'
import { roleLabel } from '../auth/rules'
import { ConfirmDialog, ErrorNotice, Loading, Menu, MenuItem } from '../components/ui'
import { formatDateTime } from './format'

const roleItem = (role: Account['role']) => {
  const label = roleLabel(role)
  return t`Rolle: ${label}`
}

const deleteAccountTitle = (username: string) => t`Konto „${username}" löschen?`

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
          <Trans>Benutzer</Trans>
        </h2>
        <button type="button" className="btn btn-primary ml-auto" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden /> <Trans>Konto</Trans>
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
              <th>
                <Trans>Benutzer</Trans>
              </th>
              <th>
                <Trans>Name</Trans>
              </th>
              <th>
                <Trans>Rolle</Trans>
              </th>
              <th>
                <Trans>Status</Trans>
              </th>
              <th>
                <Trans>Letzte Anmeldung</Trans>
              </th>
              <th>
                <span className="sr-only">
                  <Trans>Aktionen</Trans>
                </span>
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
                      <span className="text-muted text-xs">
                        {' '}
                        <Trans>(Sie)</Trans>
                      </span>
                    )}
                  </td>
                  <td>{user.display_name || '–'}</td>
                  <td>
                    <span className={`chip ${user.role === 'admin' ? 'chip-active' : ''}`}>
                      {roleLabel(user.role)}
                    </span>
                  </td>
                  <td>
                    {locked ? t`gesperrt` : t`aktiv`}
                    {user.must_change_password && (
                      <div className="text-muted text-xs">
                        <Trans>Startpasswort offen</Trans>
                      </div>
                    )}
                  </td>
                  <td>{formatDateTime(user.last_login_at)}</td>
                  <td className="text-right">
                    <Menu label={actionsFor(user.username)}>
                      <MenuItem
                        onSelect={() =>
                          update.mutate({ username: user.username, body: { role: other } })
                        }
                      >
                        {roleItem(other)}
                      </MenuItem>
                      <MenuItem onSelect={() => reset.mutate(user.username)}>
                        <Trans>Passwort zurücksetzen</Trans>
                      </MenuItem>
                      <MenuItem
                        onSelect={() =>
                          update.mutate({
                            username: user.username,
                            body: { status: locked ? 'active' : 'locked' },
                          })
                        }
                      >
                        {locked ? t`Entsperren` : t`Sperren`}
                      </MenuItem>
                      <MenuItem danger onSelect={() => setDeleting(user)}>
                        <Trans>Löschen</Trans>
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
        <Trans>
          Der letzte aktive Administrator lässt sich weder sperren, herabstufen noch löschen.
        </Trans>
      </p>
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(undefined)}
          title={deleteAccountTitle(deleting.username)}
          confirm={t`Löschen`}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.username)}
        >
          <p>
            <Trans>
              Das Konto und seine Anmeldungen werden entfernt. Das Importprotokoll behält den Namen.
            </Trans>
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
      aria-label={t`Neues Konto`}
      className="card mb-4 max-w-md p-4"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <h3 className="mb-2 text-lg">
        <Trans>Neues Konto</Trans>
      </h3>
      <label className="mb-2 flex items-center gap-3 text-sm">
        <span className="w-24">
          <Trans>Benutzer</Trans>
        </span>
        <input
          className="input flex-1"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="mb-2 flex items-center gap-3 text-sm">
        <span className="w-24">
          <Trans>Name</Trans>
        </span>
        <input
          className="input flex-1"
          value={displayName}
          maxLength={120}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      <fieldset className="mb-2 flex items-center gap-3 text-sm">
        <legend className="sr-only">
          <Trans>Rolle</Trans>
        </legend>
        <span className="w-24">
          <Trans>Rolle</Trans>
        </span>
        {(['admin', 'user'] as const).map((r) => (
          <label key={r} className="flex items-center gap-1">
            <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
            {roleLabel(r)}
          </label>
        ))}
      </fieldset>
      <p className="text-muted mb-3 text-xs">
        <Trans>
          Das Startpasswort wird erzeugt und einmal angezeigt; es muss bei der ersten Anmeldung
          geändert werden.
        </Trans>
      </p>
      <ErrorNotice error={create.error} />
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={onCancel}>
          <Trans>Abbrechen</Trans>
        </button>
        <button type="submit" className="btn btn-primary ml-auto" disabled={create.isPending}>
          <Trans>Anlegen</Trans>
        </button>
      </div>
    </form>
  )
}

function IssuedPassword({ issued, onClose }: { issued: StartPassword; onClose: () => void }) {
  const username = issued.account.username
  return (
    <div role="status" className="card border-accent mb-4 max-w-md p-4 text-sm">
      <p>
        <Trans>
          Startpasswort für <strong>{username}</strong>:
        </Trans>
      </p>
      <p className="my-2">
        <code aria-label={t`Startpasswort`} className="bg-neutral-200 px-2 py-1 text-base">
          {issued.start_password}
        </code>
      </p>
      <p className="text-muted text-xs">
        <Trans>
          Wird nur jetzt angezeigt. Bitte sicher weitergeben; es muss bei der ersten Anmeldung
          geändert werden.
        </Trans>
      </p>
      <button type="button" className="btn mt-2" onClick={onClose}>
        <Trans>Verstanden</Trans>
      </button>
    </div>
  )
}
