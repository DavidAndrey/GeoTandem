// Delete a layer (design D5). E1.3 deletes for good; archiving is not in F-2.7
// (plan D2). Sessions and saved queries that use the layer follow in E1.7.
import { formatNumber } from '../i18n/locale'
import { Trans } from '@lingui/react/macro'
import { deleteTitle } from '../i18n/phrases'
import { t } from '@lingui/core/macro'
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
  const count = formatNumber(layer.feature_count)
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={deleteTitle(layer.title)}
      confirm={t`Endgültig löschen`}
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
        <Trans>
          Der Layer und seine {count} Objekte werden endgültig entfernt. Abfragen, die ihn
          verwenden, laufen danach nicht mehr.
        </Trans>
      </p>
      <ErrorNotice error={remove.error} />
    </ConfirmDialog>
  )
}
