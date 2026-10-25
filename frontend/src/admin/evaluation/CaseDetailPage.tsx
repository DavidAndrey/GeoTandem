// One case (design V2): the question, the reference as readable condition
// trees with their hits, split, tags, note, origin and data state. An own case
// is edited here, except its reference, which changes over the workplace
// (V2.1: "Im Arbeitsplatz öffnen", "Weitere Lesart hinzufügen"); a behaviour
// case names the expected answer (V2.2); a start case is read only and can
// be copied into an own case (V2.3).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent, type RefObject } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { canonicalQuery } from '../../analysis/query'
import { useAnalysis } from '../../analysis/store'
import { api, type CaseView, type EvalCase } from '../../api/client'
import { useLayers } from '../../api/queries'
import { ConfirmDialog, ErrorNotice, Loading, Modal } from '../../components/ui'
import { formatDateTime } from '../format'
import { CaseStatusLabel, Field, SplitChoice, TagEditor } from './parts'
import { caseKeys, createCase, updateCase, useCase, useCaseChange, useCases } from './queries'
import { Reference } from './Reference'
import { appliedAnalysis, referenceFor } from './reference'
import {
  ANSWER_KINDS,
  approachText,
  caseErrorText,
  caseKindText,
  dataStateText,
  idProblem,
  isBehaviour,
  kindText,
  layersOf,
  MAX_READINGS,
  originText,
  readings,
  splitText,
  tagText,
  withReadings,
  type AnswerKind,
} from './words'

export function CaseDetailPage() {
  const { id = '' } = useParams()
  const view = useCase(id)
  // The version last saved here, so "Gespeichert." outlives the fresh form.
  const [saved, setSaved] = useState<string | null>(null)
  const data = view.data
  return (
    <section aria-labelledby="case-title">
      {!data && <Breadcrumb />}
      {view.isPending && <Loading />}
      <ErrorNotice error={view.error} />
      {/* A saved case starts the form again from what the server keeps. */}
      {data && (
        <CaseForm
          key={`${data.case.id}|${data.updated_at ?? ''}`}
          view={data}
          saved={saved !== null && saved === data.updated_at}
          onSaved={setSaved}
        />
      )}
    </section>
  )
}

const LIST = '/admin/bewertung/faelle'

/** "Bewertung › Prüffälle ›"; ``guard`` asks before leaving unsaved edits. */
function Breadcrumb({ guard }: { guard?: (go: () => void) => void }) {
  const navigate = useNavigate()
  return (
    <p className="text-muted mb-1 text-sm">
      <Link
        to={LIST}
        className="hover:text-accent-700"
        onClick={(event) => {
          if (!guard) return
          event.preventDefault()
          guard(() => navigate(LIST))
        }}
      >
        <Trans>Bewertung › Prüffälle</Trans>
      </Link>{' '}
      ›
    </p>
  )
}

