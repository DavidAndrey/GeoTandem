// "Duplizieren" in the catalog (design D2): a copy of data, metadata and
// visibility under a new name; the server proposes one if left empty.
import { useState, type FormEvent } from 'react'
import type { AdminLayerInfo } from '../api/client'
import { useDuplicateLayer } from '../api/queries'
import { ErrorNotice, Modal } from '../components/ui'

export function DuplicateLayerDialog({
  layer,
  onClose,
}: {
  layer: AdminLayerInfo
  onClose: (copy?: string) => void
}) {
  const [title, setTitle] = useState(`${layer.title} (Kopie)`)
  const [name, setName] = useState('')
  const duplicate = useDuplicateLayer()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    duplicate.mutate(
      { layer: layer.name, title: title.trim() || undefined, name: name.trim() || undefined },
      { onSuccess: (copy) => onClose(copy.name) },
    )
  }
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`„${layer.title}" duplizieren`}
      description="Kopie eines Layers mit Daten, Metadaten und Sichtbarkeit"
    >
      <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="label-caps">Titel</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Name (optional)</span>
          <input
            className="input font-mono"
            value={name}
            placeholder={`${layer.name}_kopie`}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="text-muted">
          Die Kopie übernimmt Daten, Feldbeschreibungen und die Sichtbarkeit; sie wird im
          Importprotokoll vermerkt.
        </p>
        <ErrorNotice error={duplicate.error} />
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={duplicate.isPending}>
            Duplizieren
          </button>
          <button type="button" className="btn" onClick={() => onClose()}>
            Abbrechen
          </button>
        </div>
      </form>
    </Modal>
  )
}
