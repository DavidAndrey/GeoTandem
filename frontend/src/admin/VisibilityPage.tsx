// Visibility of layers per role (design D10, F-2.7). Administrators always
// see every layer; new layers stay hidden for users until released.
import { useSetVisibility, useVisibility } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'

export function VisibilityPage() {
  const rows = useVisibility()
  const set = useSetVisibility()
  return (
    <section aria-labelledby="visibility-title" className="max-w-3xl">
      <h2 id="visibility-title" className="mb-3 text-2xl">
        Sichtbarkeit
      </h2>
      {rows.isPending && <Loading />}
      <ErrorNotice error={rows.error ?? set.error} />
      {rows.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Layer</th>
              <th>Administrator</th>
              <th>Anwender</th>
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
                  <input
                    type="checkbox"
                    checked
                    disabled
                    aria-label={`${row.title} für Administrator`}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={row.roles.user ?? false}
                    disabled={set.isPending}
                    aria-label={`${row.title} für Anwender`}
                    onChange={(e) => set.mutate({ layer: row.layer, visible: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-muted mt-3 text-sm">
        Neue Layer sind für Anwender erst nach Freigabe sichtbar. Administratoren sehen alle Layer.
      </p>
    </section>
  )
}
