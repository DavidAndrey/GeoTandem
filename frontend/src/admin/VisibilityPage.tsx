// Visibility of layers per role (design D10, F-2.7). Administrators always
// see every layer; new layers follow the instance setting below.
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
  useSetVisibility,
  useSetVisibilityDefault,
  useVisibility,
  useVisibilityDefault,
} from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'

const forRole = (layer: string) => ({
  admin: t`${layer} für Administrator`,
  user: t`${layer} für Anwender`,
})

export function VisibilityPage() {
  const rows = useVisibility()
  const set = useSetVisibility()
  const fallback = useVisibilityDefault()
  const setFallback = useSetVisibilityDefault()
  return (
    <section aria-labelledby="visibility-title" className="max-w-3xl">
      <h2 id="visibility-title" className="mb-3 text-2xl">
        <Trans>Sichtbarkeit</Trans>
      </h2>
      {rows.isPending && <Loading />}
      <ErrorNotice error={rows.error ?? set.error} />
      {rows.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <Trans>Layer</Trans>
              </th>
              <th>
                <Trans>Administrator</Trans>
              </th>
              <th>
                <Trans>Anwender</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.data.map((row) => (
              <tr key={row.layer}>
                <td>
                  {row.title}
                  <div className="text-muted text-xs">{row.layer}</div>
                </td>
                <td>
                  <input type="checkbox" checked disabled aria-label={forRole(row.title).admin} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={row.roles.user ?? false}
                    disabled={set.isPending}
                    aria-label={forRole(row.title).user}
                    onChange={(e) => set.mutate({ layer: row.layer, visible: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <fieldset className="mt-4 text-sm">
        <legend className="label-caps mb-1">
          <Trans>Neue Layer für Anwender</Trans>
        </legend>
        {fallback.data && (
          <div className="flex gap-4">
            {[
              { value: false, label: t`erst nach Freigabe` },
              { value: true, label: t`sofort sichtbar` },
            ].map((option) => (
              <label key={option.label} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="new-layers"
                  checked={fallback.data.new_layers_visible === option.value}
                  disabled={setFallback.isPending}
                  onChange={() => setFallback.mutate(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        )}
        <ErrorNotice error={fallback.error ?? setFallback.error} />
        <p className="text-muted mt-1">
          <Trans>
            Gilt für neu importierte Layer; ein aktualisierter Layer behält seine Sichtbarkeit.
            Administratoren sehen alle Layer.
          </Trans>
        </p>
      </fieldset>
    </section>
  )
}
