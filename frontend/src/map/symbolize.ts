// Symbolisation (F-4.8): single colour, categories, classes (quantile or
// equal intervals), graduated size. The query object carries the hint
// (`symbology`); the classes are computed here from the result values. Pure.
import { create } from 'zustand'
import type { Symbology } from '../analysis/model'
import { PALETTE } from './style'
import { formatNumber } from '../i18n/locale'

export interface Symbol {
  color: string
  /** Point radius in pixels. */
  radius: number
}

export interface LegendEntry {
  label: string
  color: string
  radius?: number
}

export interface Symbolizer {
  of: (properties: Record<string, unknown>) => Symbol
  legend: LegendEntry[]
}

/** Light to dark in the accent hue, sampled for 2 to 9 classes. */
const RAMP = [
  '#fff3e4',
  '#ffe3bf',
  '#facb8d',
  '#e1ad66',
  '#c28d41',
  '#a06f24',
  '#7d5411',
  '#5a3b0a',
  '#3a270d',
]

export function ramp(classes: number): string[] {
  if (classes >= RAMP.length) return RAMP
  return Array.from(
    { length: classes },
    (_, i) => RAMP[Math.round(1 + (i * (RAMP.length - 2)) / Math.max(1, classes - 1))] as string,
  )
}

const numbers = (values: unknown[]) =>
  values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)

/** Upper bounds of each class; the last equals the maximum. */
export function breaks(
  values: number[],
  method: 'quantile' | 'equal_interval',
  classes: number,
): number[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0] as number
  const max = sorted[sorted.length - 1] as number
  if (method === 'equal_interval')
    return Array.from({ length: classes }, (_, i) => min + ((max - min) * (i + 1)) / classes)
  const bounds = Array.from({ length: classes }, (_, i) => {
    const position = ((i + 1) * sorted.length) / classes - 1
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(position)))] as number
  })
  // Repeated values make empty quantile classes; keep distinct bounds only.
  return bounds.filter((b, i) => i === 0 || b !== bounds[i - 1])
}

const fmt = (n: number) => formatNumber(n, { maximumFractionDigits: 2 })

export function symbolizer(
  symbology: Symbology | null,
  values: (attr: string) => unknown[],
  fallback: string,
): Symbolizer {
  if (!symbology || symbology.kind === 'single') {
    const color = symbology?.color ?? fallback
    return { of: () => ({ color, radius: 5 }), legend: [] }
  }
  if (symbology.kind === 'categorized') {
    const categories = [...new Set(values(symbology.attr).map((v) => String(v ?? '')))].sort()
    const colors = new Map(
      categories.map((c, i) => [
        c,
        symbology.colors?.[c] ?? (PALETTE[i % PALETTE.length] as string),
      ]),
    )
    return {
      of: (p) => ({ color: colors.get(String(p[symbology.attr] ?? '')) ?? fallback, radius: 5 }),
      legend: categories.map((c) => ({ label: c || '(leer)', color: colors.get(c) as string })),
    }
  }
  const sorted = numbers(values(symbology.attr))
  if (symbology.kind === 'classified') {
    const bounds = breaks(sorted, symbology.method, symbology.classes ?? 5)
    const colors = ramp(bounds.length)
    const classOf = (v: unknown) => (typeof v === 'number' ? bounds.findIndex((b) => v <= b) : -1)
    let lower = sorted[0] ?? 0
    const legend = bounds.map((upper, i) => {
      const entry = { label: `${fmt(lower)} – ${fmt(upper)}`, color: colors[i] as string }
      lower = upper
      return entry
    })
    return {
      of: (p) => {
        const index = classOf(p[symbology.attr])
        return { color: index < 0 ? fallback : (colors[index] as string), radius: 5 }
      },
      legend,
    }
  }
  // Graduated size: radius proportional to the value between min and max.
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  const lo = symbology.min_size ?? 4
  const hi = symbology.max_size ?? 24
  const size = (v: unknown) =>
    typeof v === 'number' && max > min ? lo + ((hi - lo) * (v - min)) / (max - min) : lo
  return {
    of: (p) => ({
      color: fallback,
      radius: size(p[symbology.attr]) / 2,
    }),
    legend: sorted.length
      ? [
          { label: fmt(min), color: fallback, radius: lo / 2 },
          { label: fmt(max), color: fallback, radius: hi / 2 },
        ]
      : [],
  }
}

/** Legend entries per displayed layer, reported by the map layers. */

interface LegendStore {
  entries: Record<string, LegendEntry[]>
  set: (layer: string, entries: LegendEntry[]) => void
}

export const useLegend = create<LegendStore>()((set) => ({
  entries: {},
  set: (layer, entries) => set((s) => ({ entries: { ...s.entries, [layer]: entries } })),
}))
