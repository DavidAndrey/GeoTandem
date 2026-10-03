// Every session dialog in one place, mounted once in the application header.
import { useMutation } from '@tanstack/react-query'
import { AlertDialog } from 'radix-ui'
import { ErrorNotice } from '../components/ui'
import { saveSession } from './actions'
import { SaveAsDialog } from './SaveAsDialog'
import { SessionsDialog } from './SessionsDialog'
import { useSession } from './store'
import { useSessionUi } from './ui'

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
          <AlertDialog.Title className="mb-2 text-xl">Ungespeicherte Änderungen</AlertDialog.Title>
          <AlertDialog.Description className="text-sm">
            Die Analyse hat Änderungen, die noch nicht gespeichert sind.
          </AlertDialog.Description>
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              Speichern und {guard?.label}
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
              Verwerfen
            </button>
            <AlertDialog.Cancel className="btn">Abbrechen</AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
