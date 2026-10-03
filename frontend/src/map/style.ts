// How layers look on the map (F-4.8 defaults, design B9). Pure.
import type { DisplayLayer } from '../analysis/model'

/** Muted colours that sit well on the grey background; the accent is kept for hits. */
export const PALETTE = ['#4a6fa5', '#6b8f71', '#8e5f8a', '#5d8aa8', '#8a7f5a', '#a0614c', '#5f7a8c']
export const ACCENT = '#b68235'

function hash(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(h)
}

/** A stable colour per layer, so a layer keeps its colour across sessions. */
export function layerColor(layer: DisplayLayer): string {
  if (layer.symbology?.kind === 'single') return layer.symbology.color
  const key = layer.source.kind === 'catalog' ? layer.source.layer : layer.source.name
  return PALETTE[hash(key) % PALETTE.length] as string
}

export type HitState = 'hit' | 'miss' | 'plain'

/** Hits in the accent, non-hits at 35 % opacity (design B9). */
export function featureStyle(color: string, opacity: number, state: HitState) {
  const stroke = state === 'hit' ? ACCENT : color
  const factor = state === 'miss' ? 0.35 : 1
  return {
    color: stroke,
    weight: state === 'hit' ? 2.5 : 1.5,
    opacity: opacity * factor,
    fillColor: stroke,
    fillOpacity: opacity * factor * 0.35,
    radius: state === 'hit' ? 6 : 5,
  }
}
