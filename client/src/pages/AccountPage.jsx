import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Button } from '../components/Button'
import { ErrorBanner } from '../components/ErrorBanner'
import { PageHeader } from '../components/PageHeader'
import { useAuth } from '../context/useAuth'

export function AccountPage() {
  const { user, status, logout } = useAuth()
  const location = useLocation()
  const [error, setError] = useState(null)
  const [leaving, setLeaving] = useState(false)

  if (status === 'loading') {
    return (
      <p className="loading" aria-live="polite">
        Checking your session…
      </p>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  async function handleLogout() {
    setLeaving(true)
    setError(null)
    try {
      await logout()
    } catch (err) {
      setError(err)
      setLeaving(false)
    }
  }

  return (
    <div className="page page--narrow">
      <PageHeader eyebrow="Your session" title={user.name || 'Account'}>
        <p>These fields come from GET /api/v1/auth/me. The JWT stays in the cookie.</p>
      </PageHeader>

      {error ? <ErrorBanner error={error} title="Could not log out" /> : null}

      <section className="panel">
        <dl className="facts">
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Role</dt>
          <dd>{user.role}</dd>
          <dt>Account status</dt>
          <dd>{user.isActive ? 'Active' : 'Deactivated'}</dd>
        </dl>
        <div className="actions">
          <Button type="button" variant="secondary" onClick={handleLogout} disabled={leaving}>
            {leaving ? 'Logging out…' : 'Log out'}
          </Button>
        </div>
      </section>
    </div>
  )
}
