// Mandatory password change after signing in with a start password (design A4).
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { Navigate, useNavigate } from 'react-router'
import { useMe, useResetSession } from '../api/queries'
import { AccessCard } from './AccessCard'
import { PasswordForm } from './PasswordForm'

export function PasswordPage() {
  const me = useMe()
  const navigate = useNavigate()
  const resetSession = useResetSession()
  if (me.data && !me.data.must_change_password) return <Navigate to="/" replace />
  return (
    <AccessCard title={t`Passwort festlegen`}>
      <p className="mb-4 text-sm">
        <Trans>
          Sie haben sich mit einem Startpasswort angemeldet. Bitte legen Sie jetzt ein eigenes fest.
        </Trans>
      </p>
      <PasswordForm
        onDone={async () => {
          await resetSession()
          navigate('/', { replace: true })
        }}
      />
    </AccessCard>
  )
}
