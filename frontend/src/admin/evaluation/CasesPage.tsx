// Prüffälle (design V1, reworked for use): own cases first, then the start set
// (read only, folded to five while no filter is set), each part under its own
// heading; split, tags, origin and data state as columns, so a filter such as
// "only own cases on live data" is one row. Columns sort within each part; own
// cases that need editing come first, with the reason under the question, and
// a line above the list shows only them (V1.2). Import is all or nothing
// (V1.3); without own cases the three ways to make one stand above the list
// (V1.4). Filters and sort live in the address, as in the model log; filtered,
// the list says how many it shows and hands the filter to a new run when a run
// would take exactly these cases.
import { Trans } from '@lingui/react/macro'
import { plural, t } from '@lingui/core/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, type CaseView, type DataState, type Split, type CaseOrigin } from '../../api/client'
import { useLayers, useMe } from '../../api/queries'
import { ErrorNotice, Loading, Modal } from '../../components/ui'
import { formatNumber } from '../../i18n/locale'
import { importCases, type Outcome } from './importFile'
import { choiceForList, choiceParams } from './caseChoice'
import { CaseStatusLabel } from './parts'
import { rowOpener } from './rowOpener'
import { NEW_RUN } from './runWords'
import { caseKeys, useCases } from './queries'
import {
  caseKindShort,
  DATA_STATES,
  dataStateText,
  isBehaviour,
  notRun,
  ORIGINS,
  originText,
  SPLITS,
  splitText,
  tagList,
  tagText,
} from './words'

/** Start cases shown before "… weitere Startfälle" while no filter is set (V1.1). */
const START_SHOWN = 5
/** The list's columns, for rows that span them. */
const COLUMNS = 8
/** ``?zustand=bearbeiten``: only own cases that need editing. */
const ATTENTION = 'bearbeiten'

const SORT_KEYS = ['kennung', 'frage', 'art', 'teil', 'herkunft', 'datenstand', 'zustand'] as const
type SortKey = (typeof SORT_KEYS)[number]
/** ``?sortierung=teil`` up, ``-teil`` down; within own cases and the start set each. */
interface Sort {
  key: SortKey
  down: boolean
}

const sortOf = (value: string | null): Sort | null => {
  const down = value?.startsWith('-') ?? false
  const key = SORT_KEYS.find((k) => k === value?.replace(/^-/, ''))
  return key ? { key, down } : null
}

/** Cases needing editing first, then a changed data state, then the rest. */
const statusRank = (view: CaseView) =>
  notRun(view.status) ? 0 : view.status === 'dataset_changed' ? 1 : 2

const sortValue = (view: CaseView, key: SortKey): string | number => {
  const c = view.case
  switch (key) {
    case 'kennung':
      return c.id
    case 'frage':
      return c.prompt
    case 'art':
      return caseKindShort(c)
    case 'teil':
      return splitText(c.split)
    case 'herkunft':
      return originText(c.origin)
    case 'datenstand':
      return dataStateText(c.data_state ?? 'sample')
    case 'zustand':
      return statusRank(view)
  }
}

/** A stable sort, so equal cases keep the list's own order; ``null`` keeps it. */
function sorted(views: CaseView[], sort: Sort | null): CaseView[] {
  if (!sort) return views
  const sign = sort.down ? -1 : 1
  return [...views].sort((a, b) => {
    const x = sortValue(a, sort.key)
    const y = sortValue(b, sort.key)
    const order =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), 'de')
    return sign * order
  })
}

type Kind = 'query' | 'behaviour'

interface Filters {
  q: string
  kind?: Kind
  split?: Split
  tag?: string
  origin?: CaseOrigin
  dataState?: DataState
  /** Only own cases that need editing before they run again (*veraltet*, *ungültig*). */
  attention?: boolean
}

