// Change the own password (design A4): at least 10 characters, not the old one.
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { ErrorNotice } from '../components/ui'
import { Field } from './AccessCard'
import { passwordProblems } from './rules'

export function PasswordForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const change = useMutation({
    mutationFn: () => api.auth.changePassword(current, next),
    onSuccess: onDone,
  })
  const problems = passwordProblems(current, next, repeat)
  const ready = current !== '' && repeat !== '' && problems.length === 0

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) change.mutate()
      }}
    >
      <Field label="Aktuelles Passwort">
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="Neues Passwort">
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field label="Neues Passwort wiederholen">
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </Field>
      {next !== '' && problems.length > 0 && (
        <ul className="text-muted mb-2 list-disc pl-5 text-xs">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <ErrorNotice error={change.error} />
      <div className="mt-2 flex gap-2">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Abbrechen
          </button>
        )}
        <button
          type="submit"
          className="btn btn-primary ml-auto"
          disabled={!ready || change.isPending}
        >
          Passwort ändern
        </button>
      </div>
    </form>
  )
}
