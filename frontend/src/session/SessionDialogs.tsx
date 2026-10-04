// Every session dialog in one place, mounted once in the application header.
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { AlertDialog } from 'radix-ui'
import { ErrorNotice } from '../components/ui'
import { saveSession } from './actions'
import { SaveAsDialog } from './SaveAsDialog'
import { SessionsDialog } from './SessionsDialog'
import { useSession } from './store'
import { useSessionUi, type GuardedAction } from './ui'

const SAVE_AND: Record<GuardedAction, MessageDescriptor> = {
  open: msg`Speichern und öffnen`,
  new: msg`Speichern und neu beginnen`,
  logout: msg`Speichern und abmelden`,
}

export function SessionDialogs() {
  return (
    <>
      <SaveAsDialog />
      <SessionsDialog />
      <UnsavedDialog />
    </>
  )
}

/** C5: before opening, starting anew or signing out with unsaved changes. */
function UnsavedDialog() {
  const { guard, setGuard, openDialog } = useSessionUi()
  const save = useMutation({
    mutationFn: async () => {
      if (!guard) return
      if (useSession.getState().current) {
        await saveSession()
        setGuard(null)
        guard.run()
      } else {
        // A new analysis needs a name first; the action follows the save.
        setGuard(null)
        openDialog('saveAs', guard.run)
      }
    },
  })
  return (
    <AlertDialog.Root open={guard !== null} onOpenChange={(next) => !next && setGuard(null)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="bg-ink/30 fixed inset-0 z-[1200]" />
        <AlertDialog.Content className="card fixed top-1/3 left-1/2 z-[1200] w-[30rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5 shadow-[var(--shadow-md)]">
          <AlertDialog.Title className="mb-2 text-xl">
            <Trans>Ungespeicherte Änderungen</Trans>
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm">
            <Trans>Die Analyse hat Änderungen, die noch nicht gespeichert sind.</Trans>
          </AlertDialog.Description>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {guard && i18n._(SAVE_AND[guard.action])}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                const pending = guard
                setGuard(null)
                pending?.run()
              }}
            >
              <Trans>Verwerfen</Trans>
            </button>
            <AlertDialog.Cancel className="btn">
              <Trans>Abbrechen</Trans>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
