// "Duplizieren" in the catalog (design D2): a copy of data, metadata and
// visibility under a new name; the server proposes one if left empty.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useState, type FormEvent } from 'react'
import type { AdminLayerInfo } from '../api/client'
import { useDuplicateLayer } from '../api/queries'
import { ErrorNotice, Modal } from '../components/ui'

const copyOf = (title: string) => t`${title} (Kopie)`
const duplicateTitle = (title: string) => t`„${title}" duplizieren`

export function DuplicateLayerDialog({
  layer,
  onClose,
}: {
  layer: AdminLayerInfo
  onClose: (copy?: string) => void
}) {
  const [title, setTitle] = useState(() => copyOf(layer.title))
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
      title={duplicateTitle(layer.title)}
      description={t`Kopie eines Layers mit Daten, Metadaten und Sichtbarkeit`}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="label-caps">
            <Trans>Titel</Trans>
          </span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">
            <Trans>Name (optional)</Trans>
          </span>
          <input
            className="input font-mono"
            value={name}
            placeholder={`${layer.name}_kopie`}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="text-muted">
          <Trans>
            Die Kopie übernimmt Daten, Feldbeschreibungen und die Sichtbarkeit; sie wird im
            Importprotokoll vermerkt.
          </Trans>
        </p>
        <ErrorNotice error={duplicate.error} />
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={duplicate.isPending}>
            <Trans>Duplizieren</Trans>
          </button>
          <button type="button" className="btn" onClick={() => onClose()}>
            <Trans>Abbrechen</Trans>
          </button>
        </div>
      </form>
    </Modal>
  )
}
