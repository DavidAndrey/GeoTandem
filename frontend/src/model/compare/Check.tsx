// The chain's check of a direct answer (plan-check-mode). Where the
// connection checks, the server asks the prompt again with the chain by
// itself, after the answer, as a repeat marked ``is_check``, and compares the
// chain's plan with the answer by feature ids (``view.check``). The answer
// stays as it is; the mark says what the check found:
//
// - ``running``: the check plans; the workplace polls the answer until the
//   mark changes (``useCheckPolling``), as it polls a request, but without
//   holding the field: the account's next prompt aborts the check (D3).
// - ``same``: the chain finds the same features.
// - ``differs``: *Unsicher*, with both counts and *Vergleich ansehen*, which
//   brings the check into the dialogue as a repeat (``shown``) and opens the
//   comparison of the plan (the server's ``_compared``: a check waiting with
//   its plan compares the plan's query, no step runs). Taking the chain's
//   side is that plan's own approval and run, as for any repeated chain.
// - ``not_checked``: the check ended without a plan to compare.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useShallow } from 'zustand/react/shallow'
import type { ModelActionView } from '../../api/client'
import { formatNumber } from '../../i18n/locale'
import { useModel } from '../store'
import { showCheck } from './checked'

/** The mark of a checked direct answer, under its explanation. */
export function CheckNote({ view }: { view: ModelActionView }) {
  const check = useModel(useShallow((s) => s.views[view.id]?.check ?? view.check))
  if (!check) return null
  const direct = formatNumber(check.direct_hits ?? 0)
  const chain = formatNumber(check.chain_hits ?? 0)
  switch (check.state) {
    case 'running':
      return (
        <p className="text-muted text-xs" aria-live="polite">
          <Trans>Wird mit der Werkzeugkette geprüft …</Trans>
        </p>
      )
    case 'same':
      return (
        <p className="text-muted text-xs" aria-live="polite">
          {t`Geprüft: Die Werkzeugkette findet dieselben ${direct} Objekte.`}
        </p>
      )
    case 'differs':
      return (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
          <p className="text-danger">
            {t`Unsicher: Die schrittweise Prüfung findet ${chain} statt ${direct} Objekte.`}
          </p>
          {check.action_id != null && (
            <button
              type="button"
              className="btn"
              data-compare={check.action_id}
              onClick={() => void showCheck(check.action_id as number)}
            >
              <Trans>Vergleich ansehen</Trans>
            </button>
          )}
        </div>
      )
    default:
      return (
        <p className="text-muted text-xs">
          <Trans>Nicht geprüft.</Trans>
        </p>
      )
  }
}
