// The session in the header (design C1): its name as a menu, and whether it
// is saved. Changes are "ungespeichert" except moving the map (design decision 3).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../api/client'
import { ConfirmDialog } from '../components/ui'
import { newSession } from './actions'
import { useSession } from './store'
import { formatWhen, guarded, isMac, saveOrAsk, sessionKeys, useSessionUi, useUnsaved } from './ui'

const item =
  'flex cursor-pointer items-center justify-between gap-6 px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200 data-[disabled]:cursor-default data-[disabled]:text-muted'

export function SessionMenu() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const current = useSession((s) => s.current)
  const unsaved = useUnsaved()
  const openDialog = useSessionUi((s) => s.openDialog)
  const [deleting, setDeleting] = useState(false)
  const sessions = useQuery({ queryKey: sessionKeys.list, queryFn: api.sessions.list })
  const save = useMutation({
    mutationFn: saveOrAsk,
    onSuccess: () => client.invalidateQueries({ queryKey: sessionKeys.list }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.sessions.remove(id),
    onSuccess: () => {
      setDeleting(false)
      newSession()
      navigate('/')
      return client.invalidateQueries({ queryKey: sessionKeys.list })
    },
  })
  // "Zuletzt": the two most recently opened others (design C1).
  const recent = [...(sessions.data ?? [])]
    .filter((s) => s.id !== current?.id)
    .sort((a, b) => (b.opened_at ?? b.updated_at).localeCompare(a.opened_at ?? a.updated_at))
    .slice(0, 2)

  return (
    <div className="flex items-center gap-3">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="btn btn-primary" aria-label="Sitzungsmenü">
          {current?.name ?? 'Neue Sitzung'}
          <ChevronDown size={14} aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            className="card z-[1100] min-w-64 py-1 shadow-[var(--shadow-md)]"
          >
            <DropdownMenu.Item className={item} onSelect={() => save.mutate()}>
              Speichern <Shortcut>{isMac() ? '⌘S' : 'Ctrl+S'}</Shortcut>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={item} onSelect={() => openDialog('saveAs')}>
              Speichern unter …
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-divider)]" />
            <DropdownMenu.Item
              className={item}
              onSelect={() =>
                guarded('neu beginnen', () => {
                  newSession()
                  navigate('/')
                })
              }
            >
              Neue Sitzung
            </DropdownMenu.Item>
            {recent.length > 0 && (
              <DropdownMenu.Label className="label-caps px-3 pt-2">Zuletzt</DropdownMenu.Label>
            )}
            {recent.map((s) => (
              <DropdownMenu.Item
                key={s.id}
                className={item}
                onSelect={() => guarded('öffnen', () => navigate(`/sitzung/${s.id}`))}
              >
                {s.name}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Item className={item} onSelect={() => openDialog('list')}>
              Alle öffnen … <Shortcut>C3</Shortcut>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-divider)]" />
            <DropdownMenu.Item
              className={item}
              disabled={!current}
              onSelect={() => setDeleting(true)}
            >
              Diese Sitzung löschen
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span role="status" aria-label="Speicherstand" className="text-muted text-sm">
        {unsaved ? (
          <>
            <span aria-hidden className="mr-1 inline-block size-2 rounded-full bg-neutral-500" />
            ungespeichert
          </>
        ) : current ? (
          `gespeichert ${formatWhen(current.savedAt).replace(/^heute /, '')}`
        ) : null}
      </span>
      {save.isError && (
        <span role="alert" className="text-danger text-sm">
          Speichern fehlgeschlagen
        </span>
      )}
      {current && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`„${current.name}" löschen?`}
          confirm="Löschen"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(current.id)}
        >
          <p>Die Sitzung wird endgültig gelöscht; der Arbeitsplatz beginnt danach leer.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

function Shortcut({ children }: { children: ReactNode }) {
  return <span className="text-muted text-xs">{children}</span>
}