function matches(view: CaseView, f: Filters): boolean {
  const c = view.case
  if (f.q) {
    const text = `${c.id} ${c.prompt} ${c.tags.map(tagText).join(' ')}`.toLowerCase()
    if (!text.includes(f.q.toLowerCase())) return false
  }
  if (f.kind && (f.kind === 'behaviour') !== isBehaviour(c)) return false
  if (f.split && c.split !== f.split) return false
  if (f.tag && !c.tags.includes(f.tag)) return false
  if (f.origin && c.origin !== f.origin) return false
  if (f.dataState && (c.data_state ?? 'sample') !== f.dataState) return false
  if (f.attention && !notRun(view.status)) return false
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
    attention: params.get('zustand') === ATTENTION || undefined,
  }
  const sort = sortOf(params.get('sortierung'))
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
  const start = sorted(
    shown.filter((v) => v.read_only),
    sort,
  )
  const own = sorted(
    shown.filter((v) => !v.read_only),
    sort ?? { key: 'zustand', down: false },
  )
  const ownTotal = all.filter((v) => !v.read_only).length
  const needEditing = all.filter((v) => !v.read_only && notRun(v.status)).length
  const foldable = !filtered && start.length > START_SHOWN
  const hidden = foldable && !expanded ? start.length - START_SHOWN : 0
  const startRows = hidden ? start.slice(0, START_SHOWN) : start
  const more = formatNumber(hidden)
  const shownCount = formatNumber(shown.length)
  const ownCount = formatNumber(own.length)
  const startCount = formatNumber(start.length)
  const setSort = (next: Sort | null) =>
    setFilter('sortierung', next ? `${next.down ? '-' : ''}${next.key}` : undefined)
  const allCount = formatNumber(all.length)

  const select = (
    label: string,
    key: string,
    value: string | undefined,
    options: [string, string][],
  ) => (
    <label className="flex items-center gap-1.5 text-sm">
      <span>{label}</span>
      <select
        className={`input max-w-40 py-0.5 ${value ? 'border-accent-700 text-accent-700' : ''}`}
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
          placeholder={t`Frage oder Stichwort suchen`}
          aria-label={t`Frage oder Stichwort suchen`}
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
          <div className="mb-2 flex flex-wrap items-center gap-3">
            {filtered ? (
              <p className="text-xs" aria-live="polite">
                <Trans>
                  {shownCount} von {allCount} Prüffällen
                </Trans>{' '}
                <button
                  type="button"
                  className="text-accent-700 ml-1"
                  onClick={() => {
                    // The sort is no filter: it stays.
                    const next = new URLSearchParams()
                    const by = params.get('sortierung')
                    if (by) next.set('sortierung', by)
                    setParams(next, { replace: true })
                  }}
                >
                  <Trans>Filter zurücksetzen</Trans>
                </button>
              </p>
            ) : (
              <Summary all={all} />
            )}
            {filtered && <RunWithThese all={all} shown={shown} filters={filters} />}
          </div>
          {needEditing > 0 && !filters.attention && (
            <NeedEditing count={needEditing} onShow={() => setFilter('zustand', ATTENTION)} />
          )}
          {ownTotal === 0 && <NoOwnCases onImport={importer.choose} busy={importer.busy} />}
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader by="kennung" sort={sort} onSort={setSort}>
                  <Trans>Kennung</Trans>
                </SortHeader>
                <SortHeader by="frage" sort={sort} onSort={setSort}>
                  <Trans>Frage</Trans>
                </SortHeader>
                <SortHeader by="art" sort={sort} onSort={setSort}>
                  <Trans>Art</Trans>
                </SortHeader>
                <SortHeader by="teil" sort={sort} onSort={setSort}>
                  <Trans>Teil</Trans>
                </SortHeader>
                <th scope="col">
                  <Trans>Stichwörter</Trans>
                </th>
                <SortHeader by="herkunft" sort={sort} onSort={setSort}>
                  <Trans>Herkunft</Trans>
                </SortHeader>
                <SortHeader by="datenstand" sort={sort} onSort={setSort}>
                  <Trans>Datenstand</Trans>
                </SortHeader>
                <SortHeader by="zustand" sort={sort} onSort={setSort}>
                  <Trans>Status</Trans>
                </SortHeader>
              </tr>
            </thead>
            {own.length > 0 && (
              <tbody>
                <SectionRow>
                  <Trans>Eigene Prüffälle · {ownCount}</Trans>
                </SectionRow>
                {own.map((view) => (
                  <CaseRow key={rowKey(view)} view={view} />
                ))}
              </tbody>
            )}
            {start.length > 0 && (
              <tbody>
                <SectionRow>
                  <Trans>Startbestand · {startCount} (nur lesbar)</Trans>
                </SectionRow>
                {startRows.map((view) => (
                  <CaseRow key={rowKey(view)} view={view} />
                ))}
                {foldable && (
                  <tr>
                    <td colSpan={COLUMNS}>
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
              </tbody>
            )}
            {shown.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={COLUMNS} className="text-muted py-4 text-center">
                    <Trans>Kein Prüffall passt zu diesen Filtern.</Trans>
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </>
      )}
    </div>
  )
}

