// The fields a condition can refer to, with labels, types and code lists (F-2.8).
import type { DisplayLayer } from '../analysis/model'
import type { LayerInfo } from '../api/client'
import type { FieldType } from './describe'

export interface Field {
  name: string
  label: string
  type: FieldType
  unit: string | null
  /** Code list from the value domain, offered as suggestions (design B2 "Liste"). */
  codes: string[] | null
}

function fromInfo(info: LayerInfo | undefined, prefix = ''): Field[] {
  return (info?.attributes ?? []).map((a) => ({
    name: prefix + a.name,
    label: a.label || a.name,
    type: a.data_type,
    unit: a.unit,
    codes: a.value_domain?.codes
      ? Object.keys(a.value_domain.codes as Record<string, string>)
      : null,
  }))
}

export function catalogFields(name: string, catalog: LayerInfo[] | undefined): Field[] {
  return fromInfo(catalog?.find((l) => l.name === name))
}

/** Fields of the result layer: a catalog layer's, or a join's base plus joined fields. */
export function fieldsOf(
  layer: DisplayLayer | undefined,
  catalog: LayerInfo[] | undefined,
): Field[] {
  if (!layer) return []
  if (layer.source.kind === 'catalog') return catalogFields(layer.source.layer, catalog)
  const recipe = layer.source.recipe
  const base = catalogFields(recipe.layer, catalog)
  if (recipe.op !== 'join') return base
  const joined = fromInfo(
    catalog?.find((l) => l.name === recipe.join.layer),
    recipe.join.prefix ?? '',
  ).filter((f) => recipe.join.fields.includes(f.name.slice((recipe.join.prefix ?? '').length)))
  return [...base, ...joined]
}

export const labelOf = (fields: Field[]) => (name: string) =>
  fields.find((f) => f.name === name)?.label ?? name

/** Number, text or yes/no: join keys must be of the same kind on every backend (F-2.14). */
export const keyKind = (type: FieldType) =>
  type === 'integer' || type === 'real' ? 'number' : type
