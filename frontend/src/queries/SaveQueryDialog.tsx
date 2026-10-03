// "Speichern unter" for a query (design B1): name and whether to share it.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Node } from '../analysis/model'
import { currentAnalysis, useAnalysis } from '../analysis/store'
import { useLayers } from '../api/queries'
import { ErrorNotice, Modal } from '../components/ui'
import { QueryNameTaken, saveQueryAs } from './actions'
import { queryPart } from './part'
import { queryKeys, useQueryUi } from './ui'

const rows = (node: Node): number =>
  node.kind === 'group' ? node.children.reduce((n, c) => n + rows(c), 0) : 1

export function SaveQueryDialog() {
  const { dialog, close } = useQueryUi()
  return (
    <Modal
      open={dialog === 'saveAs'}
      onOpenChange={(next) => !next && close()}
      title="Abfrage speichern"
      description="Ergebnis-Layer und Bedingungen unter einem Namen speichern"
    >
      {dialog === 'saveAs' && <SaveQueryForm onDone={close} />}
    </Modal>
  )
}

function SaveQueryForm({ onDone }: { onDone: () => void }) {
  const client = useQueryClient()
  const ref = useAnalysis((s) => s.queryRef)
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const catalog = useLayers()
  // Someone else's query is saved as an own copy (design C6).
  const [name, setName] = useState(ref?.mine ? ref.name : (ref?.name ?? ''))
  const [shared, setShared] = useState(ref?.mine ? ref.shared : false)
  const [taken, setTaken] = useState<string | null>(null)
  const part = queryPart(analysis)
  const save = useMutation({
    mutationFn: (overwrite?: string) => saveQueryAs(name.trim(), shared, overwrite),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.list })
      onDone()
    },
    onError: (error) => {
      if (error instanceof QueryNameTaken) setTaken(error.existing)
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTaken(null)
    save.mutate(undefined)
  }
  const title = part
    ? (catalog.data?.find((l) => l.name === part.result)?.title ?? part.result)
    : '–'
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="label-caps">Name</span>
        <input
          className="input"
          value={name}
          maxLength={120}
          required
          autoFocus
          onChange={(e) => {
            setName(e.target.value)
            setTaken(null)
          }}
        />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        Geteilt: für alle Anwender lesbar (Ändern erzeugt bei ihnen eine Kopie)
      </label>
      <p className="text-muted">
        Ziel {title} · {rows(analysis.tree)} Bedingungen
        {analysis.restriction ? ' · mit Einschränkung' : ''}
      </p>
      {ref && !ref.mine && (
        <p className="text-muted">
          „{ref.name}" gehört jemand anderem; gespeichert wird eine eigene Kopie.
        </p>
      )}
      {taken && (
        <div role="alert" className="card flex items-center gap-2 p-2">
          <span className="flex-1">Eine eigene Abfrage „{name.trim()}" gibt es schon.</span>
          <button
            type="button"
            className="btn btn-danger"
            disabled={save.isPending}
            onClick={() => save.mutate(taken)}
          >
            Überschreiben
          </button>
        </div>
      )}
      {save.isError && !(save.error instanceof QueryNameTaken) && (
        <ErrorNotice error={save.error} />
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={save.isPending || !name.trim()}>
          Speichern
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Abbrechen
        </button>
      </div>
    </form>
  )
}
