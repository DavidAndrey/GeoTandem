// First start (design A1): the first account becomes administrator, with the
// setup token from the installation (security review #1). The log's link
// brings it as "#token=…": a fragment no server receives.
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { api } from '../api/client'
import { useResetSession, useSetupStatus } from '../api/queries'
import { ErrorNotice, Loading } from '../components/ui'
import { AccessCard, Field } from './AccessCard'
import { passwordHint, passwordProblems } from './rules'

export function SetupPage() {
  const status = useSetupStatus()
  const navigate = useNavigate()
  const location = useLocation()
  const resetSession = useResetSession()
  const [token, setToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get('token') ?? '',
  )
  const [username, setUsername] = useState('admin')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [loadSample, setLoadSample] = useState(true)
  const setup = useMutation({
    mutationFn: () =>
      api.auth.setup({
        token: token.trim(),
        username,
        display_name: displayName,
        password,
        load_sample: loadSample,
      }),
    onSuccess: async () => {
      await resetSession()
      navigate('/', { replace: true })
    },
  })

  // Read once, then out of the address bar and the history.
  useEffect(() => {
    if (location.hash)
      navigate({ pathname: location.pathname, search: location.search }, { replace: true })
  }, [location, navigate])

  if (status.isPending) return <Loading />
  if (status.data && !status.data.needs_setup && !setup.isPending && !setup.isSuccess)
    return <Navigate to="/anmelden" replace />
  const problems = passwordProblems('', password, repeat)
  const ready =
    token.trim() !== '' && username.trim() !== '' && repeat !== '' && problems.length === 0

  return (
    <AccessCard title={t`Ersteinrichtung`}>
      <p className="mb-4 text-sm">
        <Trans>
          Noch gibt es kein Konto. Das erste Konto wird Administrator und legt weitere Konten an.
        </Trans>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) setup.mutate()
        }}
      >
        <Field label={t`Einrichtungscode`}>
          <input
            className="input font-mono"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby="setup-token-hint"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <p id="setup-token-hint" className="text-muted -mt-2 mb-3 text-xs">
          <Trans>
            Steht beim ersten Start im Protokoll der Installation (<code>docker logs</code>) oder
            ist dort als <code>GEOTANDEM_SETUP_TOKEN</code> gesetzt.
          </Trans>
        </p>
        <Field label={t`Benutzername`}>
          <input
            className="input"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label={t`Anzeigename`}>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label={t`Passwort`}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <p id="password-hint" className="text-muted -mt-2 mb-3 text-xs">
          {passwordHint()}
        </p>
        <Field label={t`Passwort wiederholen`}>
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
            <Trans>Beispieldatensatz „Bern-Mittelland" laden</Trans>
          </label>
        )}
        <ErrorNotice error={setup.error} />
        <button
          type="submit"
          className="btn btn-primary mt-2 w-full justify-center"
          disabled={!ready || setup.isPending}
        >
          <Trans>Einrichten</Trans>
        </button>
      </form>
    </AccessCard>
  )
}