/**
 * The filtered cases as a new run (design V4 step 2), when origin, data state,
 * split and tag describe exactly the listed cases that run; otherwise the
 * button stays, locked, with the reason.
 */
function RunWithThese({
  all,
  shown,
  filters,
}: {
  all: CaseView[]
  shown: CaseView[]
  filters: Filters
}) {
  const choice = choiceForList(all, shown, filters)
  const label = t`Neuer Lauf mit diesen Fällen`
  if (choice)
    return (
      <Link to={`${NEW_RUN}?${choiceParams(choice).toString()}`} className="btn ml-auto text-sm">
        {label}
      </Link>
    )
  return (
    <span className="ml-auto flex items-center gap-2">
      <span className="text-muted text-xs">
        {shown.some((v) => !notRun(v.status)) ? (
          <Trans>
            Ein Lauf wählt Fälle nur nach Herkunft (Start oder eigene), Datenstand, Teil und
            Stichwort.
          </Trans>
        ) : (
          <Trans>Keiner der gezeigten Fälle läuft.</Trans>
        )}
      </span>
      <button type="button" className="btn text-sm" disabled>
        {label}
      </button>
    </span>
  )
}

/** "71 Startfälle (nur lesbar) · 3 eigene · Abstimmung 33 · Bestätigung 41". */
function Summary({ all }: { all: CaseView[] }) {
  const start = formatNumber(all.filter((v) => v.read_only).length)
  const own = formatNumber(all.filter((v) => !v.read_only).length)
  const tuning = formatNumber(all.filter((v) => v.case.split === 'tuning').length)
  const confirm = formatNumber(all.filter((v) => v.case.split === 'confirm').length)
  return (
    <p className="text-muted text-xs">
      <Trans>
        {start} Startfälle (nur lesbar) · {own} eigene · Abstimmung {tuning} · Bestätigung {confirm}
      </Trans>
    </p>
  )
}

/**
 * A row's key: origin and id, since an own case may share its id with a start
 * case a later start set brought (both are listed).
 */
const rowKey = (view: CaseView) => `${view.case.origin}|${view.case.id}`

