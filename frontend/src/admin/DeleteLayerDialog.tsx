// Delete a layer (design D5). E1.3 deletes for good; archiving is not in F-2.7
// (plan D2). Sessions and saved queries that use the layer follow in E1.7.
import { useDeleteLayer } from '../api/queries'
import { ConfirmDialog, ErrorNotice } from '../components/ui'

export function DeleteLayerDialog({
  layer,
  onClose,
  onDeleted,
}: {
  layer: { name: string; title: string; feature_count: number }
  onClose: () => void
  onDeleted?: () => void
}) {
  const remove = useDeleteLayer()
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`„${layer.title}" löschen?`}
      confirm="Endgültig löschen"
      busy={remove.isPending}
      onConfirm={() =>
        remove.mutate(layer.name, {
          onSuccess: () => {
            onClose()
            onDeleted?.()
          },
        })
      }
    >
      <p>
        Der Layer und seine {layer.feature_count} Objekte werden endgültig entfernt. Abfragen, die
        ihn verwenden, laufen danach nicht mehr.
      </p>
      <ErrorNotice error={remove.error} />
    </ConfirmDialog>
  )
}