function CaseForm({
  view,
  saved,
  onSaved,
}: {
  view: CaseView
  /** This version was just saved here. */
  saved: boolean
  onSaved: (version: string | null) => void
}) {
  const original = view.case
  const [form, setForm] = useState<EvalCase>(original)
  const [deleting, setDeleting] = useState(false)
  const [copying, setCopying] = useState(false)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const copyButton = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const readOnly = view.read_only
  const dirty = JSON.stringify(form) !== JSON.stringify(original)
  const readingsChanged = JSON.stringify(readings(form)) !== JSON.stringify(readings(original))
  /** Leaves at once, or asks first while the case has unsaved edits. */
  const guard = (go: () => void) => (dirty ? setLeaving(() => go) : go())
  const client = useQueryClient()
  const save = useCaseChange(updateCase)
  // The deleted case leaves the cache before the page does, so nothing asks for it again (404).
  const remove = useMutation({
    mutationFn: (caseId: string) => api.evaluation.remove(caseId),
    onSuccess: () => {
      client.removeQueries({ queryKey: caseKeys.one(original.id) })
      navigate(LIST)
      void client.invalidateQueries({ queryKey: caseKeys.list })
    },
  })
  // The tags in use, offered while typing: the case list (cached once loaded).
  const known = [...new Set((useCases().data?.items ?? []).flatMap((v) => v.case.tags))].sort()
  const patch = (change: Partial<EvalCase>) => setForm((f) => ({ ...f, ...change }))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || readOnly) return
    save.mutate(
      { id: original.id, body: form },
      {
        onSuccess: (next) => {
          client.setQueryData(caseKeys.one(original.id), next)
          onSaved(next.updated_at ?? null)
        },
      },
    )
  }
  const docs = readings(form)
  const behaviour = isBehaviour(form)
  const questionId = 'case-question'
  const noteId = 'case-note'
  const help = 'case-question-help'
  const title = original.id
  const kind = caseKindText(form)
  const count = docs.length

  return (
    <>
      <Breadcrumb guard={guard} />
      <form onSubmit={submit} aria-labelledby="case-title">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 id="case-title" className="mr-auto font-mono text-xl">
            {title}
          </h2>
          <CaseStatusLabel status={view.status ?? 'ok'} />
          {readOnly ? (
            <>
              <span className="border-ink text-ink rounded-full border px-2 text-xs">
                <Trans>Startfall · nur lesbar</Trans>
              </span>
              <button
                ref={copyButton}
                type="button"
                className="btn"
                onClick={() => setCopying(true)}
              >
                <Trans>Als eigenen Fall kopieren</Trans>
              </button>
            </>
          ) : (
            <>
              <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
                <Trans>Speichern</Trans>
              </button>
              <button
                type="button"
                className="btn"
                disabled={!dirty}
                onClick={() => {
                  setForm(original)
                  save.reset()
                }}
              >
                <Trans>Verwerfen</Trans>
              </button>
              <button type="button" className="btn" onClick={() => setDeleting(true)}>
                <Trans>Löschen</Trans>
              </button>
            </>
          )}
        </div>
        <StatusHint view={view} />
        {save.isError && (
          <p role="alert" className="text-danger my-2 text-sm">
            {caseErrorText(save.error, docs.length)}
          </p>
        )}
        {saved && !dirty && (
          <p role="status" className="text-muted my-2 text-sm">
            <Trans>Gespeichert.</Trans>
          </p>
        )}
        <dl className="max-w-4xl text-sm">
          <Field label={t`Frage`} id={readOnly ? undefined : questionId}>
            {readOnly ? (
              <p>{form.prompt}</p>
            ) : (
              <>
                <input
                  id={questionId}
                  className="input w-full max-w-xl"
                  value={form.prompt}
                  required
                  aria-describedby={help}
                  onChange={(e) => patch({ prompt: e.target.value })}
                />
                <p id={help} className="text-muted mt-0.5 text-xs">
                  <Trans>
                    So formulieren, wie ein Anwender fragen würde, nicht wie die Abfrage aussieht.
                  </Trans>
                </p>
              </>
            )}
          </Field>
          <Field label={t`Art`}>
            {docs.length > 1 ? (
              <Trans>
                {kind} · {count} Lesarten, jede gilt
              </Trans>
            ) : (
              kind
            )}
          </Field>
          {behaviour ? (
            <Behaviour form={form} readOnly={readOnly} patch={patch} />
          ) : docs.length ? (
            <Field label={docs.length > 1 ? t`Lesarten` : t`Referenz`}>
              <Reference
                docs={docs}
                hits={view.reference_hits}
                pending={readingsChanged}
                guard={guard}
                dataState={form.data_state ?? 'sample'}
                onRemove={
                  readOnly || docs.length < 2
                    ? undefined
                    : (i) =>
                        setForm((f) =>
                          withLayers(
                            withReadings(
                              f,
                              docs.filter((_, j) => j !== i),
                            ),
                          ),
                        )
                }
                extra={
                  !readOnly &&
                  docs.length < MAX_READINGS && (
                    <AddReading
                      docs={docs}
                      onAdd={(doc) => setForm((f) => withLayers(withReadings(f, [...docs, doc])))}
                    />
                  )
                }
              />
            </Field>
          ) : (
            form.require && (
              <Field label={t`Verlangt`}>
                <p className="mb-1">
                  <Trans>Ergebnis-Layer und Bedingungen, die jede richtige Abfrage enthält:</Trans>
                </p>
                <pre className="overflow-auto bg-neutral-200 p-2 font-mono text-xs">
                  {JSON.stringify(form.require, null, 2)}
                </pre>
              </Field>
            )
          )}
          <Field label={t`Teil`}>
            {readOnly ? (
              splitText(form.split)
            ) : (
              <SplitChoice
                label={t`Teil`}
                value={form.split}
                onChange={(split) => patch({ split })}
              />
            )}
          </Field>
          <Field label={t`Stichwörter`}>
            {readOnly ? (
              <ul className="flex flex-wrap gap-1.5">
                {form.tags.map((tag) => (
                  <li key={tag} className="chip">
                    {tagText(tag)}
                  </li>
                ))}
              </ul>
            ) : (
              <TagEditor tags={form.tags} known={known} onChange={(tags) => patch({ tags })} />
            )}
          </Field>
          <Field label={t`Anmerkung`} id={readOnly ? undefined : noteId}>
            {readOnly ? (
              <p>{form.note || '–'}</p>
            ) : (
              <textarea
                id={noteId}
                className="input w-full max-w-xl"
                rows={2}
                value={form.note ?? ''}
                onChange={(e) => patch({ note: e.target.value })}
              />
            )}
          </Field>
          <Field label={t`Herkunft`}>
            <Origin view={view} />
          </Field>
          <Field label={t`Datenstand`}>
            <DataStateText c={form} />
          </Field>
        </dl>
      </form>
      {!readOnly && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t`Prüffall löschen?`}
          confirm={t`Löschen`}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(original.id, { onError: () => setDeleting(false) })}
        >
          <Trans>
            Der Prüffall „{title}" wird gelöscht. Läufe, die ihn schon verwendet haben, behalten
            ihn.
          </Trans>
        </ConfirmDialog>
      )}
      <ErrorNotice error={remove.error} />
      {readOnly && (
        <CopyDialog
          open={copying}
          onClose={() => setCopying(false)}
          source={original}
          returnFocus={copyButton}
        />
      )}
      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(next) => !next && setLeaving(null)}
        title={t`Ungespeicherte Änderungen am Prüffall verwerfen?`}
        confirm={t`Verwerfen`}
        onConfirm={() => {
          const go = leaving
          setLeaving(null)
          go?.()
        }}
      >
        <Trans>Die Änderungen an diesem Prüffall sind nicht gespeichert und gehen verloren.</Trans>
      </ConfirmDialog>
    </>
  )
}

