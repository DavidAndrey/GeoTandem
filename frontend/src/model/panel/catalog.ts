// The layer list as a card reads it (D3, ``toAnalysis``): whether a proposal
// fits the editor is known only once the list is there (CatalogNote.tsx).
import { useLayers } from '../../api/queries'

/**
 * The layer list and what it lets a card say: ``known`` once it is there,
 * ``failed`` when it could not be loaded.
 */
export function useCatalog() {
  const layers = useLayers()
  return { catalog: layers.data, known: layers.data !== undefined, failed: layers.isError }
}
