// What opening a session found, in words (design C4, C8). Pure: the notice
// component only shows it.
import { describe } from '../editor/describe'
import type { OpenReport } from './store'

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

const hits = (n: number) => `${n.toLocaleString('de-CH')} Treffer`

export function noticeOf(report: OpenReport, title: (layer: string) => string): Notice {
  const base = { lines: [], adopt: false, chooseResult: false, autoClose: false }
  if (report.error)
    return { ...base, tone: 'error', headline: 'Sitzung nicht geöffnet', lines: [report.error] }

  const { check, removed } = report
  const labels = { field: (name: string) => name, layer: title }
  const lines: string[] = []
  for (const layer of removed.layers)
    lines.push(
      `Layer „${layer.source.kind === 'catalog' ? title(layer.source.layer) : layer.source.name}" ist nicht mehr verfügbar und wurde aus der Analyse genommen.`,
    )
  for (const row of removed.rows)
    lines.push(`Bedingung „${describe(row, labels)}" entfernt: ihr Layer fehlt.`)

  if (removed.result)
    return {
      ...base,
      tone: 'warn',
      headline: 'Der Ergebnis-Layer fehlt',
      lines: [
        'Die Abfrage kann nicht ausgeführt werden. Karte und übrige Layer sind geöffnet.',
        ...lines,
      ],
      chooseResult: true,
    }
  if (!check) return { ...base, tone: 'pending', headline: 'Ergebnis wird geprüft …', lines }

  const { saved, current } = check
  for (const name of check.changed_layers) {
    const before = saved?.data_versions[name] ?? '–'
    const after = current?.data_versions[name] ?? '–'
    lines.push(`Layer „${title(name)}" hat eine neue Fassung (${before} → ${after}).`)
  }
  for (const name of check.missing_layers)
    if (!removed.layers.some((l) => l.id === name))
      lines.push(`Layer „${title(name)}" ist nicht mehr verfügbar.`)
  if (check.error) lines.push(`Die gespeicherte Abfrage läuft nicht mehr: ${check.error}`)
  if (check.state_matches === false && removed.rows.length === 0 && removed.layers.length === 0)
    lines.push('Der gespeicherte Zustand ergibt nicht mehr genau die gespeicherte Abfrage.')

  const deviating = !check.identical || removed.rows.length > 0 || check.state_matches === false
  if (!deviating) {
    const count = saved ? hits(saved.count) : 'kein Ergebnis-Layer'
    return {
      ...base,
      tone: 'ok',
      headline: `Wiederhergestellt · ${count}, identisch mit dem Speicherstand`,
      lines: check.changed_layers.length ? [...lines, 'Die Treffer sind dieselben.'] : lines,
      autoClose: check.changed_layers.length === 0,
    }
  }
  const counts = saved && current ? `: ${saved.count} → ${hits(current.count)}` : ''
  if (lines.length === 0) lines.push('Abfrage und Rezepte sind unverändert.')
  return { ...base, tone: 'warn', headline: `Ergebnis weicht ab${counts}`, lines, adopt: true }
}