/** A live case names exactly the layers its readings use (D3); the server stamps their versions. */
function withLayers(c: EvalCase): EvalCase {
  if (c.data_state !== 'live') return c
  const used = layersOf(readings(c))
  const kept = (c.layers ?? []).filter((l) => used.includes(l.name))
  const added = used.filter((n) => !kept.some((l) => l.name === n)).map((name) => ({ name }))
  return { ...c, layers: [...kept, ...added] }
}

/**
 * "Weitere Lesart hinzufügen" (V2.1): the workplace's applied analysis, never
 * an open draft of the editor, becomes one more fair reading, through the
 * checks of "Als Prüffall speichern" (V3.2); a reading the case has is refused.
 */
function AddReading({
  docs,
  onAdd,
}: {
  docs: Record<string, unknown>[]
  onAdd: (doc: Record<string, unknown>) => void
}) {
  const analysis = useAnalysis(useShallow(appliedAnalysis))
  const catalog = useLayers().data
  const found = referenceFor(analysis, catalog)
  const twice =
    found.problem === null && docs.some((doc) => canonicalQuery(doc) === canonicalQuery(found.gold))
  const problem = found.problem ?? (twice ? t`Diese Lesart hat der Fall schon.` : null)
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={problem !== null}
        aria-describedby="add-reading-help"
        onClick={() => found.problem === null && !twice && onAdd(found.gold)}
      >
        <Trans>Weitere Lesart hinzufügen</Trans>
      </button>
      <span id="add-reading-help" className="text-muted text-xs">
        {problem ?? <Trans>übernimmt die angewendete Analyse des Arbeitsplatzes</Trans>}
      </span>
    </>
  )
}

