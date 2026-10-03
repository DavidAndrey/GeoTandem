// What the panel and the map need to know about a displayed layer.
import type { DisplayLayer } from '../analysis/model'
import type { LayerInfo } from '../api/client'

export function catalogInfo(layer: DisplayLayer, catalog: LayerInfo[] | undefined) {
  return layer.source.kind === 'catalog'
    ? catalog?.find((l) => l.name === (layer.source as { layer: string }).layer)
    : undefined
}

export function layerTitle(layer: DisplayLayer, catalog: LayerInfo[] | undefined): string {
  if (layer.source.kind === 'derived') return layer.source.name
  return catalogInfo(layer, catalog)?.title ?? layer.source.layer
}

/** Point, line, area or table: decides the swatch and what the layer can do. */
export function geometryKind(
  layer: DisplayLayer,
  catalog: LayerInfo[] | undefined,
): 'point' | 'line' | 'area' | 'table' {
  if (layer.source.kind === 'derived') {
    const recipe = layer.source.recipe
    if (recipe.op === 'buffer' || recipe.op === 'aggregate') return 'area'
  }
  const info =
    layer.source.kind === 'catalog'
      ? catalogInfo(layer, catalog)
      : catalog?.find(
          (l) => l.name === (layer.source as { recipe: { layer: string } }).recipe.layer,
        )
  const type = info?.geometry_type ?? ''
  if (info?.kind === 'table') return 'table'
  if (type.includes('Point')) return 'point'
  if (type.includes('LineString')) return 'line'
  return 'area'
}
