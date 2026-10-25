// Prüffälle (design V1): the start set (read only) above the own cases, with
// split, tags, origin and data state as columns, so a filter such as "only own
// cases on live data" is one row. Stale and re-imported own cases carry their
// status (V1.2); import is all or nothing (V1.3); without own cases the three
// ways to make one stand where they would be (V1.4). Filters live in the
// address, as in the model log.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type RefObject } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, type CaseView, type DataState, type Split, type CaseOrigin } from '../../api/client'
import { useLayers, useMe } from '../../api/queries'
import { ErrorNotice, Loading, Modal } from '../../components/ui'
import { formatNumber } from '../../i18n/locale'
import { importCases, type Outcome } from './importFile'
import { CaseStatusLabel } from './parts'
import { caseKeys, useCases } from './queries'
import {
  caseKindShort,
  DATA_STATES,
  dataStateText,
  isBehaviour,
  ORIGINS,
  originText,
  SPLITS,
  splitText,
  tagList,
  tagText,
} from './words'

/** Start cases shown before "… weitere Startfälle" while no filter is set (V1.1). */
const START_SHOWN = 5

type Kind = 'query' | 'behaviour'

interface Filters {
  q: string
  kind?: Kind
  split?: Split
  tag?: string
  origin?: CaseOrigin
  dataState?: DataState
}

function matches(view: CaseView, f: Filters): boolean {
  const c = view.case
  if (f.q && !`${c.id} ${c.prompt}`.toLowerCase().includes(f.q.toLowerCase())) return false
  if (f.kind && (f.kind === 'behaviour') !== isBehaviour(c)) return false
  if (f.split && c.split !== f.split) return false
  if (f.tag && !c.tags.includes(f.tag)) return false
  if (f.origin && c.origin !== f.origin) return false
  if (f.dataState && (c.data_state ?? 'sample') !== f.dataState) return false
  return true
}

const pick = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((v) => v === value)