function CaseRow({ view }: { view: CaseView }) {
  const c = view.case
  const navigate = useNavigate()
  const path = `/admin/bewertung/faelle/${c.id}`
  const opener = rowOpener(() => navigate(path))
  return (
    <tr
      {...opener}
      className={`${opener.className} ${notRun(view.status) ? 'text-muted' : ''}`}
      data-status={view.status}
    >
      <td className="font-mono text-xs whitespace-nowrap">
        <Link to={path} className="hover:text-accent-700">
          {c.id}
        </Link>
      </td>
      <td>
        {c.prompt}
        {view.status && view.status !== 'ok' && <StatusNote view={view} />}
      </td>
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

/**
 * What *veraltet*, *ungültig* and *Datenstand geändert* mean for this case
 * (V1.2), under its question, so the reason stands next to the case.
 */
function StatusNote({ view }: { view: CaseView }) {
  const me = useMe().data?.username ?? ''
  const catalog = useLayers().data
  const title = (name: string) => catalog?.find((l) => l.name === name)?.title ?? name
  const layers = (view.status_layers ?? []).map((n) => `„${title(n)}"`).join(', ')
  const several = (view.status_layers ?? []).length > 1
  let text: ReactNode = null
  if (view.status === 'stale')
    text = several ? (
      <Trans>
        Die Layer {layers} sind gelöscht oder für {me} nicht mehr sichtbar. Der Fall läuft nicht
        mit, bis er bearbeitet ist.
      </Trans>
    ) : (
      <Trans>
        Der Layer {layers} ist gelöscht oder für {me} nicht mehr sichtbar. Der Fall läuft nicht mit,
        bis er bearbeitet ist.
      </Trans>
    )
  else if (view.status === 'invalid')
    text = (
      <Trans>
        Die Referenz besteht die Prüfungen einer Modellabfrage nicht mehr, etwa weil ein Feld nicht
        mehr für das Modell freigegeben ist. Der Fall läuft nicht mit, bis er bearbeitet ist.
      </Trans>
    )
  else if (view.status === 'dataset_changed')
    text = several ? (
      <Trans>
        {layers} wurden seit der letzten Prüfung der Referenz neu importiert. Die Referenz gilt
        weiter; die Trefferzahl wird beim nächsten Lauf neu bestimmt.
      </Trans>
    ) : (
      <Trans>
        {layers} wurde seit der letzten Prüfung der Referenz neu importiert. Die Referenz gilt
        weiter; die Trefferzahl wird beim nächsten Lauf neu bestimmt.
      </Trans>
    )
  if (!text) return null
  return <span className="text-ink mt-0.5 block text-xs">{text}</span>
}

/** Above the list: own cases that do not run until edited, one click to show only them. */
function NeedEditing({ count, onShow }: { count: number; onShow: () => void }) {
  const text = plural(count, {
    one: '# eigener Prüffall läuft nicht mit, bis er bearbeitet ist.',
    other: '# eigene Prüffälle laufen nicht mit, bis sie bearbeitet sind.',
  })
  return (
    <p className="border-ink mb-2 flex max-w-3xl items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-sm">
      <span>{text}</span>
      <button type="button" className="text-accent-700 ml-auto" onClick={onShow}>
        <Trans>Nur diese zeigen</Trans>
      </button>
    </p>
  )
}

/** A heading row over a part of the list: own cases, start set. */
function SectionRow({ children }: { children: ReactNode }) {
  return (
    <tr>
      <th
        scope="rowgroup"
        colSpan={COLUMNS}
        className="border-b-0 pt-4 pb-1 text-left text-sm font-semibold"
      >
        {children}
      </th>
    </tr>
  )
}

/** A column header that sorts the list: up, down, back to the list's own order. */
function SortHeader({
  by,
  sort,
  onSort,
  children,
}: {
  by: SortKey
  sort: Sort | null
  onSort: (next: Sort | null) => void
  children: ReactNode
}) {
  const active = sort?.key === by
  const next = !active ? { key: by, down: false } : !sort.down ? { key: by, down: true } : null
  return (
    <th scope="col" aria-sort={active ? (sort.down ? 'descending' : 'ascending') : undefined}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 font-semibold ${active ? 'text-accent-700' : 'hover:text-accent-700'}`}
        onClick={() => onSort(next)}
      >
        {children}
        <span aria-hidden="true" className={active ? '' : 'text-muted'}>
          {active ? (sort.down ? '↓' : '↑') : '↕'}
        </span>
      </button>
    </th>
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
