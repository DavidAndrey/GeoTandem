// The level in the header (design M7): what the model may do here (M7.1, a
// read-only matrix), the short column of each level in the choice (M7.2),
// and the question before a change while a proposal waits (M7.3). Level
// names are the administrator's free text: shown, never keyed on.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Info } from 'lucide-react'
import { AlertDialog, Popover } from 'radix-ui'
import type { LevelOption, ModelActionView } from '../../api/client'
import { cellLabel, cellShort, classLabel, OP_CLASSES, type Matrix } from './governance'

/** M7.1: ⓘ beside the level opens "Was darf das Modell hier?"; read only. */
export function LevelInfo({ level }: { level: LevelOption }) {
  const matrix = level.matrix
  const name = level.name
  return (
    <Popover.Root>
      <Popover.Trigger className="btn px-1.5" aria-label={t`Was darf das Modell hier?`}>
        <Info size={14} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          aria-labelledby="level-info-title"
          className="card z-[1300] flex w-80 flex-col gap-2 bg-neutral-100 p-3 text-sm shadow-[var(--shadow-md)]"
        >
          <h2 id="level-info-title" className="font-semibold">
            <Trans>Was darf das Modell hier?</Trans>
          </h2>
          <p className="text-muted text-xs">
            {t`Stufe ${name} · nur lesbar; geändert wird sie in der Administration.`}
          </p>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-ink border-b">
                <th scope="col" className="py-0.5 font-semibold">
                  <Trans>Klasse</Trans>
                </th>
                <th scope="col" className="py-0.5 font-semibold">
                  <Trans>Festlegung</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {OP_CLASSES.map((k) => (
                <tr key={k} className="border-divider border-b">
                  <th scope="row" className="py-0.5 font-normal">
                    {classLabel(k)} <span className="text-muted font-mono text-xs">{k}</span>
                  </th>
                  <td className="py-0.5">{cellLabel(matrix[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted text-xs">
            <Trans>
              aus = nur Vorschlag, von Hand übernehmbar · Freigabe = Sie entscheiden · auto = Modell
              wendet an, Sie können zurücknehmen
            </Trans>
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/**
 * M7.2: "F F F F F", the cells in the order of the columns; a screen reader
 * hears them in words ("Katalog lesen: Freigabe, …").
 */
export function ShortColumn({ matrix }: { matrix: Matrix }) {
  const said = OP_CLASSES.map((k) => {
    const name = classLabel(k)
    const cell = cellLabel(matrix[k])
    return t`${name}: ${cell}`
  }).join(', ')
  return (
    <>
      <span aria-hidden className="text-muted font-mono text-xs whitespace-pre">
        {OP_CLASSES.map((k) => cellShort(matrix[k])).join(' ')}
      </span>
      <span className="sr-only">{said}</span>
    </>
  )
}

/**
 * M7.3: a level change while a proposal waits for approval. The proposal
 * stays bound to the level it was made under (the server evaluates the
 * snapshot, WP70); the dialog says so. A focus trap, Esc cancels.
 */
export function LevelSwitchDialog({
  target,
  waiting,
  onConfirm,
  onCancel,
}: {
  target: LevelOption | null
  waiting: ModelActionView | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const name = target?.name ?? ''
  const bound = waiting?.level.name ?? ''
  return (
    <AlertDialog.Root open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="bg-ink/30 fixed inset-0 z-[1250]" />
        <AlertDialog.Content className="card fixed top-1/3 left-1/2 z-[1300] w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5 shadow-[var(--shadow-md)]">
          <AlertDialog.Title className="mb-2 text-xl">{t`Stufe auf ${name} wechseln?`}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm">
            {t`Ein Vorschlag wartet noch auf Freigabe. Er bleibt an die Stufe ${bound} gebunden, unter der er gestellt wurde, und wird nicht automatisch angewendet.`}
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn btn-primary" onClick={onConfirm}>
              <Trans>Wechseln</Trans>
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
