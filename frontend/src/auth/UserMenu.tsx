// Header user menu: name and role, own password (design A4), sign-out.
import { useMutation } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { Dialog, DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api, type Account } from '../api/client'
import { useResetSession } from '../api/queries'
import { newSession } from '../session/actions'
import { guarded, useSessionUi } from '../session/ui'
import { PasswordForm } from './PasswordForm'
import { ROLE_LABELS } from './rules'

export function UserMenu({ account }: { account: Account }) {
  const navigate = useNavigate()
  const resetSession = useResetSession()
  const [changing, setChanging] = useState(false)
  const [changed, setChanged] = useState(false)
  const logout = useMutation({
    mutationFn: api.auth.logout,
    onSettled: async () => {
      // The next account starts empty and lands in its own last session.
      newSession()
      useSessionUi.getState().setLanded(false)
      await resetSession()
      navigate('/anmelden', { replace: true })
    },
  })

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="btn border-transparent" aria-label="Benutzermenü">
          {account.display_name || account.username}
          <ChevronDown size={14} aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="card z-50 min-w-48 py-1 shadow-[var(--shadow-md)]"
          >
            <div className="border-divider border-b px-3 pb-1 text-sm">
              <div>{account.username}</div>
              <div className="text-muted text-xs">{ROLE_LABELS[account.role]}</div>
            </div>
            <DropdownMenu.Item
              className="cursor-pointer px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200"
              onSelect={() => {
                setChanged(false)
                setChanging(true)
              }}
            >
              Passwort ändern
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="cursor-pointer px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200"
              onSelect={() => guarded('abmelden', () => logout.mutate())}
            >
              Abmelden
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog.Root open={changing} onOpenChange={setChanging}>
        <Dialog.Portal>
          <Dialog.Overlay className="bg-ink/30 fixed inset-0 z-40" />
          <Dialog.Content className="card fixed top-1/4 left-1/2 z-50 w-96 max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5 shadow-[var(--shadow-md)]">
            <Dialog.Title className="mb-3 text-xl">Passwort ändern</Dialog.Title>
            <Dialog.Description className="sr-only">Eigenes Passwort ändern</Dialog.Description>
            {changed ? (
              <div role="status">
                <p className="mb-3 text-sm">Das Passwort ist geändert.</p>
                <button type="button" className="btn" onClick={() => setChanging(false)}>
                  Schliessen
                </button>
              </div>
            ) : (
              <PasswordForm onDone={() => setChanged(true)} onCancel={() => setChanging(false)} />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
