// "Als Prüffall speichern" in the workplace, for administrators only (design
// V3, plan WP88): the current analysis becomes the reference of a new own
// case on the live data, as Modus A runs it (``resultQuery``), with the
// question as a user would ask it, an id, tags and the split (default
// Bestätigung, design review 3). A reference must pass the checks a model's
// query passes (V3.2): what the controls can tell beforehand is told at once,
// the rest is the server's refusal in words.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { resultLayer } from '../../analysis/query'
import { currentAnalysis, useAnalysis } from '../../analysis/store'
import type { EvalCase, Split } from '../../api/client'
import { useLayers, useMe } from '../../api/queries'
import { Modal } from '../../components/ui'
import { useCounts } from '../../editor/useCounts'
import { ConditionTree } from '../../model/tree'
import { SplitChoice, TagEditor } from './parts'
import { createCase, useCaseChange, useCases } from './queries'
import { keepEscapeInField } from './escape'
import { referenceFor } from './reference'
import { caseErrorText, dataStateText, hitsText, idFrom, idProblem, layersOf } from './words'

/** The entry under the query of the sidebar: only for an administrator, only with a result layer. */
export function SaveAsCase() {
  const me = useMe().data
  const hasResult = useAnalysis((s) => s.result !== null)
  const [open, setOpen] = useState(false)
  const entry = useRef<HTMLButtonElement>(null)
  if (me?.role !== 'admin' || !hasResult) return null
  return (
    <div className="mt-1.5">
      <button
        ref={entry}
        type="button"
        className="text-accent-700 text-xs"
        onClick={() => setOpen(true)}
      >
        <Trans>Als Prüffall speichern</Trans>
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t`Als Prüffall speichern`}
        description={t`Die aktuelle Analyse als Referenz eines eigenen Prüffalls speichern`}
        wide
        onEscapeKeyDown={keepEscapeInField}
        returnFocus={entry}
      >
        {open && <SaveCaseForm onClose={() => setOpen(false)} />}
      </Modal>
    </div>
  )
}

function SaveCaseForm({ onClose }: { onClose: () => void }) {
  const analysis = useAnalysis(useShallow(currentAnalysis))
  const catalog = useLayers().data
  const counts = useCounts(analysis)
  const [question, setQuestion] = useState('')
  const [id, setId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  // New own cases default to the confirmation split (design review 3).
  const [split, setSplit] = useState<Split>('confirm')
  const [tags, setTags] = useState<string[]>([])
  // The tags in use, offered while typing: the case list (cached once loaded).
  const known = [...new Set((useCases().data?.items ?? []).flatMap((v) => v.case.tags))].sort()
  const save = useCaseChange(createCase)
  const found = referenceFor(analysis, catalog)
  const problem = found.problem

  if (found.problem !== null)
    return (
      <div className="flex flex-col gap-3 text-sm">
        <div role="alert" className="border-ink rounded-[var(--radius-md)] border p-3">
          <span className="border-ink text-ink mb-2 inline-block rounded-full border px-2 text-xs">
            <Trans>Nicht speicherbar</Trans>
          </span>
          <p>{problem}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onClose()
              useAnalysis.getState().edit()
            }}
          >
            <Trans>Zur Abfrage</Trans>
          </button>
          <button type="button" className="btn" onClick={onClose}>
            <Trans>Schliessen</Trans>
          </button>
        </div>
      </div>
    )

  if (save.isSuccess) {
    const saved = save.data.case.id
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p role="status">
          <Trans>Prüffall „{saved}" gespeichert.</Trans>{' '}
          <Link to={`/admin/bewertung/faelle/${saved}`} className="text-accent-700">
            <Trans>Ansehen ›</Trans>
          </Link>
        </p>
        <div>
          <button type="button" className="btn" onClick={onClose} autoFocus>
            <Trans>Schliessen</Trans>
          </button>
        </div>
      </div>
    )
  }

  const caseId = idEdited ? id : idFrom(question)
  const idWrong = caseId ? idProblem(caseId) : null
  const ready = question.trim() !== '' && caseId !== '' && !idWrong && tags.length > 0
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || found.problem !== null) return
    const gold = found.gold
    const body: EvalCase = {
      id: caseId,
      prompt: question.trim(),
      tags,
      split,
      origin: 'authored',
      data_state: 'live',
      gold,
      // The server stamps each layer's dataset version of now (D3).
      layers: layersOf(gold).map((name) => ({ name })),
      schema_version: found.schemaVersion,
      also: [],
      forbid: [],
      note: '',
    }
    save.mutate(body)
  }
  const result = resultLayer(analysis)
  const resultTitle =
    result?.source.kind === 'catalog'
      ? (catalog?.find((l) => l.name === result.id)?.title ?? result.id)
      : ''
  const hits = counts.data ? hitsText(counts.data.hits) : '…'
  const state = dataStateText('live')
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <p className="label-caps">
          <Trans>Referenz · aktuelle Analyse · Ergebnis {resultTitle}</Trans>
        </p>
        <ConditionTree
          result={result}
          tree={analysis.tree}
          counts={counts.data?.rows}
          line="applied"
        />
        <p className="tabular-nums">
          <Trans>
            {hits} · Datenstand <span className="font-semibold">{state}</span>
          </Trans>
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="label-caps">
            <Trans>Frage</Trans>
          </span>
          <input
            className="input"
            value={question}
            required
            autoFocus
            aria-describedby="case-question-help"
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <span id="case-question-help" className="text-muted text-xs">
          <Trans>
            Schreiben Sie die Frage so, wie ein Anwender sie stellen würde: in eigenen Worten, ohne
            Feldnamen und ohne Werte, die er nicht kennt. Schlecht: „schulart = Primarschule AND
            gemeinde = Köniz".
          </Trans>
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="label-caps">
            <Trans>Kennung</Trans>
          </span>
          <input
            className="input font-mono"
            value={caseId}
            aria-invalid={idWrong !== null}
            aria-describedby="case-id-help"
            onChange={(e) => {
              setId(e.target.value)
              setIdEdited(true)
            }}
          />
        </label>
        <span id="case-id-help" className="text-muted text-xs">
          {idWrong ?? <Trans>Aus der Frage vorgeschlagen; eindeutig unter allen Prüffällen.</Trans>}
        </span>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-1">
          <span className="label-caps">
            <Trans>Teil</Trans>
          </span>
          <SplitChoice label={t`Teil`} value={split} onChange={setSplit} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="label-caps">
            <Trans>Stichwörter</Trans>
          </span>
          <TagEditor tags={tags} known={known} onChange={setTags} />
          {tags.length === 0 && (
            <span className="text-muted text-xs">
              <Trans>Mindestens ein Stichwort.</Trans>
            </span>
          )}
        </div>
      </div>
      <p className="text-muted text-xs">
        <Trans>
          Die Analyse im Arbeitsplatz bleibt unverändert. Weitere Lesarten und Anmerkung später im
          Fall.
        </Trans>
      </p>
      {save.isError && (
        <div role="alert" className="border-ink rounded-[var(--radius-md)] border p-3">
          <span className="border-ink text-ink mb-2 inline-block rounded-full border px-2 text-xs">
            <Trans>Nicht speicherbar</Trans>
          </span>
          <p>{caseErrorText(save.error)}</p>
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={!ready || save.isPending}>
          <Trans>Speichern</Trans>
        </button>
        <button type="button" className="btn" onClick={onClose}>
          <Trans>Abbrechen</Trans>
        </button>
      </div>
    </form>
  )
}
