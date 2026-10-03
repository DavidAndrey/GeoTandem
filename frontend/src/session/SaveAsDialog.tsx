// "Speichern unter" (design C2): name, note, and what will be saved. The stamp
// is the server's, computed when it saves (plan E1.7, S5).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import type { Node } from '../analysis/model'
import { resultLayer, resultQuery } from '../analysis/query'
import { useAnalysis } from '../analysis/store'
import { api } from '../api/client'
import { useLayers } from '../api/queries'
import { ErrorNotice, Modal } from '../components/ui'
import { layerTitle } from '../workplace/layerInfo'
import { NameTaken, saveSessionAs } from './actions'
import { useSession } from './store'
import { sessionKeys, useSessionUi } from './ui'

const rowCount = (node: Node): number =>
  node.kind === 'group' ? node.children.reduce((n, c) => n + rowCount(c), 0) : 1

export function SaveAsDialog() {
  const { dialog, afterSave, close } = useSessionUi()
  const open = dialog === 'saveAs'
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && close()}
      title="Sitzung speichern"
      description="Analyse unter einem Namen speichern"
    >
      {open && <SaveAsForm onDone={close} afterSave={afterSave} />}
    </Modal>
  )
}

function SaveAsForm({ onDone, afterSave }: { onDone: () => void; afterSave: (() => void) | null }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const current = useSession((s) => s.current)
  const [name, setName] = useState(current?.name ?? '')
  const [note, setNote] = useState(current?.note ?? '')
  const [taken, setTaken] = useState<string | null>(null)
  const analysis = useAnalysis(
    useShallow((s) => ({
      layers: s.layers,
      result: s.result,
      tree: s.tree,
      restriction: s.restriction,
    })),
  )
  const catalog = useLayers()
  const query = resultQuery(analysis)
  const hits = useQuery({
    queryKey: ['session-hits', query],
    queryFn: () => (query ? api.count([query]) : null),
    enabled: query !== null,
  })
  const save = useMutation({
    mutationFn: (overwrite?: string) => saveSessionAs(name.trim(), note, overwrite),
    onSuccess: async (detail) => {
      await client.invalidateQueries({ queryKey: sessionKeys.list })
      onDone()
      if (afterSave) afterSave()
      else navigate(`/sitzung/${detail.id}`, { replace: true })
    },
    onError: (error) => {
      if (error instanceof NameTaken) setTaken(error.existing)
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTaken(null)
    save.mutate(undefined)
  }
  const result = resultLayer(analysis)
  const derived = analysis.layers.filter((l) => l.source.kind === 'derived')
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
      <label className="flex flex-col gap-1">
        <span className="label-caps">Notiz (optional)</span>
        <textarea
          className="input min-h-16"
          value={note}
          maxLength={2000}
          placeholder="Fragestellung, Annahmen …"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div>
        <p className="label-caps mb-1">Wird gespeichert</p>
        <dl className="card divide-y divide-[var(--color-divider)] px-3 py-1">
          <Line term="Layer · Reihenfolge · Sichtbarkeit · Deckkraft">
            {analysis.layers.length}
          </Line>
          <Line term={`Abfrage · Ziel ${result ? layerTitle(result, catalog.data) : '–'}`}>
            {rowCount(analysis.tree)} Bed.
          </Line>
          <Line term="Abgeleitete Layer (als Rezept)">
            {derived.length ? derived.map((l) => layerTitle(l, catalog.data)).join(', ') : 'keine'}
          </Line>
          <Line term="Kartenausschnitt · Tabelle (Spalten, Sortierung)">
            <Check size={14} aria-label="ja" />
          </Line>
          <Line term="Ergebnis-Stempel">
            {query === null
              ? 'kein Ergebnis-Layer'
              : hits.data
                ? `${hits.data.counts[0]} Treffer`
                : '…'}
          </Line>
        </dl>
      </div>
      {taken && (
        <div role="alert" className="card border-accent flex items-center gap-2 p-2">
          <span className="flex-1">Eine Sitzung „{name.trim()}" gibt es schon.</span>
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
      {save.isError && !(save.error instanceof NameTaken) && <ErrorNotice error={save.error} />}
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

function Line({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <dt>{term}</dt>
      <dd className="text-muted text-right">{children}</dd>
    </div>
  )
}
