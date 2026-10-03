// Feature popup (F-4.9): attribute labels and units from the metadata (F-2.8).
// Built from DOM nodes with textContent: values come from imported files and
// must never be interpreted as HTML.
import type { LayerInfo } from '../api/client'
import { formatDate } from '../editor/describe'

export function formatValue(
  value: unknown,
  unit: string | null | undefined,
  type?: string,
): string {
  if (value === null || value === undefined || value === '') return '–'
  if (type === 'date' && typeof value === 'string') return formatDate(value)
  const text =
    typeof value === 'number'
      ? value.toLocaleString('de-CH', { maximumFractionDigits: 2 })
      : typeof value === 'boolean'
        ? value
          ? 'ja'
          : 'nein'
        : String(value)
  return unit ? `${text} ${unit}` : text
}

export function popupContent(
  title: string,
  properties: Record<string, unknown>,
  info: LayerInfo | undefined,
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'geotandem-popup'
  // The feature's own name heads the popup (design B1 "GS Nord"); the layer below.
  const name = featureName(properties, info)
  const heading = document.createElement('p')
  heading.className = 'font-semibold'
  heading.textContent = name ?? title
  root.append(heading)
  if (name) {
    const layer = document.createElement('p')
    layer.className = 'text-muted text-xs mb-1'
    layer.textContent = title
    root.append(layer)
  }
  const list = document.createElement('dl')
  list.className = 'grid grid-cols-[auto_1fr] gap-x-3 text-xs'
  const attributes = info?.attributes ?? []
  const names = attributes.length ? attributes.map((a) => a.name) : Object.keys(properties)
  for (const name of names) {
    if (!(name in properties)) continue
    const meta = attributes.find((a) => a.name === name)
    const term = document.createElement('dt')
    term.className = 'text-muted'
    term.textContent = meta?.label || name
    const value = document.createElement('dd')
    value.textContent = formatValue(properties[name], meta?.unit, meta?.data_type)
    list.append(term, value)
  }
  root.append(list)
  return root
}

/** A "name"-like text attribute, else the first text attribute with a value. */
export function featureName(
  properties: Record<string, unknown>,
  info: LayerInfo | undefined,
): string | null {
  const texts = (info?.attributes ?? []).filter((a) => a.data_type === 'text').map((a) => a.name)
  const preferred = ['name', 'bezeichnung', 'titel', ...texts]
  for (const key of preferred) {
    const value = properties[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}
