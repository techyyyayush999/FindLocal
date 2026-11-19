import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listAdminShops, listUsers } from '../../api/admin'
import { listAdminProducts } from '../../api/products'
import { DashboardNav } from '../../components/DashboardNav'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { useAuth } from '../../context/useAuth'
import { ADMIN_NAV } from './adminNav'

export function AdminDashboardPage() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [counts, setCounts] = useState({ shops: 0, users: 0, pendingProducts: 0 })

  // Initial load. Promise.allSettled never rejects, so state is applied in the
  // deferred .then/.finally callbacks rather than synchronously in the effect.
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      listAdminShops(),
      listUsers(),
      listAdminProducts({ status: 'PENDING' }),
    ])
      .then(([shopsResult, usersResult, pendingResult]) => {
        if (cancelled) return
        const shops =
          shopsResult.status === 'fulfilled'
            ? (shopsResult.value?.count ?? shopsResult.value?.data?.shops?.length ?? 0)
            : 0
        const users =
          usersResult.status === 'fulfilled'
            ? (usersResult.value?.count ?? usersResult.value?.data?.users?.length ?? 0)
            : 0
        const pendingProducts =
          pendingResult.status === 'fulfilled' ? (pendingResult.value?.total ?? 0) : 0

        setCounts({ shops, users, pendingProducts })

        const failed = [shopsResult, usersResult, pendingResult].find(
          (result) => result.status === 'rejected'
        )
        setError(failed ? failed.reason : null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <PageHeader eyebrow="Admin console" title={`Welcome, ${user?.name || 'admin'}`}>
        <p>Verify shops, moderate product submissions and manage accounts.</p>
      </PageHeader>

      <DashboardNav items={ADMIN_NAV} />

      {error ? <ErrorBanner error={error} title="Some admin data could not be loaded" /> : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading admin overview…
        </p>
      ) : null}

      <ul className="tiles">
        <li>
          <Link className="tile" to="/admin/shops">
            <h2 className="tile__title">Shops</h2>
            <p className="tile__body">
              {loading ? 'Loading…' : `${counts.shops} shops registered. Verify sellers to unlock inventory.`}
            </p>
          </Link>
        </li>
        <li>
          <Link className="tile" to="/admin/products">
            <h2 className="tile__title">Product moderation</h2>
            <p className="tile__body">
              {loading
                ? 'Loading…'
                : `${counts.pendingProducts} submissions waiting for review.`}
            </p>
          </Link>
        </li>
        <li>
          <Link className="tile" to="/admin/users">
            <h2 className="tile__title">Users</h2>
            <p className="tile__body">
              {loading ? 'Loading…' : `${counts.users} accounts across all roles.`}
            </p>
          </Link>
        </li>
      </ul>
    </div>
  )
}
