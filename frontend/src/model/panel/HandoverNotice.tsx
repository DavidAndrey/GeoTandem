// In the editor while it holds a proposal (design M4.2): a draft, not yet the
// analysis; "Übernehmen" is the user's change.
import { Trans } from '@lingui/react/macro'
import { FRAME } from '../statusKey'
import { useHandover } from './handover'
import { clockTime } from './time'

export function HandoverNotice() {
  const handover = useHandover((s) => s.open)
  if (!handover) return null
  const time = clockTime(handover.at)
  return (
    <div role="note" className={`mt-3 flex flex-col gap-1 rounded p-2 text-sm ${FRAME.dashed}`}>
      <span className="border-accent text-accent-700 self-start rounded-full border border-dashed px-2 text-xs">
        <Trans>Entwurf aus Vorschlag {time}</Trans>
      </span>
      <p>
        <Trans>Noch nicht in der Analyse. „Übernehmen“ gilt als Ihre Änderung.</Trans>
      </p>
      {/* The applied query is the model's exactly (P1, D2); "Verwerfen" brings it back. */}
      {handover.before.restriction && (
        <p>
          <Trans>
            „Nur in“ entfällt: Der Vorschlag gilt ohne Ihre Einschränkung auf Ausschnitt oder
            Fläche. „Verwerfen“ stellt sie wieder her.
          </Trans>
        </p>
      )}
    </div>
  )
}
