import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/useAuth'
import { ErrorBanner } from '../components/ErrorBanner'

function navClass(isActive, extra = '') {
  return [isActive ? 'nav__link is-active' : 'nav__link', extra].filter(Boolean).join(' ')
}

export function CustomerShell() {
  const { user, bootstrapError } = useAuth()

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <NavLink to="/" className="brand">
            <span className="brand__mark">FindLocal</span>
            <span className="brand__sub">Neighborhood pickup</span>
          </NavLink>
          <nav className="nav" aria-label="Primary">
            <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>
              Shops
            </NavLink>
            <NavLink to="/nearby" className={({ isActive }) => navClass(isActive)}>
              Nearby
            </NavLink>
            {user ? (
              <NavLink to="/search" className={({ isActive }) => navClass(isActive)}>
                Search
              </NavLink>
            ) : null}
            {user ? (
              <>
                {user.role === 'seller' ? (
                  <NavLink to="/seller" className={({ isActive }) => navClass(isActive)}>
                    Seller
                  </NavLink>
                ) : null}
                {user.role === 'admin' ? (
                  <NavLink to="/admin" className={({ isActive }) => navClass(isActive)}>
                    Admin
                  </NavLink>
                ) : null}
                {user.role === 'customer' ? (
                  <NavLink to="/reservations" className={({ isActive }) => navClass(isActive)}>
                    Reservations
                  </NavLink>
                ) : null}
                <NavLink to="/account" className={({ isActive }) => navClass(isActive)}>
                  Account
                </NavLink>
              </>
            ) : (
              <>
                <NavLink to="/login" className={({ isActive }) => navClass(isActive)}>
                  Log in
                </NavLink>
                <NavLink to="/register" className={({ isActive }) => navClass(isActive, 'nav__link--accent')}>
                  Join
                </NavLink>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {bootstrapError ? (
          <ErrorBanner
            error={bootstrapError}
            title="Could not check your session"
          />
        ) : null}
        <Outlet />
      </main>
      <footer className="footer">
        <p>FindLocal connects verified neighborhood shops with the people nearby.</p>
      </footer>
    </div>
  )
}
