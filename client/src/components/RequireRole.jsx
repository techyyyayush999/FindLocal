import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/useAuth'

// Where a user of each role should land if they open a dashboard they do not own.
const HOME_FOR_ROLE = {
  customer: '/',
  seller: '/seller',
  admin: '/admin',
}

// Client-side guard for dashboard routes. This is a user-experience helper only —
// the backend `protect` + `authorize` middleware remains the authoritative check.
export function RequireRole({ allow, children }) {
  const { user, status } = useAuth()
  const location = useLocation()

  // Wait for the session bootstrap instead of redirecting on the first render.
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

  if (!allow.includes(user.role)) {
    return <Navigate to={HOME_FOR_ROLE[user.role] || '/'} replace />
  }

  return children ?? <Outlet />
}