export function CasesPage() {
  const [params, setParams] = useSearchParams()
  const cases = useCases()
  const filters: Filters = {
    q: params.get('suche') ?? '',
    kind: pick<Kind>(['query', 'behaviour'], params.get('art')),
    split: pick(SPLITS, params.get('teil')),
    tag: params.get('stichwort') ?? undefined,
    origin: pick(ORIGINS, params.get('herkunft')),
    dataState: pick(DATA_STATES, params.get('datenstand')),
  }
  const filtered = Object.entries(filters).some(([, v]) => v)
  const [expanded, setExpanded] = useState(false)
  const importer = useImport()
  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const all = useMemo(() => cases.data?.items ?? [], [cases.data])
  const tags = useMemo(() => [...new Set(all.flatMap((v) => v.case.tags))].sort(), [all])
  const shown = all.filter((v) => matches(v, filters))
  const start = shown.filter((v) => v.read_only)
  const own = shown.filter((v) => !v.read_only)
  const ownTotal = all.filter((v) => !v.read_only).length
  const foldable = !filtered && start.length > START_SHOWN
  const hidden = foldable && !expanded ? start.length - START_SHOWN : 0
  const startRows = hidden ? start.slice(0, START_SHOWN) : start
  const more = formatNumber(hidden)

  const select = (
    label: string,
    key: string,
    value: string | undefined,
    options: [string, string][],
  ) => (
    <label className="flex items-center gap-1.5 text-sm">
      <span>{label}</span>
      <select
        className="input max-w-40 py-0.5"
        value={value ?? ''}
        onChange={(e) => setFilter(key, e.target.value || undefined)}
      >
        <option value="">{t`alle`}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          className="input w-44"
          placeholder={t`Frage suchen`}
          aria-label={t`Frage suchen`}
          value={filters.q}
          onChange={(e) => setFilter('suche', e.target.value || undefined)}
        />
        {select(t`Art`, 'art', filters.kind, [
          ['query', t`Abfrage`],
          ['behaviour', t`Verhalten`],
        ])}
        {select(
          t`Teil`,
          'teil',
          filters.split,
          SPLITS.map((s) => [s, splitText(s)]),
        )}
        {select(
          t`Stichwort`,
          'stichwort',
          filters.tag,
          tags.map((tag) => [tag, tagText(tag)]),
        )}
        {select(
          t`Herkunft`,
          'herkunft',
          filters.origin,
          ORIGINS.map((o) => [o, originText(o)]),
        )}
        {select(
          t`Datenstand`,
          'datenstand',
          filters.dataState,
          DATA_STATES.map((d) => [d, dataStateText(d)]),
        )}
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            className="btn"
            onClick={(e) => importer.choose(e.currentTarget)}
            disabled={importer.busy}
          >
            <Trans>Importieren</Trans>
          </button>
          <a className="btn" href={api.evaluation.exportUrl} download="pruefaelle.json">
            <Trans>Exportieren</Trans>
          </a>
        </span>
      </div>
      {importer.view}
      {cases.isPending && <Loading />}
      <ErrorNotice error={cases.error} />
      {cases.data && (
        <>
          <Summary all={all} />
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  <Trans>Kennung</Trans>
                </th>
                <th>
                  <Trans>Frage</Trans>
                </th>
                <th>
                  <Trans>Art</Trans>
                </th>
                <th>
                  <Trans>Teil</Trans>
                </th>
                <th>
                  <Trans>Stichwörter</Trans>
                </th>
                <th>
                  <Trans>Herkunft</Trans>
                </th>
                <th>
                  <Trans>Datenstand</Trans>
                </th>
                <th>
                  <span className="sr-only">
                    <Trans>Status</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {startRows.map((view) => (
                <CaseRow key={view.case.id} view={view} />
              ))}
              {foldable && (
                <tr>
                  <td colSpan={8}>
                    <button
                      type="button"
                      className="text-muted hover:text-accent-700 text-sm"
                      aria-expanded={expanded}
                      onClick={() => setExpanded(!expanded)}
                    >
                      {expanded ? (
                        <Trans>Startfälle wieder einklappen</Trans>
                      ) : (
                        <Trans>… {more} weitere Startfälle</Trans>
                      )}
                    </button>
                  </td>
                </tr>
              )}
              {own.map((view) => (
                <CaseRow key={view.case.id} view={view} />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted py-4 text-center">
                    <Trans>Kein Prüffall passt zu diesen Filtern.</Trans>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <StatusNotes views={own} />
          {ownTotal === 0 && <NoOwnCases onImport={importer.choose} busy={importer.busy} />}
        </>
      )}
    </div>
  )
}

/** "71 Startfälle (nur lesbar) · 3 eigene · Abstimmung 33 · Bestätigung 41". */
function Summary({ all }: { all: CaseView[] }) {
  const start = formatNumber(all.filter((v) => v.read_only).length)
  const own = formatNumber(all.filter((v) => !v.read_only).length)
  const tuning = formatNumber(all.filter((v) => v.case.split === 'tuning').length)
  const confirm = formatNumber(all.filter((v) => v.case.split === 'confirm').length)
  return (
    <p className="text-muted mb-2 text-xs">
      <Trans>
        {start} Startfälle (nur lesbar) · {own} eigene · Abstimmung {tuning} · Bestätigung {confirm}
      </Trans>
    </p>
  )
}

function CaseRow({ view }: { view: CaseView }) {
  const c = view.case
  const stale = view.status === 'stale'
  return (
    <tr className={stale ? 'text-muted' : undefined} data-status={view.status}>
      <td className="font-mono text-xs whitespace-nowrap">
        <Link to={`/admin/bewertung/faelle/${c.id}`} className="hover:text-accent-700">
          {c.id}
        </Link>
      </td>
      <td>{c.prompt}</td>
      <td>{caseKindShort(c)}</td>
      <td>{splitText(c.split)}</td>
      <td>{tagList(c.tags)}</td>
      <td>{originText(c.origin)}</td>
      <td className="whitespace-nowrap">{dataStateText(c.data_state ?? 'sample')}</td>
      <td className="whitespace-nowrap">
        <CaseStatusLabel status={view.status ?? 'ok'} />
      </td>
    </tr>
  )
}

/** What *veraltet* and *Datenstand geändert* mean for the cases that have them (V1.2). */
function StatusNotes({ views }: { views: CaseView[] }) {
  const me = useMe().data?.username ?? ''
  const catalog = useLayers().data
  const title = (name: string) => catalog?.find((l) => l.name === name)?.title ?? name
  const names = (view: CaseView) =>
    (view.status_layers ?? []).map((n) => `„${title(n)}"`).join(', ')
  const several = (view: CaseView) => (view.status_layers ?? []).length > 1
  const stale = views.filter((v) => v.status === 'stale')
  const changed = views.filter((v) => v.status === 'dataset_changed')
  if (!stale.length && !changed.length) return null
  return (
    <div className="mt-3 flex max-w-3xl flex-col gap-1 text-sm">
      {stale.map((view) => {
        const id = view.case.id
        const layers = names(view)
        const word = t`veraltet`
        return (
          <p key={id}>
            {several(view) ? (
              <Trans>
                <span className="font-semibold">{word}</span> ({id}): Die Layer {layers} sind
                gelöscht oder für {me} nicht mehr sichtbar. Der Fall wird in keinem Lauf verwendet,
                bis er bearbeitet ist.
              </Trans>
            ) : (
              <Trans>
                <span className="font-semibold">{word}</span> ({id}): Der Layer {layers} ist
                gelöscht oder für {me} nicht mehr sichtbar. Der Fall wird in keinem Lauf verwendet,
                bis er bearbeitet ist.
              </Trans>
            )}
          </p>
        )
      })}
      {changed.map((view) => {
        const id = view.case.id
        const layers = names(view)
        const word = t`Datenstand geändert`
        return (
          <p key={id}>
            {several(view) ? (
              <Trans>
                <span className="font-semibold">{word}</span> ({id}): {layers} wurden seit dem
                Anlegen des Falls neu importiert. Die Referenz gilt weiter; die Trefferzahl wird
                beim nächsten Lauf neu bestimmt.
              </Trans>
            ) : (
              <Trans>
                <span className="font-semibold">{word}</span> ({id}): {layers} wurde seit dem
                Anlegen des Falls neu importiert. Die Referenz gilt weiter; die Trefferzahl wird
                beim nächsten Lauf neu bestimmt.
              </Trans>
            )}
          </p>
        )
      })}
    </div>
  )
}

/** V1.4: no own cases yet; the start set stays, the three ways sit where own cases would. */
function NoOwnCases({ onImport, busy }: { onImport: (from: HTMLElement) => void; busy: boolean }) {
  return (
    <div className="mt-3 max-w-2xl rounded-[var(--radius-md)] border border-dashed border-neutral-400 p-3 text-sm">
      <p className="mb-1 font-semibold">
        <Trans>Noch keine eigenen Prüffälle</Trans>
      </p>
      <p className="mb-1">
        <Trans>
          Eigene Fälle prüfen, ob eine Anbindung mit <em>Ihren</em> Layern und Fragen zurechtkommt.
          Drei Wege:
        </Trans>
      </p>
      <ol className="list-inside list-decimal">
        <li>
          <Trans>
            Im{' '}
            <Link to="/" className="text-accent-700">
              Arbeitsplatz
            </Link>{' '}
            eine Analyse bauen und <span className="font-semibold">Als Prüffall speichern</span>
          </Trans>
        </li>
        <li>
          <Trans>
            Im{' '}
            <Link to="/admin/modellprotokoll" className="text-accent-700">
              Modellprotokoll
            </Link>{' '}
            einen Eintrag <span className="font-semibold">Als Prüffall übernehmen</span>
          </Trans>
        </li>
        <li>
          <Trans>
            Eine Datei{' '}
            <button
              type="button"
              className="text-accent-700 disabled:opacity-45"
              disabled={busy}
              onClick={(e) => onImport(e.currentTarget)}
            >
              importieren
            </button>{' '}
            (Format wie Export)
          </Trans>
        </li>
      </ol>
    </div>
  )
}

/**
 * Import (V1.3) for the whole page: one file picker, the outcome kept here, so
 * a success started from the hint of V1.4 stays when the hint goes away.
 */
function useImport() {
  const input = useRef<HTMLInputElement>(null)
  // The control that opened the picker gets the focus back from the dialog.
  const opener = useRef<HTMLElement | null>(null)
  const client = useQueryClient()
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const choose = (from?: HTMLElement) => {
    if (from) opener.current = from
    input.current?.click()
  }
  const read = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const found = await importCases(file)
      setOutcome(found)
      if (found.kind === 'imported') await client.invalidateQueries({ queryKey: caseKeys.all })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  const view = (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-label={t`Prüffall-Datei wählen`}
        onChange={(e) => void read(e.target.files?.[0])}
      />
      {outcome?.kind === 'imported' && (
        <Imported count={outcome.count} onClose={() => setOutcome(null)} />
      )}
      {outcome?.kind === 'refused' && (
        <ImportProblems
          outcome={outcome}
          returnFocus={opener}
          onClose={() => setOutcome(null)}
          onRetry={() => {
            setOutcome(null)
            choose()
          }}
        />
      )}
      <ErrorNotice error={error} />
    </>
  )
  return { choose, busy, view }
}

function Imported({ count, onClose }: { count: number; onClose: () => void }) {
  const n = formatNumber(count)
  return (
    <span role="status" className="flex items-center gap-2 text-sm">
      <Trans>{n} Prüffälle übernommen.</Trans>
      <button
        type="button"
        className="text-muted"
        aria-label={t`Hinweis schliessen`}
        onClick={onClose}
      >
        ×
      </button>
    </span>
  )
}

/** V1.3: the import stopped; each faulty case with its reason, nothing taken. */
function ImportProblems({
  outcome,
  onClose,
  onRetry,
  returnFocus,
}: {
  returnFocus: RefObject<HTMLElement | null>
  outcome: Extract<Outcome, { kind: 'refused' }>
  onClose: () => void
  onRetry: () => void
}) {
  const file = outcome.file
  const faulty = formatNumber(new Set(outcome.problems.map((p) => p.caseId)).size)
  const total = outcome.cases === null ? null : formatNumber(outcome.cases)
  const nothing = t`nichts`
  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={t`Import nicht übernommen`}
      returnFocus={returnFocus}
      description={t`Die Datei hat fehlerhafte Fälle; es wurde nichts übernommen.`}
      wide
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>
          {total === null ? (
            <Trans>
              <span className="font-semibold">{file}</span> lässt sich nicht übernehmen. Es wurde{' '}
              <span className="font-semibold">{nothing}</span> übernommen.
            </Trans>
          ) : (
            <Trans>
              <span className="font-semibold">{file}</span> enthält {total} Fälle, {faulty} davon
              sind fehlerhaft. Es wurde <span className="font-semibold">{nothing}</span> übernommen.
            </Trans>
          )}
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>
                <Trans>Fall</Trans>
              </th>
              <th>
                <Trans>Grund</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {outcome.problems.map((p, i) => (
              <tr key={i}>
                <td className="font-mono text-xs whitespace-nowrap">{p.caseId ?? t`Datei`}</td>
                <td>{p.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <details className="text-xs">
          <summary className="text-muted cursor-pointer">
            <Trans>Technisch (Prüfbericht)</Trans>
          </summary>
          <ul className="mt-1 bg-neutral-200 p-2 font-mono">
            {outcome.problems.map((p, i) => (
              <li key={i}>
                {p.caseId ?? '–'}: {p.technical}
              </li>
            ))}
          </ul>
        </details>
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            <Trans>Datei korrigieren und erneut wählen</Trans>
          </button>
          <button type="button" className="btn" onClick={onClose}>
            <Trans>Schliessen</Trans>
          </button>
        </div>
      </div>
    </Modal>
  )
}
