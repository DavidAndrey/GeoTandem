// The query behind the map search (plan E1.8, G1). Pure.
import type { QueryObject } from '../analysis/model'

export const PER_LAYER = 10

/** The query that searches one layer by its name attribute. */
export function searchQuery(layer: string, attr: string, text: string): QueryObject {
  return {
    schema_version: '2',
    source: layer,
    output: 'map',
    where: { op: 'text_match', attr, text, mode: 'contains', case_sensitive: false },
    select: [attr],
    order_by: [{ attr, dir: 'asc' }],
    limit: PER_LAYER + 1,
  }
}
