// Whether a proposal fits the editor is read against the layer list (D3,
// ``toAnalysis``, ``useCatalog``). While the list loads that is not known yet:
// the buttons wait and nothing is said, never "lässt sich nicht darstellen". A
// list that failed to load says so, once, instead of a refusal.
import { Trans } from '@lingui/react/macro'

/** The note for a layer list that could not be loaded; nothing otherwise. */
export function CatalogNote({ failed }: { failed: boolean }) {
  if (!failed) return null
  return (
    <p className="text-muted w-full text-xs">
      <Trans>
        Die Layerliste fehlt; ob sich die Abfrage im Editor darstellen lässt, ist darum offen.
      </Trans>
    </p>
  )
}
