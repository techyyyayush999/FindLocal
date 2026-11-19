import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { isApiError } from '../../api/http'
import { getMyShop } from '../../api/sellerShop'
import { DashboardNav } from '../../components/DashboardNav'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { StatusChip } from '../../components/StatusChip'
import { useAuth } from '../../context/useAuth'
import { SELLER_NAV } from './sellerNav'

export function SellerDashboardPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState(null)
  const [hasShop, setHasShop] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const applyShop = useCallback((found) => {
    setShop(found ?? null)
    setHasShop(true)
    setError(null)
  }, [])

  const applyMissing = useCallback(() => {
    setShop(null)
    setHasShop(false)
    setError(null)
  }, [])

  // Initial load. The fetch is chained with .then/.catch so state updates happen
  // in deferred callbacks rather than synchronously inside the effect.
  useEffect(() => {
    let cancelled = false
    getMyShop()
      .then((body) => {
        if (!cancelled) applyShop(body?.data?.shop)
      })
      .catch((err) => {
        if (cancelled) return
        if (isApiError(err) && err.status === 404) applyMissing()
        else setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyShop, applyMissing])

  const verified = shop?.isVerified === true

  return (
    <div className="page">
      <PageHeader eyebrow="Seller workspace" title={`Welcome, ${user?.name || 'seller'}`}>
        <p>Manage your shop, inventory, product submissions and reservations.</p>
      </PageHeader>

      <DashboardNav items={SELLER_NAV} />

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading your shop…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load your shop" /> : null}

      {!loading && !error && !hasShop ? (
        <EmptyState title="You have not created a shop yet">
          <>
            A verified shop is required before you can list inventory.{' '}
            <Link to="/seller/shop">Create your shop profile</Link> to get started.
          </>
        </EmptyState>
      ) : null}

      {!loading && !error && hasShop && shop ? (
        <>
          <section className="panel">
            <div className="page-actions">
              <h2 className="panel__title">{shop.name}</h2>
              <div className="row">
                <StatusChip status={verified ? 'VERIFIED' : 'UNVERIFIED'} />
                <StatusChip status={shop.isOpen === true ? 'OPEN' : 'CLOSED'} />
              </div>
            </div>
            <dl className="facts">
              <dt>Address</dt>
              <dd>{shop.address || '—'}</dd>
              {shop.phone ? (
                <>
                  <dt>Phone</dt>
                  <dd>{shop.phone}</dd>
                </>
              ) : null}
              {shop.description ? (
                <>
                  <dt>Description</dt>
                  <dd>{shop.description}</dd>
                </>
              ) : null}
            </dl>
          </section>

          {!verified ? (
            <div className="banner banner--info" role="status">
              <p className="banner__title">Awaiting verification</p>
              <p className="banner__body">
                An admin must verify your shop before you can add products to inventory,
                change prices or update stock. You can still prepare your shop profile and
                submit products for approval. Deactivating an existing listing is allowed.
              </p>
            </div>
          ) : null}

          <ul className="tiles">
            <li>
              <Link className="tile" to="/seller/shop">
                <h2 className="tile__title">Shop profile</h2>
                <p className="tile__body">
                  Update your shop name, address, contact details and open status.
                </p>
              </Link>
            </li>
            <li>
              <Link className="tile" to="/seller/inventory">
                <h2 className="tile__title">Inventory</h2>
                <p className="tile__body">
                  {verified
                    ? 'List products, adjust stock and manage prices.'
                    : 'Available once your shop is verified.'}
                </p>
              </Link>
            </li>
            <li>
              <Link className="tile" to="/seller/products">
                <h2 className="tile__title">Products</h2>
                <p className="tile__body">
                  Submit new products for admin approval and edit your pending submissions.
                </p>
              </Link>
            </li>
            <li>
              <Link className="tile" to="/seller/reservations">
                <h2 className="tile__title">Reservations</h2>
                <p className="tile__body">
                  Review holds placed on your stock and mark them as picked up.
                </p>
              </Link>
            </li>
          </ul>
        </>
      ) : null}
    </div>
  )
}
