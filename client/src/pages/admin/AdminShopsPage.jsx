import { useCallback, useEffect, useState } from 'react'
import { listAdminShops, verifyShop } from '../../api/admin'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DashboardNav } from '../../components/DashboardNav'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { PageHeader } from '../../components/PageHeader'
import { StatusChip } from '../../components/StatusChip'
import { ADMIN_NAV } from './adminNav'

export function AdminShopsPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [shops, setShops] = useState([])
  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')

  const applyShops = useCallback((body) => {
    setShops(body?.data?.shops ?? [])
    setError(null)
  }, [])

  const load = useCallback(async () => {
    try {
      const body = await listAdminShops()
      applyShops(body)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [applyShops])

  // Initial load. State is applied in deferred callbacks, not synchronously.
  useEffect(() => {
    let cancelled = false
    listAdminShops()
      .then((body) => {
        if (!cancelled) applyShops(body)
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyShops])

  async function handleVerify(shop) {
    const id = shop._id || shop.id
    setBusyId(id)
    setActionError(null)
    setNotice('')
    try {
      const body = await verifyShop(id)
      const updated = body?.data?.shop
      if (updated) {
        setShops((prev) => prev.map((item) => ((item._id || item.id) === id ? updated : item)))
      } else {
        await load()
      }
      setNotice('Shop verified. The seller can now manage inventory.')
    } catch (err) {
      setActionError(err)
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Admin console" title="Shops">
        <p>Verification is one-way: a verified shop cannot be unverified from here.</p>
      </PageHeader>

      <DashboardNav items={ADMIN_NAV} />

      {notice ? (
        <div className="banner banner--success" role="status">
          <p className="banner__body">{notice}</p>
        </div>
      ) : null}

      {actionError ? (
        <ErrorBanner error={actionError} title="Could not verify that shop" />
      ) : null}

      {loading ? (
        <p className="loading" aria-live="polite">
          Loading shops…
        </p>
      ) : null}

      {error ? <ErrorBanner error={error} title="Could not load shops" /> : null}

      {!loading && !error ? (
        shops.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">All registered shops</caption>
              <thead>
                <tr>
                  <th scope="col">Shop</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Address</th>
                  <th scope="col">Verification</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shops.map((shop) => {
                  const id = shop._id || shop.id
                  const owner = shop.owner && typeof shop.owner === 'object' ? shop.owner : null
                  const verified = shop.isVerified === true
                  return (
                    <tr key={id}>
                      <td>
                        <strong>{shop.name || 'Shop'}</strong>
                        {shop.phone ? <div className="subtle">{shop.phone}</div> : null}
                      </td>
                      <td>
                        {owner?.name || '—'}
                        {owner?.email ? <div className="subtle">{owner.email}</div> : null}
                      </td>
                      <td>{shop.address || '—'}</td>
                      <td>
                        <StatusChip status={verified ? 'VERIFIED' : 'UNVERIFIED'} />
                      </td>
                      <td>
                        <StatusChip status={shop.isOpen === true ? 'OPEN' : 'CLOSED'} />
                      </td>
                      <td>
                        <div className="data-table__actions">
                          {verified ? (
                            <span className="subtle">Verified</span>
                          ) : (
                            <ConfirmButton
                              variant="primary"
                              onConfirm={() => handleVerify(shop)}
                              busy={busyId === id}
                              busyLabel="Verifying…"
                              confirmLabel="Yes, verify"
                            >
                              Verify
                            </ConfirmButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No shops yet">
            Shops appear here as soon as sellers create them.
          </EmptyState>
        )
      ) : null}
    </div>
  )
}