/** V2.2: the expected answer in the status language of E2 (black: a message), what else passes. */
function Behaviour({
  form,
  readOnly,
  patch,
}: {
  form: EvalCase
  readOnly: boolean
  patch: (change: Partial<EvalCase>) => void
}) {
  const expected = form.expect as AnswerKind
  const also = form.also ?? []
  const others = ANSWER_KINDS.filter((k) => k !== expected)
  const refused = others.filter((k) => !also.includes(k))
  return (
    <>
      <Field label={t`Erwartet`} id={readOnly ? undefined : 'case-expect'}>
        {readOnly ? (
          <span className="border-ink text-ink rounded-full border px-2 text-xs">
            {kindText(expected)}
          </span>
        ) : (
          <select
            id="case-expect"
            className="input"
            value={expected}
            onChange={(e) => {
              const kind = e.target.value as AnswerKind
              patch({ expect: kind, also: also.filter((k) => k !== kind) })
            }}
          >
            {ANSWER_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindText(k)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t`Auch zulässig`}>
        <fieldset>
          <legend className="sr-only">{t`Auch zulässig`}</legend>
          <ul className="flex flex-col gap-0.5">
            {others.map((kind) => (
              <li key={kind}>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={also.includes(kind)}
                    disabled={readOnly}
                    onChange={(e) =>
                      patch({
                        also: e.target.checked ? [...also, kind] : also.filter((k) => k !== kind),
                      })
                    }
                  />
                  {kindText(kind)}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </Field>
      {form.other_approach && (
        <Field label={t`Arbeitsweise`}>{approachText(form.other_approach)}</Field>
      )}
      <Field label={t`Nicht zulässig`}>
        {refused.length ? refused.map(kindText).join(', ') : '–'}
        {(form.forbid ?? []).length > 0 && (
          <p className="mt-0.5">
            <Trans>Antworten mit diesen Wörtern:</Trans>{' '}
            <span className="font-mono text-xs">{(form.forbid ?? []).join(', ')}</span>
          </p>
        )}
      </Field>
    </>
  )
}

/** "Arbeitsplatz · 22.10.2026 16:40", "Protokoll · Eintrag 412", "Start". */
function Origin({ view }: { view: CaseView }) {
  const c = view.case
  const when = view.created_at ? formatDateTime(view.created_at) : null
  const action = c.origin_action
  return (
    <span>
      {originText(c.origin)}
      {action != null && (
        <>
          {' · '}
          <Link to={`/admin/modellprotokoll/${action}`} className="text-accent-700">
            <Trans>Eintrag {action}</Trans>
          </Link>
        </>
      )}
      {when && ` · ${when}`}
    </span>
  )
}

/** "Beispieldaten · fest" or "Betriebsdaten" with the layers and their dataset versions. */
function DataStateText({ c }: { c: EvalCase }) {
  const state = dataStateText(c.data_state ?? 'sample')
  if (c.data_state !== 'live') return <Trans>{state} · fest</Trans>
  return (
    <span>
      {state}
      {(c.layers ?? []).map((l) => (
        <span key={l.name}>
          {' · '}
          {l.name}
          {l.dataset_version && (
            <>
              {' '}
              <code className="font-mono text-xs">{l.dataset_version}</code>
            </>
          )}
        </span>
      ))}
    </span>
  )
}

/** The status of an own case above its fields (V1.2 "Zeile → V2.1 mit Hinweis oben"). */
function StatusHint({ view }: { view: CaseView }) {
  const names = view.status_layers ?? []
  const layers = names.map((n) => `„${n}"`).join(', ')
  if (view.status === 'stale')
    return (
      <p className="mb-2 max-w-3xl rounded-[var(--radius-md)] border border-neutral-400 p-2 text-sm">
        {names.length > 1 ? (
          <Trans>
            Veraltet: Die Layer {layers} sind gelöscht oder für Sie nicht mehr sichtbar. Der Fall
            wird in keinem Lauf verwendet, bis er bearbeitet ist.
          </Trans>
        ) : (
          <Trans>
            Veraltet: Der Layer {layers} ist gelöscht oder für Sie nicht mehr sichtbar. Der Fall
            wird in keinem Lauf verwendet, bis er bearbeitet ist.
          </Trans>
        )}
      </p>
    )
  if (view.status === 'invalid')
    return (
      <p className="mb-2 max-w-3xl rounded-[var(--radius-md)] border border-neutral-400 p-2 text-sm">
        <Trans>
          Ungültig: Die Referenz besteht die Prüfungen einer Modellabfrage nicht mehr oder lässt
          sich nicht mehr ausführen, etwa weil ein Feld nicht mehr für das Modell freigegeben ist.
          Der Fall wird in keinem Lauf verwendet, bis er bearbeitet ist.
        </Trans>
      </p>
    )
  if (view.status === 'dataset_changed')
    return (
      <p className="border-ink mb-2 max-w-3xl rounded-[var(--radius-md)] border p-2 text-sm">
        {names.length > 1 ? (
          <Trans>
            Datenstand geändert: {layers} wurden seit der letzten Prüfung der Referenz neu
            importiert. Die Referenz gilt weiter; die Trefferzahl wird beim nächsten Lauf neu
            bestimmt.
          </Trans>
        ) : (
          <Trans>
            Datenstand geändert: {layers} wurde seit der letzten Prüfung der Referenz neu
            importiert. Die Referenz gilt weiter; die Trefferzahl wird beim nächsten Lauf neu
            bestimmt.
          </Trans>
        )}
      </p>
    )
  return null
}

/** V2.3 "Als eigenen Fall kopieren": the same question and reference under a new id, as an own case. */
function CopyDialog({
  open,
  onClose,
  source,
  returnFocus,
}: {
  open: boolean
  onClose: () => void
  source: EvalCase
  returnFocus: RefObject<HTMLButtonElement | null>
}) {
  return (
    <Modal
      returnFocus={returnFocus}
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t`Als eigenen Fall kopieren`}
      description={t`Den Startfall unter einer neuen Kennung als eigenen Fall anlegen`}
    >
      {open && <CopyForm source={source} onClose={onClose} />}
    </Modal>
  )
}

function CopyForm({ source, onClose }: { source: EvalCase; onClose: () => void }) {
  const navigate = useNavigate()
  const [id, setId] = useState(`${source.id}-kopie`.slice(0, 63))
  // New own cases default to the confirmation split (design review 3).
  const [split, setSplit] = useState<EvalCase['split']>('confirm')
  const create = useCaseChange(createCase)
  const problem = idProblem(id)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (problem) return
    const from = source.id
    // Where the copy came from: the case format has no field for it, the note says it.
    const note = [t`Kopie von ${from}.`, source.note].filter(Boolean).join(' ')
    create.mutate(
      { ...source, id, split, note, origin: 'authored', origin_action: null },
      { onSuccess: (view) => navigate(`/admin/bewertung/faelle/${view.case.id}`) },
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="label-caps">
          <Trans>Kennung</Trans>
        </span>
        <input
          className="input font-mono"
          value={id}
          required
          autoFocus
          aria-invalid={problem !== null}
          aria-describedby={problem ? 'copy-id-problem' : undefined}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      {problem && (
        <p id="copy-id-problem" className="text-muted text-xs">
          {problem}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <span className="label-caps">
          <Trans>Teil</Trans>
        </span>
        <SplitChoice label={t`Teil`} value={split} onChange={setSplit} />
      </div>
      <p className="text-muted text-xs">
        <Trans>
          Frage, Referenz, Stichwörter und Anmerkung werden übernommen; der Startfall bleibt
          unverändert.
        </Trans>
      </p>
      {create.isError && (
        <p role="alert" className="text-danger text-sm">
          {caseErrorText(create.error, readings(source).length)}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={create.isPending || problem !== null}
        >
          <Trans>Kopieren</Trans>
        </button>
        <button type="button" className="btn" onClick={onClose}>
          <Trans>Abbrechen</Trans>
        </button>
      </div>
    </form>
  )
}
