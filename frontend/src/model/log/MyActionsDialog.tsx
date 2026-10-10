// "Meine Modellaktionen" (design M16.3): the account's own log entries as a
// dialog, from the user menu (and later from an answer's "Protokoll"). Own
// entries only (D4), so no column for the account. A modal dialog: focus stays
// inside until it closes (design "Barrierefreiheit"), Esc closes it.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { formatDateTime } from '../../admin/format'
import { ErrorNotice, Loading, Modal } from '../../components/ui'
import { formatNumber } from '../../i18n/locale'
import { useMyActionsDialog } from './dialog'
import { useMyActions } from './queries'
import { outcomeText } from './words'

const setOpen = (open: boolean) => useMyActionsDialog.setState({ open })

export function MyActionsDialog() {
  const open = useMyActionsDialog((s) => s.open)
  const mine = useMyActions(open)
  const items = mine.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={t`Meine Modellaktionen`}
      description={t`Ihre eigenen Anfragen an das Modell und wie sie ausgingen`}
      wide
    >
      <p className="text-muted mb-3 text-xs">
        <Trans>Nur eigene Einträge, neueste zuerst.</Trans>
      </p>
      {mine.isPending && <Loading />}
      <ErrorNotice error={mine.error} />
      {mine.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <Trans>Zeit</Trans>
              </th>
              <th>
                <Trans>Prompt</Trans>
              </th>
              <th>
                <Trans>Entscheidung</Trans>
              </th>
              <th className="text-right">
                <Trans>Treffer</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap">{formatDateTime(entry.created_at)}</td>
                <td className="max-w-[18rem] truncate" title={entry.prompt}>
                  {entry.prompt}
                </td>
                <td>{outcomeText(entry)}</td>
                <td className="text-right tabular-nums">
                  {entry.hits === null ? '–' : formatNumber(entry.hits)}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted py-4 text-center">
                  <Trans>Noch keine Modellaktionen.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs">
        <Trans>
          Ihre Eingaben werden protokolliert. Administratoren sehen alle Einträge samt Prompt.
        </Trans>
      </p>
      <div className="mt-4 flex justify-end gap-2">
        {mine.hasNextPage && (
          <button
            type="button"
            className="btn"
            disabled={mine.isFetchingNextPage}
            onClick={() => void mine.fetchNextPage()}
          >
            <Trans>Ältere laden</Trans>
          </button>
        )}
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          <Trans>Schliessen</Trans>
        </button>
      </div>
    </Modal>
  )
}
