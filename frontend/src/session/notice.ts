// What opening a session found, in words (design C4, C8). Pure: the notice
// component only shows it.
import { plural, t } from '@lingui/core/macro'
import { describe } from '../editor/describe'
import type { OpenReport } from './store'
import { formatNumber } from '../i18n/locale'

export interface Notice {
  tone: 'pending' | 'ok' | 'warn' | 'error'
  headline: string
  lines: string[]
  /** "Mit aktuellen Daten übernehmen": saving sets a new stamp (plan E1.7, WP31). */
  adopt: boolean
  /** "Anderen Ergebnis-Layer wählen" (design C8). */
  chooseResult: boolean
  /** Identical: a short notice that closes by itself (design C4). */
  autoClose: boolean
}

// "#" in a plural would format with plain "de"; the count is formatted first (L4).
export const hitCount = (n: number) => {
  const count = formatNumber(n)
  return plural(n, { one: `${count} Treffer`, other: `${count} Treffer` })
}

export function noticeOf(report: OpenReport, title: (layer: string) => string): Notice {
  const base = { lines: [], adopt: false, chooseResult: false, autoClose: false }
  if (report.error)
    return { ...base, tone: 'error', headline: t`Sitzung nicht geöffnet`, lines: [report.error] }

  const { check, removed } = report
  const labels = { field: (name: string) => name, layer: title }
  const lines: string[] = []
  for (const layer of removed.layers) {
    const name = layer.source.kind === 'catalog' ? title(layer.source.layer) : layer.source.name
    lines.push(t`Layer „${name}" ist nicht mehr verfügbar und wurde aus der Analyse genommen.`)
  }
  for (const row of removed.rows) {
    const condition = describe(row, labels)
    lines.push(t`Bedingung „${condition}" entfernt: ihr Layer fehlt.`)
  }

  if (removed.result)
    return {
      ...base,
      tone: 'warn',
      headline: t`Der Ergebnis-Layer fehlt`,
      lines: [
        t`Die Abfrage kann nicht ausgeführt werden. Karte und übrige Layer sind geöffnet.`,
        ...lines,
      ],
      chooseResult: true,
    }
  if (!check) return { ...base, tone: 'pending', headline: t`Ergebnis wird geprüft …`, lines }

  const { saved, current } = check
  for (const name of check.changed_layers) {
    const layer = title(name)
    const before = saved?.data_versions[name] ?? '–'
    const after = current?.data_versions[name] ?? '–'
    lines.push(t`Layer „${layer}" hat eine neue Fassung (${before} → ${after}).`)
  }
  for (const name of check.missing_layers)
    if (!removed.layers.some((l) => l.id === name)) {
      const layer = title(name)
      lines.push(t`Layer „${layer}" ist nicht mehr verfügbar.`)
    }
  if (check.error) {
    const error = check.error
    lines.push(t`Die gespeicherte Abfrage läuft nicht mehr: ${error}`)
  }
  if (check.state_matches === false && removed.rows.length === 0 && removed.layers.length === 0)
    lines.push(t`Der gespeicherte Zustand ergibt nicht mehr genau die gespeicherte Abfrage.`)

  const deviating = !check.identical || removed.rows.length > 0 || check.state_matches === false
  if (!deviating) {
    const count = saved ? hitCount(saved.count) : t`kein Ergebnis-Layer`
    return {
      ...base,
      tone: 'ok',
      headline: t`Wiederhergestellt · ${count}, identisch mit dem Speicherstand`,
      lines: check.changed_layers.length ? [...lines, t`Die Treffer sind dieselben.`] : lines,
      autoClose: check.changed_layers.length === 0,
    }
  }
  if (lines.length === 0) lines.push(t`Abfrage und Rezepte sind unverändert.`)
  let headline = t`Ergebnis weicht ab`
  if (saved && current) {
    const before = formatNumber(saved.count)
    const after = hitCount(current.count)
    headline = t`Ergebnis weicht ab: ${before} → ${after}`
  }
  return { ...base, tone: 'warn', headline, lines, adopt: true }
}
