// First start (design A1): the first account becomes administrator.
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { api } from '../api/client'
import { useResetSession, useSetupStatus } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { AccessCard, Field } from './AccessCard'
import { passwordProblems } from './rules'

export function SetupPage() {
  const status = useSetupStatus()
  const navigate = useNavigate()
  const resetSession = useResetSession()
  const [username, setUsername] = useState('admin')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [loadSample, setLoadSample] = useState(true)
  const setup = useMutation({
    mutationFn: () =>
      api.auth.setup({ username, display_name: displayName, password, load_sample: loadSample }),
    onSuccess: async () => {
      await resetSession()
      navigate('/', { replace: true })
    },
  })

  if (status.isPending) return <Loading />
  if (status.data && !status.data.needs_setup && !setup.isPending && !setup.isSuccess)
    return <Navigate to="/anmelden" replace />
  const problems = passwordProblems('', password, repeat)
  const ready = username.trim() !== '' && repeat !== '' && problems.length === 0

  return (
    <AccessCard title="Ersteinrichtung">
      <p className="mb-4 text-sm">
        Noch gibt es kein Konto. Das erste Konto wird Administrator und legt weitere Konten an.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) setup.mutate()
        }}
      >
        <Field label="Benutzername">
          <input
            className="input"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Anzeigename">
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Passwort">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Passwort wiederholen">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        {password !== '' && problems.length > 0 && (
          <ul className="text-muted mb-2 list-disc pl-5 text-xs">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {!status.data?.sample_loaded && (
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={loadSample}
              onChange={(e) => setLoadSample(e.target.checked)}
            />
            Beispieldatensatz „Bern-Mittelland" laden
          </label>
        )}
        <ErrorNotice error={setup.error} />
        <button
          type="submit"
          className="btn btn-primary mt-2 w-full justify-center"
          disabled={!ready || setup.isPending}
        >
          Einrichten
        </button>
      </form>
    </AccessCard>
  )
}
